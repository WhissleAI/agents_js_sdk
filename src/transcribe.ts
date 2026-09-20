// Whissle's metadata speech-to-text, driven from a browser.
//
// ── Read this before you use it: the browser cannot hold the key ──────────────
//
// Whissle's own ASR — the emotion / intent / entity heads that are the reason to
// buy this rather than a transcription API — went self-serve on 2026-09-20. The
// streaming door is a WebSocket that takes its credential as a QUERY PARAMETER,
// precisely because a browser cannot set a header on a WebSocket. That looks like
// an invitation to put the key in a page. It is not.
//
// The scope that opens it is `models:invoke`, and a publishable (`wpk_`) key can
// never carry it. The platform caps a publishable key's scopes to
// `{sessions:write, embed:mint, chat:invoke, agents:read}` and enforces the cap at
// AUTHENTICATION time, not just when the key is minted — so even a key wrongly
// issued with `models:invoke` is refused at the door
// (`pipecat-bot/services/api_keys.py`, `PUBLISHABLE_MAX_SCOPES` /
// `cap_publishable_scopes`). The ASR gateway lets a `wpk_` through to that refusal
// deliberately, so the developer gets "your key is missing models:invoke" rather
// than "API token required" (`agent/gateway/platform_auth.py`).
//
// So the only credential that opens this socket is a `wsk_` workspace SECRET key,
// which must never reach a browser. And unlike a voice session, there is NO
// short-lived token to mint in its place: the door accepts exactly a `wsk_`, a
// legacy `wh_`, or the gateway's internal secret, and nothing else
// (`agent/gateway/auth.py`, `authenticate_ws_token`). There is no ASR equivalent
// of `POST /api/embed/session-token`.
//
// ── What this module therefore is ────────────────────────────────────────────
//
// It does not hold a credential and it will not build a Whissle URL for you. You
// give it a URL; in production that is a WebSocket endpoint on YOUR server, which
// holds the `wsk_` and relays to Whissle. What this module owns is the part that
// is genuinely the browser's problem and genuinely fiddly:
//
//   * opening the microphone and keeping the track alive,
//   * resampling whatever rate the hardware gave you down to the 16 kHz mono
//     signed-16-bit little-endian PCM the engine requires,
//   * the config frame, the framing, and the `{"type":"end"}` flush,
//   * turning the event stream into typed transcripts instead of `any`.
//
// Passing a `wsk_` here throws, the same way `WhissleAgent` refuses one.
//
// ── Not to be confused with `listen()` ───────────────────────────────────────
//
// This SDK exports both `transcribe()` and `listen()` and they are different
// products that happen to both involve a microphone:
//
//   transcribe()  raw PCM over a WebSocket to the ASR engine. No agent, no room,
//                 no LiveKit. You supply the socket. Billed per second of audio to
//                 the workspace whose `wsk_` your server used.
//   listen()      a LiveKit room for an agent LISTEN session, started by your
//                 server with `@whissle/sdk`'s `whissle.listen.start(agentId)`.
//                 An agent exists and the platform records the session.
//
// The gateway's `/listen` WebSocket path is the `transcribe()` one, which is an
// unfortunate collision in the platform's own naming. It is not what `listen()`
// joins.

/**
 * A metadata head the engine can be asked for.
 *
 * Asking for one is not the same as getting one: whether a tag returns anything
 * depends on the model the deployment actually loaded, and the smallest English
 * model has no metadata head at all. **Nothing on the platform reports which tags
 * a deployment supports** — `/asr/status` lists models, decoders and vocabulary
 * sizes but no metadata categories, and the tag classifier's own category list is
 * never surfaced over HTTP. An unsupported category is simply absent from the
 * event. So discover it at runtime by reading which keys turn up, and never
 * promise a caller emotion unconditionally.
 */
export type MetadataTag =
  | "emotion"
  | "intent"
  | "entity"
  | "age"
  | "gender"
  | "dialect"
  | "behavior"
  | "eval"
  | "role";

/** An entity the metadata head tagged. The engine sends no spans or offsets. */
export interface TranscriptEntity {
  type: string;
  value: string;
  /** The raw tagged token, before the engine's own tidying. */
  raw: string;
}

