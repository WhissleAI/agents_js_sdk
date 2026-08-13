import { beforeEach, describe, expect, it, vi } from "vitest";
import { TextChannel, WhissleTextError } from "../src/text";
import { WhissleAgent } from "../src/WhissleAgent";

/**
 * A Whissle agent is one brain with several mouths, and this SDK could only reach the
 * voice one. Two very common visitors had no path at all: the one who denies the
 * microphone, and the one who doesn't want to talk out loud. These cover the text
 * channel and — the part that is easy to get wrong — the fact that it behaves
 * DIFFERENTLY while a call is up.
 */

const OK = {
  reply: "Refunds are within 30 days.",
  conversation_id: "conv-1",
  session_id: "sess-1",
  tools_used: ["search_knowledge_base"],
  evidence: [{ document_id: "d1", quote: "…30 days…" }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("a text turn", () => {
  it("posts the token and the message, and reads the reply back", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(OK);
    });
    const c = new TextChannel("https://gw.test/bot/api/embed/chat/turn", "tok", "sess-1", fetchImpl);
    const turn = await c.send("what's the refund policy?");
    expect(bodies[0]).toEqual({
      token: "tok",
      message: "what's the refund policy?",
      session_id: "sess-1",
    });
    expect(turn).toEqual({
      reply: OK.reply,
      conversationId: "conv-1",
      threadId: "sess-1",
      sessionId: "sess-1",
      toolsUsed: ["search_knowledge_base"],
      evidence: OK.evidence,
    });
  });

  it("never sends a conversation_id, because nothing reads one", async () => {
    // The gateway's request model is ChatTurnRequest{token, message, session_id,
    // images} (routes/embed.py) and pydantic DROPS extras, so a `conversation_id` in
    // the body is not "ignored by the server" — it is invisible to it. Asserting the
    // ABSENCE is the point: the previous version of this test only checked that the
    // SDK put the field in the body, which passes whether or not anything reads it,
    // and is exactly how a silent no-op shipped.
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(OK);
    });
    const c = new TextChannel("https://gw.test/x", "tok", "sess-1", fetchImpl);
    c.resume("thread-old");
    await c.send("hi", { threadId: "thread-explicit" });
    expect(Object.keys(bodies[0])).toEqual(["token", "message", "session_id"]);
    expect(bodies[0].conversation_id).toBeUndefined();
  });

  it("continues the same thread on the next message", async () => {
    // Without this the agent starts cold on every message, which reads to a visitor
    // as an assistant with no memory — a search box that talks.
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(OK);
    });
    const c = new TextChannel("https://gw.test/x", "tok", "sess-1", fetchImpl);
    await c.send("one");
    await c.send("two");
    expect(bodies[0].session_id).toBe("sess-1");
    expect(bodies[1].session_id).toBe("sess-1");
    expect(c.thread).toBe("sess-1");
  });

  it("learns the thread key from the reply when it was minted without one", async () => {
    // A caller who hands the SDK a bare token string has no session id to pass. The
    // gateway then files the thread under the token's own `sid` and ECHOES it as
    // `session_id`, so the first reply is where a resumable key comes from. Without
    // this, `textThread` stays null and there is nothing to persist.
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(OK);
    });
    const c = new TextChannel("https://gw.test/x", "tok", undefined, fetchImpl);
    expect(c.thread).toBeNull();
    await c.send("one");
    expect(bodies[0].session_id).toBeUndefined(); // nothing to say yet
    expect(c.thread).toBe("sess-1"); // …learned from the echo
    await c.send("two");
    expect(bodies[1].session_id).toBe("sess-1");
  });

  it("does not let the echo overwrite a key the caller chose", async () => {
    // The response's `session_id` is always the TOKEN's sid, never the key that was
    // sent. Adopting it on a caller-supplied key would silently move them off their
    // own thread on turn two.
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(OK);
    });
    const c = new TextChannel("https://gw.test/x", "tok", undefined, fetchImpl);
    c.resume("visitor-42");
    await c.send("one");
    await c.send("two");
    expect(bodies.map((b) => b.session_id)).toEqual(["visitor-42", "visitor-42"]);
    expect(c.thread).toBe("visitor-42");
  });

  it("resumes a thread from a previous page load, as session_id", async () => {
    // The whole bug in one test. The gateway keys the thread on
    //   external_id = (body.session_id or "").strip() or claims["sid"]
    // so the ONLY way a returning visitor lands on their old conversation is for the
    // prior key to arrive as `session_id`. The mint's own session id — a NEW one on
    // this page load — must not win over it, or resuming does nothing at all.
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(OK);
    });
    const c = new TextChannel("https://gw.test/x", "tok", "sess-NEW", fetchImpl);
    c.resume("sess-OLD");
    await c.send("still there?");
    expect(bodies[0].session_id).toBe("sess-OLD");
  });

  it("lets one call opt into a different thread without moving the channel", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(OK);
    });
    const c = new TextChannel("https://gw.test/x", "tok", "sess-1", fetchImpl);
    await c.send("elsewhere", { threadId: "other" });
    await c.send("back here");
    expect(bodies.map((b) => b.session_id)).toEqual(["other", "sess-1"]);
  });

  it("sends attached images when there are any", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(OK);
    });
    const c = new TextChannel("https://gw.test/x", "tok", undefined, fetchImpl);
    await c.send("what is this part?", { images: ["data:image/png;base64,AAAA"] });
    expect(bodies[0].images).toEqual(["data:image/png;base64,AAAA"]);
  });
});

