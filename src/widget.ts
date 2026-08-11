import { normalizeAvatar } from "./avatar";
import { WhissleAgent, type WhissleAgentOptions } from "./WhissleAgent";

export interface WidgetOptions extends WhissleAgentOptions {
  /** Header label shown above the widget. */
  title?: string;
  /** Accent color (CSS color). Defaults to Whissle green. */
  accent?: string;
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
@media(prefers-color-scheme:dark){.wa-w{background:#151e19;border-color:#26302a;color:#eaf1ea}
 .wa-hd,.wa-ft{border-color:#26302a}.wa-agent{background:#1b241f}.wa-icon{background:#151e19;border-color:#26302a;color:#a7b5ab}}
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
      <div class="wa-err" data-err style="display:none"></div>
      <div class="wa-ft">
        <button class="wa-btn" data-start>Start</button>
      </div>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const dot = $(".wa-dot");
  const log = $<HTMLDivElement>("[data-log]");
  const hint = $<HTMLDivElement>("[data-hint]");
  const err = $<HTMLDivElement>("[data-err]");
  const startBtn = $<HTMLButtonElement>("[data-start]");

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

  return agent;
}
