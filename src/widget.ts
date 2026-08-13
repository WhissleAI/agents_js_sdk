import { normalizeAvatar } from "./avatar";
import { WhissleAgent, type WhissleAgentOptions } from "./WhissleAgent";

export interface WidgetOptions extends WhissleAgentOptions {
  /** Header label shown above the widget. */
  title?: string;
  /** Accent color (CSS color). Defaults to Whissle green. */
  accent?: string;
  /**
   * Show a message box, so a visitor can type instead of talking.
   *
   * Default: on when the agent's session says `text_enabled`. Typing works with no
   * call up at all (a visitor who denies the mic still gets the agent), and during a
   * call it goes into the same conversation — spell an email rather than repeating it
   * four times. Set `false` to force voice only.
   */
  text?: boolean;
}

const CSS = `
.wa-w{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;flex-direction:column;
 height:100%;min-height:320px;border:1px solid #e3e8e4;border-radius:16px;overflow:hidden;background:#fff;color:#14201a}
.wa-hd{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #eef2ec;font-size:14px;font-weight:600}
.wa-dot{width:8px;height:8px;border-radius:50%;background:#c4cfbe}
.wa-dot.on{background:var(--wa-accent)}
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
@media(prefers-color-scheme:dark){.wa-w{background:#151e19;border-color:#26302a;color:#eaf1ea}
 .wa-hd,.wa-ft,.wa-think{border-color:#26302a}.wa-agent{background:#1b241f}
 .wa-icon,.wa-say{background:#151e19;border-color:#26302a;color:#a7b5ab}}
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
      <div class="wa-hd"><span class="wa-dot" data-dot></span><span data-title>${options.title || "Talk to the assistant"}</span></div>
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
    })
    .on("disconnected", () => {
      dot.classList.remove("on");
      startBtn.textContent = "Start";
      startBtn.classList.remove("end");
      startBtn.disabled = false;
    })
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
    const send = async () => {
      const text = say.value.trim();
      if (!text) return;
      say.value = "";
      addLine("user", text);
      sendBtn.disabled = true;
      try {
        await agent.sendText(text);
      } catch {
        // `sendText` already emitted a described `error`; the bar above is showing it.
        // Give the message back rather than swallowing what they typed.
        say.value = text;
      } finally {
        sendBtn.disabled = false;
        say.focus();
      }
    };
    sendBtn.addEventListener("click", () => void send());
    say.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void send();
    });
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

/** Exported for tests — the copy rule is worth pinning, the DOM around it isn't. */
export const WIDGET_INTERNALS = { working };
