/* ─────────────────────────────────────────────────────────────────────────────
   The Signal Console.

   One rule holds this file together: **everything renders from one event stream**.
   A live session pushes SDK events into `emit()`; a replay pushes recorded events
   into the same `emit()` at their recorded offsets. Nothing downstream can tell the
   difference, which is why a replay is a faithful re-shoot rather than an animation
   of a summary.

       SDK events ─┐
                   ├─► emit(type, payload, t) ─► record ─► apply() ─► panels + timeline
       recording ──┘                         └─► /api/log (terminal + .log file)

   The second rule is honesty, and it costs code:
     · A missing emotion reading is rendered as missing. The platform writes NEUTRAL
       both for a calm speaker and for a head that never ran, so a top label of
       NEUTRAL is never presented as a reading — but the DISTRIBUTION behind it is
       shown, because that is the honest output and it is not blank.
     · The acoustic card always says which of the two it is: no frames arrived, or
       frames arrived and carried no confident emotion. An empty box says neither.
     · Every latency is measured with this browser's clock at the moment the event
       reached this page, and is labelled as such.
   ──────────────────────────────────────────────────────────────────────────── */

import { WhissleAgent } from "@whissle/agents";
import { installRehearsal } from "./rehearsal.js";
import { installMicTap, describe as describeMicError } from "./mic.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const clip = (s, n = 220) => (String(s).length > n ? String(s).slice(0, n) + "…" : String(s));
const ms = (v) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const bare = (l) => String(l ?? "").replace(/^(EMOTION|INTENT|AGE|GENDER)_/, "");

const C = {
  you: "#6fa3db", agent: "#4fb89e", tools: "#45bec5", pred: "#efc463",
  signal: "#c088a6", live: "#f14e52", muted: "#adafb4", faint: "#6b6060",
  ink: "#f1f0f0", grid: "rgba(73,65,65,.65)", think: "#adafb4",
};

/* ── model ───────────────────────────────────────────────────────────────── */
let M;
function blankModel() {
  return {
    startedAt: null, now: 0, state: "not started", transport: null, sessionId: null, ended: false,
    interims: [], turns: [],
    speaking: false, words: [], partial: "", replies: [], gist: null,
    thinking: { active: false, label: null },
    tools: new Map(), toolOrder: [],
    preds: new Map(), signals: [], roster: null, seen: new Set(),
    // the acoustic read: frames counted whether or not they carry a confident label
    read: { frames: 0, lastAt: null, emotion: null, intent: null, extra: null, source: null },
    reads: [],
    spans: [], marks: [], open: {},
    metric: { asr: [], firstWord: [], think: [], tool: [], barge: [] },
    lastInterimAt: null, lastFinalAt: null, awaitFirstWord: false, awaitThink: false, bargeAt: null,
    errors: [], eventCount: 0,
  };
}

let rec = [];
let recMeta = {};
let mode = "idle";

function safe(p) {
  if (p === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(p, (k, v) => (v instanceof Node || v instanceof MediaStream ? undefined : v)));
  } catch {
    return null;
  }
}

let t0 = 0;
let replay = null;
const nowMs = () =>
  mode === "replay" ? (replay ? replay.clock : 0) : mode === "live" ? performance.now() - t0 : M.now;

/* ── the one door every event goes through ───────────────────────────────── */
function emit(type, payload, tOverride) {
  const t = tOverride != null ? tOverride : nowMs();
  const p = safe(payload);
  if (mode === "live") {
    rec.push({ t: Math.round(t), type, p });
    queueLog(t, type, p);
  }
  M.now = t;
  M.eventCount++;
  streamRow(t, type, p);
  try {
    apply(type, payload, t);
  } catch (err) {
    console.error("apply", type, err);
  }
  dirty = true;
}

/* ═══ the reducer ═════════════════════════════════════════════════════════ */
function apply(type, p, t) {
  switch (type) {
    case "session":
      M.startedAt = p?.startedAt ?? new Date().toISOString();
      M.transport = p?.transport ?? null;
      M.sessionId = p?.sessionId ?? null;
      setTransport();
      break;
    case "connecting": setState("connecting"); break;
    case "connected":  setState("connected"); break;
    case "bot-ready":  setState("listening"); mark("agent", t, C.agent, "bot ready"); break;
    case "disconnected":
      setState("ended"); M.ended = true;
      closeSpan("you", t); closeSpan("agent", t); closeSpan("think", t);
      break;

    case "listening-started":
      openSpan("you", t, C.you, "speech");
      if (M.speaking) { M.bargeAt = t; mark("barge", t, C.live, "barge-in"); $("caption").classList.add("barge"); }
      renderLive();
      break;
    case "listening-stopped":
      closeSpan("you", t);
      $("caption").classList.remove("barge");
      renderLive();
      break;
    case "user-interim":
      M.interims.push({ t, text: p, read: snapshotRead() });
      M.lastInterimAt = t;
      mark("you", t, C.you, "interim");
      renderLive();
      break;
    case "user-transcript": finaliseTurn(p, t); break;

    case "speaking-started":
      M.speaking = true; M.words = []; M.partial = "";
      openSpan("agent", t, C.agent, "speaking");
      setState("agent speaking"); renderAgentState();
      break;
    case "speaking-stopped":
      M.speaking = false; closeSpan("agent", t);
      if (M.bargeAt != null) { M.metric.barge.push(t - M.bargeAt); M.bargeAt = null; }
      setState(M.ended ? "ended" : "listening");
      $("caption").textContent = "";
      renderAgentState(); renderStats();
      break;
    case "agent-word":
      if (M.awaitFirstWord && M.lastFinalAt != null) {
        M.metric.firstWord.push(t - M.lastFinalAt);
        M.awaitFirstWord = false;
        mark("agent", t, C.agent, "first word");
        renderStats();
      }
      M.words.push(p); renderCaption();
      break;
    case "agent-partial": M.partial = p; renderReply(); break;
    case "agent-transcript": M.replies.push({ t, text: p }); M.partial = ""; renderReply(true); break;
    case "gist": M.gist = p; $("gist").hidden = false; $("gist").textContent = p; break;

    case "thinking":
      M.thinking = { active: !!p?.active, label: p?.label ?? null, tool: p?.tool ?? null };
      if (p?.active) {
        openSpan("think", t, C.think, p?.tool ?? "thinking");
        if (M.awaitThink && M.lastFinalAt != null) {
          M.metric.think.push(t - M.lastFinalAt); M.awaitThink = false; renderStats();
        }
      } else closeSpan("think", t);
      renderAgentState();
      break;

    case "tool-started":  toolStarted(p, t); break;
    case "tool-progress": toolProgress(p, t); break;
    case "tool-finished": toolFinished(p, t); break;

    case "signal":        onSignal(p, t); break;
    case "user-metadata": onMetadata(p, t); break;

    case "error":
      M.errors.push({ t, message: p?.message, code: p?.code });
      $("footErr").textContent = `${p?.code ? `[${p.code}] ` : ""}${p?.message ?? ""}`;
      if (p?.code === "microphone") micProblem(p.message);
      mark("agent", t, C.live, `error: ${p?.code ?? ""}`);
      break;
    case "demo-limit": $("footErr").textContent = "Demo cap reached — the platform ended this session."; break;
    case "mic-lost": micProblem("The microphone stopped producing audio mid-session (unplugged, or another app took it)."); break;
    case "mic-restored": $("micWarn").hidden = true; $("footErr").textContent = ""; break;
    case "server-message": break;   // shown raw in the event stream; nothing typed to draw
  }
}

