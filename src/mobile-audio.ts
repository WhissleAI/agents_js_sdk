// Boost agent TTS loudness on mobile browsers.
//
// Shared mechanism with the Whissle dashboard's `lib/mobile-audio.ts` — deliberately
// the same file, because an integrator's page and ours have the same problem and two
// competing gain paths would be worse than the bug. Keep them in step.
//
// A bare `<audio srcObject={remoteWebRTCStream}>` is fine on desktop, but on a phone
// it is too quiet to use. Two separate reasons, and they stack:
//
//  * iOS Safari plays it through the *earpiece* at a capped level, and
//    `HTMLMediaElement.volume` is read-only there — nothing on the element can turn
//    it up.
//  * Android Chrome, while a WebRTC session with a live microphone is up, hands
//    browser output to the platform's *voice-call* stream rather than the media
//    stream. The visitor's media volume can be at maximum and the agent is still
//    quiet, because the slider that governs it is the in-call one — which nobody
//    touches during a browser session, and which the page cannot read or set.
//    There is no web API for the Android stream type and `setSinkId` has nothing to
//    select (Android Chrome enumerates no `audiooutput` devices), so the only lever
//    a page has is digital level. That makes the quality of this graph the whole
//    fix, not a nicety.
//
// So the same stream is routed through a WebAudio graph to `destination`, which
// plays via the media/loudspeaker path AND lets us apply real gain:
//
//     source -> compressor -> gain -> limiter -> destination
//
// Desktop is untouched (the element keeps playing normally). On mobile the graph
// drives output and the element is muted to avoid double audio; if anything in the
// WebAudio path fails, we fall back to the plain element. A kill switch
// (`window.__whissleNoAudioBoost = true`, or `?audioboost=0`) disables it live.

let ctx: AudioContext | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let analyser: AnalyserNode | null = null;
let currentStream: MediaStream | null = null;
// The last stream/element we were asked to boost. Kept so the graph can be wired
// LATER — when the context finally reaches "running" — instead of only at the
// instant the bot's track arrives. See `onCtxStateChange`.
let wantedStream: MediaStream | null = null;
let wantedEl: HTMLAudioElement | null = null;
let listenersBound = false;

/**
 * The graph, measured rather than guessed. Numbers are from an OfflineAudioContext
 * sweep over a real 27 s speech recording peak-normalised
 * across the range TTS actually arrives at, scoring every candidate on loudness gain
 * vs. desktop unity AND on clipped-sample count. See the PR body for the table.
 *
 * The compressor earns its place now. The version that shipped first used
 * `knee: 30` against `threshold: -24`, which puts the soft knee at -24…+6 dBFS —
 * i.e. it never leaves the knee on speech and barely compresses at all (measured:
 * +0.57 dB of reduction on peaks). The `2.5` gain then went straight past full
 * scale: 254,851 of 1.3 M samples — about 20% — hard-clipped at the destination.
 * That is not a small blemish. Clipped speech through a phone's tiny speaker reads
 * as harsh and mushy, and hard clipping does not even buy the loudness it costs:
 * it is why "turn it up" had stopped working on mobile.
 *
 * Narrowing the knee to 6 makes the compressor actually reduce crest factor, which
 * is what makes the following gain safe. The limiter after the gain is the hard
 * guarantee: knee 0, ratio 20, instant attack, ceiling -3 dBFS.
 */
const COMPRESSOR = {
  threshold: -24,
  knee: 6,
  ratio: 12,
  attack: 0.005,
  release: 0.15,
} as const;

/** Make-up gain. 3.5 is the knee of the measured curve — below it loudness is left
 *  on the table, above it the limiter simply eats the extra (4.5 buys +0.2 dB) while
 *  working harder, which is audible as pumping. */
const MOBILE_GAIN = 3.5;

/** Brick wall. Nothing downstream can exceed this, so the graph cannot clip however
 *  hot the TTS arrives — verified 0 clipped samples with the source peak-normalised
 *  anywhere from -6 to -0.1 dBFS. */
const LIMITER = {
  threshold: -3,
  knee: 0,
  ratio: 20,
  attack: 0,
  release: 0.1,
} as const;

