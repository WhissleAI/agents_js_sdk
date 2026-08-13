import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhissleAgent } from "../src/WhissleAgent";

/**
 * What an embedder sees when it doesn't work.
 *
 * Every failure here used to arrive as one of two sentences — "This site isn't allowed
 * to embed this agent" or "Couldn't start the agent (check the key + agent id)" — and
 * the second one was the default. So an empty wallet, a disabled agent and a rate limit
 * all told a developer to go and check a key that was fine, and told the visitor
 * nothing at all.
 */

const LIVE = "https://gw.test/bot";

class TestAgent extends WhissleAgent {
  webrtcCalls: string[] = [];
  livekitCalls: Array<{ url: string; token: string }> = [];
  livekitFails = false;

  protected async openWebRTC(endpoint: string): Promise<void> {
    this.webrtcCalls.push(endpoint);
  }
  protected async openLiveKit(info: { url: string; token: string }): Promise<void> {
    if (this.livekitFails) throw new Error("could not reach the SFU");
    this.livekitCalls.push(info);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

/** Start an agent whose mint answers `status`, and report what the caller learned. */
async function mintFails(status: number, detail?: string) {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(detail ? { detail } : {}, status)));
  const agent = new TestAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: LIVE, micPreflight: false });
  const seen: Array<{ message: string; detail: unknown }> = [];
  agent.on("error", (m, d) => seen.push({ message: String(m), detail: d }));
  await expect(agent.start()).rejects.toThrow();
  return seen[0];
}

describe("why the session wouldn't start", () => {
  it("names an empty wallet", async () => {
    const e = await mintFails(402);
    expect(e.detail).toEqual({ code: "no-credit", status: 402 });
    expect(e.message).toMatch(/out of credit/i);
  });

  it("names the origin that isn't allowlisted, and where to add it", async () => {
    const e = await mintFails(403);
    expect(e.detail).toEqual({ code: "origin-not-allowed", status: 403 });
    expect(e.message).toMatch(/Embed settings/);
  });

  it("distinguishes 'not allowed here' from 'doesn't exist'", async () => {
    // Very different problems for whoever installed the widget.
    expect((await mintFails(404)).detail).toEqual({ code: "not-found", status: 404 });
  });

  it("names an invalid key rather than blaming the agent", async () => {
    expect((await mintFails(401)).detail).toEqual({ code: "expired", status: 401 });
  });

  it("names a rate limit, and quotes the gateway's own words", async () => {
    const e = await mintFails(429, "Too many sessions for this embed token.");
    expect(e.detail).toEqual({ code: "rate-limited", status: 429 });
    expect(e.message).toBe("Too many sessions for this embed token.");
  });

  it("falls back to a code rather than guessing, on a status it doesn't know", async () => {
    expect((await mintFails(418)).detail).toEqual({ code: "connection", status: 418 });
  });

  it("survives an error body that isn't JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));
    const agent = new TestAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: LIVE, micPreflight: false });
    await expect(agent.start()).rejects.toThrow(/502/);
  });
});

describe("the transport the mint told us to fall back to", () => {
  const withFallback = {
    token: "tok",
    transport: {
      kind: "livekit",
      url: "wss://sfu.test",
      fallbacks: [{ kind: "webrtc", connect: { url: "/api/embed/offer" } }],
    },
  };

  it("takes the WebRTC fallback when the room can't be reached", async () => {
    // The gateway has been publishing this fallback chain all along and the SDK
    // ignored it, so a room the browser couldn't reach was the end of the session
    // rather than a detour.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(withFallback)));
    const agent = new TestAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: LIVE, micPreflight: false });
    agent.livekitFails = true;
    await agent.start();
    expect(agent.webrtcCalls).toHaveLength(1);
    expect(agent.transport).toBe("webrtc");
  });

  it("does NOT second-guess a caller who asked for a specific transport", async () => {
    // Asking for `livekit` and silently getting SmallWebRTC is a worse outcome than
    // being told it failed — you asked for a specific transport for a reason.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(withFallback)));
    const agent = new TestAgent({
      apiKey: "wpk_x",
      agentId: "a",
      baseUrl: LIVE,
      transport: "livekit",
      micPreflight: false,
    });
    agent.livekitFails = true;
    await expect(agent.start()).rejects.toThrow(/SFU/);
    expect(agent.webrtcCalls).toHaveLength(0);
  });

  it("gives up when the mint named no fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ token: "tok", transport: { kind: "livekit", url: "wss://x" } })),
    );
    const agent = new TestAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: LIVE, micPreflight: false });
    agent.livekitFails = true;
    await expect(agent.start()).rejects.toThrow(/SFU/);
    expect(agent.webrtcCalls).toHaveLength(0);
  });

  it("reports the fallback's own failure, not the first one's", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(withFallback)));
    class BothFail extends TestAgent {
      protected async openWebRTC(): Promise<void> {
        throw new Error("no ICE candidates");
      }
    }
    const agent = new BothFail({ apiKey: "wpk_x", agentId: "a", baseUrl: LIVE, micPreflight: false });
    agent.livekitFails = true;
    await expect(agent.start()).rejects.toThrow(/ICE/);
  });
});

describe("the microphone, before anything connects", () => {
  it("refuses to start when the browser is blocking the mic", async () => {
    // The bug: `enableMic: true` runs its own getUserMedia, and when that fails it
    // does not reliably throw out of connect(). The session comes UP with no inbound
    // audio — the server sees zero frames and the visitor sees a widget that ignores
    // them, for the whole call.
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })),
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ token: "tok" })));
    const agent = new TestAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: LIVE });
    const details: unknown[] = [];
    agent.on("error", (_m, d) => details.push(d));
    await expect(agent.start()).rejects.toThrow(/padlock/);
    expect(details).toEqual([{ code: "microphone" }]);
    // …and it never spent the session token on a call that could not have worked.
    expect(agent.webrtcCalls).toHaveLength(0);
  });

  it("connects normally when the mic is fine", async () => {
    const stopped: string[] = [];
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () => ({
          getAudioTracks: () => [{ readyState: "live", muted: false }],
          getTracks: () => [{ stop: () => stopped.push("stopped") }],
        }),
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ token: "tok" })));
    const agent = new TestAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: LIVE });
    await agent.start();
    expect(agent.webrtcCalls).toHaveLength(1);
    // The mic is handed straight back — holding it would make us the app the
    // "another app is using your microphone" message tells people to go and close.
    expect(stopped).toEqual(["stopped"]);
  });

  it("can be turned off for a page that manages permission itself", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { mediaDevices: undefined });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ token: "tok" })));
    const agent = new TestAgent({
      apiKey: "wpk_x",
      agentId: "a",
      baseUrl: LIVE,
      micPreflight: false,
    });
    await agent.start();
    expect(agent.webrtcCalls).toHaveLength(1);
  });
});
