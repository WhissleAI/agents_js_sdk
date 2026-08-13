import { describe, expect, it } from "vitest";
import { type SessionCallbacks } from "../src/livekit";
import { WhissleAgent } from "../src/WhissleAgent";

/**
 * An agent and the app around it need to talk about things this SDK knows
 * nothing about: an interview announcing which question it reached, an app
 * asking it to wrap up early. Both directions existed on the wire and neither
 * was reachable — messages the SDK didn't recognise were dropped, and there was
 * no way to send one at all.
 */

class Probe extends WhissleAgent {
  cb: SessionCallbacks = this.callbacks();
  seen: unknown[] = [];
  sent: unknown[] = [];
  constructor() {
    super({ sessionToken: "t" });
    this.on("server-message", (m) => this.seen.push(m));
    // Stand in for a connected LiveKit session. `sendClientMessage` is the real
    // method the agent must call — see the outbound tests below for why.
    (this as unknown as {
      lk: { sendClientMessage: (t: string, d?: unknown) => void };
    }).lk = {
      sendClientMessage: (t: string, d?: unknown) => this.sent.push({ t, d }),
    };
  }
}

describe("messages from the agent", () => {
  it("passes through what the SDK doesn't consume", () => {
    const p = new Probe();
    p.cb.onServerMessage({ t: "question", index: 3, text: "Why CPVC?" });
    expect(p.seen).toEqual([{ t: "question", index: 3, text: "Why CPVC?" }]);
  });

  it("keeps consuming its own, without leaking them", () => {
    const p = new Probe();
    // These drive the avatar. An app that also received them would be handed
    // base64 audio it has no use for on every single utterance.
    p.cb.onServerMessage({ t: "simli-audio", pcm: "AAAA" });
    p.cb.onServerMessage({ t: "simli-clear" });
    expect(p.seen).toEqual([]);
  });

  it("reports running out of credit as an error, not as app data", () => {
    const p = new Probe();
    const errors: unknown[] = [];
    p.on("error", (e) => errors.push(e));
    p.cb.onServerMessage({ type: "error", error: "no_credits", message: "Out of credit." });
    expect(errors).toEqual(["Out of credit."]);
    expect(p.seen).toEqual([]);
  });
});

describe("messages to the agent", () => {
  it("sends a bare control message", () => {
    const p = new Probe();
    p.send("wrap-up");
    expect(p.sent).toEqual([{ t: "wrap-up", d: undefined }]);
  });

  it("carries a payload when there is one", () => {
    const p = new Probe();
    p.send("set-difficulty", { level: "hard" });
    expect(p.sent).toEqual([{ t: "set-difficulty", d: { level: "hard" } }]);
  });

  it("is a no-op before the session is up", () => {
    // Not connected: no transport of any kind.
    const p = new WhissleAgent({ sessionToken: "t" });
    // A control message lost while connecting must never throw — the caller is
    // usually a click handler, and taking the page down with it is worse than
    // the message not arriving.
    expect(() => p.send("pause")).not.toThrow();
  });
});
