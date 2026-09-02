import { normalizeAvatar } from "./avatar";
import type { Affordance, AffordanceResolution, ToolFinished } from "./tool-events";
import {
  WhissleAgent,
  type FireAffordanceOptions,
  type WhissleAgentOptions,
} from "./WhissleAgent";

export interface WidgetOptions extends WhissleAgentOptions {
  /** Header label shown above the widget. */
  title?: string;
  /** Accent color (CSS color). Defaults to Whissle green. */
  accent?: string;
  /**
   * Show a message box, so a visitor can type instead of talking.
   *
   * Typing works with no call up at all (a visitor who denies the mic still gets the
   * agent), and during a call it goes into the same conversation — spell an email
   * rather than repeating it four times.
   *
   *   `false`      voice only, always. The box is never rendered.
   *   `true`       always shown, whatever the agent says.
   *   *unset*      shown, and REMOVED as soon as the agent turns out not to support
   *                text — either the session mint says `text_enabled: false`, or a
   *                send comes back 404.
   *
   * The default is optimistic on purpose. `mount()` has no session yet — learning
   * whether text is enabled costs a mint, and minting on page load would spend a
   * metered token against the rate limit for a conversation most visitors never
   * start. Hiding the box until a call succeeds would also be backwards: the visitor
   * this exists for is the one who just refused the microphone. So it is offered, and
   * withdrawn at the first authoritative answer rather than left to 404 on every send.
   */
  text?: boolean;
}

const CSS = `
.wa-w{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;flex-direction:column;
 height:100%;min-height:320px;border:1px solid #e3e8e4;border-radius:16px;overflow:hidden;background:#fff;color:#14201a}
.wa-hd{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #eef2ec;font-size:14px;font-weight:600}
.wa-dot{width:8px;height:8px;border-radius:50%;background:#c4cfbe}
.wa-dot.on{background:var(--wa-accent)}
/* The session-ceiling countdown. Empty (and so invisible) unless the mint said this
   session is bounded; tabular digits so it doesn't wobble as it counts. */
.wa-timer{margin-left:auto;font-size:12px;font-weight:500;color:#6b7a70;font-variant-numeric:tabular-nums}
.wa-face{position:relative;width:100%;aspect-ratio:1/1;max-height:52%;background:#0d1310;overflow:hidden;flex:0 0 auto}
.wa-face video{width:100%;height:100%;object-fit:cover;display:block}
.wa-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;font-size:14px;line-height:1.45}
.wa-msg{max-width:85%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
.wa-user{align-self:flex-end;background:var(--wa-accent);color:#fff;border-bottom-right-radius:4px}
.wa-agent{align-self:flex-start;background:#f1f4ef;border-bottom-left-radius:4px}
.wa-ft{padding:12px 14px;border-top:1px solid #eef2ec;display:flex;gap:8px;align-items:center}
.wa-btn{flex:1;border:0;border-radius:12px;padding:11px 14px;font-size:14px;font-weight:600;cursor:pointer;
 background:var(--wa-accent);color:#fff;transition:opacity .15s}
.wa-btn:disabled{opacity:.5;cursor:default}
.wa-btn.end{background:#e5433f}
.wa-icon{border:1px solid #e3e8e4;background:#fff;border-radius:12px;padding:11px;cursor:pointer;color:#46564c}
.wa-hint{color:#6b7a70;font-size:12px;text-align:center;margin:auto 0}
.wa-err{color:#c0392b;font-size:12px;padding:0 14px 8px}
/* The thinking strip. A tool call is silence with a reason, and this is the reason.
   Reserves no height when idle, so nothing jumps when it appears. */
.wa-think{display:none;align-items:center;gap:8px;padding:6px 14px;font-size:12px;color:#6b7a70;
 border-top:1px solid #eef2ec}
.wa-think.on{display:flex}
.wa-think::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--wa-accent);
 animation:wa-pulse 1.1s ease-in-out infinite;flex:0 0 auto}
@keyframes wa-pulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
@media(prefers-reduced-motion:reduce){.wa-think::before{animation:none;opacity:.8}}
.wa-say{flex:1;min-width:0;border:1px solid #e3e8e4;border-radius:12px;padding:10px 12px;font:inherit;
 font-size:14px;background:#fff;color:inherit}
.wa-say:focus{outline:2px solid var(--wa-accent);outline-offset:-1px}
/* A tool card with pending actions — the same bubble an agent line gets, plus a
   button row. Approve is filled with the accent, reject stays quiet: the visitor
   should be able to find "yes" without reading. */
.wa-card{align-self:flex-start;max-width:85%;background:#f1f4ef;border-radius:12px;
 border-bottom-left-radius:4px;padding:8px 11px;font-size:14px;line-height:1.45}
.wa-card-t{white-space:pre-wrap;word-break:break-word}
.wa-acts{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.wa-act{border:1px solid #d6ded5;background:#fff;color:#14201a;border-radius:10px;
 padding:7px 12px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}
.wa-act.fill{background:var(--wa-accent);border-color:var(--wa-accent);color:#fff}
.wa-act:disabled{opacity:.5;cursor:default}
.wa-resolved{display:block;margin-top:8px;font-size:12px;color:#6b7a70}
@media(prefers-color-scheme:dark){.wa-w{background:#151e19;border-color:#26302a;color:#eaf1ea}
 .wa-hd,.wa-ft,.wa-think{border-color:#26302a}.wa-agent{background:#1b241f}
 .wa-icon,.wa-say{background:#151e19;border-color:#26302a;color:#a7b5ab}
 .wa-card{background:#1b241f}.wa-act{background:#151e19;border-color:#26302a;color:#a7b5ab}
 .wa-act.fill{background:var(--wa-accent);border-color:var(--wa-accent);color:#fff}}
`;