/* ── the caller's words ──────────────────────────────────────────────────── */

let liveEl = null;
let lastInterimPaint = 0;

function renderLive() {
  const body = $("youBody");
  if (!liveEl) {
    liveEl = el("div", "live-turn");
    liveEl.innerHTML = `<div class="interims"></div>`;
    body.querySelector(".empty")?.remove();
    body.appendChild(liveEl);
  }
  const now = performance.now();
  if (now - lastInterimPaint < 90 && M.interims.length) return;
  lastInterimPaint = now;

  const stack = liveEl.querySelector(".interims");
  const shown = M.interims.slice(-4);
  stack.innerHTML =
    shown
      .map((iv, i) => {
        const prev = shown[i - 1]?.text ?? "";
        const grew = iv.text.startsWith(prev) && prev;
        const html = grew
          ? `${esc(prev)}<span class="new">${esc(iv.text.slice(prev.length))}</span>`
          : esc(iv.text);
        // The prediction standing at the moment this interim landed. This is the
        // per-interim read: it moves as the utterance goes on.
        const r = iv.read;
        const chip = r
          ? `<span class="ichip">${r.intent ? `intent <b>${esc(r.intent.label)}</b> ${(r.intent.p * 100).toFixed(0)}%` : "intent —"} · ` +
            `${r.emotionConfident ? `emotion <b>${esc(r.emotion.label)}</b> ${(r.emotion.p * 100).toFixed(0)}%` : `emotion <i>no confident reading</i>`}</span>`
          : "";
        return `<div class="iv">${html}${chip}</div>`;
      })
      .join("") || `<div class="iv">…</div>`;

  liveEl.querySelector(".vad")?.remove();
  if (M.open.you) {
    liveEl.insertAdjacentHTML(
      "beforeend",
      `<div class="vad"><span class="bar"></span><span class="bar"></span><span class="bar"></span> speaking</div>`,
    );
  }
  pin($("youBody"));
}

