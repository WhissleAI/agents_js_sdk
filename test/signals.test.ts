import { describe, expect, it } from "vitest";
import { parseSignal, parseUserMetadata, turnIdOf } from "../src/signals";

/**
 * The honesty tests.
 *
 * The emotion head's output reaches the browser as a label, and the platform writes
 * `NEUTRAL` both when it genuinely read a calm speaker AND as the fallback when no
 * reading was produced at all — a deployment with no metadata sidecar, a language the
 * head isn't trusted on, a classifier call that failed. The wire is identical.
 *
 * So an SDK that surfaced `emotion: "NEUTRAL"` would let an embedder render "the
 * caller is calm" on top of "we have no idea", which is a confident claim about a
 * person built out of a blank. These pin the choice not to.
 */

describe("emotion: absence is the honest answer", () => {
  const neutral = ["NEUTRAL", "neutral", "EMOTION_NEUTRAL", "UNKNOWN", "NONE", ""];

  it.each(neutral)("reports no emotion for %o", (label) => {
    const m = parseUserMetadata({ t: "user-metadata", emotion: label, intent: "INTENT_BOOKING" });
    expect(m?.emotion).toBeUndefined();
  });

  it("reports a real emotion, with the model's own probability", () => {
    const m = parseUserMetadata({
      t: "user-metadata",
      emotion: "EMOTION_ANGRY",
      probs: {
        emotion: [
          { token: "EMOTION_ANGRY", probability: 0.62 },
          { token: "EMOTION_NEUTRAL", probability: 0.3 },
        ],
      },
    });
    expect(m?.emotion).toEqual({
      label: "ANGRY",
      confidence: 0.62,
      candidates: [
        { label: "ANGRY", probability: 0.62 },
        { label: "NEUTRAL", probability: 0.3 },
      ],
    });
  });

  it("keeps NEUTRAL in the distribution even when it isn't the reading", () => {
    // Dropping it from `candidates` too would misrepresent the distribution. The
    // suppression is about not ASSERTING it, not about hiding the numbers.
    const m = parseUserMetadata({
      t: "user-metadata",
      emotion: "SAD",
      probs: {
        emotion: [
          { token: "SAD", probability: 0.55 },
          { token: "NEUTRAL", probability: 0.4 },
        ],
      },
    });
    expect(m?.emotion?.candidates?.map((c) => c.label)).toEqual(["SAD", "NEUTRAL"]);
  });

  it("does NOT suppress intent's catch-all — 'other' is a real answer there", () => {
    // The intent head has no silent-fallback problem, so treating INTENT_OTHER like
    // NEUTRAL would throw away information the platform genuinely has.
    const m = parseUserMetadata({ t: "user-metadata", intent: "INTENT_OTHER" });
    expect(m?.intent?.label).toBe("OTHER");
  });

  it("stays quiet when there is nothing usable at all", () => {
    // No event beats an event carrying two undefineds.
    expect(parseUserMetadata({ t: "user-metadata", emotion: "NEUTRAL" })).toBeNull();
    expect(parseUserMetadata({ t: "user-metadata", age: "AGE_18_60+" })).toBeNull();
  });

  it("keeps the whole payload on `raw` for anyone who wants to see for themselves", () => {
    const wire = { t: "user-metadata", emotion: "HAPPY", age: "AGE_18_60+", gender: "F" };
    expect(parseUserMetadata(wire)?.raw).toBe(wire);
  });

  it("ignores anything that isn't a metadata payload", () => {
    for (const m of [null, undefined, 7, "x", {}, { t: "gist", text: "hi" }]) {
      expect(parseUserMetadata(m)).toBeNull();
    }
  });
});

