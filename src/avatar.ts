// Type-only: erased at build time, so the runtime import below stays lazy.
import type { SimliClient as SimliClientInstance } from "simli-client/dist/client.js";

/** What `POST /api/embed/simli-token` returns. */
export interface AvatarMint {
  session_token: string;
  ice_servers?: RTCIceServer[] | null;
  face_id?: string;
}

export interface AvatarOptions {
  /**
   * Avatar code from the Whissle catalog — `F1-HR`, `F2-TL`, `F3-SE`, `M1-HR`,
   * `M2-TL`, `M3-SE` (see `GET /api/avatars`). Omit to use whichever avatar the
   * agent itself is configured with.
   */
  id?: string;
  /**
   * Where to put the `<video>`. A CSS selector or an element. Omit and the SDK
   * creates the element but attaches it to nothing — read `agent.videoElement`
   * (or the `avatar-ready` payload) and place it yourself.
   */
  container?: string | HTMLElement;
  /**
   * Treat an avatar failure as a session failure. Default `false`: if the avatar
   * can't be minted or started, the conversation still connects **audio-only**
   * and you get an `avatar-failed` event saying why. A dead session is never the
   * right answer to a missing face.
   */
  required?: boolean;
  /**
   * How long to wait for the face before giving up on it and connecting
   * audio-only (default 15 s). The face comes up BEFORE the conversation, so
   * this is also the worst case the caller waits to hear anything — an avatar
   * that is slow to connect must not be able to hold the whole session hostage.
   */
  timeoutMs?: number;
}

/**
 * Simli's own tested default buffer (3000 samples / ~187 ms @ 16 kHz). Do not
 * lower it: 1800 made lip-sync drift wholesale in the app this is ported from.
 */
const AUDIO_BUFFER_SIZE = 3000;

/**
 * How long to wait for clean PCM before falling back to piping the WebRTC track.
 *
 * The backend mirrors the bot's TTS as `{"t":"simli-audio"}` app messages when
 * the session runs with `avatar_render=client`, and that is much better input
 * than the track (which reaches us Opus-decoded and resampled to ~48 kHz, so the
 * visemes barely move). But an older gateway won't send it at all, and dead lips
 * with no fallback is worse than mediocre lips. So: wait, then fall back — and
 * once we've fallen back, never mix the two inputs, which garbles both.
 */
const PCM_GRACE_MS = 14_000;

type SimliCtor = typeof import("simli-client/dist/client.js").SimliClient;

let simliCtor: Promise<SimliCtor> | null = null;

/**
 * Load simli-client lazily, from the concrete module rather than the package
 * barrel — see `src/vendor.d.ts` for why the barrel is unusable. Cached, so a
 * second avatar session doesn't re-fetch the chunk.
 */
function loadSimli(): Promise<SimliCtor> {
  if (!simliCtor) {
    simliCtor = import("simli-client/dist/client.js").then((mod) => {
      const ctor =
        mod?.SimliClient ??
        (mod as unknown as { default?: { SimliClient?: SimliCtor } })?.default?.SimliClient;
      if (!ctor) throw new Error("simli-client loaded but exported no SimliClient");
      return ctor;
    });
    // A failed load must not poison every later attempt.
    simliCtor.catch(() => {
      simliCtor = null;
    });
  }
  return simliCtor;
}

/** Normalize the three shapes `avatar` accepts into one. */
export function normalizeAvatar(
  avatar: string | boolean | AvatarOptions | undefined,
): AvatarOptions | null {
  if (!avatar) return null;
  if (avatar === true) return {};
  if (typeof avatar === "string") return { id: avatar };
  return avatar;
}

/**
 * A browser-rendered Simli avatar for one session.
 *
 * The architecture is deliberately browser-direct: Whissle mints a short-lived
 * Simli session token server-side (so `SIMLI_API_KEY` never reaches the page),
 * and the browser opens its own connection to Simli and renders the video. Our
 * node does zero video codec.
 */
export class SimliAvatar {
  readonly video: HTMLVideoElement;
  /** Simli plays its lip-synced audio here. Detached from the DOM on purpose. */
  private readonly audio: HTMLAudioElement;
  private client: SimliClientInstance | null = null;
  private started = false;
  private destroyed = false;
  private pendingTrack: MediaStreamTrack | null = null;
  private usingTrack = false;
  private gotPcm = false;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(video?: HTMLVideoElement) {
    this.video = video ?? document.createElement("video");
    this.video.autoplay = true;
    this.video.playsInline = true;
    // The face's own audio comes from `this.audio`; a video element that also
    // played it would double every word.
    this.video.muted = true;
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
  }