describe("why it failed", () => {
  const cases: Array<[number, RegExp]> = [
    [401, /expired/i],
    [402, /out of credit/i],
    [403, /allowed to use this agent/i],
    [404, /isn't set up for text/i],
    [503, /isn't available/i],
  ];

  it.each(cases)("turns %i into something a visitor can act on", async (status, expected) => {
    // A widget that says "402" tells the visitor nothing and the developer who
    // embedded it almost as little. Each of these is a different fix.
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "raw server text" }, status));
    const c = new TextChannel("https://gw.test/x", "tok", undefined, fetchImpl);
    await expect(c.send("hi")).rejects.toThrow(expected);
    await expect(c.send("hi")).rejects.toBeInstanceOf(WhissleTextError);
  });

  it("prefers the gateway's own sentence where the gateway writes one for the visitor", async () => {
    // 400/413/429 come back with `detail` already phrased for a person. Overwriting
    // those with our own guess would be strictly worse — the server knows which limit
    // was hit and we don't.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ detail: "Too many messages — please slow down a moment." }, 429),
    );
    const c = new TextChannel("https://gw.test/x", "tok", undefined, fetchImpl);
    await expect(c.send("hi")).rejects.toThrow(/slow down a moment/);
  });

  it("still has something to say when the gateway sends no detail", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429));
    const c = new TextChannel("https://gw.test/x", "tok", undefined, fetchImpl);
    await expect(c.send("hi")).rejects.toThrow(/slow down/i);
  });

  it("keeps the status on the error so a caller can branch", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "no" }, 402));
    const c = new TextChannel("https://gw.test/x", "tok", undefined, fetchImpl);
    await expect(c.send("hi")).rejects.toMatchObject({ code: 402 });
  });

  it("survives a non-JSON error body", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    const c = new TextChannel("https://gw.test/x", "tok", undefined, fetchImpl);
    await expect(c.send("hi")).rejects.toThrow(/502/);
  });

  it("reports a network failure as one", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    const c = new TextChannel("https://gw.test/x", "tok", undefined, fetchImpl);
    await expect(c.send("hi")).rejects.toMatchObject({ code: 0 });
  });
});

