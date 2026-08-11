import { describe, expect, it } from "vitest";
import { RTVIMessageType } from "@pipecat-ai/client-js";
import { LiveKitSession, type SessionCallbacks } from "../src/livekit";
import { WhissleAgent } from "../src/WhissleAgent";

/**
 * A live LiveKit session logged every reply TWICE, concatenated, with the
 * sentences interleaved out of order. Captured off the wire, one greeting is
 * three RTVI messages carrying the same sentence:
 *
 *   bot-output        {spoken:false, aggregated_by:"sentence"}   t+0ms
 *   bot-output        {spoken:true,  aggregated_by:"sentence"}   t+1ms
 *   bot-transcription {text:…}                                   (LLM-paced)
 *
 * …and the SDK appended all of them to one buffer. These pin down which copy
 * wins and prove the others are dropped rather than concatenated.
 */

/** Reaches `callbacks()`, which is where turn/transcript logic actually lives. */
class Probe extends WhissleAgent {
  cb: SessionCallbacks = this.callbacks();
  lines: string[] = [];
  constructor() {
    super({ sessionToken: "t" });
    this.on("agent-transcript", (t) => this.lines.push(String(t)));
  }
}

/** Drive one bot turn, in the order the messages actually reach the browser. */
function turn(
  p: Probe,
  opts: { spoken?: string[]; unspoken?: string[]; legacy?: string[] },
) {
  // `bot-transcription` is cut on LLM tokens, so it lands FIRST — before the
  // bot has even started speaking.
  for (const t of opts.legacy ?? []) p.cb.onBotLegacyOutput(t);
  p.cb.onBotStartedSpeaking();
  const n = Math.max(opts.spoken?.length ?? 0, opts.unspoken?.length ?? 0);
  for (let i = 0; i < n; i++) {
    if (opts.unspoken?.[i] !== undefined) p.cb.onBotOutput(opts.unspoken[i], false);
    if (opts.spoken?.[i] !== undefined) p.cb.onBotOutput(opts.spoken[i], true);
  }
  p.cb.onBotStoppedSpeaking();
}

describe("agent-transcript", () => {
  it("emits the turn ONCE when all three copies of it arrive", () => {
    const line = "Hi! I'm your tutor for Electrician.";
    const p = new Probe();
    turn(p, { legacy: [line], unspoken: [line], spoken: [line] });
    expect(p.lines).toEqual([line]);
  });

  it("still joins the sentences of one turn into a single line", () => {
    const p = new Probe();
    turn(p, {
      unspoken: ["Hi! I'm your tutor.", "What are you working on?"],
      spoken: ["Hi! I'm your tutor.", "What are you working on?"],
    });
    expect(p.lines).toEqual(["Hi! I'm your tutor. What are you working on?"]);
  });

  it("reports what was SPOKEN, in spoken order, when the copies disagree", () => {
    // The bug's signature: the copies are paced differently, so merging them
    // scrambled the sentences as well as doubling them. The TTS-cut copy is the
    // one the listener actually heard.
    const p = new Probe();
    p.cb.onBotLegacyOutput("—that's non-negotiable.");
    p.cb.onBotStartedSpeaking();
    p.cb.onBotOutput("Right, so you're aiming for Electrician.", true);
    p.cb.onBotLegacyOutput("Before we pick apart the rules,");
    p.cb.onBotOutput("Before we pick apart the rules,", false);
    p.cb.onBotOutput("why do you have to do it every time?", true);
    p.cb.onBotStoppedSpeaking();

    expect(p.lines).toEqual([
      "Right, so you're aiming for Electrician. why do you have to do it every time?",
    ]);
  });

  it("falls back to the unspoken copy when a gateway sends no TTS aggregation", () => {
    const p = new Probe();
    turn(p, { legacy: ["Legacy copy."], unspoken: ["LLM copy."] });
    expect(p.lines).toEqual(["LLM copy."]);
  });

  it("falls back to bot-transcription when a gateway sends nothing better", () => {
    const p = new Probe();
    turn(p, { legacy: ["Older gateway.", "Still talking."] });
    expect(p.lines).toEqual(["Older gateway. Still talking."]);
  });

  it("keeps one line per turn across a whole conversation", () => {
    const p = new Probe();
    turn(p, { legacy: ["One."], unspoken: ["One."], spoken: ["One."] });
    turn(p, { legacy: ["Two."], unspoken: ["Two."], spoken: ["Two."] });
    turn(p, { legacy: ["Three."], unspoken: ["Three."], spoken: ["Three."] });
    expect(p.lines).toEqual(["One.", "Two.", "Three."]);
  });

  it("emits nothing for a turn with no text at all", () => {
    const p = new Probe();
    turn(p, {});
    expect(p.lines).toEqual([]);
  });
});

describe("LiveKit RTVI routing", () => {
  function route(type: string, data: Record<string, unknown>) {
    const seen: Array<[string, string, boolean?]> = [];
    const cb = {
      onBotOutput: (t: string, spoken: boolean) => seen.push(["output", t, spoken]),
      onBotLegacyOutput: (t: string) => seen.push(["legacy", t]),
    } as unknown as SessionCallbacks;
    const payload = new TextEncoder().encode(JSON.stringify({ label: "rtvi-ai", type, data }));
    // `handleData` is the translation layer; there is no public seam for it.
    (new LiveKitSession() as unknown as { handleData(p: Uint8Array, c: SessionCallbacks): void })
      .handleData(payload, cb);
    return seen;
  }

  it("sends bot-output and bot-transcription to two different callbacks", () => {
    expect(route(RTVIMessageType.BOT_TRANSCRIPTION, { text: "llm" })).toEqual([["legacy", "llm"]]);
    expect(route(RTVIMessageType.BOT_OUTPUT, { text: "x", spoken: true })).toEqual([
      ["output", "x", true],
    ]);
  });

  it("carries the spoken flag through, which is all that separates the two copies", () => {
    expect(route(RTVIMessageType.BOT_OUTPUT, { text: "x", spoken: false })).toEqual([
      ["output", "x", false],
    ]);
    // Absent flag must not read as spoken, or an older gateway doubles again.
    expect(route(RTVIMessageType.BOT_OUTPUT, { text: "x" })).toEqual([["output", "x", false]]);
  });
});