/** Render a ready-made voice widget into `target`. Returns the WhissleAgent so
 *  you can also subscribe to events. Zero dependencies beyond the SDK. */
export function mount(target: string | HTMLElement, options: WidgetOptions): WhissleAgent {
  const root =
    typeof target === "string" ? (document.querySelector(target) as HTMLElement) : target;
  if (!root) throw new Error(`Whissle widget: target "${String(target)}" not found`);

  const accent = options.accent || "#1c7a5e";
  if (!document.getElementById("wa-style")) {
    const s = document.createElement("style");
    s.id = "wa-style";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // A widget with an avatar gets a stage for the face; the SDK renders its
  // <video> into it (see `avatar.container` below) so the caller places nothing.
  const wantsAvatar = Boolean(options.avatar);

  root.innerHTML = `
    <div class="wa-w" style="--wa-accent:${accent}">
      <div class="wa-hd"><span class="wa-dot" data-dot></span><span data-title>${options.title || "Talk to the assistant"}</span><span class="wa-timer" data-timer role="timer"></span></div>
      ${wantsAvatar ? '<div class="wa-face" data-face></div>' : ""}
      <div class="wa-log" data-log><div class="wa-hint" data-hint>Tap Start and allow your microphone to begin.</div></div>
      <div class="wa-err" data-err style="display:none" role="alert"></div>
      <div class="wa-think" data-think aria-live="polite"><span data-think-text></span></div>
      <div class="wa-ft">
        <button class="wa-btn" data-start>Start</button>
      </div>
      <div class="wa-ft" data-say-row style="display:none">
        <input class="wa-say" data-say placeholder="Or type a message…" aria-label="Message" />
        <button class="wa-icon" data-send aria-label="Send">Send</button>
      </div>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const dot = $(".wa-dot");
  const log = $<HTMLDivElement>("[data-log]");
  const hint = $<HTMLDivElement>("[data-hint]");
  const err = $<HTMLDivElement>("[data-err]");
  const startBtn = $<HTMLButtonElement>("[data-start]");
  const think = $<HTMLDivElement>("[data-think]");
  const thinkText = $<HTMLSpanElement>("[data-think-text]");
  const sayRow = $<HTMLDivElement>("[data-say-row]");
  const say = $<HTMLInputElement>("[data-say]");
  const sendBtn = $<HTMLButtonElement>("[data-send]");
  const timer = $<HTMLSpanElement>("[data-timer]");

  // Point the avatar at the stage we just rendered, unless the caller named
  // their own container — their layout wins over ours.
  const face = wantsAvatar ? $<HTMLDivElement>("[data-face]") : null;
  const avatar = normalizeAvatar(options.avatar);
  const agent = new WhissleAgent(
    face && avatar ? { ...options, avatar: { ...avatar, container: avatar.container ?? face } } : options,
  );

  const addLine = (who: "user" | "agent", text: string) => {
    hint?.remove();
    const el = document.createElement("div");
    el.className = `wa-msg wa-${who}`;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  };

  // ── actionable cards ─────────────────────────────────────────────────────────
  //
  // A tool that deferred its side effect ships the choices on its result card
  // (`ToolFinished.affordances`); the widget renders them as buttons and fires the
  // tapped one. The buttons are DISABLED the moment one is tapped and swapped for a
  // resolved line on `affordance-resolved` — which arrives whatever surface did the
  // resolving, this widget included, because `fireAffordance` emits it too. A race
  // (two tabs, a spoken "send it" mid-tap) is safe by construction: the server takes
  // the first write and answers the rest 409 with the standing state, which
  // `fireAffordance` resolves — never rejects — so the card renders the outcome
  // instead of an error.
  const cardRows: Array<{ row: AffordanceRow; paint: () => void }> = [];
  agent
    .on("tool-finished", (payload) => {
      const card = payload as ToolFinished;
      if (!card.affordances?.length) return;
      hint?.remove();
      const row = new AffordanceRow(card.affordances);
      const el = document.createElement("div");
      el.className = "wa-card";
      const title = document.createElement("div");
      title.className = "wa-card-t";
      title.textContent = cardTitle(card);
      el.appendChild(title);
      const acts = document.createElement("div");
      acts.className = "wa-acts";
      el.appendChild(acts);
      const paint = () => {
        acts.textContent = "";
        const v = row.view;
        if (v.state === "resolved") {
          const line = document.createElement("span");
          line.className = "wa-resolved";
          line.textContent = v.line;
          acts.appendChild(line);
          return;
        }
        for (const b of v.buttons) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = b.filled ? "wa-act fill" : "wa-act";
          btn.textContent = b.label;
          btn.disabled = v.disabled;
          btn.addEventListener("click", () => {
            const fire = row.tap(b.id);
            if (!fire) return;
            paint(); // disabled immediately — a double-tap must not fire twice
            agent.fireAffordance(fire).catch(() => {
              // The firing never landed (network, channel timeout). Re-arm the
              // buttons — unless a resolution arrived meanwhile, which `fail()`
              // respects. The error bar above is already showing the sentence.
              row.fail();
              paint();
            });
          });
          acts.appendChild(btn);
        }
      };
      paint();
      cardRows.push({ row, paint });
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    })
    .on("affordance-resolved", (payload) => {
      const r = payload as AffordanceResolution;
      for (const c of cardRows) {
        if (c.row.resolve(r)) {
          c.paint();
          break;
        }
      }
    });

  // ── the session ceiling ──────────────────────────────────────────────────────
  //
  // The mint SAYS whether this session is bounded (`session.limits` — derived from
  // the same rule the pipeline arms its own timer from), so the widget can draw a
  // countdown and explain the end instead of appearing to freeze mid-sentence at
  // exactly the cap. The `demo-limit` event — the SDK's surfacing of the envelope
  // the pipeline sends just before it hangs up — is the authoritative end; the
  // local clock is the backstop for that envelope never arriving.
  let countdown: ReturnType<typeof setInterval> | null = null;
  let capExplained = false;
  const clearCountdown = () => {
    if (countdown) clearInterval(countdown);
    countdown = null;
    timer.textContent = "";
  };
  const explainEnd = () => {
    if (capExplained) return;
    capExplained = true;
    clearCountdown();
    hint?.remove();
    const note = document.createElement("div");
    note.className = "wa-hint";
    note.textContent = sessionEnded(agent.session?.limits?.reason);
    log.appendChild(note);
    log.scrollTop = log.scrollHeight;
  };
  const startCountdown = () => {
    clearCountdown();
    capExplained = false;
    const cap = agent.session?.limits?.max_session_seconds;
    // `null`/absent means nothing caps this session — most customer embeds. No
    // timer then: a clock on an unbounded call would be counting down to nothing.
    if (typeof cap !== "number" || !(cap > 0)) return;
    const endsAt = Date.now() + cap * 1000;
    const tick = () => {
      const left = Math.ceil((endsAt - Date.now()) / 1000);
      timer.textContent = formatRemaining(left);
      if (left <= 0) explainEnd(); // backstop — the server ends the session itself
    };
    tick();
    countdown = setInterval(tick, 500);
  };

  agent
    .on("connecting", () => {
      startBtn.textContent = "Connecting…";
      startBtn.disabled = true;
    })
    .on("connected", () => {
      dot.classList.add("on");
      startBtn.textContent = "End";
      startBtn.classList.add("end");
      startBtn.disabled = false;
      startCountdown();
    })
    .on("disconnected", () => {
      dot.classList.remove("on");
      startBtn.textContent = "Start";
      startBtn.classList.remove("end");
      startBtn.disabled = false;
      clearCountdown();
    })
    .on("demo-limit", () => explainEnd())
    .on("avatar-failed", () => {
      // The conversation is still coming up, audio-only — so take the empty
      // stage away rather than leaving a black rectangle and no explanation.
      if (face) face.remove();
    })
    .on("user-transcript", (t) => addLine("user", String(t)))
    .on("agent-transcript", (t) => addLine("agent", String(t)))
    // Why the agent has gone quiet. The tool cue is the audible half of this signal
    // and the SDK plays it; this is the half you can read. Without either, a tool call
    // is several seconds of nothing, which every visitor reads as a hang.
    .on("thinking", (state) => {
      const s = state as { active: boolean; tool?: string; label?: string };
      think.classList.toggle("on", s.active);
      thinkText.textContent = s.active ? s.label || working(s.tool) : "";
    })
    .on("error", (m) => {
      err.style.display = "block";
      err.textContent = String(m);
      startBtn.disabled = false;
      startBtn.textContent = "Start";
      startBtn.classList.remove("end");
    });

  startBtn.addEventListener("click", () => {
    err.style.display = "none";
    if (agent.state === "connected") agent.stop();
    else void agent.start();
  });

  // ── typing ───────────────────────────────────────────────────────────────────
  //
  // Shown unless the caller said no. Deliberately available BEFORE any call: the
  // visitor who won't grant a microphone is the one this is for, and hiding the box
  // until they succeed at the thing they refused to do would be exactly backwards.
  if (options.text !== false) {
    sayRow.style.display = "flex";

    /**
     * Take the box away once we KNOW this agent has no text channel.
     *
     * Only when the caller left the choice to us (`text` unset): someone who wrote
     * `text: true` asked for the box and gets to keep it, even against an agent that
     * will refuse — that is a configuration mistake they should be able to see.
     */
    const withdraw = (why: string) => {
      if (options.text === true) return;
      sayRow.remove();
      err.style.display = "none";
      hint?.remove();
      const note = document.createElement("div");
      note.className = "wa-hint";
      note.textContent = why;
      log.appendChild(note);
    };
    // The mint is the authoritative answer and `start()` is when we get one.
    const checkSession = () => {
      if (agent.session && agent.session.text_enabled === false) {
        withdraw("This assistant is voice only.");
      }
    };
    agent.on("connected", checkSession).on("bot-ready", checkSession);

    const send = async () => {
      const text = say.value.trim();
      if (!text) return;
      say.value = "";
      addLine("user", text);
      sendBtn.disabled = true;
      try {
        await agent.sendText(text);
      } catch (e) {
        // `sendText` already emitted a described `error`; the bar above is showing it.
        // Give the message back rather than swallowing what they typed.
        say.value = text;
        // …unless the answer was "this agent has no text channel", which is not a
        // transient failure and will be the answer to every future message too.
        if ((e as { code?: number })?.code === 404) {
          say.value = "";
          withdraw("This assistant is voice only — tap Start to talk to it.");
        }
      } finally {
        sendBtn.disabled = false;
        say.focus();
      }
    };
    sendBtn.addEventListener("click", () => void send());
    say.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void send();
    });
    checkSession();
  }

  return agent;
}

/**
 * Verbs whose `-ing` needs the stress pattern of the word, which no rule below can
 * see. English doubles the final consonant when the last syllable is stressed —
 * transFER → transferring — and does not when it isn't — REGister → registering. Both
 * end in the same three letters, so a rule that gets `transfer` right gets `register`,
 * `offer`, `edit` and `visit` wrong, which is a worse trade in this vocabulary.
 *
 * So: the handful that actually occur as tool names are listed, and everything else
 * takes the rules that are safe. Short and boring beats clever and wrong on a line the
 * visitor reads.
 */
const IRREGULAR: Record<string, string> = {
  transfer: "transferring",
  submit: "submitting",
  cancel: "cancelling",
  refer: "referring",
  begin: "beginning",
  forget: "forgetting",
};

/** "search_knowledge_base" → "Searching knowledge base…" — a present-progressive line
 *  for a tool nobody wrote copy for. The platform invents tools at runtime, so this has
 *  to be total; "Working…" is the honest answer when the name says nothing. */
function working(tool?: string): string {
  const words = (tool ?? "").replace(/[_-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const verb = words[0]?.toLowerCase() ?? "";
  if (!verb) return "Working…";
  const rest = words.slice(1).join(" ");
  const ing =
    IRREGULAR[verb] ??
    // A trailing silent `e` goes (schedule → scheduling, issue → issuing). Guarded
    // against `ee`, which is not silent — `see` becomes `seeing`, not `seing`.
    (/[^e]e$/.test(verb)
      ? `${verb.slice(0, -1)}ing`
      : // One vowel group means one syllable, and a one-syllable stem is always
        // stressed — which is the whole condition for doubling. Counting syllables
        // rather than letters is what tells `set` (setting) from `edit` (editing);
        // both are short and both end consonant-vowel-consonant.
        (verb.match(/[aeiouy]+/g) ?? []).length === 1 &&
          /[^aeiou][aeiou][^aeiouwxy]$/.test(verb)
        ? `${verb}${verb.slice(-1)}ing`
        : `${verb}ing`);
  return `${ing.charAt(0).toUpperCase()}${ing.slice(1)}${rest ? ` ${rest}` : ""}…`;
}

/** What one of a card's buttons should look like. */
export interface AffordanceButtonView {
  id: string;
  label: string;
  /** Filled with the accent (an approve, or a `choice` marked primary); everything
   *  else — every reject — stays quiet, so "yes" is findable without reading. */
  filled: boolean;
}

/** What the card's action row should render right now. */
export type AffordanceRowView =
  | { state: "open" | "fired"; buttons: AffordanceButtonView[]; disabled: boolean }
  | { state: "resolved"; line: string };

/**
 * The state machine behind a card's buttons, kept apart from the DOM so it can be
 * tested where the DOM cannot be (the suite runs in Node).
 *
 * The rules it pins are exactly the contract's integrity rules, seen from a screen:
 * a tap disables the row immediately (an affordance fires ONCE, so a double-tap
 * must not fire twice); a resolution from ANY surface ends the row for good (`fail`
 * cannot re-open it); and the first resolution wins (a second is reported
 * unchanged, so a mirrored 409 arriving after the event repaints nothing).
 */
export class AffordanceRow {
  private fired = false;
  private line: string | null = null;

  constructor(private readonly affordances: Affordance[]) {}

  get view(): AffordanceRowView {
    if (this.line !== null) return { state: "resolved", line: this.line };
    return {
      state: this.fired ? "fired" : "open",
      disabled: this.fired,
      buttons: this.affordances.map((a) => ({
        id: a.id,
        label: a.label,
        filled: a.kind === "approve" || (a.kind === "choice" && a.primary === true),
      })),
    };
  }

  /** A tap. Returns what to fire — or `null` when the row is already spent, which is
   *  the double-tap and the tap-after-resolution both answered in one place. */
  tap(id: string): FireAffordanceOptions | null {
    if (this.fired || this.line !== null) return null;
    const a = this.affordances.find((x) => x.id === id);
    if (!a) return null;
    this.fired = true;
    return {
      actionId: a.actionId,
      affordanceId: a.id,
      disposition: a.kind === "reject" ? "reject" : "approve",
      source: "tap",
    };
  }

  /** The firing never landed. Re-arm — unless a resolution arrived meanwhile, in
   *  which case the row stays resolved: the outcome outranks our delivery failure. */
  fail(): void {
    if (this.line === null) this.fired = false;
  }

  /** A resolution from any surface. `true` when it was this card's and changed it. */
  resolve(r: AffordanceResolution): boolean {
    if (this.line !== null) return false;
    const mine = this.affordances.some(
      (a) => a.id === r.affordanceId || a.actionId === r.actionId,
    );
    if (!mine) return false;
    this.line = resolvedLine(r.disposition);
    return true;
  }
}

/** The resolved state, as one line. Total over dispositions this build has never
 *  heard of — an unknown one must land on honest copy, never on `undefined`. */
function resolvedLine(disposition?: string): string {
  if (disposition === "reject") return "Discarded";
  if (disposition === "approve") return "Approved · sent";
  return "Resolved";
}

/** The line above a card's buttons: the card's own display sentence when the tool
 *  wrote one, else a readable version of the tool's name. Total, like `working` —
 *  the platform invents tools at runtime and nobody wrote copy for this one. */
function cardTitle(card: ToolFinished): string {
  const display = (card.result as { _display?: unknown } | undefined)?._display;
  if (typeof display === "string" && display.trim()) return display;
  const words = (card.name ?? "").replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "The agent prepared an action.";
}

/** `125` → `"2:05"`. Floors at zero rather than ever counting negative — a clock
 *  that reads "-0:03" says the widget lost track, which is worse than "0:00". */
function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The end-card line, by the `limits.reason` the mint gave. Total over unknown
 *  reasons — a future rule set must land on honest copy, not `undefined`. */
function sessionEnded(reason?: string | null): string {
  return reason === "demo"
    ? "That's the end of the free demo — thanks for trying it."
    : "This session reached its time limit.";
}

/** Exported for tests — the copy rules and the card state machine are worth pinning,
 *  the DOM around them isn't. */
export const WIDGET_INTERNALS = {
  working,
  formatRemaining,
  sessionEnded,
  resolvedLine,
  cardTitle,
  AffordanceRow,
};
