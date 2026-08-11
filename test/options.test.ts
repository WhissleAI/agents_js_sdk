import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeAvatar } from "../src/avatar";
import { WhissleAgent } from "../src/WhissleAgent";

/**
 * These cover the decisions `start()` makes BEFORE any media flows: which
 * credential is used, which transport is chosen, which query params the gateway
 * is asked for, and what happens when the avatar mint fails. They are the parts
 * that can go wrong silently. What they deliberately do NOT cover is anything
 * needing a real browser — see the "Testing" note in the README.
 */

const LIVE = "https://gw.test/bot";

/** A WhissleAgent whose transports are stubbed, so `start()` returns at the wire. */
class TestAgent extends WhissleAgent {
  webrtcCalls: string[] = [];
  livekitCalls: Array<{ url: string; token: string }> = [];

  protected async openWebRTC(endpoint: string): Promise<void> {
    this.webrtcCalls.push(endpoint);
  }
  protected async openLiveKit(info: { url: string; token: string }): Promise<void> {
    this.livekitCalls.push(info);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Route every fetch by path; anything unrouted is a test bug, so it throws. */
function routeFetch(routes: Record<string, (url: URL) => Response>) {
  const calls: URL[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    calls.push(url);
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected fetch: ${url.pathname}`);
    return route(url);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const sessionOnly = {
  "/bot/api/embed/session-token": () => jsonResponse({ token: "tok-123", expires_in: 900 }),
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("credentials", () => {
  it("refuses to construct with no credential at all", () => {
    expect(() => new WhissleAgent({} as never)).toThrow(/apiKey|sessionToken|getToken/);
  });

  it("refuses a secret key, which must never reach a browser", () => {
    expect(() => new WhissleAgent({ apiKey: "wsk_live_abc" })).toThrow(/SECRET key/);
  });

  it("still accepts the 0.1.x shape: apiKey + agentId, nothing else", () => {
    const agent = new WhissleAgent({ apiKey: "wpk_abc", agentId: "a-1" });
    expect(agent.state).toBe("idle");
    expect(agent.transport).toBeNull();
  });

  it("mints with api_key for a publishable key and embed_key for a wek_ key", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return jsonResponse({ token: "t" });
      }),
    );
    await new TestAgent({ apiKey: "wpk_abc", agentId: "a", baseUrl: LIVE }).start();
    await new TestAgent({ apiKey: "wek_abc", agentId: "a", baseUrl: LIVE }).start();
    expect(JSON.parse(bodies[0])).toMatchObject({ api_key: "wpk_abc", agent_id: "a" });
    expect(JSON.parse(bodies[1])).toMatchObject({ embed_key: "wek_abc" });
  });

  it("uses a pre-minted sessionToken and never calls the mint", async () => {
    const calls = routeFetch({});
    const agent = new TestAgent({ sessionToken: "pre-minted", baseUrl: LIVE });
    await agent.start();
    expect(calls).toHaveLength(0);
    expect(agent.webrtcCalls[0]).toContain("token=pre-minted");
  });

  it("calls getToken on every start, so a reconnect gets a fresh token", async () => {
    routeFetch({});
    let n = 0;
    const agent = new TestAgent({ getToken: () => `tok-${++n}`, baseUrl: LIVE });
    await agent.start();
    agent.stop();
    await agent.start();
    expect(agent.webrtcCalls.map((u) => new URL(u).searchParams.get("token"))).toEqual([
      "tok-1",
      "tok-2",
    ]);
  });

  it("says the backend refused rather than blaming itself when getToken is empty", async () => {
    const agent = new TestAgent({ getToken: () => "", baseUrl: LIVE });
    await expect(agent.start()).rejects.toThrow(/didn't issue a session token/);
  });

  it("explains a 403 as an origin-allowlist problem", async () => {
    routeFetch({ "/bot/api/embed/session-token": () => jsonResponse({}, 403) });
    const agent = new TestAgent({ apiKey: "wpk_abc", agentId: "a", baseUrl: LIVE });
    await expect(agent.start()).rejects.toThrow(/isn't allowed to embed/);
  });
});

describe("transport selection", () => {
  it("defaults to SmallWebRTC when the mint says nothing (today's gateway)", async () => {
    routeFetch(sessionOnly);
    const agent = new TestAgent({ apiKey: "wpk_a", agentId: "a", baseUrl: LIVE });
    await agent.start();
    expect(agent.transport).toBe("webrtc");
    expect(agent.livekitCalls).toHaveLength(0);
  });

  it("follows a LiveKit transport descriptor without a second round-trip", async () => {
    const calls = routeFetch({
      "/bot/api/embed/session-token": () =>
        jsonResponse({
          token: "t",
          transport: { kind: "livekit", url: "wss://lk.test", token: "lk-tok" },
        }),
    });
    const agent = new TestAgent({ apiKey: "wpk_a", agentId: "a", baseUrl: LIVE });
    await agent.start();
    expect(agent.transport).toBe("livekit");
    expect(agent.livekitCalls[0]).toEqual({ url: "wss://lk.test", token: "lk-tok" });
    expect(calls.map((c) => c.pathname)).toEqual(["/bot/api/embed/session-token"]);
  });

  it("asks /api/embed/livekit when LiveKit is forced but undescribed", async () => {
    routeFetch({
      ...sessionOnly,
      "/bot/api/embed/livekit": () =>
        jsonResponse({ url: "wss://lk.test", token: "lk-tok", room: "r" }),
    });
    const agent = new TestAgent({
      apiKey: "wpk_a",
      agentId: "a",
      baseUrl: LIVE,
      transport: "livekit",
    });
    await agent.start();
    expect(agent.livekitCalls[0]).toMatchObject({ url: "wss://lk.test" });
  });

  it("fails loudly, not silently downgrades, when forced LiveKit is disabled", async () => {
    routeFetch({ ...sessionOnly, "/bot/api/embed/livekit": () => jsonResponse({}, 404) });
    const agent = new TestAgent({
      apiKey: "wpk_a",
      agentId: "a",
      baseUrl: LIVE,
      transport: "livekit",
    });
    await expect(agent.start()).rejects.toThrow(/LiveKit isn't enabled/);
  });

  it("honours transport: webrtc even when the mint offers LiveKit", async () => {
    routeFetch({
      "/bot/api/embed/session-token": () =>
        jsonResponse({ token: "t", transport: { kind: "livekit", url: "u", token: "k" } }),
    });
    const agent = new TestAgent({
      apiKey: "wpk_a",
      agentId: "a",
      baseUrl: LIVE,
      transport: "webrtc",
    });
    await agent.start();
    expect(agent.transport).toBe("webrtc");
  });
});

describe("avatar options", () => {
  it("normalizes all three shapes", () => {
    expect(normalizeAvatar(undefined)).toBeNull();
    expect(normalizeAvatar(false)).toBeNull();
    expect(normalizeAvatar(true)).toEqual({});
    expect(normalizeAvatar("F1-HR")).toEqual({ id: "F1-HR" });
    expect(normalizeAvatar({ id: "M2-TL", required: true })).toEqual({
      id: "M2-TL",
      required: true,
    });
  });

  it("does not touch the avatar endpoint when no avatar was asked for", async () => {
    const calls = routeFetch(sessionOnly);
    await new TestAgent({ apiKey: "wpk_a", agentId: "a", baseUrl: LIVE }).start();
    expect(calls.map((c) => c.pathname)).toEqual(["/bot/api/embed/session-token"]);
  });

  it("passes the requested code to the avatar mint", async () => {
    const calls = routeFetch({
      ...sessionOnly,
      "/bot/api/embed/simli-token": () => jsonResponse({}, 502),
    });
    await new TestAgent({
      apiKey: "wpk_a",
      agentId: "a",
      baseUrl: LIVE,
      avatar: "F1-HR",
    }).start();
    const mint = calls.find((c) => c.pathname.endsWith("simli-token"))!;
    expect(mint.searchParams.get("avatar_id")).toBe("F1-HR");
    expect(mint.searchParams.get("token")).toBe("tok-123");
  });

  it("connects AUDIO-ONLY with an avatar-failed event when the mint fails", async () => {
    routeFetch({ ...sessionOnly, "/bot/api/embed/simli-token": () => jsonResponse({}, 502) });
    const agent = new TestAgent({
      apiKey: "wpk_a",
      agentId: "a",
      baseUrl: LIVE,
      avatar: "F1-HR",
    });
    const failures: unknown[] = [];
    agent.on("avatar-failed", (m) => failures.push(m));
    await agent.start();
    expect(failures).toHaveLength(1);
    // The session still came up, and the bot was NOT told to skip its own render.
    expect(agent.webrtcCalls).toHaveLength(1);
    expect(agent.webrtcCalls[0]).not.toContain("avatar_render");
  });

  it("names an unknown avatar code in the failure, not a bare status", async () => {
    routeFetch({ ...sessionOnly, "/bot/api/embed/simli-token": () => jsonResponse({}, 404) });
    const agent = new TestAgent({
      apiKey: "wpk_a",
      agentId: "a",
      baseUrl: LIVE,
      avatar: "deborah",
    });
    const failures: string[] = [];
    agent.on("avatar-failed", (m) => failures.push(String(m)));
    await agent.start();
    expect(failures[0]).toMatch(/Unknown avatar "deborah"/);
  });

  it("fails the whole session when the avatar is required", async () => {
    routeFetch({ ...sessionOnly, "/bot/api/embed/simli-token": () => jsonResponse({}, 502) });
    const agent = new TestAgent({
      apiKey: "wpk_a",
      agentId: "a",
      baseUrl: LIVE,
      avatar: { id: "F1-HR", required: true },
    });
    await expect(agent.start()).rejects.toThrow(/avatar/i);
    expect(agent.webrtcCalls).toHaveLength(0);
  });
});

describe("session query params", () => {
  it("carries only the token when there is no avatar", async () => {
    routeFetch(sessionOnly);
    const agent = new TestAgent({ apiKey: "wpk_a", agentId: "a", baseUrl: LIVE });
    await agent.start();
    const url = new URL(agent.webrtcCalls[0]);
    expect(url.pathname).toBe("/bot/api/embed/offer");
    expect([...url.searchParams.keys()]).toEqual(["token"]);
  });
});
