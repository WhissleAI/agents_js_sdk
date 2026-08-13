// Microphone checks and device selection.
//
// The failure this exists to prevent: the visitor hears the greeting, talks, and
// nothing happens — for the whole session. From inside the page it is invisible.
// `PipecatClient({enableMic: true})` runs its own `getUserMedia`, and when that fails
// it does not reliably throw out of `connect()`, so the session comes UP with no
// inbound audio. The server sees zero frames; the visitor sees a connected widget that
// ignores them. Asking for the microphone ourselves first turns that into a sentence
// before the call starts.
//
// Deliberately NOT a loudness test. Someone who hasn't started talking yet is silent,
// and failing them for it would be worse than the bug. Whether the audio is actually
// carrying speech is watched server-side and arrives as `{t:"mic_dead"}` mid-session.

/**
 * How sure we are that this is really broken.
 *
 * `blocking` means the microphone demonstrably cannot deliver audio: permission was
 * refused, the device is gone, another app holds it, the browser has no API at all.
 * Refusing to start a session on one of those is right — the session would come up
 * deaf, which is the failure this module exists to prevent.
 *
 * `warning` means something looks off but a working microphone can look exactly the
 * same. Those are reported and never fatal, because a preflight that is on by default
 * and refuses a working microphone is worse than the bug it prevents.
 */
export type MicSeverity = "blocking" | "warning";

/** Why the microphone isn't usable, and what to do about it. `null` means it is. */
export type MicProblem = { severity: MicSeverity } & (
  | { code: "unsupported"; message: string }
  | { code: "denied"; message: string }
  | { code: "in-use"; message: string }
  | { code: "not-found"; message: string }
  | { code: "muted"; message: string }
  | { code: "unknown"; message: string }
);

/**
 * How long to let a freshly-opened track settle before believing `muted`.
 *
 * Per spec `MediaStreamTrack.muted` means "not currently providing data", which is
 * ordinarily true for the first moments of any track's life — it flips to false with
 * the first sample, via an `unmute` event. Several browsers report it true right out
 * of `getUserMedia`. Judging it synchronously therefore fails perfectly good hardware,
 * and this waits for the first sample instead. 400 ms is far longer than the gap in
 * practice and short enough to be invisible inside a connect that takes seconds.
 */
const MUTE_GRACE_MS = 400;

/** Resolve once the track reports data, or when the grace runs out. */
function settled(track: MediaStreamTrack): Promise<void> {
  if (!track.muted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      track.removeEventListener("unmute", done);
      resolve();
    };
    const timer = setTimeout(done, MUTE_GRACE_MS);
    track.addEventListener("unmute", done);
  });
}

/**
 * Open the microphone, look at the track, hand it straight back.
 *
 * Every message names the fix rather than the fault. "Permission denied" is a
 * diagnosis; "click the padlock, choose Allow, then reload" is something the visitor
 * can actually do, and it is the difference between a widget that gets used and one
 * that gets closed.
 */
export async function checkMicrophone(): Promise<MicProblem | null> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return {
      severity: "blocking",
      code: "unsupported",
      message:
        "This browser can't reach a microphone. Try Chrome, Edge or Safari — and note that " +
        "microphone access needs the page to be served over HTTPS.",
    };
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      return {
        severity: "blocking",
        code: "denied",
        message:
          "Your browser is blocking the microphone for this site. Click the blocked-mic icon " +
          "(or the padlock) at the right of the address bar, choose Allow, then reload.",
      };
    }
    if (name === "NotReadableError" || name === "AbortError") {
      return {
        severity: "blocking",
        code: "in-use",
        message:
          "Another app is using your microphone, so this tab can't. Close it (Zoom, Meet, or " +
          "any recording app) and try again.",
      };
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return {
        severity: "blocking",
        code: "not-found",
        message: "No microphone found. Plug one in or pick a different input, then try again.",
      };
    }
    return {
      severity: "blocking",
      code: "unknown",
      message: `We couldn't open your microphone (${name || "unknown error"}).`,
    };
  }
  const track = stream.getAudioTracks()[0];
  // Give a live track a moment to produce its first sample before reading `muted`.
  // Without this the check fails hardware that is about to work perfectly — see
  // MUTE_GRACE_MS.
  if (track && track.readyState === "live") await settled(track);
  const problem: MicProblem | null = !track
    ? {
        severity: "blocking",
        code: "unknown",
        message: "Your browser gave us no microphone track at all.",
      }
    : track.readyState !== "live"
      ? {
          severity: "blocking",
          code: "in-use",
          message:
            "Your microphone closed as soon as we opened it — another app may have taken it.",
        }
      : track.muted
        ? {
            // A WARNING, never fatal. `muted` still true after the grace usually does
            // mean a system-level mute — but it can equally be a browser that never
            // clears the flag on an input that is working, and we cannot tell the two
            // apart from here. The server watches whether audio is actually arriving
            // and says so mid-session ({t:"mic_dead"}), which is the check that can
            // tell, so this one only has to be honest about its own uncertainty.
            severity: "warning",
            code: "muted",
            message:
              "Your microphone reports itself muted. If you hear no response, unmute it " +
              "in your system sound settings and try again.",
          }
        : null;
  // Hand it back immediately. The transport opens its own, and holding this one would
  // make us the app that is holding the microphone — the exact thing the "in-use"
  // message above tells people to go and close.
  for (const t of stream.getTracks()) t.stop();
  return problem;
}

/**
 * The microphones this browser will admit to.
 *
 * Before permission is granted a browser returns one unlabelled placeholder, so a
 * picker built from this list before `start()` is a menu of nothing. Call it after the
 * session is up (or after `checkMicrophone()`), when the labels are real.
 */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "audioinput");
  } catch {
    return [];
  }
}
