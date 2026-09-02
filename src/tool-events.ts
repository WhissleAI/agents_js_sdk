// The agent's tool calls, as the pipeline reports them.
//
// When an agent looks something up, books something, or sends something, the pipeline
// narrates it to the client on the `server-message` channel. Four phases, all with
// `kind: "tool"` (services/tool_events.py):
//
//   {kind:"tool", phase:"started",  tool_call_id, function_name, arguments, sound?}
//   {kind:"tool", phase:"progress", tool_call_id, function_name, display, data}
//   {kind:"tool", phase:"result",   tool_call_id, function_name, ok, result, evidence?, sound?, affordances?}
//   {kind:"tool", phase:"action",   tool_call_id, affordance_id, action_id, disposition, status, source}
//
// The last is not a tool running — it is a card's pending action being RESOLVED
// (approved or rejected), from whatever surface fired it. See `Affordance`.
//
// Until 0.5.0 this SDK forwarded all three untouched as `server-message` and did
// nothing with them, which had two consequences an embedder could not fix from outside:
// the earcon on `started` was never played (the embed was silent for the whole tool
// call), and there was no signal to hang a "looking that up…" affordance on. Both are
// the same underlying fact — the agent has gone quiet ON PURPOSE — and neither was
// reachable.
//
// The parsing is deliberately forgiving. These envelopes gain fields as the platform
// grows, and a widget that throws on an unknown one is worse than a widget that ignores
// it: the raw payload is kept on `.raw` so nothing is ever actually lost.

/** A tool call the agent has started. Payload of the `tool-started` event. */
export interface ToolStarted {
  /** Ties `tool-started` / `tool-progress` / `tool-finished` together. Two calls to
   *  the same tool can be in flight at once, so match on this, never on `name`. */
  id?: string;
  /** The tool's name, e.g. `"search_knowledge_base"`. */
  name?: string;
  /** What the model passed it. Shape is the tool's own. */
  arguments?: unknown;
  /** The earcon clip the platform chose for this tool, `"<category>_<n>"`. Already
   *  played by the SDK unless earcons are off — exposed so a page that wants its own
   *  sound design can read the category instead of re-deriving it. */
  sound?: string;
  /** The untouched envelope. */
  raw: unknown;
}

/** An interim update from inside a long-running tool. Payload of `tool-progress`. */
export interface ToolProgress {
  id?: string;
  name?: string;
  /** A human sentence, meant to be shown as-is ("Checking Tuesday…"). */
  display?: string;
  data?: unknown;
  raw: unknown;
}

/**
 * One actionable button on a tool-result card.
 *
 * A tool that DEFERS its side effect — the drafted email, the tentative booking —
 * parks it as a pending action and describes the choices on the card itself. Each
 * affordance is one of those choices. Fire it with `agent.fireAffordance(…)` (or
 * let the ready-made widget do it); the outcome comes back as the
 * `affordance-resolved` event, whichever surface fired it.
 *
 * A card with no `affordances` is exactly what it always was: render-only.
 */
export interface Affordance {
  /** Unique within the session, e.g. `"aff_…"`. What to pass as `affordanceId`. */
  id: string;
  /** Display text, written by the platform to be shown as-is ("Send email"). */
  label: string;
  /**
   * `"approve"` fires the pending action, `"reject"` discards it, `"choice"` is
   * pick-one — several `choice` affordances on a card, and tapping one approves
   * that variant.
   */
  kind: "approve" | "reject" | "choice";
  /** The pending actions-queue row this fires. What to pass as `actionId`. */
  actionId: string;
  /** At most one per card — the default target for a voice or gesture confirmation.
   *  Never set on a `reject`. */
  primary?: boolean;
  /** The untouched wire object. */
  raw: unknown;
}

/**
 * A card's pending action was resolved. Payload of the `affordance-resolved` event.
 *
 * This arrives on the live channel from ANY surface — a tap here, a spoken
 * confirmation, the operator's own inbox — which is why a card's buttons must be
 * driven by this event, not by the local tap handler alone.
 */
export interface AffordanceResolution {
  /** The tool call whose card this resolves — matches `ToolFinished.id`. */
  id?: string;
  /** Which affordance fired. */
  affordanceId?: string;
  /** The actions-queue row that was resolved. */
  actionId?: string;
  /** `"approve"` or `"reject"` — what happened to it. */
  disposition?: string;
  /** The queue row's status after the firing (e.g. `"approved"`, `"rejected"`). */
  status?: string;
  /** Which modality fired it: `"tap"`, `"voice"` or `"gesture"`. */
  source?: string;
  /**
   * Set by `fireAffordance` when the server answered 409: someone — or some other
   * surface — resolved this action first, and this is the standing state, not an
   * error. Render it exactly as if the resolution had been yours.
   */
  alreadyResolved?: boolean;
  /** The untouched envelope (or, from `fireAffordance`, the HTTP response body). */
  raw: unknown;
}

/** A tool that has come back. Payload of the `tool-finished` event. */
export interface ToolFinished {
  id?: string;
  name?: string;
  /** Whether the tool succeeded. `undefined` when the tool didn't say. */
  ok?: boolean;
  /** The structured card payload when the tool produced one, else what the model saw.
   *  Secrets (a keypad-entered PIN or CVV) are redacted server-side on both paths. */
  result?: unknown;
  /** Sources behind this result — the receipt for what the agent is about to claim.
   *  Present only when the tool produced citations. */
  evidence?: unknown[];
  /** Set only on FAILURE (`error_0`). Success gets no cue: the agent is about to say
   *  the answer, so a success chime on every call would turn the bank into wallpaper. */
  sound?: string;
  /** The card's actionable buttons, when the tool deferred its side effect into the
   *  pending-actions queue. Absent on a render-only card — which is every card that
   *  existed before these did. */
  affordances?: Affordance[];
  raw: unknown;
}

