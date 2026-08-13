// What the pipeline knows about the caller, and about itself.
//
// Two separate streams arrive on the same `server-message` channel and mean different
// things. Both were being forwarded raw and neither was documented, so an embedder had
// to reverse-engineer them off the wire to use either.
//
//   {t:"user-metadata", …}                the acoustic read of the CALLER — emotion,
//                                         intent, and a probability distribution behind
//                                         each. Change-gated, a few times a second.
//   {kind:"signal", v:1, …}               the live signal stream: what the pipeline's
//                                         own subsystems are doing — barge-in, endpoint
//                                         prediction, language switches, entities, flow
//                                         state. Documented as schema v1 in the
//                                         gateway's docs/live-signal-stream.md.
//
// A third shape, `{kind:"signal"}` with NO `v`, is a legacy mirror that is off by
// default. It is deliberately NOT surfaced as a signal here: it shares the
// discriminator but not the schema, and quietly handing a caller two incompatible
// shapes under one event is how a consumer ends up with `undefined.seq`.

/**
 * One reading, with the confidence behind it.
 *
 * `confidence` is the model's own probability for `label`, not a certainty. Our
 * emotion head tops out around 0.63 on low-arousal states, so a UI that renders this
 * as a fact is over-claiming on the platform's behalf.
 */
export interface Reading {
  label: string;
  confidence?: number;
  /** The full distribution, best first, when the pipeline sent one. */
  candidates?: Array<{ label: string; probability: number }>;
}

/**
 * The live acoustic read of the person speaking.
 *
 * ── Why `emotion` can be undefined even though the wire said something ──────────
 *
 * `NEUTRAL` is not reported here, and that is deliberate.
 *
 * The platform writes `NEUTRAL` in two completely different situations: when the
 * acoustic head genuinely read a calm speaker, and as the FALLBACK when the reading
 * was never produced at all — a deployment whose ear has no metadata sidecar, a
 * language the head is not trusted on, a classifier call that failed. The wire looks
 * identical in both cases (see the gateway's metadata_extractor `_default_msg`, whose
 * own comment records an incident where an outage classified every turn of every call
 * as NEUTRAL and "nothing downstream knew the difference between a real NEUTRAL and a
 * fallback one").
 *
 * So a `NEUTRAL` on this wire supports exactly one honest statement: *nothing was
 * detected*. Surfacing it as a reading would let an embedder build "the caller is
 * calm" out of "we don't know", which is worse than showing nothing — it is a
 * confident claim about a person, drawn from a blank.
 *
 * `undefined` is therefore the whole answer for both "no reading" and "neutral", and
 * `raw` is there for anyone who needs to see for themselves.
 */
export interface UserMetadata {
  /** Absent unless a non-neutral emotion was actually detected. See above. */
  emotion?: Reading;
  /** What the caller appears to want. No fallback-value problem — reported as sent. */
  intent?: Reading;
  /** The untouched payload, including `age`, `gender` and the raw `probs` map. */
  raw: unknown;
}

/** One event from the pipeline's live signal stream (schema v1). */
export interface LiveSignal {
  /** `"barge_in"`, `"endpoint"`, `"language"`, `"entity"`, `"flow_state"`, `"emotion"`,
   *  `"intent"`, `"hesitation"`, `"addressee"`, `"stream.start"`, … */
  type: string;
  /** Which part of the pipeline said it, e.g. `"barge_in"`, `"focus.audio_gate"`. */
  subsystem?: string;
  /** Per-call ordinal. This — not arrival order — is the authoritative sequence. */
  seq?: number;
  /** Milliseconds since the call started, clamped non-decreasing at the source. */
  tMs?: number;
  /** Set when this event is a PREDICTION that a later event will resolve. */
  predictionId?: string;
  /** Set when this event RESOLVES an earlier prediction — the id it resolves. */
  resolves?: string;
  /** How the prediction turned out, e.g. `"committed"`, `"false_cut"`, `"held"`. */
  outcome?: string;
  /** The event's own payload. Shape depends on `type`. */
  data?: unknown;
  raw: unknown;
}

/**
 * `NEUTRAL` in every spelling the pipeline has used for it. `INTENT_OTHER` is NOT
 * here: the intent head has no silent-fallback problem, and "other" is a real answer.
 */
const NOT_A_READING = new Set(["", "NEUTRAL", "EMOTION_NEUTRAL", "UNKNOWN", "NONE", "NULL"]);

/** Strip the taxonomy prefix the heads emit (`EMOTION_HAPPY` → `HAPPY`). */
function bare(label: string): string {
  return label.replace(/^(EMOTION|INTENT|AGE|GENDER)_/, "");
}

function reading(
  label: unknown,
  probs: unknown,
  field: string,
  dropNeutral: boolean,
): Reading | undefined {
  const top = typeof label === "string" ? bare(label.trim().toUpperCase()) : "";
  const list = (probs as Record<string, unknown> | undefined)?.[field];
  const candidates = Array.isArray(list)
    ? list
        .map((e) => {
          const o = e as { token?: unknown; probability?: unknown };
          return {
            label: typeof o?.token === "string" ? bare(o.token.toUpperCase()) : "",
            probability: typeof o?.probability === "number" ? o.probability : 0,
          };
        })
        .filter((c) => c.label)
    : undefined;
  if (!top || (dropNeutral && NOT_A_READING.has(top))) return undefined;
  return {
    label: top,
    confidence: candidates?.find((c) => c.label === top)?.probability,
    candidates: candidates?.length ? candidates : undefined,
  };
}

/** Read a `{t:"user-metadata"}` payload, or `null` if that isn't what this is. */
export function parseUserMetadata(message: unknown): UserMetadata | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.t !== "user-metadata") return null;
  const emotion = reading(m.emotion, m.probs, "emotion", true);
  const intent = reading(m.intent, m.probs, "intent", false);
  // Nothing usable in it — don't wake a consumer up to hand them two undefineds.
  if (!emotion && !intent) return null;
  return { emotion, intent, raw: message };
}

/** Read a v1 live-signal envelope, or `null`. Legacy `kind:"signal"` without a `v` is
 *  a different schema and is deliberately not matched here. */
export function parseSignal(message: unknown): LiveSignal | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.kind !== "signal" || m.v !== 1 || typeof m.type !== "string") return null;
  return {
    type: m.type,
    subsystem: typeof m.subsystem === "string" ? m.subsystem : undefined,
    seq: typeof m.seq === "number" ? m.seq : undefined,
    tMs: typeof m.t_ms === "number" ? m.t_ms : undefined,
    predictionId: typeof m.prediction_id === "string" ? m.prediction_id : undefined,
    resolves: typeof m.resolves === "string" ? m.resolves : undefined,
    outcome: typeof m.outcome === "string" ? m.outcome : undefined,
    data: m.data,
    raw: message,
  };
}
