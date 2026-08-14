import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import {
  decodeBase64,
  normalizeAvatar,
  SimliAvatar,
  type AvatarAudioStats,
  type AvatarOptions,
} from "./avatar";
import { EarconPlayer, type EarconOptions } from "./earcons";
import { LiveKitSession, type LiveKitConnectInfo, type SessionCallbacks } from "./livekit";
import { checkMicrophone, listMicrophones, type MicProblem } from "./mic";
import { BoostedPlayout } from "./mobile-audio";
import { parseSignal, parseUserMetadata } from "./signals";
import { TextChannel, WhissleTextError, type SendTextOptions, type TextTurn } from "./text";
import {
  parseToolEvent,
  ThinkingTracker,
  type ThinkingState,
  type ToolFinished,
  type ToolProgress,
  type ToolStarted,
} from "./tool-events";

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
  agent?: {
    name?: string;
    greeting?: string;
    /**
     * Where this agent's tool cues are played: `"ui"` (the client does it — the
     * default, and what every embed gets unless someone changed it), `"call"` (the
     * pipeline mixes them into the outgoing audio itself) or `"off"`.
     *
     * Read so that a `"call"` agent doesn't get the cue twice. The gateway does not
     * send this field yet; when absent the SDK plays, which is correct for `"ui"` and
     * harmless for `"off"` because that mode ships no clip name to play.
     */
    tool_sounds?: string;
  };
  /** As `agent.tool_sounds`, accepted at the top level too. */
  tool_sounds?: string;
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
  sessionToken?: string | WhissleSessionInfo;
  /**
   * Get a session token from YOUR backend instead of minting one here.
   *
   * Same trust model as `sessionToken`, but re-fetched on every `start()`, so a
   * reconnect after a long idle gets a fresh token rather than reusing an
   * expired one. When set, `apiKey` and `agentId` are ignored — the token
   * already names the agent.
   */
  getToken?: () => string | WhissleSessionInfo | Promise<string | WhissleSessionInfo>;
  /** The agent to talk to (from whissle.ai). Not needed with a token. */
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
  /**
   * Tool earcons — the short cue that plays when the agent goes off to do something.
   *
   * On by default, and worth leaving on. When an agent calls a tool it stops talking
   * for as long as the tool takes; without a cue that is dead air the visitor reads as
   * a hang. The platform picks the cue per tool and sends its name; this SDK plays it.
   * See `./earcons` for what "plays it" means and why it isn't the mp3 bank.
   *
   *   earcons: false                          // silent tool calls
   *   earcons: { volume: 0.6 }                // quieter
   *   earcons: { bankUrl: "/sounds/tool" }    // the real clips, hosted by you
   */
  earcons?: boolean | EarconOptions;
  /**
   * Ask for the microphone and check it BEFORE connecting, so a blocked or busy mic
   * is a sentence instead of a session that connects and then ignores the visitor.
   * Default `true`. See `./mic` for why this is not paranoia.
   */
  micPreflight?: boolean;
}

export type WhissleEvent =
  | "connecting"
  | "connected"
  | "disconnected"
  | "speaking-started"
  | "speaking-stopped"
  | "user-transcript"
  /**
   * The caller's speech as it is still being recognised — replaced by the next
   * one, and finally by a `user-transcript`. Render it as provisional (greyed,
   * italic) and never store it: it is a guess that changes.
   *
   * Worth wiring even though it carries no information the final doesn't. A
   * speaker with nothing on screen while they talk assumes they aren't being
   * heard, and starts repeating themselves.
   */
  | "user-interim"
  | "agent-transcript"
  /**
   * The reply SO FAR in the current turn, re-emitted each time another sentence is
   * aggregated. `agent-transcript` still arrives once at the end of the turn.
   *
   * The one to render when the agent is mid-answer. `agent-transcript` fires when the
   * bot STOPS speaking, so on a long reply a transcript built from it alone sits empty
   * for ten seconds and then dumps a paragraph.
   */
  | "agent-partial"
  /**
   * One word of the reply, at the moment the voice says it (`bot-tts-text`).
   *
   * The finest granularity the pipeline offers, and the only one that can drive a
   * caption that keeps time with the audio. Use `agent-partial` for a transcript and
   * this for a karaoke-style live caption; wiring both is normal.
   */
  | "agent-word"
  /**
   * The caller started speaking, according to the server's voice-activity detector.
   *
   * The barge-in edge: if this arrives between `speaking-started` and
   * `speaking-stopped`, the visitor has just interrupted the agent. (The interruption
   * itself is handled server-side — this is how you find out it happened.)
   */
  | "listening-started"
  | "listening-stopped"
  /**
   * The agent has called a tool, and has therefore gone quiet on purpose. Carries the
   * tool name, its arguments, and the earcon the platform chose.
   */
  | "tool-started"
  /** An interim update from inside a long-running tool, with a line to show. */
  | "tool-progress"
  /** A tool came back — with its result, whether it succeeded, and any citations. */
  | "tool-finished"
  /**
   * One boolean for "the agent is working, that's why it's quiet". Collapses however
   * many tools are in flight into the single thing a UI needs. This is what the
   * dashboard's thinking strip is built on.
   */
  | "thinking"
  /** A one-line caption of the reply being spoken right now, from the agent's own
   *  `[[GIST:…]]` marker. Present only on agents that emit one. */
  | "gist"
  /**
   * The live acoustic read of the caller — emotion and intent, with the distributions
   * behind them. Read `./signals` before rendering the emotion: absence is the honest
   * state and `NEUTRAL` is deliberately not reported.
   */
  | "user-metadata"
  /** One event from the pipeline's live signal stream (barge-in, endpointing,
   *  language switches, entities, flow state). Schema v1; see `./signals`. */
  | "signal"
  /** This session hit the anonymous demo cap and is about to end. */
  | "demo-limit"
  | "bot-ready"
  | "avatar-ready"
  | "avatar-failed"
  /**
   * The microphone stopped producing audio mid-session — unplugged, grabbed by
   * another app, or revoked in browser settings. The session stays up (the
   * caller can still hear the agent), so this is a prompt to tell them, not a
   * reason to tear down.
   */
  | "mic-lost"
  /** The microphone came back. Only ever follows a `mic-lost`. */
  | "mic-restored"
  /**
   * A structured message from the agent that this SDK does not itself consume —
   * your own application events, passed through untouched. The payload is
   * whatever the agent sent.
   */
  | "server-message"
  | "error";