/** One recognised utterance — provisional while still being recognised, then final. */
export interface Transcript {
  text: string;
  /** `false` for a guess the next event replaces; `true` once the engine has settled. */
  final: boolean;
  /** Which input the audio was labelled as. The engine defaults it to `"microphone"`. */
  channel?: string;
  /** Seconds from the start of the session to the start of this segment. */
  audioOffset?: number;
  /** The engine considers the utterance complete. True on every final. */
  utteranceEnd?: boolean;
  /**
   * The metadata heads that reported, as a flat map — `emotion`, `intent`, `age`,
   * `gender`, `dialect`, `behavior`, `eval`, `role`.
   *
   * The VALUES are not normalised and their shape depends on which head produced
   * them: the CTC path emits raw vocabulary tokens (`"EMOTION_HAPPY"`), while a
   * loaded tag classifier emits its own label strings. Match loosely; do not
   * assume a prefix.
   */
  metadata?: Record<string, string>;
  /**
   * The distribution behind each metadata category, best first.
   *
   * `token` rather than `label` because that is what the engine calls it, and it
   * is a vocabulary token, not a display string.
   */
  metadataProbs?: Record<string, Array<{ token: string; probability: number }>>;
  /** Entities the metadata head tagged. Only when `"entity"` was among the tags. */
  entities?: TranscriptEntity[];
  /** The engine's own confidence, when it sent one. Never synthesised. */
  confidence?: number;
  /** The whole event, untouched. Everything typed above is also in here. */
  raw: unknown;
}

export type TranscribeEvent =
  /** The socket is up and the microphone is publishing. */
  | "open"
  /** A `Transcript` — interims and finals both, distinguished by `final`. */
  | "transcript"
  /** Any JSON event from the engine, untouched — including ones typed above. */
  | "message"
  /**
   * A string. The engine's own `{"type":"error"}` message, or ours.
   *
   * The engine's errors carry no code and no detail — only a sentence — so this
   * is a string rather than a structured type that would be mostly empty.
   */
  | "error"
  /**
   * A string: the engine dropped audio because it could not keep up.
   *
   * Separate from `error` because the session is still running and still billing.
   * A consumer that treats backpressure as fatal tears down a working stream; one
   * that ignores it silently loses words.
   */
  | "warning"
  /** The socket is closed. Fires exactly once. */
  | "close";

export interface TranscribeOptions {
  /**
   * The WebSocket endpoint to stream to — **your** server, which holds the
   * `wsk_` and relays to Whissle. A function is called on every `start()`, so a
   * reconnect can fetch a fresh short-lived URL from your own auth.
   *
   * A URL carrying a `wsk_` throws: that key must not be in a page. See this
   * file's header for why there is no browser-safe alternative.
   */
  url: string | (() => string | Promise<string>);
  /** BCP-47-ish language hint for the engine. Default: the engine's own default. */
  language?: string;
  /**
   * Which metadata heads to ask for.
   *
   * Note the engine's default, which is the opposite of what most people expect:
   * **omitting this asks for ALL of them**, and passing an empty array asks for
   * none. Both are forwarded faithfully — an empty array is sent rather than
   * dropped, so `metadataTags: []` really does suppress metadata instead of
   * silently turning everything on.
   */
  metadataTags?: MetadataTag[];
  /** Phrases to bias the language model toward, e.g. product names. */
  hotwords?: string[];
  /** How hard to bias toward `hotwords`. The engine's default applies when absent. */
  hotwordWeight?: number;
  /** Which microphone to capture from. Default: the browser's choice. */
  deviceId?: string;
  /**
   * Extra config-frame fields, merged last.
   *
   * An escape hatch for engine options this build has never heard of, so a new
   * decoder flag does not need an SDK release. Nothing here is validated.
   */
  config?: Record<string, unknown>;
}

/** The sample rate the engine requires. Not configurable: the engine decodes at 16 kHz. */
const TARGET_SAMPLE_RATE = 16000;

/**
 * Float samples in −1..1 → signed 16-bit little-endian, the engine's wire format.
 *
 * Clamped before scaling. An un-clamped sample slightly over 1.0 — which a gain
 * stage or a resampler will produce — wraps to a large NEGATIVE number in two's
 * complement, so a loud moment arrives as a click rather than as loud audio.
 */