function diffWords(before, after) {
  const a = before.trim().split(/\s+/).filter(Boolean);
  const b = after.trim().split(/\s+/).filter(Boolean);
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = norm(a[i]) === norm(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0, changed = 0;
  while (i < a.length && j < b.length) {
    if (norm(a[i]) === norm(b[j])) { out.push({ w: b[j], fix: false }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else { out.push({ w: b[j], fix: true }); changed++; j++; }
  }
  while (j < b.length) { out.push({ w: b[j], fix: true }); changed++; j++; }
  return { words: out, changed };
}

function finaliseTurn(text, t) {
  const last = M.interims[M.interims.length - 1]?.text ?? "";
  const { words, changed } = diffWords(last, text);
  const turn = {
    t, text, changed,
    interims: M.interims.length,
    span: M.interims.length ? t - M.interims[0].t : null,
    commit: M.lastInterimAt != null ? t - M.lastInterimAt : null,
  };
  M.turns.push(turn);
  if (turn.commit != null) M.metric.asr.push(turn.commit);
  M.lastFinalAt = t;
  M.awaitFirstWord = true;
  M.awaitThink = true;
  mark("you", t, C.ink, "final");

  const node = el("div", "turn");
  node.innerHTML =
    `<div class="final">${words.map((w) => (w.fix ? `<span class="fix">${esc(w.w)}</span>` : esc(w.w))).join(" ")}</div>` +
    `<div class="meta">` +
      `<span><b>${turn.interims}</b> interims</span>` +
      `<span><b>${changed}</b> word${changed === 1 ? "" : "s"} corrected</span>` +
      (turn.span != null ? `<span>spoken over <b>${ms(turn.span)}</b></span>` : "") +
      (turn.commit != null ? `<span>committed <b>${ms(turn.commit)}</b> after the last interim</span>` : "") +
    `</div>`;
  liveEl?.remove();
  liveEl = null;
  $("youBody").appendChild(node);
  pin($("youBody"));
  $("youNote").textContent = `${M.turns.length} turn${M.turns.length === 1 ? "" : "s"}`;

  commitRead(t);
  M.interims = [];
  renderStats();
}

/* ── the agent ───────────────────────────────────────────────────────────── */

function renderAgentState() {
  const s = $("agentState");
  s.innerHTML = "";
  if (M.thinking.active)
    s.appendChild(el("span", "thinking-strip", esc(M.thinking.label ?? `working${M.thinking.tool ? ` · ${M.thinking.tool}` : ""}`)));
  else if (M.speaking) s.appendChild(el("span", "pill ok", `<span class="dot"></span>speaking`));
  else if (mode !== "idle") s.appendChild(el("span", "pill", `<span class="dot"></span>listening`));
}

function renderCaption() {
  const tail = M.words.slice(-16);
  $("caption").innerHTML = tail.map((w, i) => (i === tail.length - 1 ? `<b>${esc(w)}</b>` : esc(w))).join(" ");
}

let replyEl = null;
function renderReply(done) {
  const box = $("replies");
  box.querySelector(".empty")?.remove();
  if (done) {
    const text = M.replies[M.replies.length - 1]?.text ?? "";
    if (replyEl) { replyEl.className = "reply-block"; replyEl.innerHTML = `<div class="reply done">${esc(text)}</div>`; }
    else box.appendChild(el("div", "reply-block", `<div class="reply done">${esc(text)}</div>`));
    replyEl = null;
    $("agentNote").textContent = `${M.replies.length} turn${M.replies.length === 1 ? "" : "s"}`;
    return;
  }
  if (!replyEl) { replyEl = el("div", "reply-block"); box.appendChild(replyEl); }
  replyEl.innerHTML = `<div class="reply partial">${esc(M.partial)}</div>`;
  pin($("agentBody"));
}

/* ── tools ───────────────────────────────────────────────────────────────── */

const toolKey = (p) => p?.id ?? `${p?.name ?? "tool"}@anon`;

function toolStarted(p, t) {
  const id = toolKey(p);
  const r = { id, name: p?.name ?? "tool", args: p?.arguments, sound: p?.sound, t0: t, progress: [], state: "running" };
  M.tools.set(id, r);
  M.toolOrder.push(id);
  openSpan(`tool:${id}`, t, C.tools, r.name, "tools");
  const node = el("div", "tool running");
  node.dataset.id = id;
  node.innerHTML = toolHtml(r);
  $("toolBody").querySelector(".empty")?.remove();
  $("toolBody").appendChild(node);
  pin($("toolBody"));
  $("toolNote").textContent = `${M.toolOrder.length} call${M.toolOrder.length === 1 ? "" : "s"}`;
}

function toolProgress(p, t) {
  const r = M.tools.get(toolKey(p));
  if (!r) return;
  r.progress.push({ t, display: p?.display, data: p?.data });
  repaintTool(r);
}

function toolFinished(p, t) {
  const r = M.tools.get(toolKey(p));
  if (!r) return;
  r.t1 = t; r.ok = p?.ok; r.result = p?.result; r.evidence = p?.evidence;
  if (p?.sound) r.failSound = p.sound;
  // `ok: undefined` is not `false` — the tool timed out and its success is genuinely
  // unknown. Calling that a failure would be inventing a fact.
  r.state = r.ok === true ? "ok" : r.ok === false ? "failed" : "unknown";
  M.metric.tool.push(t - r.t0);
  closeSpan(`tool:${r.id}`, t, r.state === "failed" ? C.live : r.state === "unknown" ? C.pred : C.tools);
  repaintTool(r);
  renderStats();
  harvestArtifacts(r);
}

function repaintTool(r) {
  const node = $("toolBody").querySelector(`[data-id="${CSS.escape(r.id)}"]`);
  if (!node) return;
  node.className = `tool ${r.state}`;
  node.innerHTML = toolHtml(r);
}

function toolHtml(r) {
  const dur = r.t1 != null ? ms(r.t1 - r.t0) : null;
  const status = r.state === "running" ? "running…" : r.state === "ok" ? "ok" : r.state === "failed" ? "failed" : "ok not reported";
  const args = r.args && Object.keys(r.args ?? {}).length ? `<div class="kv">${esc(clip(pretty(r.args), 400))}</div>` : "";
  const prog = r.progress.length
    ? `<div class="progress">${r.progress.map((x) => `<span>› ${esc(clip(x.display ?? pretty(x.data), 120))}</span>`).join("")}</div>` : "";
  const result = r.t1 != null && r.result != null ? `<div class="kv result">${esc(clip(pretty(r.result), 460))}</div>` : "";
  const ev = Array.isArray(r.evidence) && r.evidence.length
    ? `<div class="evidence">${r.evidence.slice(0, 5).map(citation).join("")}</div>` : "";
  return (
    `<div class="line">` +
      `<span class="name">${esc(r.name)}</span>` +
      (r.sound ? `<span class="earcon">♪ ${esc(r.sound)}</span>` : "") +
      (r.failSound ? `<span class="earcon">♪ ${esc(r.failSound)}</span>` : "") +
      `<span class="status">${dur ? `<span class="dur">${dur}</span>` : ""}${status}</span>` +
    `</div>` + args + prog + result + ev
  );
}

function citation(e, i) {
  if (typeof e === "string") return `<div class="src"><span class="n">${i + 1}</span><span>${esc(clip(e, 160))}</span></div>`;
  const title = e?.title ?? e?.source ?? e?.name ?? e?.doc_title ?? "source";
  const url = e?.url ?? e?.link ?? e?.uri;
  const snip = e?.snippet ?? e?.text ?? e?.content;
  return (
    `<div class="src"><span class="n">${i + 1}</span><span>` +
    (url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(clip(title, 90))}</a>` : esc(clip(title, 90))) +
    (snip ? ` — ${esc(clip(snip, 120))}` : "") +
    `</span></div>`
  );
}

function pretty(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 1); } catch { return String(v); }
}

const MEDIA = [
  [/\.(png|jpe?g|gif|webp|avif)(\?|$)/i, "img"],
  [/^data:image\//i, "img"],
  [/\.(mp4|webm|mov)(\?|$)/i, "video"],
  [/\.(mp3|wav|ogg|m4a|flac)(\?|$)/i, "audio"],
];
function harvestArtifacts(r) {
  const found = [];
  const walk = (v, depth) => {
    if (depth > 4 || found.length >= 6) return;
    if (typeof v === "string") {
      if (!/^(https?:|data:)/i.test(v)) return;
      for (const [re, kind] of MEDIA) if (re.test(v)) { found.push({ kind, url: v }); return; }
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(r.result, 0);
  walk(r.evidence, 0);
  for (const f of found.slice(0, 4)) {
    const node = el("div", "artifact");
    node.innerHTML =
      (f.kind === "img" ? `<img src="${esc(f.url)}" alt="${esc(r.name)} output" loading="lazy" />`
        : f.kind === "video" ? `<video src="${esc(f.url)}" controls playsinline></video>`
        : `<audio src="${esc(f.url)}" controls></audio>`) +
      `<div class="cap">${esc(r.name)}</div>`;
    $("artifacts").appendChild(node);
  }
}

/* ── the live signal stream ──────────────────────────────────────────────── */

const GOOD = new Set(["committed", "used", "held", "target", "directed"]);
const BAD = new Set(["false_cut", "discarded", "stale", "unused", "bystander", "side_talk"]);

function onSignal(s, t) {
  M.signals.push({ t, s });
  M.seen.add(s.type);
  if (s.type === "stream.start") { M.roster = s.data ?? {}; renderRoster(); }
  if (s.type === "emotion" || s.type === "intent") { readingFromSignal(s, t); return; }

  if (s.predictionId) predOpen(s, t);
  else if (s.resolves) predResolve(s, t);

  mark("signal", t, s.predictionId ? C.pred : C.signal, s.type);

  const row = el("div", `sig${s.resolves ? " res" : ""}${s.type === "stream.throttled" ? " warnish" : ""}`);
  row.innerHTML =
    `<span class="t">${(t / 1000).toFixed(2)}s</span><span class="ty">${esc(s.type)}</span>` +
    `<span class="d">${esc(summarise(s))}</span>`;
  $("sigEmpty")?.remove();
  $("sigList").appendChild(row);
  while ($("sigList").children.length > 300) $("sigList").firstChild.remove();
  pin($("sigBody"));
  $("sigNote").textContent = `${M.signals.length} events · v${s.version}`;
  renderRoster();
}

function summarise(s) {
  const d = s.data ?? {};
  switch (s.type) {
    case "stream.start":
      return `schema v${d.schema_version} · ${(d.types ?? []).length} types declared · cap ${d.max_events_per_min}/min`;
    case "endpoint":
      return `${d.bucket} p=${(d.completeness_p ?? 0).toFixed(2)} stop=${d.stop_secs}s ${d.model ?? ""} “${clip(d.text ?? "", 60)}”`;
    case "barge_in":
      return d.mode ? `mode=${d.mode} commit=${d.commit_ms}ms` : summariseResolution(s);
    case "addressee":
      return `${d.verdict} → ${d.action} (${d.mode}${d.source ? `, ${d.source}` : ""})${d.score != null ? ` score=${d.score.toFixed(3)}/${d.threshold}` : ""}`;
    case "language": return `${d.side}: ${d.from ?? "?"} → ${d.to} (${d.trigger})`;
    case "flow_state": return `${d.state} · ${d.event} · turn ${d.turn}`;
    case "flow_transition": return `${d.from} → ${d.to} (${d.transition_kind}) ${d.reason ?? ""}`;
    case "entity": case "entity_miss": return clip(pretty(d).replace(/\s+/g, " "), 90);
    case "speculative_tool":
      return d.tool ? `${d.tool} · origin=${d.origin}${d.query ? ` · “${clip(d.query, 40)}”` : ""}` : summariseResolution(s);
    case "shadow_draft":
      return d.drafted != null
        ? `“${clip(d.draft_preview ?? d.partial_text ?? "", 60)}”${d.predicted_tools ? ` · tools ${d.predicted_tools.join(",")}` : ""}`
        : summariseResolution(s);
    case "hesitation":
      return `entropy=${(d.emotion_entropy ?? 0).toFixed(2)} instability=${(d.emotion_instability ?? 0).toFixed(2)} flips=${d.emotion_flips}`;
    case "stream.throttled": return `dropped ${d.dropped_total} · cap ${d.max_per_min}/min`;
    default: return s.resolves ? summariseResolution(s) : clip(pretty(d).replace(/\s+/g, " "), 90);
  }
}
const summariseResolution = (s) =>
  `${s.outcome ?? "resolved"}${s.raw?.prediction_age_ms != null ? ` after ${ms(s.raw.prediction_age_ms)}` : ""}${s.data?.reason ? ` (${s.data.reason})` : ""}`;

function renderRoster() {
  const declared = M.roster?.types ?? [];
  const unresolvable = M.roster?.unresolvable ?? {};
  if (!declared.length) { $("roster").innerHTML = ""; return; }
  $("roster").innerHTML = declared
    .map((ty) => `<span class="lane ${M.seen.has(ty) ? "lit" : ""}" title="${esc(unresolvable[ty] ?? "")}">${esc(ty)}</span>`)
    .join("");
}

/* ── predictions ─────────────────────────────────────────────────────────── */

function predOpen(s, t) {
  if (M.roster?.resolutions?.[s.type]?.length === 0) return;
  const arc = { id: s.predictionId, type: s.type, t, data: s.data ?? {}, state: "pending" };
  M.preds.set(s.predictionId, arc);
  const node = el("div", "parc pending");
  node.dataset.pid = s.predictionId;
  node.innerHTML = predHtml(arc);
  $("predBody").querySelector(".empty")?.remove();
  $("predBody").appendChild(node);
  while ($("predBody").children.length > 60) $("predBody").firstChild.remove();
  pin($("predBody"));
  countPreds();
}

function predResolve(s, t) {
  const r = M.preds.get(s.resolves);
  if (!r) return;
  r.outcome = s.outcome ?? "resolved";
  r.age = s.raw?.prediction_age_ms ?? t - r.t;
  r.reason = s.data?.reason;
  r.state = GOOD.has(r.outcome) ? "good" : BAD.has(r.outcome) ? "bad" : "flat";
  const node = $("predBody").querySelector(`[data-pid="${CSS.escape(r.id)}"]`);
  if (node) { node.className = `parc ${r.state}`; node.innerHTML = predHtml(r); }
  mark("pred", t, r.state === "bad" ? C.live : r.state === "good" ? C.agent : C.pred, r.outcome);
  countPreds();
}

function predHtml(r) {
  const d = r.data ?? {};
  const what =
    r.type === "endpoint" ? `sentence is <b>${esc(d.bucket ?? "?")}</b> · p=${(d.completeness_p ?? 0).toFixed(2)} · patience ${d.stop_secs}s<br>“${esc(clip(d.text ?? "", 70))}”`
    : r.type === "barge_in" ? `that noise is an interruption · <b>${esc(d.mode ?? "")}</b> · commit ${d.commit_ms}ms`
    : r.type === "speculative_tool" ? `pre-warm <code>${esc(d.tool ?? "")}</code> · ${esc(d.origin ?? "")}${d.query ? `<br>“${esc(clip(d.query, 60))}”` : ""}`
    : r.type === "shadow_draft" ? `drafted early${d.predicted_tools ? ` · predicts <code>${esc(d.predicted_tools.join(", "))}</code>` : ""}${d.draft_preview ? `<br>“${esc(clip(d.draft_preview, 70))}”` : ""}`
    : esc(clip(pretty(d).replace(/\s+/g, " "), 90));
  const out = r.outcome
    ? `${esc(r.outcome)}<br><span class="age">${ms(r.age)}${r.reason ? ` · ${esc(r.reason)}` : ""}</span>`
    : `in flight`;
  return `<span class="type">${esc(r.type)}</span><span class="what">${what}</span><span class="out">${out}</span>`;
}

function countPreds() {
  const open = [...M.preds.values()].filter((p) => p.state === "pending").length;
  $("predNote").textContent = `${M.preds.size - open} resolved · ${open} open`;
}

/* ═══ the acoustic read ═══════════════════════════════════════════════════════

   This card was empty on a real session, and the reason is worth writing down.

   `user-metadata` frames were arriving the whole time. Every one carried
   `emotion: "Neutral"` — and NEUTRAL is the one value the platform writes both for a
   genuinely calm speaker and as the fallback when no reading was produced, so the SDK
   drops it and reports `emotion: undefined`. The card only had a reading to draw when
   emotion was non-neutral, so it drew nothing: a live pipeline, a working parse, and a
   dead-looking panel. Worse, an empty box cannot tell a viewer whether nothing is
   being predicted or the console is broken.

   The fix is not to fabricate a reading. It is to render what genuinely exists:

     1. the DISTRIBUTION, which the wire carries in full (`probs.emotion` on the
        metadata frame, `top_k` on the live signal) and which is the honest output;
     2. the intent read, which has no NEUTRAL ambiguity and is usually decisive;
     3. an explicit "no confident emotion reading" line when the top of the emotion
        distribution is NEUTRAL — deliberate content, not blankness;
     4. a frame counter, so "no frames arrived" and "frames arrived, nothing
        confident in them" never look the same.
   ═════════════════════════════════════════════════════════════════════════ */

const NOT_A_READING = new Set(["", "NEUTRAL", "UNKNOWN", "NONE", "NULL"]);

/** `[{token,probability}]` (metadata) or `[{label,p}]` (signal) → one shape. */
function distOf(list) {
  if (!Array.isArray(list)) return null;
  const out = list
    .map((e) => ({ label: bare(e?.token ?? e?.label), p: Number(e?.probability ?? e?.p ?? 0) }))
    .filter((e) => e.label);
  return out.length ? out.sort((a, b) => b.p - a.p) : null;
}

function ingest(kind, dist, extra) {
  if (!dist) return;
  const top = dist[0];
  M.read[kind] = {
    dist,
    top,
    confident: !NOT_A_READING.has(top.label.toUpperCase()),
    ...extra,
  };
  M.read.frames++;
  M.read.lastAt = M.now;
  renderReadLive();
}

/** The SDK's parsed read — plus its `raw`, which carries the distributions. */
function onMetadata(m, t) {
  const raw = m?.raw ?? {};
  const probs = raw.probs ?? {};
  M.read.source = "user-metadata";
  ingest("emotion", distOf(probs.emotion) ?? (m?.emotion ? [{ label: m.emotion.label, p: m.emotion.confidence ?? 0 }] : null), { trusted: true });
  ingest("intent", distOf(probs.intent) ?? (m?.intent ? [{ label: m.intent.label, p: m.intent.confidence ?? 0 }] : null), { trusted: true });
  // Age and gender ride the same frame. Secondary, and labelled as the model's guess.
  M.read.extra = { age: bare(raw.age), gender: bare(raw.gender), ageDist: distOf(probs.age), genderDist: distOf(probs.gender) };
}

/** The live signal stream's version: a distribution, never a bare label. */
function readingFromSignal(s, t) {
  const d = s.data ?? {};
  M.read.source = "live signal stream";
  ingest(s.type, distOf(d.top_k), {
    trusted: d.trusted !== false,
    flips: d.flips ?? 0,
    changed: !!d.changed,
    prev: d.prev_label ? bare(d.prev_label) : null,
    heldMs: d.held_ms,
  });
  mark("signal", t, C.signal, s.type);
  M.seen.add(s.type);
  renderRoster();
}

/** What the read looked like at the instant an interim landed. */
function snapshotRead() {
  const e = M.read.emotion, i = M.read.intent;
  if (!e && !i) return null;
  return {
    emotion: e ? { label: e.top.label, p: e.top.p } : null,
    emotionConfident: !!e?.confident,
    intent: i ? { label: i.top.label, p: i.top.p } : null,
  };
}

function readCard(read, title) {
  const e = read.emotion, i = read.intent, x = read.extra;
  const head = `<div class="read-head">${title} · <b>${read.frames}</b> frame${read.frames === 1 ? "" : "s"}${read.source ? ` from the ${esc(read.source)}` : ""}</div>`;
  return head + block("emotion", e, true) + block("intent", i, false) + (x ? extraHtml(x) : "");
}

function block(kind, r, neutralIsAmbiguous) {
  if (!r) {
    return (
      `<div class="read-sub">${kind}</div>` +
      `<span class="noread"><span class="x">✕</span>no ${kind} frames on this session</span>`
    );
  }
  const confident = r.confident;
  const label = confident
    ? `<b class="lean">${esc(r.top.label)}</b> <span class="pct">${(r.top.p * 100).toFixed(0)}%</span> <span class="hint">leaning, not a verdict</span>`
    : neutralIsAmbiguous
      ? `<span class="noread inline"><span class="x">✕</span>no confident reading</span>`
      : `<b class="lean">${esc(r.top.label)}</b> <span class="pct">${(r.top.p * 100).toFixed(0)}%</span>`;
  const flags =
    (r.trusted === false ? ` · <span class="untrust">untrusted on this language</span>` : "") +
    (r.flips ? ` · ${r.flips} flip${r.flips === 1 ? "" : "s"}` : "") +
    (r.changed && r.prev ? ` · was ${esc(r.prev)}` : "");
  const rows = r.dist.slice(0, 5).map((c, idx) =>
    `<div class="row ${idx === 0 ? "top" : ""}">` +
      `<span class="lbl">${esc(c.label)}</span>` +
      `<span class="track"><span class="fill" style="width:${Math.max(1, Math.round(c.p * 100))}%"></span></span>` +
      `<span class="pct">${(c.p * 100).toFixed(0)}%</span>` +
    `</div>`).join("");
  const why = !confident && neutralIsAmbiguous
    ? `<div class="why">NEUTRAL is written both for a calm speaker and when no reading was produced, so it is never shown as a verdict. The distribution below is what the head actually said.</div>`
    : "";
  return (
    `<div class="read-sub">${kind} — ${label}${flags}</div>` + why +
    `<div class="dist ${r.trusted === false ? "untrusted" : ""}">${rows}</div>`
  );
}

const extraHtml = (x) =>
  `<div class="read-extra">also on this frame · age <b>${esc(x.age || "—")}</b> · gender <b>${esc(x.gender || "—")}</b></div>`;

function renderReadLive() {
  // Between utterances there is nothing live to show, and the two-block "no frames"
  // card read as a broken panel. Say what is true instead — the previous utterance's
  // card is directly below, so the panel is never blank.
  $("readLive").innerHTML = M.read.frames
    ? `<div class="read-block live">${readCard(M.read, "live")}</div>`
    : `<div class="read-block live idle">${mode === "idle"
        ? "No session running. Start one and this fills as you speak."
        : "Listening — no acoustic frames since the last utterance. The most recent read is below."}</div>`;
  $("readNote").textContent = M.read.frames
    ? `${M.read.frames} frames · last ${ms(Math.max(0, M.now - (M.read.lastAt ?? M.now)))} ago`
    : "no frames yet";
}

/** At each final: freeze the read into the history, and start a clean one. */
function commitRead(t) {
  const r = M.read;
  const node = el("div", "read-block");
  node.innerHTML = readCard(r, `utterance ${M.turns.length} · ${(t / 1000).toFixed(1)}s`);
  M.reads.push({ t, emotion: r.emotion, intent: r.intent, frames: r.frames });
  $("readHistory").prepend(node);
  while ($("readHistory").children.length > 10) $("readHistory").lastChild.remove();
  M.read = { frames: 0, lastAt: null, emotion: null, intent: null, extra: null, source: r.source };
  renderReadLive();
}

/* ── latency, honestly ───────────────────────────────────────────────────── */

const STATS = [
  { key: "asr", label: "interim → final", hint: "ASR commit lag" },
  { key: "firstWord", label: "final → first word", hint: "your last word to its first" },
  { key: "think", label: "final → tool call", hint: "when a turn used one" },
  { key: "tool", label: "tool round-trip", hint: "started → result" },
  { key: "barge", label: "barge-in → silence", hint: "how fast it yields" },
];

function renderStats() {
  $("stats").innerHTML = STATS.map(({ key, label, hint }) => {
    const a = M.metric[key];
    const last = a.length ? a[a.length - 1] : null;
    return (
      `<div class="stat">` +
        (last == null ? `<div class="v none">—</div>` : `<div class="v">${ms(last)} <u>med ${ms(median(a))}</u></div>`) +
        `<div class="k">${label}</div><div class="n">${a.length ? `n=${a.length}` : hint}</div>` +
      `</div>`
    );
  }).join("");
}

/* ── the event stream, with the bytes behind every row ───────────────────── */

let lastWordRow = null;
function streamRow(t, type, p) {
  const body = $("streamBody");
  body.querySelector(".empty")?.remove();

  // Words arrive several times a second. Collapse a run of them into one row that
  // grows, so the stream stays readable without hiding anything: the row carries
  // every word, and the raw payload of the run is on it.
  if (type === "agent-word" && !$("showWords").checked) {
    if (lastWordRow && lastWordRow.isConnected) {
      lastWordRow.dataset.n = String(Number(lastWordRow.dataset.n) + 1);
      lastWordRow.dataset.words = `${lastWordRow.dataset.words} ${p}`;
      lastWordRow.querySelector(".sum").textContent = `×${lastWordRow.dataset.n} ${clip(lastWordRow.dataset.words, 70)}`;
      lastWordRow.querySelector(".raw")?.remove();
      return;
    }
  } else if (type !== "agent-word") lastWordRow = null;

  const row = el("div", `ev ${cls(type)}`);
  row.innerHTML =
    `<span class="t">${(t / 1000).toFixed(3)}</span>` +
    `<span class="ty">${esc(type)}</span>` +
    `<span class="sum">${esc(clip(summariseEvent(type, p), 90))}</span>`;
  row.dataset.raw = JSON.stringify(p ?? null, null, 1);
  if (type === "agent-word") { row.dataset.n = "1"; row.dataset.words = String(p ?? ""); lastWordRow = row; }
  row.onclick = () => {
    const open = row.querySelector(".raw");
    if (open) { open.remove(); row.classList.remove("open"); return; }
    row.classList.add("open");
    row.appendChild(el("pre", "raw", esc(row.dataset.raw)));
  };
  body.appendChild(row);
  while (body.children.length > 600) body.firstChild.remove();
  pin(body);
  $("streamNote").textContent = `${M.eventCount} events`;
}

function cls(type) {
  if (type.startsWith("tool")) return "t-tool";
  if (type === "signal") return "t-signal";
  if (type === "user-metadata") return "t-read";
  if (type.startsWith("user")) return "t-you";
  if (type.startsWith("agent") || type.startsWith("speaking")) return "t-agent";
  if (type === "error" || type === "mic-lost" || type === "demo-limit") return "t-bad";
  if (type === "server-message") return "t-unknown";
  return "";
}

function summariseEvent(type, p) {
  if (p == null) return "";
  switch (type) {
    case "user-interim": case "user-transcript": case "agent-partial": case "agent-transcript":
    case "agent-word": case "gist": return String(p);
    case "signal": return `${p.type} ${p.outcome ?? ""} ${clip(pretty(p.data).replace(/\s+/g, " "), 50)}`;
    case "user-metadata": return `emotion ${bare(p.raw?.emotion) || "—"} · intent ${bare(p.raw?.intent) || "—"}`;
    case "tool-started": return `${p.name} ${clip(pretty(p.arguments).replace(/\s+/g, " "), 50)}`;
    case "tool-progress": return `${p.name} ${p.display ?? ""}`;
    case "tool-finished": return `${p.name} ${p.ok === true ? "ok" : p.ok === false ? "FAILED" : "ok not reported"}`;
    case "thinking": return p.active ? `active ${p.tool ?? ""} ${p.label ?? ""}` : "idle";
    case "error": return `${p.code ?? ""} ${p.message ?? ""}`;
    case "server-message": return `unmodelled — ${clip(pretty(p).replace(/\s+/g, " "), 60)}`;
    default: return clip(pretty(p).replace(/\s+/g, " "), 60);
  }
}

/* ── the timeline ────────────────────────────────────────────────────────── */

const LANES = [
  { key: "you", name: "you", color: C.you },
  { key: "pred", name: "predict", color: C.pred },
  { key: "think", name: "think", color: C.think },
  { key: "tools", name: "tools", color: C.tools },
  { key: "agent", name: "agent", color: C.agent },
  { key: "signal", name: "signals", color: C.signal },
];
const LANE_INDEX = Object.fromEntries(LANES.map((l, i) => [l.key, i]));

function openSpan(key, t, color, label, lane) {
  const s = { lane: lane ?? key, t0: t, t1: null, color, label, row: 0 };
  M.open[key] = s;
  M.spans.push(s);
  if (s.lane === "tools") s.row = M.spans.filter((x) => x.lane === "tools" && x !== s && x.t1 == null).length % 2;
}
function closeSpan(key, t, color) {
  const s = M.open[key];
  if (!s) return;
  s.t1 = t;
  if (color) s.color = color;
  delete M.open[key];
}
function mark(lane, t, color, label) { M.marks.push({ lane, t, color, label }); }

const cv = $("tl");
const ctx = cv.getContext("2d");
let dirty = true;
let canvasSize = "";

function sizeCanvas() {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvasSize = `${r.width}x${r.height}`;
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dirty = true;
}
window.addEventListener("resize", sizeCanvas);

const WINDOW = 45000;
function drawTimeline() {
  const r = cv.getBoundingClientRect();
  const W = r.width, H = r.height;
  const GUT = 62, PADR = 10, PADT = 8, AXIS = 18;
  ctx.clearRect(0, 0, W, H);

  const now = Math.max(nowMs(), 1);
  const t1 = Math.max(now, WINDOW * 0.35);
  const t0v = Math.max(0, t1 - WINDOW);
  const x = (t) => GUT + ((t - t0v) / (t1 - t0v)) * (W - GUT - PADR);
  const laneH = (H - PADT - AXIS) / LANES.length;

  ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
  ctx.textBaseline = "middle";
  LANES.forEach((l, i) => {
    const y = PADT + i * laneH;
    ctx.fillStyle = i % 2 ? "rgba(241,240,240,.018)" : "transparent";
    ctx.fillRect(GUT, y, W - GUT - PADR, laneH);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(GUT, Math.round(y) + 0.5); ctx.lineTo(W - PADR, Math.round(y) + 0.5); ctx.stroke();
    ctx.fillStyle = l.color; ctx.globalAlpha = 0.85; ctx.textAlign = "right";
    ctx.fillText(l.name, GUT - 10, y + laneH / 2);
    ctx.globalAlpha = 1;
  });

  ctx.textAlign = "center";
  for (let t = Math.ceil(t0v / 5000) * 5000; t <= t1; t += 5000) {
    const px = Math.round(x(t)) + 0.5;
    ctx.strokeStyle = "rgba(241,240,240,.06)";
    ctx.beginPath(); ctx.moveTo(px, PADT); ctx.lineTo(px, H - AXIS); ctx.stroke();
    ctx.fillStyle = C.faint;
    ctx.fillText(`${Math.round(t / 1000)}s`, px, H - AXIS / 2);
  }

  for (const s of M.spans) {
    const li = LANE_INDEX[s.lane];
    if (li == null) continue;
    const end = s.t1 ?? now;
    if (end < t0v) continue;
    const y = PADT + li * laneH;
    const h = s.lane === "tools" ? laneH * 0.34 : laneH * 0.5;
    const yy = y + laneH / 2 - h / 2 + (s.lane === "tools" ? (s.row ? h * 0.62 : -h * 0.62) : 0);
    const x0 = Math.max(x(Math.max(s.t0, t0v)), GUT);
    const w = Math.max(2, x(end) - x0);
    ctx.fillStyle = s.color;
    ctx.globalAlpha = s.t1 == null ? 0.5 : 0.8;
    roundRect(x0, yy, w, h, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (w > 46 && s.label) {
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, yy, w, h); ctx.clip();
      ctx.fillStyle = "rgba(20,16,16,.92)"; ctx.textAlign = "left";
      ctx.font = '500 9px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillText(s.label, x0 + 5, yy + h / 2);
      ctx.restore();
    }
  }

  for (const m of M.marks) {
    if (m.t < t0v) continue;
    const px = Math.round(x(m.t)) + 0.5;
    if (m.lane === "barge") {
      ctx.strokeStyle = C.live; ctx.globalAlpha = 0.75; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(px, PADT); ctx.lineTo(px, H - AXIS); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      continue;
    }
    const li = LANE_INDEX[m.lane];
    if (li == null) continue;
    const y = PADT + li * laneH;
    ctx.fillStyle = m.color;
    if (m.label === "final" || m.label === "first word") {
      ctx.beginPath();
      ctx.moveTo(px, y + laneH * 0.22);
      ctx.lineTo(px + 4, y + laneH * 0.36);
      ctx.lineTo(px - 4, y + laneH * 0.36);
      ctx.closePath(); ctx.fill();
    } else {
      ctx.globalAlpha = 0.7;
      ctx.fillRect(px - 0.5, y + laneH * 0.62, 1.5, laneH * 0.22);
      ctx.globalAlpha = 1;
    }
  }

  const nx = Math.round(x(now)) + 0.5;
  ctx.strokeStyle = mode === "replay" ? C.you : C.live;
  ctx.globalAlpha = 0.9;
  ctx.beginPath(); ctx.moveTo(nx, PADT - 4); ctx.lineTo(nx, H - AXIS); ctx.stroke();
  ctx.globalAlpha = 1;
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  const rr = Math.min(r, h / 2, w / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ── the microphone strip ────────────────────────────────────────────────── */

const tap = installMicTap();
const METER_BARS = [...$("meter").children];

function renderMic(now) {
  const s = tap.sample(now);
  const lit = Math.round(Math.min(1, s.peak * 9) * METER_BARS.length);
  METER_BARS.forEach((b, i) => b.classList.toggle("on", i < lit));
  $("micbar").classList.toggle("rehearsal", s.source === "rehearsal");
  $("micSrc").textContent = mode === "replay" ? "RECORDING" : s.source === "rehearsal" ? "SYNTHETIC" : "MICROPHONE";

  const bits = [];
  if (mode === "replay") bits.push("replaying a recorded session — no live input");
  else if (s.label) bits.push(s.label);
  else if (s.permission === "denied") bits.push("permission denied");
  else if (mode === "idle") bits.push("not started");
  if (s.track) {
    bits.push(s.readyState === "ended" ? "track ended" : s.muted ? "track muted by the OS" : "live");
    if (s.everHeard) bits.push(`peak ${(s.peak * 100).toFixed(0)}%`);
  }
  $("micState").textContent = bits.join(" · ");

  // The self-diagnosis: a session that is up and hearing nothing must say so.
  let warn = null;
  if (mode === "replay") warn = null;
  else if (s.error) warn = s.error;
  else if (s.permission === "denied") warn = describeMicError({ name: "NotAllowedError" });
  else if (mode === "live" && s.track && s.readyState === "ended") warn = "The input track ended. Stop and start the session again.";
  else if (mode === "live" && s.track && s.silentSince != null && now - s.silentSince > 3000)
    warn = s.everHeard
      ? `No sound from “${s.label ?? "the input"}” for ${Math.round((now - s.silentSince) / 1000)}s — the session is up and hearing silence.`
      : `Nothing has ever reached this session from “${s.label ?? "the input"}”. Check the input device, the OS mute switch, and that nothing else is holding the mic.`;
  $("micWarn").hidden = !warn;
  if (warn) $("micWarn").textContent = warn;
}

function micProblem(message) {
  $("micWarn").hidden = false;
  $("micWarn").textContent = message;
}

async function fillDevices() {
  const list = await tap.devices();
  if (!list.length) return;
  const cur = tap.state.deviceId;
  $("micPick").innerHTML = list
    .map((d) => `<option value="${esc(d.deviceId)}"${d.deviceId === cur ? " selected" : ""}>${esc(d.label || "Input device")}</option>`)
    .join("");
  $("micPick").disabled = false;
}

/* ── frame loop ──────────────────────────────────────────────────────────── */
let lastFrame = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (ts - lastFrame < 33) return;              // 30fps — what a screen recording keeps
  lastFrame = ts;
  const r = cv.getBoundingClientRect();
  if (`${r.width}x${r.height}` !== canvasSize) sizeCanvas();
  if (mode === "replay" && replay?.playing) {
    replay.clock = replay.offset + (performance.now() - replay.wall) * replay.speed;
    pumpReplay();
  }
  renderMic(ts);
  const t = nowMs();
  if (mode !== "idle") {
    const s = Math.floor(t / 1000);
    $("clock").innerHTML = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}<span>.${Math.floor((t % 1000) / 100)}</span>`;
  }
  if (M.read.frames && mode === "live") renderReadFreshness();
  if (dirty || mode === "live" || (mode === "replay" && replay?.playing)) { drawTimeline(); dirty = false; }
}

let lastFresh = 0;
function renderReadFreshness() {
  if (M.now - lastFresh < 500) return;
  lastFresh = M.now;
  $("readNote").textContent = `${M.read.frames} frames · last ${ms(Math.max(0, nowMs() - (M.read.lastAt ?? 0)))} ago`;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function pin(node) {
  if (node.scrollHeight - node.scrollTop - node.clientHeight < 140) node.scrollTop = node.scrollHeight;
}
function setState(s) {
  M.state = s;
  $("stateText").textContent = s;
  $("statePill").className = `pill ${s === "listening" || s === "connected" ? "ok" : s === "ended" ? "" : "warn"}`;
}
function setTransport() {
  if (!M.transport) return;
  $("transportPill").hidden = false;
  $("transportText").textContent = `${M.transport}${M.sessionId ? ` · ${M.sessionId.slice(0, 8)}` : ""}`;
}
function setMode(m) {
  mode = m;
  const pill = $("modePill");
  pill.className = `pill ${m === "live" ? "live" : m === "replay" ? "replay" : ""}`;
  pill.innerHTML = `<span class="dot"></span><b>${m === "live" ? "LIVE" : m === "replay" ? "REPLAY" : "IDLE"}</b>`;
}

function reset() {
  M = blankModel();
  rec = [];
  liveEl = null; replyEl = null; lastWordRow = null;
  for (const id of ["youBody", "readLive", "readHistory", "replies", "artifacts", "toolBody", "predBody", "sigList", "roster", "streamBody"])
    $(id).innerHTML = "";
  $("caption").textContent = "";
  $("gist").hidden = true;
  $("agentState").innerHTML = "";
  $("footErr").textContent = "";
  for (const id of ["youNote", "agentNote", "toolNote", "predNote", "sigNote", "streamNote"]) $(id).textContent = "";
  $("readNote").textContent = "no frames yet";
  $("clock").innerHTML = `00:00<span>.0</span>`;
  renderReadLive();
  renderStats();
  dirty = true;
}

/* ── terminal logging: the same stream, beside the video ─────────────────── */

let logQueue = [];
let logTimer = null;
function queueLog(t, type, p) {
  logQueue.push({ t: Math.round(t), type, summary: clip(summariseEvent(type, p), 160) });
  if (logTimer) return;
  logTimer = setTimeout(() => {
    const batch = logQueue;
    logQueue = [];
    logTimer = null;
    fetch("/api/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: recMeta.sessionId ?? null, events: batch }),
    }).catch(() => {});
  }, 400);
}

/* ═══ live session ════════════════════════════════════════════════════════ */

let agent = null;
let info = null;
let rehearsal = null;

async function loadAgent() {
  try {
    info = await fetch("/api/agent").then((r) => r.json());
    $("agentName").textContent = info.name ?? "agent";
    $("agentMeta").textContent = `${info.type ?? "agent"} · ear: ${info.stt ?? "unknown"} · ${info.id?.slice(0, 8) ?? ""}`;
  } catch {
    $("agentName").textContent = "server unreachable";
  }
}

async function startLive() {
  reset();
  setMode("live");

  // Rehearsal is opt-in, loud, and stamped into the recording. Default is the mic.
  const script = new URLSearchParams(location.search).get("rehearse");
  if (script && !rehearsal) {
    try {
      rehearsal = await installRehearsal(script === "1" ? "rehearsal.json" : script);
      $("rehearsalBanner").hidden = false;
      tap.setSource("rehearsal", rehearsal.track);
    } catch (err) {
      $("footErr").textContent = `Rehearsal script failed: ${err?.message ?? err}`;
    }
  }

  t0 = performance.now();
  setState("connecting");
  $("btnStart").disabled = true;
  $("btnStop").disabled = false;
  $("btnMute").disabled = false;
  $("btnCues").disabled = false;

  agent = new WhissleAgent({
    // The browser holds no Whissle key: it asks OUR server, which mints a token for
    // one agent. Returning the whole mint lets the SDK follow the transport and ICE
    // servers the platform advertises.
    getToken: () => fetch("/api/session", { method: "POST" }).then((r) => r.json()),
  });

  const pass = (evt) =>
    agent.on(evt, (a, b) => emit(evt, evt === "error" ? { message: String(a), ...(b ?? {}) } : a));
  ["connecting", "connected", "bot-ready", "disconnected", "speaking-started", "speaking-stopped",
   "agent-partial", "agent-word", "agent-transcript", "user-interim", "user-transcript",
   "listening-started", "listening-stopped", "thinking", "tool-started", "tool-progress",
   "tool-finished", "signal", "user-metadata", "gist", "demo-limit", "mic-lost", "mic-restored",
   "error"].forEach(pass);

  // Everything the SDK does not model. Tool, signal and metadata frames are already
  // parsed above and would only be recorded twice; the avatar's PCM frames arrive
  // several times a second and concern nothing here. Everything else is shown raw —
  // an unknown event renders as unknown, never as nothing.
  agent.on("server-message", (m) => {
    const k = m?.kind, tt = m?.t;
    if (k === "tool" || k === "signal" || tt === "user-metadata" || tt === "simli-audio" || tt === "simli-clear") return;
    emit("server-message", m);
  });

  try {
    await agent.start();
    emit("session", {
      startedAt: new Date().toISOString(),
      transport: agent.transport,
      sessionId: agent.session?.session_id ?? null,
      agent: { name: info?.name, id: info?.id, stt: info?.stt },
      source: rehearsal ? "rehearsal" : "microphone",
    }, 0);
    recMeta = {
      agent: { name: info?.name ?? null, id: info?.id ?? null, type: info?.type ?? null, stt: info?.stt ?? null },
      transport: agent.transport ?? null,
      sessionId: agent.session?.session_id ?? null,
      source: rehearsal ? "rehearsal" : "microphone",
    };
    $("btnSave").disabled = false;
    $("btnExport").disabled = false;
    void fillDevices();
    rehearsal?.play((cue) => emit("server-message", { t: "rehearsal-cue", file: cue.file }));
  } catch (err) {
    emit("error", { message: describeMicError(err) || String(err?.message ?? err), code: err?.code ?? "connection" });
    micProblem(describeMicError(err));
    stopLive();
  }
}

function stopLive() {
  try { agent?.stop(); } catch {}
  $("btnStart").disabled = false;
  $("btnStop").disabled = true;
  $("btnMute").disabled = true;
  $("btnCues").disabled = true;
  // Stay live long enough for the SDK's own `disconnected` to be recorded — a
  // recording that stops one event short replays one event short.
  setTimeout(() => {
    if (!M.ended) emit("disconnected");
    setMode("idle");
    M.now = nowMs();
  }, 500);
}

/* ═══ replay ══════════════════════════════════════════════════════════════ */

async function loadRecordings() {
  try {
    const rows = await fetch("/api/recordings").then((r) => r.json());
    $("replayPick").innerHTML =
      `<option value="">Replay…</option>` +
      rows.map((r) => `<option value="${esc(r.file)}">${esc(r.file.replace(/\.json$/, ""))} · ${(r.durationMs / 1000).toFixed(0)}s · ${r.events} events</option>`).join("");
  } catch {}
}

async function startReplay(file) {
  const data = await fetch(`/sessions/${encodeURIComponent(file)}`).then((r) => r.json());
  reset();
  setMode("replay");
  if (data.agent) {
    $("agentName").textContent = data.agent.name ?? "agent";
    $("agentMeta").textContent = `recorded ${new Date(data.recordedAt).toLocaleString()} · ear: ${data.agent.stt ?? "?"}`;
  }
  // A rehearsed recording carries its banner into the replay. A synthetic take must
  // never be able to pass for a live one, in any window it is ever shown in.
  $("rehearsalBanner").hidden = data.source !== "rehearsal";
  replay = {
    events: [...(data.events ?? [])].sort((a, b) => a.t - b.t),
    i: 0, speed: Number($("speed").value) || 1, playing: true,
    clock: 0, offset: 0, wall: performance.now(), durationMs: data.durationMs ?? 0,
  };
  $("btnReplay").disabled = false;
  $("btnReplay").textContent = "Pause";
  $("speed").disabled = false;
  $("btnStop").disabled = false;
  $("btnSave").disabled = true;
  $("btnExport").disabled = false;
}

function pumpReplay() {
  if (!replay) return;
  while (replay.i < replay.events.length && replay.events[replay.i].t <= replay.clock) {
    const e = replay.events[replay.i++];
    emit(e.type, e.p, e.t);
  }
  if (replay.i >= replay.events.length && replay.clock > (replay.durationMs || 0) + 400) {
    replay.playing = false;
    $("btnReplay").textContent = "Replay ended";
    $("btnReplay").disabled = true;
  }
}

/* ═══ wiring ══════════════════════════════════════════════════════════════ */

$("btnStart").onclick = () => startLive();
$("btnStop").onclick = () => {
  if (mode === "replay") { replay = null; setMode("idle"); $("btnStop").disabled = true; $("speed").disabled = true; return; }
  stopLive();
};
$("btnMute").onclick = (e) => {
  const muted = e.target.getAttribute("aria-pressed") === "true";
  agent?.setMuted(!muted);
  e.target.setAttribute("aria-pressed", String(!muted));
  e.target.textContent = !muted ? "Mic muted" : "Mic on";
};
$("btnCues").onclick = (e) => {
  const on = e.target.getAttribute("aria-pressed") === "true";
  agent?.setEarconsMuted(on);
  e.target.setAttribute("aria-pressed", String(!on));
  e.target.textContent = on ? "Cues off" : "Cues on";
};
$("micPick").onchange = (e) => {
  const ok = agent?.setMicrophone(e.target.value);
  if (ok === false) $("micWarn").hidden = false,
    ($("micWarn").textContent = "This transport cannot switch input device mid-session. Stop, pick the device, and start again.");
};

const recording = () => ({
  version: 1,
  recordedAt: new Date().toISOString(),
  ...recMeta,
  durationMs: Math.round(M.now),
  events: rec,
});

$("btnExport").onclick = () => {
  const blob = new Blob([JSON.stringify(recording(), null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `whissle-session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

$("btnSave").onclick = async () => {
  const name = prompt("Save this session as", `session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`);
  if (!name) return;
  const r = await fetch("/api/recordings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...recording(), name }),
  }).then((x) => x.json());
  await loadRecordings();
  if (r.file) $("replayPick").value = r.file;
};

$("replayPick").onchange = (e) => { if (e.target.value) startReplay(e.target.value); };
$("btnReplay").onclick = () => {
  if (!replay) return;
  if (replay.playing) { replay.playing = false; replay.offset = replay.clock; $("btnReplay").textContent = "Play"; }
  else {
    replay.playing = true; replay.wall = performance.now();
    replay.speed = Number($("speed").value) || 1;
    $("btnReplay").textContent = "Pause";
  }
};
$("speed").onchange = () => {
  if (!replay) return;
  replay.offset = replay.clock;
  replay.wall = performance.now();
  replay.speed = Number($("speed").value) || 1;
};

/* ── boot ────────────────────────────────────────────────────────────────── */
// The model and the raw recording, reachable from devtools. A console that could not
// be interrogated from the console would be a poor advertisement for one.
Object.defineProperty(window, "signalConsole", { get: () => ({ model: M, recording: rec, mode, replay, mic: tap.state }) });

M = blankModel();
setMode("idle");
renderReadLive();
renderStats();
sizeCanvas();
requestAnimationFrame(frame);
loadAgent();
navigator.mediaDevices?.addEventListener?.("devicechange", () => void fillDevices());
void fillDevices();
loadRecordings().then(() => {
  const wanted = new URLSearchParams(location.search).get("replay");
  if (wanted) startReplay(wanted.endsWith(".json") ? wanted : `${wanted}.json`).catch(() => {});
});