/**
 * Why something failed, in a form you can branch on.
 *
 * The `error` event's first argument stays the human sentence it has always been; this
 * arrives as a SECOND argument, so existing handlers are untouched and new ones can
 * tell "top up your wallet" apart from "this domain isn't on the allowlist" — two
 * failures that look identical from a page and have completely different fixes.
 *
 *   agent.on("error", (message, detail) => {
 *     if ((detail as WhissleErrorDetail)?.code === "no-credit") showBillingLink();
 *     else showMessage(String(message));
 *   });
 */
export interface WhissleErrorDetail {
  code:
    | "no-credit"
    | "origin-not-allowed"
    | "expired"
    | "not-found"
    | "rate-limited"
    | "unavailable"
    | "microphone"
    | "autoplay"
    | "demo-limit"
    | "agent-down"
    | "connection";
  /** The HTTP status, when the failure came from a request. */
  status?: number;
}

type Handler = (payload?: unknown, detail?: unknown) => void;

/**
 * Accept either half of what a backend can hand back.
 *
 * A bare token is the obvious thing to return and it works — but it is only the
 * credential. The mint also says which transport to use, with which ICE servers,
 * and what the call will be called, and a backend that forwards the whole
 * response gets all of it. Returning just the string quietly opts out of LiveKit
 * and out of the gateway's own ICE, which is precisely backwards: the server-mint
 * path is the one that most wants them.
 */
function asSession(v: string | WhissleSessionInfo): WhissleSessionInfo {
  return typeof v === "string" ? { token: v } : v;
}

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

/** FastAPI puts its error text in `detail`. Best-effort — a non-JSON body is still
 *  an error, it just doesn't get to explain itself. */
async function detailOf(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return typeof body?.detail === "string" ? body.detail : undefined;
  } catch {
    return undefined;
  }
}