/**
 * Is this a phone/tablet, where the platform is holding the level down?
 *
 * Prefers `navigator.userAgentData.mobile` — a real client hint the browser reports
 * about itself, and the definitive answer on the Chromium browsers this most
 * affects. Only when that is absent (Safari/WebKit ships no UA-CH) do we fall back
 * to reading the UA string, plus the iPadOS special case: it reports a desktop UA
 * and has to be told apart by touch points.
 *
 * The `mobile === false` early return matters as much as the true case: it is what
 * keeps a desktop Chrome with a spoofed mobile UA (devtools device mode, a privacy
 * extension) from getting a boost that would make the agent shout.
 */
export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof uaData?.mobile === "boolean") return uaData.mobile;
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  // iPadOS 13+ reports as desktop Safari but has touch points.
  return navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1;
}

function boostDisabled(): boolean {
  if (typeof window === "undefined") return true;
  if ((window as unknown as { __whissleNoAudioBoost?: boolean }).__whissleNoAudioBoost) {
    return true;
  }
  try {
    return new URLSearchParams(window.location.search).get("audioboost") === "0";
  } catch {
    return false;
  }
}

function AudioCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

/**
 * The context is the one piece of state that has to be right, and the browser can
 * take it away at any moment: an AudioContext created before a user gesture starts
 * `suspended`, and a phone that backgrounds the tab, rings, or plugs in headphones
 * suspends a running one mid-call.
 *
 * So the rule this enforces is: *the element is muted only while the graph is
 * actually running*. Anything else — suspended, closed, interrupted — and the
 * element goes back to being the audible sink. Quiet is a bug; silent is a much
 * worse one, and muting the element on a context that never started was the way to
 * get there.
 */
function onCtxStateChange(): void {
  if (!ctx) return;
  if (ctx.state === "running") {
    // Late arrival: wire (or re-wire) whatever we were last asked to boost.
    if (wantedStream) wire(wantedStream, wantedEl);
    return;
  }
  // Not running → the graph is producing nothing. Hand the audio back.
  if (wantedEl) wantedEl.muted = false;
  void ctx.resume().catch(() => {});
}

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  const AC = AudioCtor();
  if (!AC) return null;
  try {
    ctx = new AC();
    ctx.onstatechange = onCtxStateChange;
    void ctx.resume().catch(() => {});
    bindResumeListeners();
    return ctx;
  } catch {
    ctx = null;
    return null;
  }
}

/**
 * A suspended context must not stay suspended for the rest of the call.
 *
 * Two ways back: the tab becoming visible again (the backgrounding case), and the
 * visitor's next touch anywhere on the page (the case where the context was created
 * without an activation to spend). Both are cheap, passive, and idempotent — and
 * both fix a session that is *already* live, which is the point: the boost repairs
 * itself instead of being decided once, at the worst possible moment, and lost.
 */
function bindResumeListeners(): void {
  if (listenersBound || typeof document === "undefined") return;
  listenersBound = true;
  document.addEventListener("visibilitychange", resumeBoostedPlayout);
  for (const ev of ["pointerdown", "touchend", "keydown"] as const) {
    document.addEventListener(ev, resumeBoostedPlayout, { passive: true, capture: true });
  }
}

function unbindResumeListeners(): void {
  if (!listenersBound || typeof document === "undefined") return;
  listenersBound = false;
  document.removeEventListener("visibilitychange", resumeBoostedPlayout);
  for (const ev of ["pointerdown", "touchend", "keydown"] as const) {
    document.removeEventListener(ev, resumeBoostedPlayout, { capture: true });
  }
}

