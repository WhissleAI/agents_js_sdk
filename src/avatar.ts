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
   *
   * Pass a `<video>` ELEMENT (rather than a container to append into) and the
   * SDK renders straight into yours instead of making its own. That is the hook
   * for an app that has to own the element — one doing chroma-key compositing,
   * a custom frame, or anything else that has to be the thing on screen.
   */
  container?: string | HTMLElement | HTMLVideoElement;
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
  /**
   * Re-pace the incoming PCM to real time before handing it to Simli
   * (default `true`).
   *
   * The bot mirrors its TTS at a steady ~187 ms cadence, but that cadence does
   * not survive the trip: the audio rides the same output queue as the WebRTC
   * track (so a burst is released whenever the track's send buffer has room)
   * and then a reliable, ordered data channel, which holds everything behind a
   * lost packet and delivers the backlog in one go. Simli consumes a *real-time*
   * stream, so a second of audio arriving in a millisecond is what makes the
   * face stutter. Set `false` to hand chunks straight through (the 0.2.0
   * behaviour) — useful only for A/B'ing this.
   */
  pacing?: boolean;
}

/**
 * Simli's own tested default buffer (3000 samples / ~187 ms @ 16 kHz). Do not
 * lower it: 1800 made lip-sync drift wholesale in the app this is ported from.
 */
const AUDIO_BUFFER_SIZE = 3000;

/** 16 kHz, Int16, mono — so one millisecond of audio is 32 bytes. */
const BYTES_PER_MS = 32;

/**
 * How fast we are willing to hand audio over, as a multiple of real time.
 *
 * NOT 1.0, and the measurement is why. Chunk arrivals on a live session look
 * like this (ms between 187.5 ms chunks):
 *
 *   143 188 188 187 | 257 392 367 400 441 399 401 481 362 478 401 | 82 66 1 68 1 1 1 67 0 0 0 0 0 22 | 188 189 188
 *   ^ real time     ^ four seconds at half speed                  ^ 2.6 s of audio in 310 ms          ^ recovered
 *
 * So the stream does not merely arrive early — it alternates starving and
 * dumping. A strict 1× metronome would fix only the dump: during the starve our
 * queue is empty, we can release nothing, and Simli runs dry exactly as it does
 * today. What keeps a face fed across a stall is a cushion, and the only chance
 * to build one is the dump.
 *
 * So: release faster than real time, but nowhere near as fast as the dump. At
 * 1.5× the 310 ms dump above becomes a ~1.7 s ramp, Simli ends it holding ~0.9 s
 * of cushion, and the next stall comes out of that cushion instead of out of the
 * user's ears.
 */
const RELEASE_RATE = 1.5;

/**
 * Audio we will hand over with no rate limit at all, at the start of a run or
 * after a stall — two chunks. Simli must never be waiting on us when it has
 * nothing to play, and these would have gone out immediately anyway.
 */
const BURST_MS = 375;

/**
 * Hard ceiling on the queue.
 *
 * Deliberately very generous, because dropping costs the listener words and
 * this queue costs them nothing: releasing at 1.5× means we always out-run
 * playback, so a backlog is handed over before Simli can reach the end of it
 * and the audio is heard at the same moment either way. A live session was
 * measured handing over a 10.1 s backlog in one go — the gateway had fallen
 * twelve seconds behind real time and then caught up all at once — so anything
 * tighter than this drops real speech.
 *
 * Thirty seconds of backlog means the browser has stopped running our timer
 * while the tab was visible. At that point the face is a lost cause and staying
 * near the live edge is the better trade.
 */
const MAX_BACKLOG_MS = 30_000;

