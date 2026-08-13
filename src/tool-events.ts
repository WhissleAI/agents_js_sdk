// The agent's tool calls, as the pipeline reports them.
//
// When an agent looks something up, books something, or sends something, the pipeline
// narrates it to the client on the `server-message` channel. Three phases, all with
// `kind: "tool"` (services/tool_events.py):
//
//   {kind:"tool", phase:"started",  tool_call_id, function_name, arguments, sound?}
//   {kind:"tool", phase:"progress", tool_call_id, function_name, display, data}
//   {kind:"tool", phase:"result",   tool_call_id, function_name, ok, result, evidence?, sound?}
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
  | { phase: "result"; data: ToolFinished };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
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
