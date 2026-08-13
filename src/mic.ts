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

/** Why the microphone isn't usable, and what to do about it. `null` means it is. */
export type MicProblem =
  | { code: "unsupported"; message: string }
  | { code: "denied"; message: string }
  | { code: "in-use"; message: string }
  | { code: "not-found"; message: string }
  | { code: "muted"; message: string }
  | { code: "unknown"; message: string };

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
        code: "denied",
        message:
          "Your browser is blocking the microphone for this site. Click the blocked-mic icon " +
          "(or the padlock) at the right of the address bar, choose Allow, then reload.",
      };
    }
    if (name === "NotReadableError" || name === "AbortError") {
      return {
        code: "in-use",
        message:
          "Another app is using your microphone, so this tab can't. Close it (Zoom, Meet, or " +
          "any recording app) and try again.",
      };
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return {
        code: "not-found",
        message: "No microphone found. Plug one in or pick a different input, then try again.",
      };
    }
    return {
      code: "unknown",
      message: `We couldn't open your microphone (${name || "unknown error"}).`,
    };
  }
  const track = stream.getAudioTracks()[0];
  const problem: MicProblem | null = !track
    ? { code: "unknown", message: "Your browser gave us no microphone track at all." }
    : track.readyState !== "live"
      ? {
          code: "in-use",
          message:
            "Your microphone closed as soon as we opened it — another app may have taken it.",
        }
      : track.muted
        ? {
            code: "muted",
            message: "Your microphone is muted at the system level. Unmute it and try again.",
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