describe("the live signal stream", () => {
  it("reads a v1 envelope", () => {
    const s = parseSignal({
      kind: "signal",
      v: 1,
      seq: 12,
      t_ms: 4300,
      type: "barge_in",
      subsystem: "barge_in",
      prediction_id: "barge_7",
      data: { mode: "open", commit_ms: 180 },
    });
    expect(s).toMatchObject({
      type: "barge_in",
      subsystem: "barge_in",
      seq: 12,
      tMs: 4300,
      predictionId: "barge_7",
    });
  });

  it("reads a resolution and its outcome", () => {
    const s = parseSignal({
      kind: "signal",
      v: 1,
      type: "endpoint",
      resolves: "ep_3",
      outcome: "false_cut",
    });
    expect(s).toMatchObject({ resolves: "ep_3", outcome: "false_cut" });
  });

  it("refuses the legacy unversioned shape that shares the discriminator", () => {
    // `{kind:"signal"}` with no `v` is a different, off-by-default schema. Handing a
    // caller two incompatible shapes under one event is how they end up with
    // `undefined.seq` in production.
    expect(parseSignal({ kind: "signal", signal: "shadow", drafted: true })).toBeNull();
    expect(parseSignal({ kind: "signal", v: "1", type: "barge_in" })).toBeNull();
    expect(parseSignal({ kind: "signal", v: 0, type: "barge_in" })).toBeNull();
  });

  it("accepts a FUTURE version rather than going silent on a schema bump", () => {
    // The stream is documented additive-only, so a v2 is v1 plus fields this build has
    // never heard of. Failing closed on the number would mute `signal` on every embed
    // already published, the moment the gateway bumped it — an outage bought with
    // nothing, since a genuinely incompatible schema would have to change `kind`.
    const s = parseSignal({
      kind: "signal",
      v: 2,
      type: "barge_in",
      seq: 7,
      t_ms: 1200,
      something_new: { we: "have never seen" },
    });
    expect(s).toMatchObject({ type: "barge_in", seq: 7, tMs: 1200, version: 2 });
    // …and everything unrecognised is still reachable, untouched.
    expect((s!.raw as Record<string, unknown>).something_new).toEqual({
      we: "have never seen",
    });
  });

  it("ignores everything else", () => {
    for (const m of [null, undefined, "x", { kind: "tool", phase: "started" }, { v: 1 }]) {
      expect(parseSignal(m)).toBeNull();
    }
  });
});

describe("turn_id: one clock for the transcript and its signals", () => {
  // Every final `user-transcription` carries a `turn_id`, and the emotion/intent
  // signals for the same utterance carry the same one. Without it a consumer lines
  // the two up by arrival order, which on a busy channel is wrong more often than
  // it looks.
  it("reads turn_id from the envelope", () => {
    const s = parseSignal({ kind: "signal", v: 1, type: "emotion", turn_id: "turn_7", data: {} });
    expect(s?.turnId).toBe("turn_7");
  });

  it("reads turn_id from inside data when the gateway put it there", () => {
    const s = parseSignal({ kind: "signal", v: 1, type: "intent", data: { turn_id: "turn_8" } });
    expect(s?.turnId).toBe("turn_8");
  });

  it("does not invent one — absent and empty are both absent", () => {
    expect(parseSignal({ kind: "signal", v: 1, type: "barge_in" })).not.toHaveProperty("turnId");
    expect(parseSignal({ kind: "signal", v: 1, type: "barge_in", turn_id: "" })).not.toHaveProperty("turnId");
    expect(turnIdOf(null)).toBeUndefined();
    expect(turnIdOf({ turn_id: 12 })).toBeUndefined();
  });

  it("reads the per-utterance delivery fields off an emotion/intent signal", () => {
    const s = parseSignal({
      kind: "signal",
      v: 1,
      type: "emotion",
      turn_id: "turn_7",
      data: {
        label: "ANGRY",
        words_per_minute: 168,
        speech_ms: 2400,
        entity_disagreements: [
          { label: "PSA-12345", kind: "cert_id" },
          { kind: "no label — dropped" },
          "garbage",
        ],
      },
    });
    expect(s).toMatchObject({
      turnId: "turn_7",
      wordsPerMinute: 168,
      speechMs: 2400,
      entityDisagreements: [{ label: "PSA-12345", kind: "cert_id" }],
    });
  });

  it("leaves the delivery fields absent (not zero) when the frame has none", () => {
    const s = parseSignal({ kind: "signal", v: 1, type: "emotion", data: { label: "HAPPY", words_per_minute: "fast" } });
    expect(s).not.toHaveProperty("wordsPerMinute");
    expect(s).not.toHaveProperty("speechMs");
    expect(s).not.toHaveProperty("entityDisagreements");
  });

  it("stamps user-metadata with its turn_id too", () => {
    const m = parseUserMetadata({ t: "user-metadata", intent: "INTENT_BOOKING", turn_id: "turn_3" });
    expect(m?.turnId).toBe("turn_3");
    expect(parseUserMetadata({ t: "user-metadata", intent: "INTENT_BOOKING" })).not.toHaveProperty("turnId");
  });
});
