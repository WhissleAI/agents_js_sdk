/* ─────────────────────────────────────────────────────────────────────────────
   The microphone tap.

   "Can it hear me?" is the first question anyone asks of a voice agent, and until
   now this page answered it the same way every voice widget does: by saying nothing
   until a transcript happens to appear. That is indistinguishable from a broken
   session, and a silent failure is exactly what filmed a dead demo.

   So the console watches the microphone directly — and specifically the TRACK THE
   SESSION IS PUBLISHING, not a second `getUserMedia` of the same device. Two capture
   streams of one device can differ (one gets the echo-cancelled feed, one doesn't), so
   a meter on a second stream can happily bounce while the session hears silence. The
   only honest meter is on the track that is actually going out.

   Getting at it means wrapping `navigator.mediaDevices.getUserMedia`: the SDK opens
   the mic itself, several times (a preflight that stops what it opened, then the real
   one). The wrapper hands every request straight through to the browser — nothing is
   faked, nothing is substituted — and keeps a reference to whatever came back.
   ──────────────────────────────────────────────────────────────────────────── */

export function installMicTap() {
  const listeners = new Set();
  const state = {
    source: "microphone",     // "microphone" | "rehearsal"
    track: null,
    label: null,
    deviceId: null,
    readyState: null,
    muted: null,
    permission: "unknown",    // "granted" | "denied" | "prompt" | "unknown"
    level: 0,                 // 0..1, RMS of the last analyser frame
    peak: 0,                  // decaying peak, so a meter reads at 30fps
    silentSince: null,        // ms timestamp the level last went quiet
    everHeard: false,         // has this track EVER produced a sample above the floor
    error: null,
  };

  const notify = () => listeners.forEach((fn) => fn(state));

  let ctx = null;
  let analyser = null;
  let node = null;
  let buf = null;

  function meter(track) {
    try {
      ctx = ctx ?? new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume?.();
      node?.disconnect();
      node = ctx.createMediaStreamSource(new MediaStream([track]));
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.4;
      buf = new Float32Array(analyser.fftSize);
      node.connect(analyser);
      // Deliberately NOT connected to the destination: metering the mic must never
      // put the microphone into the speakers.
    } catch (err) {
      state.error = `Could not meter the input: ${err?.message ?? err}`;
    }
  }

  function attach(track, source) {
    if (!track || track === state.track) return;
    state.track = track;
    state.source = source ?? state.source;
    const s = track.getSettings?.() ?? {};
    state.deviceId = s.deviceId ?? null;
    state.label = track.label || null;
    state.readyState = track.readyState;
    state.muted = track.muted;
    state.everHeard = false;
    state.silentSince = performance.now();
    state.error = null;
    track.addEventListener?.("ended", () => { state.readyState = "ended"; notify(); });
    track.addEventListener?.("mute", () => { state.muted = true; notify(); });
    track.addEventListener?.("unmute", () => { state.muted = false; notify(); });
    meter(track);
    notify();
  }

  // The wrapper. Everything goes to the real browser API; we only keep the result.
  const original = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (original) {
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      try {
        const stream = await original(constraints);
        const track = stream.getAudioTracks?.()[0];
        // A track the SDK is about to stop (its preflight) still tells us the device
        // name and that permission was granted, so attach it either way — the next
        // one replaces it.
        if (track) { state.permission = "granted"; attach(track, "microphone"); }
        return stream;
      } catch (err) {
        state.permission = err?.name === "NotAllowedError" ? "denied" : state.permission;
        state.error = describe(err);
        notify();
        throw err;
      }
    };
  }

  // Ask the browser what it already knows, before anything opens the device.
  navigator.permissions?.query?.({ name: "microphone" })
    .then((p) => {
      state.permission = p.state;
      p.onchange = () => { state.permission = p.state; notify(); };
      notify();
    })
    .catch(() => {});

  /** Sample the analyser. Called from the console's frame loop, not its own. */
  function sample(now) {
    if (!analyser || !state.track) return state;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    state.level = rms;
    state.peak = Math.max(rms, state.peak * 0.9);
    // -60 dBFS. Below this a room with a live microphone in it is indistinguishable
    // from a track that is producing nothing at all.
    if (rms > 0.001) { state.everHeard = true; state.silentSince = null; }
    else if (state.silentSince == null) state.silentSince = now;
    state.readyState = state.track.readyState;
    state.muted = state.track.muted;
    return state;
  }

  return {
    state,
    sample,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Called by the rehearsal harness so the strip can shout about itself. */
    setSource(source, track) { state.source = source; if (track) attach(track, source); notify(); },
    async devices() {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        return all.filter((d) => d.kind === "audioinput");
      } catch { return []; }
    },
    restore() { if (original) navigator.mediaDevices.getUserMedia = original; },
  };
}

/** Browser mic failures, in words with the fix in them. */
export function describe(err) {
  const name = err?.name ?? "";
  if (name === "NotAllowedError")
    return "Chrome blocked the microphone. Click the camera/mic icon at the right of the address bar, choose Allow, then reload.";
  if (name === "NotFoundError") return "No microphone found. Plug one in, or pick another input device.";
  if (name === "NotReadableError")
    return "Another app is holding the microphone (Zoom, Meet, QuickTime). Quit it and press Start again.";
  if (name === "OverconstrainedError") return "That input device is no longer available. Pick another one.";
  return err?.message ? String(err.message) : "The microphone could not be opened.";
}
