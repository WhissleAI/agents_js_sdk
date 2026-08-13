import { beforeEach, describe, expect, it, vi } from "vitest";
import { type SessionCallbacks } from "../src/livekit";
import { WhissleAgent } from "../src/WhissleAgent";

/**
 * One channel, three discriminators, and until 0.5.0 the agent read none of them: tool
 * events, live signals and acoustic metadata all arrived, were forwarded raw as
 * `server-message`, and that was that. So an embedded agent was silent during tool
 * calls and had no way to say why it had gone quiet — the information was there the
 * whole time, unlabelled.
 *
 * The compatibility rule these also pin: everything that used to reach
 * `server-message` still does. Routing it better must not take it away from anyone who
 * already parses it by hand.
 */

class Probe extends WhissleAgent {
  cb: SessionCallbacks = this.callbacks();
  events: Array<[string, unknown]> = [];
  constructor(opts: Record<string, unknown> = {}) {
    super({ sessionToken: "t", earcons: false, ...opts });
    for (const e of [
      "server-message",
      "tool-started",
      "tool-progress",
      "tool-finished",
      "thinking",
      "signal",
      "user-metadata",
      "gist",
      "demo-limit",
      "error",
      "agent-partial",
      "agent-word",
      "listening-started",
      "agent-transcript",
    ] as const) {
      this.on(e, (p) => this.events.push([e, p]));
    }
  }
  of(name: string) {
    return this.events.filter(([e]) => e === name).map(([, p]) => p);
  }
  get names() {
    return this.events.map(([e]) => e);
  }
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

const started = {
  kind: "tool",
  phase: "started",
  tool_call_id: "c1",
  function_name: "book_appointment",
  arguments: { when: "Tuesday" },
  sound: "create_0",
};

describe("tool events", () => {
  it("names a tool call instead of leaving it as an anonymous blob", () => {
    const p = new Probe();
    p.cb.onServerMessage(started);
    expect(p.of("tool-started")[0]).toMatchObject({
      id: "c1",
      name: "book_appointment",
      sound: "create_0",
    });
  });

  it("still forwards it as `server-message`, unchanged", () => {
    // Anyone already parsing these by hand keeps working. Tidier routing is not worth
    // a silent breaking change.
    const p = new Probe();
    p.cb.onServerMessage(started);
    expect(p.of("server-message")).toEqual([started]);
  });

  it("turns a turn's tools into ONE thinking edge each way", () => {
    const p = new Probe();
    p.cb.onServerMessage(started);
    p.cb.onServerMessage({ ...started, tool_call_id: "c2", function_name: "check_availability" });
    p.cb.onServerMessage({ kind: "tool", phase: "result", tool_call_id: "c1", ok: true });
    p.cb.onServerMessage({ kind: "tool", phase: "result", tool_call_id: "c2", ok: true });
    expect(p.of("thinking")).toEqual([
      { active: true, tool: "book_appointment", label: undefined },
      { active: false },
    ]);
  });

  it("stops thinking when the bot starts speaking, whatever the bookkeeping says", () => {
    const p = new Probe();
    p.cb.onServerMessage(started);
    p.cb.onBotStartedSpeaking();
    expect(p.of("thinking")).toEqual([
      { active: true, tool: "book_appointment", label: undefined },
      { active: false },
    ]);
  });

  it("carries a progress line for a long tool", () => {
    const p = new Probe();
    p.cb.onServerMessage(started);
    p.cb.onServerMessage({
      kind: "tool",
      phase: "progress",
      tool_call_id: "c1",
      function_name: "book_appointment",
      display: "Checking Tuesday…",
    });
    expect(p.of("thinking")[1]).toMatchObject({ active: true, label: "Checking Tuesday…" });
  });

  it("surfaces citations on the result", () => {
    const p = new Probe();
    p.cb.onServerMessage({
      kind: "tool",
      phase: "result",
      function_name: "search_knowledge_base",
      ok: true,
      evidence: [{ document_id: "d1", quote: "…" }],
    });
    expect((p.of("tool-finished")[0] as { evidence?: unknown[] }).evidence).toHaveLength(1);
  });
});

describe("earcons", () => {
  /** Capture what the agent asked the earcon player to play. */
  function withPlayer(p: Probe) {
    const played: Array<string | null | undefined> = [];
    (p as unknown as { earcons: { play: (n?: string | null) => void } }).earcons = {
      play: (n: string | null | undefined) => played.push(n),
    } as never;
    return played;
  }

  it("plays the clip the platform chose on a tool start", () => {
    const p = new Probe();
    const played = withPlayer(p);
    p.cb.onServerMessage(started);
    expect(played).toEqual(["create_0"]);
  });

  it("plays nothing on a SUCCESSFUL result", () => {
    // The agent is about to say the answer; a chime on every result would turn the
    // bank into wallpaper.
    const p = new Probe();
    const played = withPlayer(p);
    p.cb.onServerMessage({ kind: "tool", phase: "result", tool_call_id: "c1", ok: true });
    expect(played).toEqual([undefined]);
  });

  it("plays the failure cue when a tool fails", () => {
    const p = new Probe();
    const played = withPlayer(p);
    p.cb.onServerMessage({
      kind: "tool",
      phase: "result",
      tool_call_id: "c1",
      ok: false,
      sound: "error_0",
    });
    expect(played).toEqual(["error_0"]);
  });
});

describe("the other families on the same channel", () => {
  it("routes a live signal", () => {
    const p = new Probe();
    p.cb.onServerMessage({ kind: "signal", v: 1, seq: 3, type: "barge_in", data: { mode: "open" } });
    expect(p.of("signal")[0]).toMatchObject({ type: "barge_in", seq: 3 });
  });

  it("routes acoustic metadata", () => {
    const p = new Probe();
    p.cb.onServerMessage({ t: "user-metadata", emotion: "ANGRY", intent: "INTENT_COMPLAINT" });
    expect(p.of("user-metadata")[0]).toMatchObject({ emotion: { label: "ANGRY" } });
  });

  it("routes the live gist caption", () => {
    const p = new Probe();
    p.cb.onServerMessage({ t: "gist", text: "Looking up your booking" });
    expect(p.of("gist")).toEqual(["Looking up your booking"]);
  });

  it("keeps consuming the avatar frames without leaking them to the app", () => {
    const p = new Probe();
    p.cb.onServerMessage({ t: "simli-audio", pcm: "AAAA" });
    p.cb.onServerMessage({ t: "simli-clear" });
    expect(p.events).toEqual([]);
  });

  it("passes an app's own message through untouched", () => {
    const p = new Probe();
    const mine = { t: "question", index: 3, text: "Why CPVC?" };
    p.cb.onServerMessage(mine);
    expect(p.names).toEqual(["server-message"]);
    expect(p.of("server-message")).toEqual([mine]);
  });
});

describe("errors carry a code as well as a sentence", () => {
  it("says out-of-credit, not 'connection error'", () => {
    const p = new Probe();
    const details: unknown[] = [];
    p.on("error", (_m, d) => details.push(d));
    p.cb.onServerMessage({ type: "error", error: "no_credits", message: "Credits exhausted." });
    expect(p.of("error")).toEqual(["Credits exhausted."]);
    expect(details).toEqual([{ code: "no-credit" }]);
    // An error, not application data — the existing contract never leaked it.
    expect(p.of("server-message")).toEqual([]);
  });

  it("reports the demo cap as its own thing", () => {
    const p = new Probe();
    p.cb.onServerMessage({ type: "demo-limit", reason: "time" });
    expect(p.names).toEqual(["demo-limit", "error"]);
  });

  it("distinguishes a dead mic from a lost device", () => {
    const p = new Probe();
    const details: unknown[] = [];
    p.on("error", (_m, d) => details.push(d));
    p.cb.onServerMessage({ t: "mic_dead", text: "We can't hear you." });
    expect(details).toEqual([{ code: "microphone" }]);
  });

  it("reports the agent's brain being down as its own code", () => {
    const p = new Probe();
    const details: unknown[] = [];
    p.on("error", (_m, d) => details.push(d));
    p.cb.onServerMessage({ t: "agent_error", text: "The agent is unavailable." });
    expect(details).toEqual([{ code: "agent-down" }]);
  });
});

describe("the reply, as it happens", () => {
  it("emits the turn so far, not just the finished paragraph", () => {
    // `agent-transcript` fires when the bot STOPS speaking. On a long reply a
    // transcript built from it alone sits empty for ten seconds and then dumps.
    const p = new Probe();
    p.cb.onBotStartedSpeaking();
    p.cb.onBotOutput("Hi there.", true);
    p.cb.onBotOutput("How can I help?", true);
    p.cb.onBotStoppedSpeaking();
    expect(p.of("agent-partial")).toEqual(["Hi there.", "Hi there. How can I help?"]);
    expect(p.of("agent-transcript")).toEqual(["Hi there. How can I help?"]);
  });

  it("never interleaves the LLM and TTS copies of one reply", () => {
    // A gateway aggregates the SAME reply twice — once off the LLM stream
    // (`spoken:false`) and once off the TTS stream (`spoken:true`) — cut at the same
    // places but arriving at different times. Appending both to one buffer is what
    // made every reply appear two or three times over, interleaved.
    //
    // The old version of this test used the same string for both copies, so it could
    // not have caught that: "Hi there." and "Hi there." concatenated wrongly still
    // reads as a plausible answer. These differ, so a mixed buffer would spell it out.
    const p = new Probe();
    p.cb.onBotStartedSpeaking();
    p.cb.onBotOutput("The policy is thirty days.", false); // LLM, first
    p.cb.onBotOutput("The policy is 30 days.", true); // TTS, same sentence
    p.cb.onBotOutput("Anything else?", false);
    p.cb.onBotOutput("Anything else?", true);

    for (const partial of p.of("agent-partial")) {
      expect(partial).not.toMatch(/thirty days.*30 days|30 days.*thirty days/);
    }
    p.cb.onBotStoppedSpeaking();
    // One turn, one transcript, in the wording the listener actually heard.
    expect(p.of("agent-transcript")).toEqual(["The policy is 30 days. Anything else?"]);
  });

  it("never lets a partial go backwards, even when the LLM copy arrives whole", () => {
    // Straight off a live session with the production demo agent. The LLM stream
    // delivered the entire greeting as ONE segment; the TTS stream then delivered the
    // same greeting a WORD at a time. Preferring `spoken` unconditionally rendered the
    // whole sentence and then replaced it with "Hey,", re-growing over two seconds —
    // so anyone rendering `agent-partial` (which the README recommends as the thing to
    // show mid-answer) watched the reply apparently delete itself.
    const p = new Probe();
    p.cb.onBotStartedSpeaking();
    p.cb.onBotOutput("Hey, I'm Lulu. What's on your mind?", false); // whole, at once
    for (const word of ["Hey,", "I'm", "Lulu.", "What's", "on", "your", "mind?"]) {
      p.cb.onBotOutput(word, true); // …then word by word
    }
    const partials = p.of("agent-partial") as string[];
    expect(partials[0]).toBe("Hey, I'm Lulu. What's on your mind?");
    // Monotone: every partial is at least as long as the one before it.
    for (let i = 1; i < partials.length; i++) {
      expect(partials[i].length).toBeGreaterThan(partials[i - 1].length);
    }
    // And nothing was emitted just to say the same thing again.
    expect(new Set(partials).size).toBe(partials.length);
  });

  it("falls back to the unspoken copy when a gateway sends no spoken one", () => {
    // The de-duplication must not become a way to lose the only copy there is.
    const p = new Probe();
    p.cb.onBotStartedSpeaking();
    p.cb.onBotOutput("Only the LLM stream here.", false);
    p.cb.onBotStoppedSpeaking();
    expect(p.of("agent-transcript")).toEqual(["Only the LLM stream here."]);
  });

  it("surfaces words as they are spoken", () => {
    const p = new Probe();
    p.cb.onBotWord("Hello");
    p.cb.onBotWord("");
    expect(p.of("agent-word")).toEqual(["Hello"]);
  });

  it("surfaces the VAD edge that makes barge-in observable", () => {
    const p = new Probe();
    p.cb.onUserStartedSpeaking();
    expect(p.of("listening-started")).toHaveLength(1);
  });
});
