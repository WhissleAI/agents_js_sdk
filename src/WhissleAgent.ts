import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import { decodeBase64, normalizeAvatar, SimliAvatar, type AvatarOptions } from "./avatar";
import { LiveKitSession, type LiveKitConnectInfo, type SessionCallbacks } from "./livekit";

const DEFAULT_BASE_URL = "https://aws-gateway-backend.whissle.ai/bot";
const DEFAULT_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

/** Which realtime transport carries the conversation. */
export type WhissleTransport = "auto" | "webrtc" | "livekit";

/**
 * What `POST /api/embed/session-token` returns.
 *
 * `token` / `expires_in` / `agent` / `text_enabled` are what it returns today.
 * `transport`, `ice_servers` and `session_id` are the self-describing fields it
 * is growing: when they are present the SDK follows them, when they are absent
 * it behaves exactly as it does today. That fallback is deliberate — this SDK
 * has to work against the gateway that is live right now.
 */
export interface WhissleSessionInfo {
  token: string;
  expires_in?: number;
  agent?: { name?: string; greeting?: string };
  text_enabled?: boolean;
  session_id?: string;
  ice_servers?: RTCIceServer[];
  transport?: { kind?: string; url?: string; token?: string };
}

export interface WhissleAgentOptions {
  /** Your publishable Whissle key (from the agent's Embed & SDK settings). Safe
   *  to ship in client code — it's origin-restricted and only authorizes a
   *  metered session with this agent.
   *
   *  Required UNLESS you pass `sessionToken` or `getToken`, in which case no key
   *  belongs here at all. Never put a `wsk_` secret key in any of these fields:
   *  it carries full org authority and this code runs in a browser. */
  apiKey?: string;
  /**
   * A session token your backend already minted, passed straight in.
   *
   * This is the recommended shape when your server does the minting anyway: it
   * calls `POST /api/embed/session-token` with its secret key behind your own
   * auth, hands the browser the short-lived token, and no Whissle credential
   * ever reaches the page.
   *
   *   const { token } = await fetch("/api/voice-token").then((r) => r.json());
   *   new WhissleAgent({ sessionToken: token });
   *
   * Use `getToken` instead when the session may outlive the token (it is called
   * again on every `start()`); use this when you already have one in hand.
   */
  sessionToken?: string;
  /**
   * Get a session token from YOUR backend instead of minting one here.
   *
   * Same trust model as `sessionToken`, but re-fetched on every `start()`, so a
   * reconnect after a long idle gets a fresh token rather than reusing an
   * expired one. When set, `apiKey` and `agentId` are ignored — the token
   * already names the agent.
   */
  getToken?: () => string | Promise<string>;
  /** The agent to talk to (from platform.whissle.ai). Not needed with a token. */
  agentId?: string;
  /** Override the API base URL (self-hosted / staging). */
  baseUrl?: string;
  /** Override the ICE servers used for WebRTC. */
  iceServers?: RTCIceServer[];
  /**
   * Render a talking avatar for this agent.
   *
   *   avatar: "F1-HR"                       // a code from GET /api/avatars
   *   avatar: true                          // whatever the agent is configured with
   *   avatar: { id: "M2-TL", container: "#face" }
   *
   * The avatar is rendered **in the browser**, straight from Simli, so Whissle
   * does no video transcoding and the video never makes a second trip. If it
   * can't start, the session still connects audio-only and you get an
   * `avatar-failed` event — unless you set `required: true`.
   */
  avatar?: string | boolean | AvatarOptions;
  /**
   * Which transport to use. Default `"auto"`: follow the transport the session
   * mint describes (LiveKit when it offers one — the client SDK then owns ICE,
   * TURN, reconnection and track subscription), else SmallWebRTC, which is what
   * every 0.1.x session used.
   *
   * `"livekit"` forces LiveKit even when the mint says nothing, by asking
   * `POST /api/embed/livekit` directly. Note the gateway must have LiveKit
   * enabled; if it doesn't, `start()` fails rather than silently downgrading —
   * you asked for a specific transport.
   */
  transport?: WhissleTransport;
}

export type WhissleEvent =
  | "connecting"
  | "connected"
  | "disconnected"
  | "speaking-started"
  | "speaking-stopped"
  | "user-transcript"
  | "agent-transcript"
  | "bot-ready"
  | "avatar-ready"
  | "avatar-failed"
  | "error";

type Handler = (payload?: unknown) => void;

