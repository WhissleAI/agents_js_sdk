import { describe, expect, it } from "vitest";
import { parseSignal, parseUserMetadata } from "../src/signals";

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
    expect(parseSignal({ kind: "signal", v: 2, type: "barge_in" })).toBeNull();
  });

  it("ignores everything else", () => {
    for (const m of [null, undefined, "x", { kind: "tool", phase: "started" }, { v: 1 }]) {
      expect(parseSignal(m)).toBeNull();
    }
  });
});