/** Build the graph for `stream` and mute `el`. Caller has checked the context runs. */
function wire(stream: MediaStream, el: HTMLAudioElement | null): boolean {
  if (!ctx) return false;
  try {
    if (source && currentStream === stream) {
      if (el) el.muted = true;
      return true; // already wired for this stream
    }
    if (source) {
      try {
        source.disconnect();
      } catch {
        /* ignore */
      }
      source = null;
    }
    source = ctx.createMediaStreamSource(stream);
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = COMPRESSOR.threshold;
    compressor.knee.value = COMPRESSOR.knee;
    compressor.ratio.value = COMPRESSOR.ratio;
    compressor.attack.value = COMPRESSOR.attack;
    compressor.release.value = COMPRESSOR.release;
    const gain = ctx.createGain();
    gain.gain.value = MOBILE_GAIN;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;
    // A tap, not a stage — an AnalyserNode has no effect on what it observes, and
    // this one is never connected onward. It is how `boostDiagnostics()` can report
    // the real output level from a real phone instead of us inferring it.
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    source.connect(compressor);
    compressor.connect(gain);
    gain.connect(limiter);
    limiter.connect(ctx.destination);
    limiter.connect(analyser);

    currentStream = stream;
    if (el) el.muted = true; // WebAudio drives output now; avoid double playback
    return true;
  } catch (err) {
    console.warn("[mobile-audio] boosted playout unavailable, using element:", err);
    if (el) el.muted = false;
    currentStream = null;
    source = null;
    analyser = null;
    return false;
  }
}

/** Create + resume the playback AudioContext from inside the connect user gesture.
 *  Starting it on the gesture means it is already running by the time the bot's
 *  first words arrive, rather than racing them. No-op on desktop / when disabled. */
export function primeBoostedPlayout(): void {
  if (!isMobileBrowser() || boostDisabled()) return;
  // Readable from a phone over remote devtools — the only way to check the graph
  // on the hardware that has the problem.
  (window as unknown as { __whissleAudioBoost?: unknown }).__whissleAudioBoost =
    boostDiagnostics;
  ensureCtx();
}

/** Route `stream` through the boosted graph to the speakers and mute the fallback
 *  `<audio>` element. Returns true when the boosted path is driving audio (element
 *  muted); false means the element is playing it, at normal volume.
 *
 *  A false here is not final. The stream and element are remembered, so if the
 *  context is still starting — or is suspended, or gets suspended later — the graph
 *  is wired the moment it runs, without needing another track event.
 *
 *  Safe to call repeatedly (e.g. on element remount) — it rewires only when the
 *  stream changes and no-ops otherwise. */
export function attachBoostedPlayout(
  stream: MediaStream,
  el: HTMLAudioElement | null,
): boolean {
  if (!isMobileBrowser() || boostDisabled()) return false;
  wantedStream = stream;
  wantedEl = el;
  const c = ensureCtx();
  if (!c) return false;
  if (c.state !== "running") {
    // Keep the element audible meanwhile — quiet beats silent — and let
    // `onCtxStateChange` upgrade to the boosted path as soon as it can.
    if (el) el.muted = false;
    void c.resume().catch(() => {});
    return false;
  }
  return wire(stream, el);
}

/** Resume the context after a backgrounding / interruption. Bound to visibility and
 *  the next gesture automatically; exported for callers that know of another moment
 *  worth retrying on. No-op on desktop. */
export function resumeBoostedPlayout(): void {
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
}

/** What the boost is actually doing, from the device it is doing it on.
 *  `rmsDb` is measured off a tap on the graph's output — the number to read when
 *  checking a real phone rather than trusting the graph on paper. */
export function boostDiagnostics(): {
  active: boolean;
  state: AudioContextState | "none";
  gain: number;
  rmsDb: number | null;
} {
  const active = !!(ctx && ctx.state === "running" && source);
  let rmsDb: number | null = null;
  if (analyser) {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    rmsDb = rms <= 1e-9 ? -Infinity : 20 * Math.log10(rms);
  }
  return { active, state: ctx ? ctx.state : "none", gain: MOBILE_GAIN, rmsDb };
}

/** Tear the graph down at disconnect so a stale source can't linger. */
export function teardownBoostedPlayout(): void {
  if (source) {
    try {
      source.disconnect();
    } catch {
      /* ignore */
    }
  }
  // Give the element its voice back on the way out. The graph is what muted it,
  // and once the graph is gone a still-muted element is a silent next session —
  // which is exactly what happens if the boost is disabled (kill switch, a
  // desktop reload) between one call and the next.
  if (wantedEl) wantedEl.muted = false;
  source = null;
  analyser = null;
  currentStream = null;
  wantedStream = null;
  wantedEl = null;
  unbindResumeListeners();
  if (ctx) {
    ctx.onstatechange = null;
    void ctx.close().catch(() => {});
    ctx = null;
  }
}