describe("sendText on the agent", () => {
  const mint = {
    token: "tok",
    text_enabled: true,
    session_id: "sess-1",
    transport: { kind: "livekit", text: { connect: { url: "/api/embed/chat/turn" } } },
  };

  it("goes over HTTP when no call is up, and follows the mint's own text door", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        seen.push(new URL(url).pathname);
        return jsonResponse(url.includes("chat/turn") ? OK : mint);
      }),
    );
    const agent = new WhissleAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: "https://gw.test/bot" });
    const replies: string[] = [];
    agent.on("agent-transcript", (t) => replies.push(String(t)));
    const turn = await agent.sendText("what's the refund policy?");
    expect(seen).toEqual(["/bot/api/embed/session-token", "/bot/api/embed/chat/turn"]);
    expect(turn?.reply).toBe(OK.reply);
    // Also surfaced as an ordinary turn, so a UI wired for voice lights up for typed
    // messages with no second code path.
    expect(replies).toEqual([OK.reply]);
    // The mint's session id — the key that resumes — NOT the conversation row id.
    expect(agent.textThread).toBe("sess-1");
    expect(turn?.conversationId).toBe("conv-1");
  });

  it("remembers a thread to resume without minting a session to hold it", async () => {
    // `resumeTextThread` is called on page load, often before the visitor has typed
    // anything. Minting there would spend a session token — against the mint's rate
    // limit — for a conversation that may never happen.
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(new URL(url).pathname);
        return jsonResponse(url.includes("chat/turn") ? OK : mint);
      }),
    );
    const agent = new WhissleAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: "https://gw.test/bot" });
    agent.resumeTextThread("sess-OLD");
    expect(calls).toEqual([]);
    expect(agent.textThread).toBe("sess-OLD");

    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("chat/turn")) bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse(url.includes("chat/turn") ? OK : mint);
      }),
    );
    await agent.sendText("still there?");
    // The resumed key beats the session id this page load's mint just handed us.
    expect((bodies[0] as Record<string, unknown>).session_id).toBe("sess-OLD");
  });

  it("re-mints once the token it holds has expired, keeping the thread", async () => {
    // An embed can sit on a page for hours; the token lives 900 s. Without this the
    // cached channel holds a dead token for ever and every later message answers
    // "this session has expired" with no way back on a page that never reloaded.
    let minted = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("chat/turn")) return jsonResponse(OK);
        minted++;
        return jsonResponse({ ...mint, expires_in: 900, session_id: `sess-${minted}` });
      }),
    );
    const agent = new WhissleAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: "https://gw.test/bot" });
    await agent.sendText("one");
    expect(minted).toBe(1);
    await agent.sendText("two");
    expect(minted).toBe(1); // still fresh — no needless mint

    try {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(Date.now() + 900_000);
      await agent.sendText("three");
      expect(minted).toBe(2);
      // The conversation is not restarted by the new credential.
      expect(agent.textThread).toBe("sess-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets go of the session on stop(), so the next message mints a fresh one", async () => {
    let minted = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("chat/turn")) return jsonResponse(OK);
        minted++;
        return jsonResponse(mint);
      }),
    );
    const agent = new WhissleAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: "https://gw.test/bot" });
    await agent.sendText("one");
    expect(minted).toBe(1);
    agent.stop();
    expect(agent.session).toBeNull();
    await agent.sendText("two");
    expect(minted).toBe(2);
    expect(agent.textThread).toBe("sess-1"); // the thread outlives the credential
  });

  it("destroy() releases the handlers as well", async () => {
    const agent = new WhissleAgent({ sessionToken: "tok" });
    const seen: unknown[] = [];
    agent.on("error", (m) => seen.push(m));
    agent.destroy();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "no" }, 402)));
    await expect(agent.sendText("hi")).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("injects it into the LIVE session instead, when one is up", async () => {
    // The voice↔text handoff: spelling an email rather than repeating it four times.
    // It must NOT open a second HTTP conversation alongside the call.
    const agent = new WhissleAgent({ sessionToken: "tok" });
    const sent: Array<{ t: string; d?: unknown }> = [];
    (agent as unknown as { lk: unknown }).lk = {
      sendClientMessage: (t: string, d?: unknown) => sent.push({ t, d }),
    };
    (agent as unknown as { _state: string })._state = "connected";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("must not be called"); }));
    await expect(agent.sendText("k.singla@example.com")).resolves.toBeNull();
    expect(sent).toEqual([{ t: "user-text", d: { text: "k.singla@example.com" } }]);
  });

  it("refuses up front when the agent has text turned off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ...mint, text_enabled: false })));
    const agent = new WhissleAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: "https://gw.test/bot" });
    await expect(agent.sendText("hi")).rejects.toThrow(/isn't set up for text/i);
  });

  it("reports a text failure with a code, not just a sentence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("chat/turn") ? jsonResponse({ detail: "no" }, 402) : jsonResponse(mint),
      ),
    );
    const agent = new WhissleAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: "https://gw.test/bot" });
    const details: unknown[] = [];
    agent.on("error", (_m, d) => details.push(d));
    await expect(agent.sendText("hi")).rejects.toThrow();
    expect(details).toEqual([{ code: "no-credit", status: 402 }]);
  });

  it("ignores an empty message rather than spending a turn on it", async () => {
    const agent = new WhissleAgent({ sessionToken: "tok" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("must not be called"); }));
    await expect(agent.sendText("   ")).resolves.toBeNull();
  });
});