/** Reject with `message` if `work` hasn't settled in `ms`. */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Payload of the `avatar-ready` event. */
export interface AvatarReady {
  video: HTMLVideoElement;
  faceId?: string;
}

/**
 * A single voice (or voice + avatar) conversation with one Whissle agent.
 *
 *   // A widget on a public page — a publishable key, origin-restricted:
 *   const agent = new WhissleAgent({ apiKey: "wpk_…", agentId: "…" });
 *
 *   // With a talking face, rendered in the browser:
 *   const agent = new WhissleAgent({ apiKey: "wpk_…", agentId: "…", avatar: "F1-HR" });
 *
 *   // Inside a product that already logged the user in — no key in the browser
 *   // at all; your server mints the session behind your own auth:
 *   const agent = new WhissleAgent({ sessionToken: tokenFromYourServer });
 *
 *   agent.on("agent-transcript", (t) => console.log(t));
 *   await agent.start();      // asks for the mic, connects
 *   …
 *   agent.stop();
 *
 * Framework-agnostic: emits plain events you can wire into React/Vue/vanilla, or
 * use WhissleAgent.mount() for a ready-made widget.
 */
export class WhissleAgent {
  private opts: Required<Pick<WhissleAgentOptions, "baseUrl" | "iceServers">> &
    WhissleAgentOptions;
  /** True when the caller pinned ICE servers, so a mint can't override them. */
  private readonly iceFromCaller: boolean;
  private client: PipecatClient | null = null;
  private lk: LiveKitSession | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private handlers = new Map<WhissleEvent, Set<Handler>>();
  private _state: "idle" | "connecting" | "connected" = "idle";
  private _transport: "webrtc" | "livekit" | null = null;
  private _session: WhissleSessionInfo | null = null;
  private avatarOpts: AvatarOptions | null;
  private avatar: SimliAvatar | null = null;
  /** ICE for the session being opened — resolved from caller > mint > defaults. */
  private ice: RTCIceServer[] = DEFAULT_ICE;
  private remoteTrack: MediaStreamTrack | null = null;
  // Accumulates the agent's bot-output segments for the CURRENT turn. The backend
  // (pipecat) emits one bot-output per aggregated sentence, so a multi-sentence
  // reply arrives as several segments; we buffer them and emit ONE agent-transcript
  // per turn (flushed when the bot stops speaking) instead of one per sentence.
  private _botTurn = "";

  constructor(options: WhissleAgentOptions) {
    if (!options?.apiKey && !options?.sessionToken && !options?.getToken) {
      throw new Error(
        "WhissleAgent: pass `apiKey` (a publishable wpk_ key), `sessionToken` (one your " +
          "backend already minted), or `getToken` (a function that fetches one).",
      );
    }
    // A secret key here would be shipped to every visitor's browser, where it
    // carries full authority over the workspace. Refuse loudly rather than let
    // it reach a page — the mint would even succeed, which is what makes this
    // worth catching at construction.
    if (options.apiKey?.startsWith("wsk_")) {
      throw new Error(
        "WhissleAgent: that's a SECRET key (wsk_) and this code runs in a browser. Use a " +
          "publishable (wpk_) key, or mint a session token on your server and pass it as " +
          "`sessionToken` / `getToken`.",
      );
    }
    this.iceFromCaller = Array.isArray(options.iceServers) && options.iceServers.length > 0;
    this.opts = {
      ...options,
      // Applied AFTER the spread, not before: an explicitly-`undefined` property
      // (`baseUrl: props.baseUrl` where the prop is absent — every React caller
      // writes this) would otherwise overwrite the default with undefined, and
      // the SDK would quietly POST to a relative "undefined/api/…" on your own
      // origin.
      baseUrl: options.baseUrl || DEFAULT_BASE_URL,
      iceServers: this.iceFromCaller ? options.iceServers! : DEFAULT_ICE,
    };
    this.avatarOpts = normalizeAvatar(options.avatar);
  }

  get state() {
    return this._state;
  }

  /** Which transport the current (or last) session used. `null` before `start()`. */
  get transport(): "webrtc" | "livekit" | null {
    return this._transport;
  }

  /** What the mint told us about this session — agent name, greeting, TTL. */
  get session(): WhissleSessionInfo | null {
    return this._session;
  }

  /** The avatar's `<video>`, once one exists. Place it wherever you like. */
  get videoElement(): HTMLVideoElement | null {
    return this.avatar?.video ?? null;
  }