  /** Open the Simli session. Resolves when the face is live. */
  async start(mint: AvatarMint): Promise<void> {
    const SimliClient = await loadSimli();
    if (this.destroyed) return;

    const client = new SimliClient(
      mint.session_token,
      this.video,
      this.audio,
      mint.ice_servers ?? null,
      // Take the SDK's defaults for logLevel / transport / signaling / ws URL;
      // only the trailing audioBufferSize is ours.
      undefined,
      undefined,
      undefined,
      undefined,
      AUDIO_BUFFER_SIZE,
    );
    this.client = client;

    // simli-client only reports the session live from a `requestVideoFrameCallback`
    // on this element — i.e. once a frame has actually been PAINTED. A video that
    // never starts playing therefore never reports ready, and the SDK gives up
    // with "CONNECTION TIMED OUT" while the media is flowing perfectly. So kick
    // playback the moment there is anything to play, rather than waiting for a
    // ready signal that is itself waiting on playback.
    const play = () => {
      void this.video.play().catch(() => undefined);
      void this.audio.play().catch(() => undefined);
    };
    this.video.addEventListener("loadedmetadata", play);
    this.video.addEventListener("loadeddata", play);
    this.audio.addEventListener("loadeddata", play);

    let failure: string | null = null;
    client.on("start", () => {
      this.started = true;
      if (this.pendingTrack) {
        const track = this.pendingTrack;
        this.pendingTrack = null;
        this.attachTrack(track);
      }
      play();
    });
    const fail = (...args: unknown[]) => {
      failure = String(args[0] ?? "simli error");
    };
    client.on("error", fail);
    client.on("startup_error", fail);

    // Resolves when the face is live; rejects (after its own retries) otherwise.
    await client.start();
    if (failure) throw new Error(failure);
    this.started = true;
    play();
  }

  /**
   * Arm the track fallback. Called once the session is connected: if no clean
   * PCM has arrived by then + `PCM_GRACE_MS`, pipe the WebRTC audio track in
   * instead so the face at least moves.
   */
  armTrackFallback(getTrack: () => MediaStreamTrack | null): void {
    if (this.fallbackTimer || this.destroyed) return;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (this.destroyed || this.gotPcm || this.usingTrack) return;
      const track = getTrack();
      if (track) this.attachTrack(track);
    }, PCM_GRACE_MS);
  }

  /** Fallback input. Never called once PCM has arrived — mixing them garbles both. */
  attachTrack(track: MediaStreamTrack): void {
    if (this.destroyed || this.gotPcm) return;
    if (!this.client || !this.started) {
      this.pendingTrack = track;
      return;
    }
    try {
      this.client.listenToMediastreamTrack(track);
      this.usingTrack = true;
    } catch {
      this.pendingTrack = track;
    }
  }

  /** Preferred input — clean 16 kHz Int16 PCM mirrored from the bot's TTS. */
  sendPcm(bytes: Uint8Array): void {
    if (this.destroyed || !this.client || !this.started || this.usingTrack) return;
    this.gotPcm = true;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    try {
      this.client.sendAudioData(bytes);
    } catch {
      /* one dropped chunk is not worth killing the session over */
    }
  }

  /** Drop Simli's queued audio — the caller was interrupted. */
  clearBuffer(): void {
    if (this.destroyed || !this.client || !this.started) return;
    try {
      this.client.ClearBuffer();
    } catch {
      /* ignore */
    }
  }

  /** End the Simli session and release the media elements. */
  async destroy(): Promise<void> {
    this.destroyed = true;
    this.pendingTrack = null;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    const client = this.client;
    this.client = null;
    try {
      // `stop()`, NOT `close()` — simli-client@3 has no close(), so calling it
      // throws into a swallowing catch and leaves the session billing until
      // maxIdleTime expires.
      await client?.stop();
    } catch {
      /* already gone */
    }
    try {
      this.audio.pause();
      this.audio.srcObject = null;
      this.video.srcObject = null;
    } catch {
      /* ignore */
    }
  }
}

/** Base64 → bytes, for the `simli-audio` app message. */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