/** Why the session mint refused, said so the person reading it can act. */
function mintFailure(
  status: number,
  detail: string | undefined,
): { code: WhissleErrorDetail["code"]; message: string } {
  switch (status) {
    case 401:
      return { code: "expired", message: detail || "That key isn't valid for this agent." };
    case 402:
      return {
        code: "no-credit",
        message: "This agent is out of credit. Top up the workspace wallet to start sessions.",
      };
    case 403:
      return {
        code: "origin-not-allowed",
        message:
          "This site isn't allowed to embed this agent. Add " +
          (typeof location !== "undefined" ? location.origin : "its origin") +
          " to the allowed origins in the agent's Embed settings.",
      };
    case 404:
      return {
        code: "not-found",
        message: "This agent isn't available to embed — check the agent id, and that embedding is turned on.",
      };
    case 429:
      return { code: "rate-limited", message: detail || "Too many sessions right now — try again shortly." };
    case 503:
      return { code: "unavailable", message: "Embedding isn't available right now." };
    default:
      return {
        code: "connection",
        message: detail || `Couldn't start the agent (${status}).`,
      };
  }
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
 * import the top-level `mount()` for a ready-made widget (`WhissleAgents.mount()`
 * from a plain `<script>` tag). There is no `WhissleAgent.mount` static.
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
  /** The caller's own mic track, watched so we can say when it dies. */
  private micTrack: MediaStreamTrack | null = null;
  private micWatch: (() => void) | null = null;
  private micIsLost = false;
  /**
   * The current turn, buffered THREE times over.
   *
   * A pipecat gateway describes one reply with three streams of RTVI messages:
   * `bot-output` aggregated off the TTS stream (`spoken: true`), `bot-output`
   * aggregated off the LLM stream (`spoken: false`), and the deprecated
   * `bot-transcription`. They carry the same sentences, cut at the same places,
   * but they arrive at different times — so appending them all to one buffer is
   * what made every reply appear two or three times over, interleaved out of
   * order. Keep them apart, and emit exactly one of them per turn.
   *
   * Each buffer accumulates per SENTENCE (that is the aggregation the gateway
   * sends) and is flushed as ONE `agent-transcript` when the bot stops
   * speaking, so a multi-sentence reply is one event, not one per sentence.
   */
  private _turnSpoken = "";
  private _turnUnspoken = "";
  private _turnLegacy = "";
  /** The last `agent-partial` emitted this turn, so the next one cannot be shorter. */
  private _turnPartial = "";
  private earcons: EarconPlayer;
  private thinking = new ThinkingTracker();
  private textChannel: TextChannel | null = null;
  /** A thread key handed to `resumeTextThread` before a channel existed to hold it. */
  private pendingThread: string | null = null;
  /** When `_session` was minted, for the TTL check in `sessionExpired`. */
  private _sessionMintedAt = 0;
  /** Per-instance mobile playout. NOT module state: two agents on one page each
   *  own their graph, so one stopping cannot mute the other. */
  private playout = new BoostedPlayout();

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
    this.earcons = new EarconPlayer(
      options.earcons === false
        ? { enabled: false }
        : options.earcons === true || options.earcons === undefined
          ? {}
          : options.earcons,
    );
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

  /**
   * What the avatar's audio path is doing. `null` without an avatar (or with
   * `avatar.pacing: false`).
   *
   * The one to watch is `maxQueuedMs`: a healthy real-time feed never holds
   * more than one chunk (~190 ms), so a large value is audio that reached the
   * browser in a burst and was re-timed rather than allowed to stutter the face.
   */
  get avatarAudioStats(): AvatarAudioStats | null {
    return this.avatar?.audioStats ?? null;
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

  private emit(event: WhissleEvent, payload?: unknown, detail?: unknown) {
    this.handlers.get(event)?.forEach((h) => {
      try {
        h(payload, detail);
      } catch (err) {
        console.error(`[whissle] handler for "${event}" threw`, err);
      }
    });
  }

  /** Emit an `error` with a machine-readable code alongside the sentence. */
  private fail(message: string, code: WhissleErrorDetail["code"], status?: number) {
    this.emit("error", message, { code, ...(status ? { status } : {}) } as WhissleErrorDetail);
  }

  /**
   * The session for this conversation.
   *
   * Either your backend hands us a token (`sessionToken` / `getToken` — then no
   * key was ever in this page), or we mint one here from a publishable key bound
   * to this origin, and get the full session descriptor with it.
   */
  private async mintSession(): Promise<WhissleSessionInfo> {
    if (this.opts.sessionToken) return asSession(this.opts.sessionToken);
    if (this.opts.getToken) {
      const token = await this.opts.getToken();
      if (!token || (typeof token === "object" && !token.token)) {
        // Almost always your endpoint refusing the user rather than a bug here,
        // so say that instead of a generic failure.
        throw new Error(
          "WhissleAgent: `getToken` returned nothing — your backend didn't issue a session " +
            "token (is the user signed in?).",
        );
      }
      return asSession(token);
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
      // Every one of these is a different problem with a different fix, and they used
      // to collapse into one sentence. "Couldn't start the agent (check the key + agent
      // id)" is actively misleading when the truth is an empty wallet or a domain that
      // was never added to the allowlist — the developer goes and checks the key,
      // which is fine, and learns nothing.
      const { code, message } = mintFailure(res.status, await detailOf(res));
      const err = new Error(message) as Error & { code: WhissleErrorDetail["code"]; status: number };
      err.code = code;
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as WhissleSessionInfo;
  }

  /**
   * Is the pipeline already mixing tool cues into the audio we are about to play?
   *
   * `services/tool_cue.py` mixes them server-side in mode `"call"`, while
   * `services/tool_events.py` keeps shipping the clip NAME in every mode but `"off"`.
   * So on a `"call"` agent an SDK that plays unconditionally produces two cues a few
   * hundred milliseconds apart. Only an explicitly-configured agent is affected — the
   * embed default is `"ui"` — but "explicitly configured" is exactly the org that
   * cared about the sound.
   */
  private serverMixesCues(session: WhissleSessionInfo): boolean {
    const mode = session.agent?.tool_sounds ?? session.tool_sounds;
    return typeof mode === "string" && mode.trim().toLowerCase() === "call";
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

  /**
   * What to try when the chosen transport didn't come up. `null` to give up.
   *
   * Only ever one hop. A retry loop over transports on a session token that has
   * already started a metered bot is a good way to bill someone twice for a call they
   * never had.
   */
  private fallbackKind(
    session: WhissleSessionInfo,
    failed: "webrtc" | "livekit",
  ): "webrtc" | "livekit" | null {
    if ((this.opts.transport || "auto") !== "auto") return null;
    const listed = (session.transport as { fallbacks?: Array<{ kind?: string }> } | undefined)
      ?.fallbacks;
    for (const f of listed ?? []) {
      if ((f?.kind === "webrtc" || f?.kind === "livekit") && f.kind !== failed) return f.kind;
    }
    return null;
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
    // Before anything awaits: warm the mobile playout context. `start()` is called
    // from the integrator's click handler, and starting the context here means it
    // is running long before the agent's first words rather than racing them.
    // No-op on desktop. See `./mobile-audio`.
    this.playout.prime();
    // Same gesture, same reason: an AudioContext created anywhere but inside the click
    // stays suspended, and a suspended context makes every tool cue a silent no-op
    // with nothing in the console to explain it.
    this.earcons.prime();
    this._state = "connecting";
    this.emit("connecting");
    try {
      // Only in a real browser. Outside one there is no microphone to check and no
      // visitor to tell, and `checkMicrophone` would honestly report "this browser
      // can't reach a microphone" for something that is not a browser.
      if (this.opts.micPreflight !== false && typeof window !== "undefined") {
        const problem = await checkMicrophone();
        // Only a BLOCKING problem ends the session. This check is on by default and
        // runs on other people's sites, so anything it is not certain about has to be
        // reported rather than enforced — refusing a working microphone is a worse
        // failure than the deaf session the preflight exists to prevent, because the
        // visitor cannot even get as far as finding out. A warning goes out as an
        // ordinary `error` event (the widget shows it) and `start()` carries on.
        if (problem?.severity === "warning") {
          this.fail(problem.message, "microphone");
        } else if (problem) {
          const err = new Error(problem.message) as Error & {
            code: WhissleErrorDetail["code"];
          };
          err.code = "microphone";
          throw err;
        }
      }
      const session = await this.mintSession();
      this._session = session;
      this._sessionMintedAt = Date.now();
      // An agent whose tool cues are mixed into the CALL audio server-side
      // (`tool_sounds: "call"`) must not also have them played here — the two land a
      // few hundred ms apart and read as a stutter, not a cue. The pipeline still
      // ships the clip name in that mode (only `"off"` suppresses it), so the mint is
      // the only place the mode is knowable. Absent = "ui" = the browser plays it,
      // which is the embed default and every agent that has never been configured.
      this.earcons.setSuppressed(this.serverMixesCues(session));
      const token = session.token;

      // The avatar comes up BEFORE the conversation, so the face is already
      // listening when the agent delivers its greeting.
      const avatarCode = this.avatarOpts ? await this.startAvatar(token) : null;

      const kind = this.transportFor(session);
      this._transport = kind;
      try {
        if (kind === "livekit") await this.connectLiveKit(session, avatarCode);
        else await this.connectWebRTC(session, avatarCode);
      } catch (err) {
        // The mint doesn't just name a transport, it names what to try INSTEAD —
        // `transport.fallbacks` is a real field the gateway has been sending all along
        // (today: LiveKit primary, SmallWebRTC fallback) and this SDK ignored it, so a
        // room the browser couldn't reach was the end of the session rather than a
        // detour. Only taken when the caller left the choice to us: someone who wrote
        // `transport: "livekit"` asked for a specific transport and should be told it
        // failed, not quietly moved somewhere else.
        const fallback = this.fallbackKind(session, kind);
        if (!fallback) throw err;
        await this.teardown();
        this._transport = fallback;
        if (fallback === "livekit") await this.connectLiveKit(session, avatarCode);
        else await this.connectWebRTC(session, avatarCode);
      }
    } catch (err) {
      this._state = "idle";
      void this.teardown();
      this.releaseSession();
      const coded = err as { code?: WhissleErrorDetail["code"]; status?: number };
      this.fail(
        err instanceof Error ? err.message : String(err),
        coded?.code ?? "connection",
        coded?.status,
      );
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

      const avatar = new SimliAvatar(this.resolveVideoElement(wanted), wanted.pacing !== false);
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

  /** The callbacks both transports feed. One brain, two wires. (Protected so a
   *  test can drive the transcript/turn logic without a browser.) */
  protected callbacks(): SessionCallbacks {
    return {
      onConnected: () => {
        this._state = "connected";
        this.watchMic();
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
        // New turn — start fresh `bot-output` buffers. NOT the legacy one: it is
        // cut on LLM tokens and lands BEFORE the bot starts speaking, so
        // clearing it here would throw the only copy some gateways send away.
        this._turnSpoken = "";
        this._turnUnspoken = "";
        this._turnPartial = "";
        // The bot talking is the ground truth that the wait is over — it beats any
        // bookkeeping, because a result frame can be dropped on the way here and
        // audio cannot be faked. Without this, one lost result pins a "working…"
        // affordance on screen for the rest of the call.
        this.settleThinking(this.thinking.clear());
        this.emit("speaking-started");
      },
      onBotStoppedSpeaking: () => {
        // One turn, one `agent-transcript`. Prefer what was actually SPOKEN —
        // it is cut on the TTS stream, so it is both the words the listener
        // heard and the order they heard them in. The other two are the same
        // reply seen from further upstream, and are only worth anything when a
        // gateway doesn't send the good one.
        const text = (this._turnSpoken || this._turnUnspoken || this._turnLegacy).trim();
        this._turnSpoken = "";
        this._turnUnspoken = "";
        this._turnLegacy = "";
        this._turnPartial = "";
        if (text) this.emit("agent-transcript", text);
        this.emit("speaking-stopped");
      },
      onBotOutput: (segment, spoken) => {
        const seg = segment.trim();
        if (!seg) return;
        if (spoken) this._turnSpoken = this._turnSpoken ? `${this._turnSpoken} ${seg}` : seg;
        else this._turnUnspoken = this._turnUnspoken ? `${this._turnUnspoken} ${seg}` : seg;
        // The turn so far, live. Prefer the spoken copy — as the final flush does —
        // but a partial must never go BACKWARDS.
        //
        // Observed on the live demo agent: the LLM stream delivers the whole greeting
        // as ONE segment, and the TTS stream then delivers the same greeting a WORD at
        // a time. Preferring `spoken` unconditionally therefore rendered the complete
        // sentence and then replaced it with "Hey,", growing back to the same sentence
        // over the next two seconds. Anyone rendering `agent-partial` — which the
        // README recommends as the thing to show mid-answer — watched the reply
        // apparently delete itself.
        //
        // So: take whichever reading is furthest along, and emit only when the turn
        // has actually advanced. The spoken copy still wins as soon as it catches up,
        // which is the normal case (it usually arrives first and is the only one).
        const ahead =
          this._turnSpoken.length >= this._turnUnspoken.length
            ? this._turnSpoken
            : this._turnUnspoken;
        if (ahead.length > this._turnPartial.length) {
          this._turnPartial = ahead;
          this.emit("agent-partial", ahead);
        }
      },
      onBotLegacyOutput: (segment) => {
        const seg = segment.trim();
        if (seg) this._turnLegacy = this._turnLegacy ? `${this._turnLegacy} ${seg}` : seg;
      },
      onBotWord: (word) => {
        if (word) this.emit("agent-word", word);
      },
      onUserTranscript: (text, final) => {
        this.emit(final ? "user-transcript" : "user-interim", text);
      },
      onUserStartedSpeaking: () => this.emit("listening-started"),
      onUserStoppedSpeaking: () => this.emit("listening-stopped"),
      onRemoteAudioTrack: (track) => {
        this.remoteTrack = track;
        // With a browser-rendered avatar, Simli plays the lip-synced audio. Also
        // playing the raw track would double every word, half a beat apart.
        if (this.avatar) return;
        if (this.audioEl) {
          const stream = new MediaStream([track]);
          this.audioEl.srcObject = stream;
          // On a phone this element is too quiet to use — iOS caps it at the
          // earpiece, Android hands it to the voice-call stream — so route the
          // same stream through a boosted WebAudio graph and mute the element to
          // avoid double playback. Desktop and any WebAudio failure leave the
          // element playing exactly as before. Never reached with an avatar: Simli
          // owns playback there, and its PCM comes off the data channel, not this
          // track.
          this.playout.attach(stream, this.audioEl);
          this.audioEl.play().catch(() => {
            this.fail(
              "Your browser blocked the agent's audio. Click anywhere on the page to allow it.",
              "autoplay",
            );
          });
        }
      },
      onServerMessage: (data) => this.routeServerMessage(data),
      onError: (message) => this.fail(message, "connection"),
    };
  }

  /**
   * Everything the pipeline says that isn't speech.
   *
   * One channel, three discriminators, and they must be read in this order — `kind`
   * (tool events and the live signal stream), then `t` (the short-tag UI events), then
   * `type` (the unlabelled session-ending notices). They are genuinely different
   * families that happen to share a pipe.
   *
   * Before 0.5.0 this method was four lines: two avatar frames, one credit check, and
   * `emit("server-message", data)` for absolutely everything else. That is why an
   * embed was silent during tool calls and had no way to explain a pause — the
   * information was arriving the whole time, unlabelled and unparsed, and the only way
   * to use any of it was to re-implement the wire format by hand off the console.
   *
   * Everything still ALSO goes out as `server-message`, unchanged, so an integrator
   * who already parses it themselves keeps working exactly as before.
   */
  private routeServerMessage(data: unknown): void {
    const msg = (data ?? {}) as {
      type?: string;
      error?: string;
      message?: string;
      t?: string;
      text?: string;
      pcm?: string;
    };

    // Avatar frames first: they arrive several times a second and never concern the app.
    if (msg.t === "simli-audio" && msg.pcm) {
      this.avatar?.sendPcm(decodeBase64(msg.pcm));
      return;
    }
    if (msg.t === "simli-clear") {
      this.avatar?.clearBuffer();
      return;
    }

    const tool = parseToolEvent(data);
    if (tool) {
      if (tool.phase === "started") {
        // The cue goes FIRST, ahead of any handler work. It is the low-latency half of
        // this signal and must not queue behind whatever an integrator does with the
        // event — a cue that lands after the tool has finished is an echo.
        this.earcons.play(tool.data.sound);
        this.settleThinking(this.thinking.start(tool.data));
        this.emit("tool-started", tool.data satisfies ToolStarted);
      } else if (tool.phase === "progress") {
        this.settleThinking(this.thinking.progress(tool.data));
        this.emit("tool-progress", tool.data satisfies ToolProgress);
      } else {
        // Only a FAILURE carries a cue here — a success is about to be narrated by the
        // agent, so a chime on every result would turn the bank into wallpaper.
        this.earcons.play(tool.data.sound);
        this.settleThinking(this.thinking.finish(tool.data));
        this.emit("tool-finished", tool.data satisfies ToolFinished);
      }
      this.emit("server-message", data);
      return;
    }

    const signal = parseSignal(data);
    if (signal) {
      this.emit("signal", signal);
      this.emit("server-message", data);
      return;
    }

    const meta = parseUserMetadata(data);
    if (meta) {
      this.emit("user-metadata", meta);
      this.emit("server-message", data);
      return;
    }

    switch (msg.t) {
      case "gist":
        if (msg.text) this.emit("gist", msg.text);
        break;
      case "mic_dead":
        // The server received no audio at all. Distinct from `mic-lost`, which is the
        // device dying: here the device is fine and the audio isn't arriving.
        this.fail(
          msg.text || "We're not hearing anything from your microphone.",
          "microphone",
        );
        break;
      case "agent_error":
        this.fail(msg.text || "The agent is having trouble responding.", "agent-down");
        break;
    }

    // The unlabelled notices. Both of these END the session, which is why they are
    // worth naming rather than leaving for the app to recognise.
    //
    // These two are CONSUMED, not forwarded — they are errors, not application data,
    // and the existing contract has never leaked them. The tool/signal/metadata events
    // above go out as `server-message` as well precisely because the opposite is true
    // there: forwarding was the only way to reach them before 0.5.0, and taking that
    // away to make the routing tidier would break every integrator who parses them by
    // hand today.
    if (msg.type === "error" && msg.error === "no_credits") {
      this.fail(msg.message || "This agent has run out of credits.", "no-credit");
      return;
    }
    if (msg.type === "demo-limit") {
      this.emit("demo-limit", data);
      this.fail("You've reached the demo limit for this agent.", "demo-limit");
      return;
    }

    // Everything else is the agent talking to YOUR app. The SDK has no opinion about
    // it — an interview announcing which question it just reached, a form reporting a
    // field captured — so hand it over intact rather than dropping what it doesn't
    // recognise.
    this.emit("server-message", data);
  }

  /** Emit `thinking` only when the state actually moved. */
  private settleThinking(next: ThinkingState | null): void {
    if (next) this.emit("thinking", next);
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
        onUserStartedSpeaking: cb.onUserStartedSpeaking,
        onUserStoppedSpeaking: cb.onUserStoppedSpeaking,
        // Word-level, as the TTS says it. Separate from `bot-output` on purpose —
        // see `SessionCallbacks.onBotWord`.
        onBotTtsText: (data: { text?: string }) => cb.onBotWord(data?.text ?? ""),
        // No `onBotTranscript` here: PipecatClient routes the deprecated
        // `bot-transcription` to its own callback, and subscribing to it only
        // buys a console warning on every session. `bot-output` still arrives
        // twice per sentence though — the `spoken` flag is what separates them.
        onBotOutput: (data: { text?: string; spoken?: boolean }) =>
          cb.onBotOutput(data?.text ?? "", data?.spoken === true),
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

  /**
   * Watch the caller's microphone for the ways it stops mid-session: unplugged,
   * taken by another application, or revoked in browser settings.
   *
   * A dead mic is invisible from inside a call — the agent simply waits, the
   * caller keeps talking, and neither can tell the other why nothing is
   * happening. The track's own `ended`/`mute` events are the only honest signal,
   * so surface them and let the app say something.
   *
   * `mute` here is the DEVICE going silent, not the caller pressing mute
   * (`setMuted` disables the track, which fires nothing).
   */
  private watchMic(): void {
    if (typeof navigator === "undefined" || this.micWatch) return;
    // The live outbound track, whichever transport published it.
    const track =
      this.lk?.micTrack?.() ??
      (this.client as unknown as { tracks?: () => { local?: { audio?: MediaStreamTrack } } })
        ?.tracks?.()?.local?.audio ??
      null;
    if (!track) return;
    this.micTrack = track;
    const lost = () => {
      if (this.micIsLost) return;
      this.micIsLost = true;
      this.emit("mic-lost");
    };
    const back = () => {
      if (!this.micIsLost) return;
      this.micIsLost = false;
      this.emit("mic-restored");
    };
    track.addEventListener("ended", lost);
    track.addEventListener("mute", lost);
    track.addEventListener("unmute", back);
    this.micWatch = () => {
      track.removeEventListener("ended", lost);
      track.removeEventListener("mute", lost);
      track.removeEventListener("unmute", back);
    };
  }

  /**
   * Send a control message to the running agent.
   *
   * The counterpart of the `server-message` event: this is how your app drives
   * behaviour the SDK knows nothing about — pausing an interview, asking it to
   * wrap up, telling it the user is ready.
   *
   *   agent.send("wrap-up");
   *   agent.send("set-difficulty", { level: "hard" });
   *
   * Delivered on the session's reliable data channel. Safe to call before the
   * session is up — it is dropped rather than throwing, because a lost control
   * message must never take down a live conversation.
   */
  send(type: string, data?: unknown): void {
    try {
      if (this.lk) {
        // Was `lk.send({type, data})`, which the bot does not recognise and drops —
        // so every control message on the LiveKit transport (the one production
        // sessions actually use) went nowhere, silently. See `LiveKitSession.
        // sendClientMessage`.
        this.lk.sendClientMessage(type, data);
        return;
      }
      (this.client as unknown as {
        sendClientMessage?: (t: string, d?: unknown) => void;
      })?.sendClientMessage?.(type, data);
    } catch {
      /* a dropped control message is not worth ending the session over */
    }
  }

  /**
   * Type to the agent.
   *
   * Same agent, same prompt, same knowledge base and tools as the voice channel — a
   * Whissle agent is one brain with several mouths, and until 0.5.0 this SDK could
   * only reach one of them. Two situations it answers, both extremely common on a
   * public page: a visitor who denies the microphone, and a visitor who does not want
   * to talk out loud.
   *
   * It behaves differently depending on whether a call is up, and that is the point:
   *
   *   • **During a live voice session** the text is injected into the SAME conversation
   *     over the data channel, and the agent answers it out loud, in context. That is
   *     the voice↔text handoff: spell an email address rather than repeating it four
   *     times, paste a reference number, type the thing you would rather not say in an
   *     open-plan office. Resolves immediately with `null` — the reply comes back as
   *     speech, through `agent-transcript` like any other turn.
   *
   *   • **With no session up** it runs a text turn over HTTP and resolves with the
   *     reply, tools used and citations. Consecutive calls continue one thread, so the
   *     agent remembers the conversation rather than starting cold each message. This
   *     needs no microphone and no WebRTC at all — a text-only widget never calls
   *     `start()`.
   *
   * Requires text to be enabled on the agent (`session.text_enabled`); without it the
   * gateway answers 404 and this rejects saying so.
   */
  async sendText(message: string, opts: SendTextOptions = {}): Promise<TextTurn | null> {
    const text = message?.trim();
    if (!text) return null;
    if (this._state === "connected") {
      // `user-text` is a small JSON control message on the data channel. Images
      // deliberately do NOT go this way: the channel chunks at ~64 KB and the far side
      // has no image handler on this path, so offering it would be offering a send
      // that quietly does nothing.
      this.send("user-text", { text });
      return null;
    }
    const channel = await this.ensureTextChannel();
    try {
      const turn = await channel.send(text, opts);
      // Emit it as an ordinary turn as well, so a UI wired for voice lights up for
      // typed messages without a second code path.
      if (turn.reply) this.emit("agent-transcript", turn.reply);
      return turn;
    } catch (err) {
      const e = err as WhissleTextError;
      this.fail(
        e?.message || "Couldn't reach the agent.",
        e?.code === 402
          ? "no-credit"
          : e?.code === 403
            ? "origin-not-allowed"
            : e?.code === 401
              ? "expired"
              : e?.code === 404
                ? "not-found"
                : e?.code === 429
                  ? "rate-limited"
                  : "connection",
        e?.code,
      );
      throw err;
    }
  }

  /**
   * The key that resumes the HTTP text thread `sendText` is on.
   *
   * Persist this (a cookie, `localStorage`) and pass it to `resumeTextThread` on the
   * visitor's next page load. It is NOT the `conversationId` on a `TextTurn`: that is
   * the gateway's conversation row id, which nothing on the wire accepts as an input.
   * See `./text` for why the distinction is load-bearing.
   */
  get textThread(): string | null {
    return this.textChannel?.thread ?? this.pendingThread ?? null;
  }

  /**
   * Continue an HTTP text thread from a previous page load.
   *
   * Deliberately does no I/O: it remembers the key and applies it when the channel is
   * built. Minting here would spend a session token — against the mint's rate limit —
   * on a page load where the visitor may never type anything.
   */
  resumeTextThread(threadId: string): void {
    if (!threadId) return;
    this.pendingThread = threadId;
    this.textChannel?.resume(threadId);
  }

  /**
   * The text door for this agent, minting a session if we don't already have one.
   *
   * The mint DESCRIBES where text turns go (`transport.text.connect`), so follow that
   * rather than hard-coding the path: it is how the gateway moves the endpoint without
   * breaking every embed in the wild. The hard-coded fallback is for a gateway old
   * enough not to describe it yet.
   */
  private async ensureTextChannel(): Promise<TextChannel> {
    if (this.textChannel && !this.sessionExpired()) return this.textChannel;
    // Expired: drop the door and mint a new one. A widget can sit on a page for hours
    // — an embed token lives 900 s — so the alternative is a `sendText` that answers
    // "this session has expired" with no way back, on a page that never reloaded.
    // The thread key survives the re-mint, so the conversation does not restart.
    if (this.textChannel) {
      this.pendingThread = this.textChannel.thread ?? this.pendingThread;
      this.textChannel = null;
      this._session = null;
    }
    const session = this._session ?? (await this.mintSession());
    this._session = session;
    this._sessionMintedAt = Date.now();
    if (session.text_enabled === false) {
      throw new WhissleTextError(
        404,
        "This agent isn't set up for text. Turn on text replies in its Embed settings.",
      );
    }
    const described = (session.transport as { text?: { connect?: { url?: string } } } | undefined)
      ?.text?.connect?.url;
    const path = described || "/api/embed/chat/turn";
    const url = /^https?:/i.test(path) ? path : `${this.opts.baseUrl}${path}`;
    const channel = new TextChannel(url, session.token, session.session_id);
    // A key the caller asked to resume outranks the one this mint happens to carry:
    // the whole point of resuming is that the new page load has a NEW session id.
    if (this.pendingThread) channel.resume(this.pendingThread);
    this.textChannel = channel;
    return channel;
  }

  /**
   * Has the session token we hold outlived its TTL?
   *
   * Judged with a 30 s margin, because the failure is asymmetric: re-minting a token
   * that had a few seconds left costs one request, while using one that has just
   * expired costs the visitor their message and gives them nothing to do about it.
   * A caller-supplied static `sessionToken` is never treated as expired — we cannot
   * mint a replacement for it, so declaring it dead would only turn a maybe-working
   * request into a definitely-failing one.
   */
  private sessionExpired(): boolean {
    if (this.opts.sessionToken) return false;
    const ttl = this._session?.expires_in;
    if (!ttl || !this._sessionMintedAt) return false;
    return Date.now() - this._sessionMintedAt > Math.max(0, ttl * 1000 - 30_000);
  }

  /** Silence tool cues without changing anything else. Wire this to your mute button:
   *  a visitor who mutes the agent means the sounds too. */
  setEarconsMuted(muted: boolean): void {
    this.earcons.setMuted(muted);
  }

  /**
   * The microphones this browser will admit to, for a device picker.
   *
   * Labels are only real once permission has been granted, so call this after
   * `start()` (or after a `checkMicrophone()`); before that a browser returns a single
   * unlabelled placeholder and a picker built from it is a menu of nothing.
   */
  listMicrophones(): Promise<MediaDeviceInfo[]> {
    return listMicrophones();
  }

  /**
   * Switch the live session to a different microphone.
   *
   * Asks the transport to swap the device it already owns rather than opening a second
   * one — holding two tracks on one input is how a device ends up locked and the
   * session ends up deaf.
   *
   * LiveKit only for now; on SmallWebRTC this is a no-op and returns `false`, because
   * failing loudly at the transport boundary would end a live call over a settings
   * change nobody had to make.
   */
  setMicrophone(deviceId: string): boolean {
    try {
      const client = this.client as unknown as { updateMic?: (id: string) => void };
      if (client?.updateMic) {
        client.updateMic(deviceId);
        return true;
      }
      return this.lk?.setMicrophone(deviceId) ?? false;
    } catch {
      return false;
    }
  }

  /** Check the microphone without starting a session — for a "test your mic" button,
   *  or to ask for permission before showing the visitor a Start button that needs it. */
  checkMicrophone(): Promise<MicProblem | null> {
    return checkMicrophone();
  }

  /** End the session and clean up. Handlers are kept, so the same instance can be
   *  started again; use `destroy()` to let go of it for good. */
  stop(): void {
    void this.teardown();
    this.releaseSession();
    this._state = "idle";
  }

  /**
   * Release everything and forget the handlers. The instance is not reusable after.
   *
   * `stop()` deliberately keeps event handlers so a widget can offer "start again"
   * without re-wiring; that also means a long-lived page accumulates them. Call this
   * when the component unmounts — an SPA route change, a React `useEffect` cleanup —
   * so the agent, its handlers and anything they close over can be collected.
   */
  destroy(): void {
    this.stop();
    this.handlers.clear();
  }

  /**
   * Drop the minted session and the text door built on it.
   *
   * Separate from `teardown()` on purpose. `teardown()` also runs MID-`start()`, when
   * a transport fails and the same session is about to be reused for the fallback —
   * clearing `_session` there would throw away the mint the retry is standing on. This
   * runs only where the session is genuinely finished.
   *
   * Not clearing it is how a widget that has been open for hours reaches a `sendText`
   * that answers "this session has expired" with nothing to do about it: the token
   * lives 900 s, the page does not reload, and the cached channel holds the dead token
   * forever. The THREAD survives (it is a key, not a credential), so the conversation
   * resumes on the next mint rather than starting cold.
   */
  private releaseSession(): void {
    this.pendingThread = this.textChannel?.thread ?? this.pendingThread;
    this.textChannel = null;
    this._session = null;
    this._sessionMintedAt = 0;
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
    this.micWatch?.();
    this.micWatch = null;
    this.micTrack = null;
    this.micIsLost = false;
    const avatar = this.avatar;
    this.avatar = null;
    await avatar?.destroy();
    this.playout.teardown();
    this.earcons.release();
    this.settleThinking(this.thinking.clear());
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.remove();
      this.audioEl = null;
    }
  }
}
