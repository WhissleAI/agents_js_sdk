// A LISTEN session: the visitor speaks, the platform transcribes and reads the
// delivery — and no agent ever answers.
//
// The other half of `POST /api/agents/{id}/listen/start`, which a server mints
// with `@whissle/sdk` (`whissle.listen.start(agentId)`) and hands to the page as
// `{url, token, room}`. The room is the same LiveKit room a voice session uses
// and the bot on the far side speaks the same RTVI envelope over the same data
// channel, so `LiveKitSession` carries it unchanged. What differs is what comes
// back: there is no bot speech, no tool calls and no reply — just the caller's
// own words as they are recognised, and the pipeline's read of how they were
// said (emotion, intent, pace, the entities the ear may have dropped).
//
// The one thing that makes a listen session USABLE rather than merely
// connected is `turn_id`. Every final `user-transcription` frame carries one,
// and the emotion/intent signal frames for that utterance carry the SAME one —
// so a consumer can put "what was said" and "how it was said" on one clock
// without guessing from arrival order, which on a busy channel is wrong more
// often than it looks. This module surfaces it on both events, and nothing
// here fires without it being read.
//
// Deliberately NOT a `WhissleAgent`. That class owns a bot: greeting handshakes,
// playback readiness, speaking edges, tool cards, an avatar. None of it applies
// here, and an emitter that fires `speaking-started` for an agent that does not
// exist is a widget that renders a phantom. A listen session is a small typed
// emitter of its own with exactly the events it can honestly deliver.

import { LiveKitSession, type LiveKitConnectInfo, type SessionCallbacks } from "./livekit";
import {
  parseSignal,
  parseUserMetadata,
  type LiveSignal,
  type UserMetadata,
} from "./signals";

/** What `listen.start` returns and what `listen()` joins. `room` is informational. */
export type ListenConnectInfo = LiveKitConnectInfo;

/** One recognised utterance — interim while still being recognised, then final. */
export interface ListenTranscript {
  text: string;
  /** `false` for a provisional guess that the next one replaces; `true` once settled. */
  final: boolean;
  /**
   * The utterance's id. Stamped by the gateway on every final; the `signal`
   * events for the same utterance carry the same one. Absent on an interim
   * (which the gateway does not stamp) and on an older gateway.
   */
  turnId?: string;
  /** The frame's `data`, untouched. */
  raw: unknown;
}

export type ListenEvent =
  | "connected"
  | "disconnected"
  /** A `ListenTranscript` — interim and final both, distinguished by `final`. */
  | "transcript"
  /** A `LiveSignal`, with `turnId` when the frame carried one. */
  | "signal"
  /** A `UserMetadata` — the acoustic read; see `./signals` for the NEUTRAL rule. */
  | "user-metadata"
  /** Any structured message from the pipeline, untouched. Everything typed above
   *  ALSO lands here, so nothing parsed by hand goes away. */
  | "server-message"
  /** A sentence describing what went wrong. */
  | "error";

export interface ListenOptions {
  /** Which microphone to capture from. Default: the browser's choice. */
  deviceId?: string;
  /** Start muted — connect the room and publish nothing until `unmute()`. */
  muted?: boolean;
}

type Handler = (payload?: unknown) => void;

/**
 * A live listen session. Construct it with `listen()`.
 *
 * Connects on creation; `connected` fires when the room is up and the mic is
 * published. `close()` leaves the room and is the only way the session ends
 * from this side — the platform ends it on its own when the caller stops for
 * long enough, at the agent's cap, or on an error, and says so in the session's
 * `end_reason` afterwards.
 */
export class ListenSession {
  private readonly handlers = new Map<ListenEvent, Set<Handler>>();
  private readonly session = new LiveKitSession();
  private _state: "connecting" | "connected" | "closed" = "connecting";
  private closed = false;

  constructor(info: ListenConnectInfo, opts: ListenOptions = {}) {
    if (opts.muted) this.session.setMuted(true);
    void this.session
      .connect(info, this.callbacks(opts))
      .catch((err) => {
        this._state = "closed";
        this.emit("error", err instanceof Error ? err.message : "Couldn't join the listen session.");
      });
  }

  /** `"connecting"` until the room is up, `"closed"` after `close()` or a drop. */
  get state(): "connecting" | "connected" | "closed" {
    return this._state;
  }

  on(event: ListenEvent, handler: Handler): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }

  off(event: ListenEvent, handler: Handler): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  /** Stop publishing audio. The room stays up; the platform hears silence. */
  mute(): void {
    this.session.setMuted(true);
  }

  unmute(): void {
    this.session.setMuted(false);
  }

  /** Switch microphones mid-session. `false` if the transport could not. */
  setMicrophone(deviceId: string): boolean {
    return this.session.setMicrophone(deviceId);
  }

  /** Leave the room. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this._state = "closed";
    this.session.disconnect();
    this.emit("disconnected");
  }

  private emit(event: ListenEvent, payload?: unknown) {
    this.handlers.get(event)?.forEach((h) => {
      try {
        h(payload);
      } catch (err) {
        console.error(`[whissle] listen handler for "${event}" threw`, err);
      }
    });
  }

  /**
   * The transport callbacks. The bot-side ones are wired to nothing on purpose:
   * a listen session has no bot, so a frame claiming it spoke is a frame this
   * session should not pretend to understand.
   */
  private callbacks(opts: ListenOptions): SessionCallbacks {
    const noop = () => {};
    return {
      onConnected: () => {
        if (this.closed) return;
        this._state = "connected";
        if (opts.deviceId) this.session.setMicrophone(opts.deviceId);
        this.emit("connected");
      },
      onDisconnected: () => {
        // A drop from the far side. `close()` already emitted for a local leave.
        if (this.closed) return;
        this.closed = true;
        this._state = "closed";
        this.emit("disconnected");
      },
      onBotReady: noop,
      onBotStartedSpeaking: noop,
      onBotStoppedSpeaking: noop,
      onBotOutput: noop,
      onBotLegacyOutput: noop,
      onBotWord: noop,
      onUserTranscript: (text, final, meta) => {
        const t: ListenTranscript = {
          text,
          final,
          ...(meta?.turnId ? { turnId: meta.turnId } : {}),
          raw: meta?.raw,
        };
        this.emit("transcript", t);
      },
      onUserStartedSpeaking: noop,
      onUserStoppedSpeaking: noop,
      onRemoteAudioTrack: noop, // nothing speaks back; a stray track is ignored
      onServerMessage: (data) => this.route(data),
      onError: (message) => this.emit("error", message),
    };
  }

  private route(data: unknown) {
    const signal = parseSignal(data);
    if (signal) {
      this.emit("signal", signal satisfies LiveSignal);
      this.emit("server-message", data);
      return;
    }
    const meta = parseUserMetadata(data);
    if (meta) {
      this.emit("user-metadata", meta satisfies UserMetadata);
      this.emit("server-message", data);
      return;
    }
    this.emit("server-message", data);
  }
}

/**
 * Join a listen room.
 *
 * ```ts
 * const info = await fetch("/api/listen").then((r) => r.json()); // your server: whissle.listen.start(agentId)
 * const l = listen(info);
 * l.on("transcript", (t) => { … });  // { text, final, turnId?, raw }
 * l.on("signal", (s) => { … });      // LiveSignal with the same turnId
 * ```
 */
export function listen(info: ListenConnectInfo, opts: ListenOptions = {}): ListenSession {
  if (!info?.url || !info?.token) {
    throw new Error("listen() needs the {url, token} your server got from listen.start.");
  }
  return new ListenSession(info, opts);
}