/** What the avatar's audio path is doing. Read it off `agent.avatarAudioStats`. */
export interface AvatarAudioStats {
  /** Chunks handed to us by the transport. */
  received: number;
  /** Chunks forwarded to Simli. */
  sent: number;
  /** Chunks dropped because the backlog blew past `MAX_BACKLOG_MS`. */
  dropped: number;
  /** Chunks thrown away by a barge-in flush. */
  flushed: number;
  /** Milliseconds of audio waiting to be forwarded right now. */
  queuedMs: number;
  /**
   * The deepest the queue ever got, in ms of audio. This is the burst detector:
   * a healthy real-time feed never exceeds one chunk, so anything above ~200 ms
   * is audio that arrived early and got smoothed instead of stuttering.
   */
  maxQueuedMs: number;
}

/**
 * Smooths PCM out to Simli instead of relaying it in dumps.
 *
 * Simli's native input is a real-time stream (its own worklet feeds it one
 * `audioBufferSize` chunk per chunk-duration, clocked by WebAudio) and it
 * visibly dislikes anything else — a burst has to be re-timed on its end, which
 * is what smears the visemes. Nothing between the bot's TTS and this class
 * preserves the cadence, so this puts it back.
 *
 * It is a token bucket, not a metronome: `playheadMs` (audio released since
 * `t0`) may run up to `RELEASE_RATE` × the wall clock, plus a `burstMs`
 * allowance. Faster than real time on purpose — see `RELEASE_RATE` — so that a
 * dump both stops being a dump AND leaves Simli a cushion for the next stall.
 *
 * The schedule is *absolute* rather than one timeout per chunk, which is what
 * makes it safe in a background tab: when the browser throttles timers to ~1 Hz
 * the wake-up finds a second of allowance accrued and releases all of it,
 * degrading to plain pass-through instead of starving Simli behind a queue that
 * only grows.
 */
export class PacedPcmQueue {
  private queue: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Wall clock this run started at. */
  private t0 = 0;
  /** Audio released since `t0`, in ms — the thing the bucket rate-limits. */
  private playheadMs = 0;
  private queuedMs = 0;
  private readonly stats: AvatarAudioStats = {
    received: 0,
    sent: 0,
    dropped: 0,
    flushed: 0,
    queuedMs: 0,
    maxQueuedMs: 0,
  };

  constructor(
    private readonly sink: (chunk: Uint8Array) => void,
    private readonly clock: () => number = defaultClock,
    private readonly isHidden: () => boolean = defaultHidden,
    private readonly burstMs: number = BURST_MS,
    private readonly maxBacklogMs: number = MAX_BACKLOG_MS,
    private readonly rate: number = RELEASE_RATE,
  ) {}

  /** Audio we are still allowed to release right now, in ms. */
  private allowanceMs(now: number): number {
    return (now - this.t0) * this.rate + this.burstMs - this.playheadMs;
  }

  /** A snapshot — safe to hand to a caller, who can't mutate our counters. */
  snapshot(): AvatarAudioStats {
    return { ...this.stats, queuedMs: this.queuedMs };
  }

  push(chunk: Uint8Array): void {
    if (this.stopped || chunk.length === 0) return;
    this.stats.received++;
    this.queue.push(chunk);
    this.queuedMs += durationMs(chunk);
    if (this.queuedMs > this.stats.maxQueuedMs) this.stats.maxQueuedMs = this.queuedMs;
    if (this.queuedMs > this.maxBacklogMs) this.trim();
    // Cap the bucket. Without this an idle stretch accrues unlimited allowance
    // and the first burst after it goes straight through — which is also what
    // keeps the steady state (one chunk arriving per chunk-duration, source
    // slower than the limit) pure pass-through: zero added latency, no drift.
    const now = this.clock();
    if (this.allowanceMs(now) > this.burstMs) {
      this.t0 = now;
      this.playheadMs = 0;
    }
    this.drain();
  }

  /**
   * Throw away everything queued — the caller interrupted the bot.
   *
   * Without this the avatar would go on mouthing the sentence it was cut off
   * mid-way through, for as long as our queue was deep.
   */
  flush(): void {
    this.stats.flushed += this.queue.length;
    this.queue = [];
    this.queuedMs = 0;
    // Simli is being told to drop its buffer too, so the next turn starts from
    // an empty pipe on both ends.
    this.t0 = this.clock();
    this.playheadMs = 0;
    this.clearTimer();
  }