export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Resample to 16 kHz by averaging each source window.
 *
 * Averaging rather than picking the nearest sample: dropping samples aliases
 * high-frequency content down into the speech band, and the engine hears it as
 * hiss. Averaging is a crude low-pass, but it is the cheap thing that is right
 * rather than the cheap thing that is wrong.
 *
 * A rate at or below the target is returned unchanged — upsampling invents detail
 * the microphone never captured, and the engine is happier with honest 8 kHz than
 * with interpolated 16.
 */
export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (!(inputRate > TARGET_SAMPLE_RATE)) return input;
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      sum += input[j]!;
      n++;
    }
    out[i] = n > 0 ? sum / n : 0;
  }
  return out;
}

/**
 * The one JSON frame the engine reads before the audio starts.
 *
 * `sample_rate` is always the target: this module resamples, so telling the engine
 * the microphone's native rate would describe bytes we are not sending.
 */
export function buildConfigFrame(opts: TranscribeOptions): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    type: "config",
    sample_rate: TARGET_SAMPLE_RATE,
  };
  if (opts.language) frame.language = opts.language;
  // Sent whenever the caller named it, INCLUDING an empty array: to the engine,
  // absent means "all tags" and `[]` means "none". Dropping an empty array would
  // turn a request for no metadata into a request for all of it.
  if (opts.metadataTags) frame.metadata_tags = [...opts.metadataTags];
  if (opts.hotwords?.length) frame.hotwords = [...opts.hotwords];
  if (typeof opts.hotwordWeight === "number") frame.hotword_weight = opts.hotwordWeight;
  return { ...frame, ...(opts.config ?? {}) };
}

/**
 * One engine event → a `Transcript`, or `null` if it is not one.
 *
 * Only `{"type":"transcript"}` events are transcripts. `is_final` is the flag to
 * branch on — the engine has no `final` field, and `utterance_end` is true on
 * every final, so it does not discriminate.
 *
 * Read forgivingly, and every optional field stays absent rather than being
 * defaulted: the engine OMITS a field it has nothing to say about (it never sends
 * `speakerChange: false`, and an interim carries no `words`, `entities` or
 * `confidence` at all), so inventing a zero would be inventing a reading.
 */
export function parseTranscript(data: unknown): Transcript | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "transcript") return null;
  const text = typeof d.text === "string" ? d.text : "";
  // An empty interim is noise; emitting it makes every consumer write this guard.
  if (!text) return null;
  const out: Transcript = { text, final: d.is_final === true, raw: data };
  if (typeof d.channel === "string") out.channel = d.channel;
  if (typeof d.audioOffset === "number") out.audioOffset = d.audioOffset;
  if (typeof d.utterance_end === "boolean") out.utteranceEnd = d.utterance_end;
  if (typeof d.confidence === "number") out.confidence = d.confidence;

  if (isPlainObject(d.metadata)) {
    const meta: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.metadata)) {
      if (typeof v === "string") meta[k] = v;
    }
    // Absent rather than empty: "did any head report" is then one truthiness check.
    if (Object.keys(meta).length) out.metadata = meta;
  }

  if (isPlainObject(d.metadata_probs)) {
    const probs: Record<string, Array<{ token: string; probability: number }>> = {};
    for (const [k, v] of Object.entries(d.metadata_probs)) {
      if (!Array.isArray(v)) continue;
      const list = v
        .filter(isPlainObject)
        .filter((c) => typeof c.token === "string" && typeof c.probability === "number")
        .map((c) => ({ token: c.token as string, probability: c.probability as number }));
      if (list.length) probs[k] = list;
    }
    if (Object.keys(probs).length) out.metadataProbs = probs;
  }

  if (Array.isArray(d.entities)) {
    const ents = d.entities
      .filter(isPlainObject)
      .filter((e) => typeof e.type === "string" && typeof e.value === "string")
      .map((e) => ({
        type: e.type as string,
        value: e.value as string,
        raw: typeof e.raw === "string" ? e.raw : "",
      }));
    if (ents.length) out.entities = ents;
  }

  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

type Handler = (payload?: unknown) => void;

/**
 * A live transcription stream. Construct it with `transcribe()`.
 *
 * `stop()` flushes and closes; the engine may emit one last final on the way out,
 * which is why the socket is not torn down until the far side closes it or the
 * flush deadline passes.
 */
export class TranscriptionStream {
  private readonly handlers = new Map<TranscribeEvent, Set<Handler>>();
  private readonly opts: TranscribeOptions;
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private stream: MediaStream | null = null;
  private _state: "connecting" | "open" | "closed" = "connecting";
  private stopped = false;
  private muted = false;