/**
 * What the agent is doing while it isn't talking. Payload of the `thinking` event.
 *
 * This is the signal behind the dashboard's "thinking strip" — the line that explains
 * a silence instead of leaving the caller to guess. It goes `active: true` when a tool
 * starts, carries the tool's own words when it reports progress, and goes
 * `active: false` when the last in-flight tool returns or the agent starts speaking.
 *
 * Track the boolean, not the individual tool events: a turn can fan out to several
 * tools at once, and this collapses them into the one thing the UI needs to know.
 */
export interface ThinkingState {
  active: boolean;
  /** The tool being waited on. With several in flight, the most recent to report. */
  tool?: string;
  /** A sentence to show, when the tool gave one. */
  label?: string;
}

/** A parsed tool envelope, or `null` if this message wasn't one. */
export type ToolEvent =
  | { phase: "started"; data: ToolStarted }
  | { phase: "progress"; data: ToolProgress }
  | { phase: "result"; data: ToolFinished }
  | { phase: "action"; data: AffordanceResolution };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

const AFFORDANCE_KINDS = ["approve", "reject", "choice"] as const;

/**
 * The card's buttons, read forgivingly — like everything else on this wire.
 *
 * An entry missing its `id`, `label` or `action_id` cannot be fired or named, so it
 * is skipped rather than rendered broken; so is a `kind` this build has never heard
 * of, because a button whose semantics we don't know must not be drawn as one we do.
 * `undefined` (never `[]`) when nothing renderable remains, so "has affordances" is
 * one truthiness check.
 */
function parseAffordances(raw: unknown): Affordance[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Affordance[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const id = str(a.id);
    const label = str(a.label);
    const actionId = str(a.action_id);
    const kind = AFFORDANCE_KINDS.find((k) => k === a.kind);
    if (!id || !label || !actionId || !kind) continue;
    out.push({ id, label, kind, actionId, ...(a.primary === true ? { primary: true } : {}), raw: item });
  }
  return out.length ? out : undefined;
}

/**
 * Read a `server-message` payload as a tool event.
 *
 * Returns `null` for anything that isn't one — including the SDK's own `simli-*`
 * frames and an integrator's application messages, which must keep flowing through
 * untouched.
 */
export function parseToolEvent(message: unknown): ToolEvent | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.kind !== "tool") return null;
  const id = str(m.tool_call_id);
  const name = str(m.function_name);
  switch (m.phase) {
    case "started":
      return {
        phase: "started",
        data: { id, name, arguments: m.arguments, sound: str(m.sound), raw: message },
      };
    case "progress":
      return {
        phase: "progress",
        data: { id, name, display: str(m.display), data: m.data, raw: message },
      };
    case "result":
      return {
        phase: "result",
        data: {
          id,
          name,
          ok: typeof m.ok === "boolean" ? m.ok : undefined,
          result: m.result,
          evidence: Array.isArray(m.evidence) ? m.evidence : undefined,
          sound: str(m.sound),
          affordances: parseAffordances(m.affordances),
          raw: message,
        },
      };
    case "action":
      return {
        phase: "action",
        data: {
          id,
          affordanceId: str(m.affordance_id),
          actionId: str(m.action_id),
          disposition: str(m.disposition),
          status: str(m.status),
          source: str(m.source),
          raw: message,
        },
      };
    default:
      return null;
  }
}

/**
 * Counts the tools in flight so `thinking` can be one boolean rather than a race.
 *
 * Correctness here is entirely about the edges. A turn that fires three tools must
 * produce ONE `thinking:true` and ONE `thinking:false`, not three of each — and a tool
 * whose result never arrives (a timeout the pipeline swallows, a session that drops
 * mid-call) must not pin the strip on forever, which is why `clear()` exists and why
 * the agent calls it when the bot starts speaking.
 */
export class ThinkingTracker {
  private open = new Map<string, string | undefined>();
  private anonymous = 0;
  private label: string | undefined;
  private active = false;

  /** A tool started. Returns the new state if it changed, else `null`. */
  start(e: ToolStarted): ThinkingState | null {
    if (e.id) this.open.set(e.id, e.name);
    else this.anonymous++;
    this.label = undefined;
    return this.settle(e.name);
  }

  /** A tool reported progress. Always a change — the label is new information. */
  progress(e: ToolProgress): ThinkingState | null {
    if (!this.active) return null;
    this.label = e.display;
    return { active: true, tool: e.name, label: e.display };
  }

  /** A tool came back. Returns the new state if it changed, else `null`. */
  finish(e: ToolFinished): ThinkingState | null {
    if (e.id && this.open.has(e.id)) this.open.delete(e.id);
    else if (this.anonymous > 0) this.anonymous--;
    return this.settle(e.name);
  }

  /**
   * Everything in flight is over, whatever the pipeline said.
   *
   * The bot starting to speak is the ground truth that the wait is done — it beats any
   * bookkeeping, because a result frame can be dropped but audio cannot be faked.
   */
  clear(): ThinkingState | null {
    this.open.clear();
    this.anonymous = 0;
    this.label = undefined;
    return this.settle(undefined);
  }

  private settle(tool: string | undefined): ThinkingState | null {
    const active = this.open.size + this.anonymous > 0;
    if (active === this.active) return null;
    this.active = active;
    return active ? { active: true, tool, label: this.label } : { active: false };
  }
}