  stop(): void {
    this.stopped = true;
    this.flush();
  }

  /**
   * Over the ceiling: drop the OLDEST audio.
   *
   * Simli plays what we send it, in order, at real time — so a deep queue means
   * the face is behind the conversation, and the way back in sync is to skip
   * ahead. Dropping the newest instead would keep the avatar reciting stale
   * audio and push it further behind on every overflow, and the newest chunks
   * are the ones the listener is about to need.
   */
  private trim(): void {
    while (this.queuedMs > this.maxBacklogMs && this.queue.length > 1) {
      const gone = this.queue.shift()!;
      this.queuedMs -= durationMs(gone);
      this.stats.dropped++;
    }
    // What survived is already late; pacing it from the old `t0` would keep it
    // late forever. Restart the clock so the survivors go out now.
    this.t0 = this.clock();
    this.playheadMs = 0;
  }

  private drain = (): void => {
    this.clearTimer();
    if (this.stopped) return;
    // A hidden tab throttles timers to ~1 Hz. Pacing under that would underrun
    // Simli and pile up a queue — and nobody is looking at the face anyway, so
    // hand everything over and let Simli do the timing.
    const hidden = this.isHidden();
    const now = this.clock();
    while (this.queue.length && (hidden || this.allowanceMs(now) >= 0)) {
      const chunk = this.queue.shift()!;
      this.queuedMs -= durationMs(chunk);
      this.playheadMs += durationMs(chunk);
      this.stats.sent++;
      this.sink(chunk);
    }
    if (!this.queue.length) return;
    // Wake when the bucket has refilled enough for the next chunk. The loop
    // above only exits with a negative allowance, so this is strictly positive
    // — no busy-spin.
    const wait = Math.max(0, -this.allowanceMs(this.clock()) / this.rate);
    this.timer = setTimeout(this.drain, wait);
  };

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** How long `chunk` takes to speak. */
function durationMs(chunk: Uint8Array): number {
  return chunk.length / BYTES_PER_MS;
}

/** Monotonic where we can get it — a clock that can step backwards would stall. */
function defaultClock(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function defaultHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

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
  /** Re-times the PCM to real time. `null` when the caller opted out. */
  private readonly pacer: PacedPcmQueue | null;

  constructor(video?: HTMLVideoElement, pacing = true) {
    this.pacer = pacing ? new PacedPcmQueue((chunk) => this.forward(chunk)) : null;
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

  /**
   * Preferred input — clean 16 kHz Int16 PCM mirrored from the bot's TTS.
   *
   * Queued rather than forwarded: see `PacedPcmQueue`. The chunks reach us in
   * bursts, and Simli wants them at the rate they are spoken.
   */
  sendPcm(bytes: Uint8Array): void {
    if (this.destroyed || !this.client || !this.started || this.usingTrack) return;
    this.gotPcm = true;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.pacer) this.pacer.push(bytes);
    else this.forward(bytes);
  }

  /** The one place PCM actually crosses into simli-client. */
  private forward(bytes: Uint8Array): void {
    if (this.destroyed || !this.client || this.usingTrack) return;
    try {
      this.client.sendAudioData(bytes);
    } catch {
      /* one dropped chunk is not worth killing the session over */
    }
  }

  /** What the audio path is doing — burst depth, drops, backlog. */
  get audioStats(): AvatarAudioStats | null {
    return this.pacer?.snapshot() ?? null;
  }

  /**
   * Drop queued audio — the caller was interrupted.
   *
   * Ours first: telling Simli to drop its buffer while we still hold half a
   * sentence would just refill it, and the avatar would talk over the user.
   */
  clearBuffer(): void {
    this.pacer?.flush();
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
    this.pacer?.stop();
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