  constructor(opts: TranscribeOptions) {
    this.opts = opts;
    void this.open().catch((err) => {
      this.fail(err instanceof Error ? err.message : "Couldn't start transcription.");
    });
  }

  /** `"connecting"` until the socket is up, `"closed"` after `stop()` or a drop. */
  get state(): "connecting" | "open" | "closed" {
    return this._state;
  }

  on(event: TranscribeEvent, handler: Handler): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }

  off(event: TranscribeEvent, handler: Handler): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  /** Stop sending audio. The socket stays up and the engine hears silence. */
  mute(): void {
    this.muted = true;
  }

  unmute(): void {
    this.muted = false;
  }

  /**
   * Force out whatever the engine is still holding, without ending the session.
   *
   * For a push-to-talk button, or any UI where the user has visibly finished but
   * the session continues. The engine replies with its finals and then
   * `{"type":"flush_done"}`, and the socket stays open.
   */
  flush(): void {
    if (this.stopped || !this.ws || this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify({ type: "flush" }));
    } catch {
      // A socket that died mid-flush is already on its way to `onclose`.
    }
  }

  /**
   * Flush and close. Idempotent.
   *
   * Sends `{"type":"end"}` so the engine emits whatever it was still holding
   * before the socket goes away — without it, the last utterance of a session is
   * routinely lost, which is the bug people report as "it drops the last word".
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: "end" }));
    } catch {
      // A socket that died before the flush is already closed; nothing to do.
    }
    this.teardownAudio();
    // The socket itself is left to the far side so a trailing final still lands.
    // If it never closes, `close` fires from our own timer rather than never.
    setTimeout(() => this.shutdown(), FLUSH_GRACE_MS);
  }

  /**
   * One engine event → the typed event it deserves.
   *
   * `{"type":"end"}` is the engine's acknowledgement that it has flushed
   * everything it was holding. Treating it as the signal to close is what makes
   * `stop()` deterministic rather than a race against the grace timer.
   */
  private route(data: unknown) {
    const t = parseTranscript(data);
    if (t) {
      this.emit("transcript", t);
      return;
    }
    if (!data || typeof data !== "object") return;
    const d = data as Record<string, unknown>;
    const message = typeof d.message === "string" ? d.message : "";
    if (d.type === "error") {
      this.emit("error", message || "The transcription engine reported an error.");
      return;
    }
    if (d.type === "warning") {
      this.emit("warning", message || "The transcription engine dropped some audio.");
      return;
    }
    // The flush is complete and the engine is about to close. Nothing more is
    // coming, so stop waiting out the grace period.
    if (d.type === "end") this.shutdown();
  }

  private emit(event: TranscribeEvent, payload?: unknown) {
    this.handlers.get(event)?.forEach((h) => {
      try {
        h(payload);
      } catch (err) {
        console.error(`[whissle] transcribe handler for "${event}" threw`, err);
      }
    });
  }

  private fail(message: string) {
    this.emit("error", message);
    this.shutdown();
  }

  private shutdown() {
    if (this._state === "closed") return;
    this._state = "closed";
    this.teardownAudio();
    try {
      this.ws?.close();
    } catch {
      // Already closing.
    }
    this.ws = null;
    this.emit("close");
  }

  private teardownAudio() {
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
      void this.ctx?.close();
    } catch {
      // A context torn down twice is not an error worth surfacing.
    }
    // Release the microphone. Holding it makes us the app that is holding the
    // microphone — the thing every "another app is using it" message blames.
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.processor = null;
    this.source = null;
    this.ctx = null;
    this.stream = null;
  }

  private async open() {
    const url = typeof this.opts.url === "function" ? await this.opts.url() : this.opts.url;
    assertBrowserSafeUrl(url);
    if (this.stopped) return;

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify(buildConfigFrame(this.opts)));
      } catch {
        // If the config cannot be sent the engine falls back to its defaults,
        // which is worse but not fatal — do not kill a working socket over it.
      }
      this._state = "open";
      this.emit("open");
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return; // the engine speaks JSON; audio is one-way
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return; // a non-JSON frame is not something a typed consumer can use
      }
      this.emit("message", parsed);
      this.route(parsed);
    };
    ws.onerror = () => {
      // The browser deliberately withholds the reason for a WebSocket failure, so
      // there is nothing more specific to say than where to look.
      this.emit("error", "The transcription socket failed. Check the URL your server returned.");
    };
    ws.onclose = (ev: CloseEvent) => {
      // The engine refuses two things before it ever accepts the socket, and both
      // arrive only as a close code. Without this they look identical to a network
      // drop, and "it just disconnects" is the least actionable bug report there is.
      const refusal =
        ev?.code === 1011
          ? "The transcription engine has no model loaded."
          : ev?.code === 1013
            ? "The transcription engine is at its concurrent-session limit. Retry shortly."
            : "";
      if (refusal) this.emit("error", refusal);
      this.shutdown();
    };

    await this.startMicrophone();
  }

  private async startMicrophone() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "This browser can't reach a microphone. Note that microphone access needs " +
          "the page to be served over HTTPS.",
      );
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: this.opts.deviceId ? { deviceId: { exact: this.opts.deviceId } } : true,
    });
    if (this.stopped) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    const Ctx: typeof AudioContext =
      (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
    const ctx = new Ctx();
    this.ctx = ctx;
    const source = ctx.createMediaStreamSource(stream);
    this.source = source;
    // ScriptProcessor is deprecated and an AudioWorklet would be the modern path,
    // but a worklet needs a separately-hosted module file, which a single-file SDK
    // shipped over a CDN cannot assume it can fetch from the embedder's origin.
    // This runs on the main thread and is loud about it only under heavy load.
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    this.processor = processor;
    processor.onaudioprocess = (ev: AudioProcessingEvent) => {
      if (this.muted || this.stopped) return;
      if (!this.ws || this.ws.readyState !== 1) return;
      const input = ev.inputBuffer.getChannelData(0);
      const pcm = floatTo16BitPCM(downsampleTo16k(input, ctx.sampleRate));
      try {
        this.ws.send(pcm.buffer as ArrayBuffer);
      } catch {
        // A send into a closing socket throws; `onclose` is already on its way.
      }
    };
    source.connect(processor);
    // A ScriptProcessor only runs while it is connected to the graph's
    // destination, even though it emits no sound of its own. Without this hop it
    // silently never fires and the session comes up deaf.
    processor.connect(ctx.destination);
  }
}