  on(event: WhissleEvent, handler: Handler): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }

  off(event: WhissleEvent, handler: Handler): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  private emit(event: WhissleEvent, payload?: unknown) {
    this.handlers.get(event)?.forEach((h) => {
      try {
        h(payload);
      } catch (err) {
        console.error(`[whissle] handler for "${event}" threw`, err);
      }
    });
  }

  /**
   * The session for this conversation.
   *
   * Either your backend hands us a token (`sessionToken` / `getToken` — then no
   * key was ever in this page), or we mint one here from a publishable key bound
   * to this origin, and get the full session descriptor with it.
   */
  private async mintSession(): Promise<WhissleSessionInfo> {
    if (this.opts.sessionToken) return { token: this.opts.sessionToken };
    if (this.opts.getToken) {
      const token = await this.opts.getToken();
      if (!token) {
        // Almost always your endpoint refusing the user rather than a bug here,
        // so say that instead of a generic failure.
        throw new Error(
          "WhissleAgent: `getToken` returned nothing — your backend didn't issue a session " +
            "token (is the user signed in?).",
        );
      }
      return { token };
    }
    // Guaranteed by the constructor: without a token there is an apiKey.
    const apiKey = this.opts.apiKey!;
    const res = await fetch(`${this.opts.baseUrl}/api/embed/session-token`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // A publishable key (wpk_) resolves the org; agent_id picks the agent.
        // A per-agent embed key (wek_) is accepted too, for convenience.
        ...(apiKey.startsWith("wek_") ? { embed_key: apiKey } : { api_key: apiKey }),
        agent_id: this.opts.agentId,
        parent_origin: typeof location !== "undefined" ? location.origin : undefined,
      }),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 403
          ? "This site isn't allowed to embed this agent. Add its origin in the agent's Embed settings."
          : "Couldn't start the agent (check the key + agent id).",
      );
    }
    return (await res.json()) as WhissleSessionInfo;
  }

  /** The ICE servers for this session: the caller's, else the mint's, else ours. */
  private iceFor(session: WhissleSessionInfo): RTCIceServer[] {
    if (this.iceFromCaller) return this.opts.iceServers;
    if (session.ice_servers?.length) return session.ice_servers;
    return this.opts.iceServers;
  }

  /**
   * Pick the transport. `auto` follows what the mint describes and falls back to
   * SmallWebRTC — it deliberately never *probes* for LiveKit, because a probe
   * spends the session token's single-use nonce and starts a metered bot.
   */
  private transportFor(session: WhissleSessionInfo): "webrtc" | "livekit" {
    const asked = this.opts.transport || "auto";
    if (asked === "webrtc" || asked === "livekit") return asked;
    return session.transport?.kind === "livekit" ? "livekit" : "webrtc";
  }

  /** Query params both `/api/embed/offer` and `/api/embed/livekit` accept. */
  private sessionQuery(token: string, avatarCode: string | null): string {
    const q = new URLSearchParams({ token });
    if (avatarCode) {
      // `avatar_render=client` is what stops the bot server-rendering the face:
      // it then emits clean TTS audio for the browser to drive Simli with. Both
      // params are required — the backend only reads the render mode inside its
      // `if avatar_id` branch.
      q.set("avatar_id", avatarCode);
      q.set("avatar_render", "client");
    }
    return q.toString();
  }

  /** Ask for the microphone and connect the live session. */
  async start(): Promise<void> {
    if (this._state !== "idle") return;
    this._state = "connecting";
    this.emit("connecting");
    try {
      const session = await this.mintSession();
      this._session = session;
      const token = session.token;

      // The avatar comes up BEFORE the conversation, so the face is already
      // listening when the agent delivers its greeting.
      const avatarCode = this.avatarOpts ? await this.startAvatar(token) : null;

      const kind = this.transportFor(session);
      this._transport = kind;
      if (kind === "livekit") await this.connectLiveKit(session, avatarCode);
      else await this.connectWebRTC(session, avatarCode);
    } catch (err) {
      this._state = "idle";
      void this.teardown();
      this.emit("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Mint the browser-direct Simli session and bring the face up.
   *
   * Returns the avatar code to hand the bot, or `null` if the avatar didn't come
   * up — in which case the conversation still connects, audio-only. A failed
   * face must never cost you the session.
   */
  private async startAvatar(token: string): Promise<string | null> {
    const wanted = this.avatarOpts!;
    try {
      const q = new URLSearchParams({ token });
      // With no code, the backend picks the agent's own avatar and tells us
      // which face it chose — we then name that face to the bot.
      if (wanted.id) q.set("avatar_id", wanted.id);
      const res = await fetch(`${this.opts.baseUrl}/api/embed/simli-token?${q.toString()}`, {
        method: "POST",
        credentials: "omit",
      });
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? wanted.id
              ? `Unknown avatar "${wanted.id}" — see GET /api/avatars for the codes.`
              : "This agent has no avatar configured — pass one, e.g. avatar: \"F1-HR\"."
            : `Couldn't start the avatar (${res.status}).`,
        );
      }
      const mint = (await res.json()) as {
        session_token: string;
        ice_servers?: RTCIceServer[];
        face_id?: string;
      };

      const avatar = new SimliAvatar(this.resolveVideoElement(wanted));
      this.avatar = avatar;
      await withTimeout(
        avatar.start(mint),
        wanted.timeoutMs ?? 15_000,
        "The avatar didn't come up in time — continuing with voice only.",
      );
      this.emit("avatar-ready", { video: avatar.video, faceId: mint.face_id } as AvatarReady);
      return wanted.id || mint.face_id || null;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.avatar?.destroy();
      this.avatar = null;
      this.emit("avatar-failed", reason);
      if (wanted.required) throw err;
      return null;
    }
  }

  /** Create (or find) the `<video>` and put it where the caller asked. */
  private resolveVideoElement(wanted: AvatarOptions): HTMLVideoElement | undefined {
    if (!wanted.container || typeof document === "undefined") return undefined;
    const host =
      typeof wanted.container === "string"
        ? document.querySelector(wanted.container)
        : wanted.container;
    if (!host) throw new Error(`Avatar container "${String(wanted.container)}" not found.`);
    if (host instanceof HTMLVideoElement) return host;
    const video = document.createElement("video");
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "cover";
    host.appendChild(video);
    return video;
  }

  /** The callbacks both transports feed. One brain, two wires. */
  private callbacks(): SessionCallbacks {
    return {
      onConnected: () => {
        this._state = "connected";
        // Clean PCM is the good input; the track is the safety net for a gateway
        // that doesn't mirror it. Arm the net only once we're actually live.
        this.avatar?.armTrackFallback(() => this.remoteTrack);
        this.emit("connected");
      },
      onDisconnected: () => {
        this._state = "idle";
        this.emit("disconnected");
      },
      onBotReady: (data) => this.emit("bot-ready", data),
      onBotStartedSpeaking: () => {
        this._botTurn = ""; // new turn — start a fresh transcript buffer
        this.emit("speaking-started");
      },
      onBotStoppedSpeaking: () => {
        // Flush the whole turn's text as a single agent-transcript, once.
        const text = this._botTurn.trim();
        this._botTurn = "";
        if (text) this.emit("agent-transcript", text);
        this.emit("speaking-stopped");
      },
      onBotOutput: (segment) => {
        // The backend emits one bot-output per aggregated SENTENCE of the reply.
        // Buffer the segments and let onBotStoppedSpeaking emit a single
        // agent-transcript for the turn — otherwise each sentence renders as its
        // own bubble.
        const seg = segment.trim();
        if (seg) this._botTurn = this._botTurn ? `${this._botTurn} ${seg}` : seg;
      },
      onUserTranscript: (text, final) => {
        if (final) this.emit("user-transcript", text);
      },
      onRemoteAudioTrack: (track) => {
        this.remoteTrack = track;
        // With a browser-rendered avatar, Simli plays the lip-synced audio. Also
        // playing the raw track would double every word, half a beat apart.
        if (this.avatar) return;
        if (this.audioEl) {
          this.audioEl.srcObject = new MediaStream([track]);
          this.audioEl.play().catch(() => {
            this.emit("error", "Browser blocked audio autoplay — a user gesture is required.");
          });
        }
      },
      onServerMessage: (data) => {
        const msg = data as { type?: string; error?: string; message?: string; t?: string; pcm?: string };
        // Clean 16 kHz PCM mirrored from the bot's TTS — the good avatar input.
        if (msg?.t === "simli-audio" && msg.pcm) {
          this.avatar?.sendPcm(decodeBase64(msg.pcm));
          return;
        }
        if (msg?.t === "simli-clear") {
          this.avatar?.clearBuffer();
          return;
        }
        if (msg?.type === "error" && msg?.error === "no_credits") {
          this.emit("error", msg.message || "This agent has run out of credits.");
        }
      },
      onError: (message) => this.emit("error", message),
    };
  }

  /** SmallWebRTC — the transport every 0.1.x session used. */
  private async connectWebRTC(
    session: WhissleSessionInfo,
    avatarCode: string | null,
  ): Promise<void> {
    this.ice = this.iceFor(session);
    const endpoint = `${this.opts.baseUrl}/api/embed/offer?${this.sessionQuery(session.token, avatarCode)}`;
    await this.openWebRTC(endpoint);
  }

  /**
   * Open the SmallWebRTC peer connection. Split out from the URL-building above
   * as the seam the tests stub — everything before this point is decisions, this
   * is the part that needs a browser.
   */
  protected async openWebRTC(endpoint: string): Promise<void> {
    const cb = this.callbacks();
    this.ensureAudioElement();

    const client = new PipecatClient({
      enableMic: true,
      enableCam: false,
      transport: new SmallWebRTCTransport({ iceServers: this.ice }),
      callbacks: {
        onConnected: cb.onConnected,
        onDisconnected: cb.onDisconnected,
        onBotReady: (data) => cb.onBotReady(data),
        onBotStartedSpeaking: cb.onBotStartedSpeaking,
        onBotStoppedSpeaking: cb.onBotStoppedSpeaking,
        onTrackStarted: (track: MediaStreamTrack, participant?: { local?: boolean }) => {
          if (participant?.local) return;
          if (track.kind === "audio") cb.onRemoteAudioTrack(track);
        },
        onUserTranscript: (data: { text: string; final?: boolean }) =>
          cb.onUserTranscript(data.text, Boolean(data.final)),
        onBotOutput: (data: { text?: string }) => cb.onBotOutput(data?.text ?? ""),
        onServerMessage: (data: unknown) => cb.onServerMessage(data),
        onError: (message: { data?: unknown }) =>
          cb.onError(typeof message?.data === "string" ? message.data : "Connection error."),
      },
    });
    this.client = client;

    await client.connect({
      webrtcRequestParams: {
        endpoint: new Request(endpoint, {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
        }),
      },
    });
  }

  /** LiveKit — the gateway names a room and the LiveKit SDK owns the media path. */
  private async connectLiveKit(
    session: WhissleSessionInfo,
    avatarCode: string | null,
  ): Promise<void> {
    await this.openLiveKit(await this.livekitInfo(session, avatarCode));
  }

  /** Join the LiveKit room. The tests' seam — see `openWebRTC`. */
  protected async openLiveKit(info: LiveKitConnectInfo): Promise<void> {
    this.ensureAudioElement();
    const lk = new LiveKitSession();
    this.lk = lk;
    await lk.connect(info, this.callbacks());
  }

  /**
   * Where the LiveKit room lives. Straight from the mint when it describes one;
   * otherwise ask `POST /api/embed/livekit`, which is what the mint will
   * eventually be doing on our behalf.
   */
  private async livekitInfo(
    session: WhissleSessionInfo,
    avatarCode: string | null,
  ): Promise<LiveKitConnectInfo> {
    const described = session.transport;
    if (described?.kind === "livekit" && described.url && described.token) {
      return { url: described.url, token: described.token };
    }
    const res = await fetch(
      `${this.opts.baseUrl}/api/embed/livekit?${this.sessionQuery(session.token, avatarCode)}`,
      {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    if (!res.ok) {
      throw new Error(
        res.status === 404
          ? "LiveKit isn't enabled on this gateway — use transport: \"webrtc\" (the default)."
          : `Couldn't open a LiveKit session (${res.status}).`,
      );
    }
    return (await res.json()) as LiveKitConnectInfo;
  }

  /** Hidden element that plays the agent's audio (unused with an avatar). */
  private ensureAudioElement(): void {
    if (typeof document === "undefined" || this.audioEl) return;
    this.audioEl = document.createElement("audio");
    this.audioEl.autoplay = true;
    this.audioEl.style.display = "none";
    document.body.appendChild(this.audioEl);
  }

  /** Mute / unmute the caller's microphone. */
  setMuted(muted: boolean): void {
    try {
      this.client?.enableMic(!muted);
      this.lk?.setMuted(muted);
    } catch {
      /* not connected yet */
    }
  }

  /** End the session and clean up. */
  stop(): void {
    void this.teardown();
    this._state = "idle";
  }

  private async teardown(): Promise<void> {
    try {
      this.client?.disconnect();
    } catch {
      /* already gone */
    }
    this.client = null;
    this.lk?.disconnect();
    this.lk = null;
    this.remoteTrack = null;
    const avatar = this.avatar;
    this.avatar = null;
    await avatar?.destroy();
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.remove();
      this.audioEl = null;
    }
  }
}