/** How long to wait after the flush for a trailing final before closing ourselves. */
const FLUSH_GRACE_MS = 1500;

/**
 * Refuse a URL that carries a secret key, and one that is not a WebSocket.
 *
 * This is the guard the whole module exists around: the ASR socket takes its
 * credential in the query string, so the wrong thing to do is exactly the easy
 * thing to do.
 */
function assertBrowserSafeUrl(url: string): void {
  if (!url || typeof url !== "string") {
    throw new Error("transcribe() needs a `url` — a WebSocket endpoint on your own server.");
  }
  if (url.includes("wsk_")) {
    throw new Error(
      "transcribe(): that URL carries a SECRET key (wsk_) and this code runs in a browser, " +
        "where anyone can read it. Whissle's ASR scope (models:invoke) cannot be held by a " +
        "publishable key, so point `url` at a WebSocket endpoint on your own server that " +
        "holds the wsk_ and relays to Whissle.",
    );
  }
  if (!/^wss?:\/\//i.test(url)) {
    throw new Error(`transcribe(): \`url\` must be a ws:// or wss:// endpoint, got "${url}".`);
  }
}

/**
 * Stream the microphone to a transcription endpoint on your own server.
 *
 * ```ts
 * const stream = transcribe({
 *   url: () => fetch("/api/asr-url", { credentials: "include" })
 *     .then((r) => r.json()).then((d) => d.url as string),
 *   metadataTags: ["emotion", "intent"],
 * });
 * stream.on("transcript", (payload) => {
 *   const t = payload as Transcript;
 *   if (t.final) show(t.text);
 * });
 * ```
 *
 * The socket is billed per second of audio to the workspace whose `wsk_` your
 * server used, so `stop()` is a cost control, not just tidiness.
 */
export function transcribe(opts: TranscribeOptions): TranscriptionStream {
  if (!opts?.url) {
    throw new Error("transcribe() needs a `url` — a WebSocket endpoint on your own server.");
  }
  return new TranscriptionStream(opts);
}
