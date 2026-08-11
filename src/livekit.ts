import { RTVIMessage, RTVIMessageType } from "@pipecat-ai/client-js";
// Type-only: erased at build time, so livekit-client stays a lazy chunk.
import type { Room as LiveKitRoom } from "livekit-client";

/** What `POST /api/embed/livekit` returns — the Tavus-shaped transport descriptor. */
export interface LiveKitConnectInfo {
  url: string;
  token: string;
  room?: string;
}

/**
 * The transport-agnostic slice of a live session that `WhissleAgent` drives.
 * SmallWebRTC (via PipecatClient) and LiveKit both fill this in.
 */
export interface SessionCallbacks {
  onConnected: () => void;
  onDisconnected: () => void;
  onBotReady: (data: unknown) => void;
  onBotStartedSpeaking: () => void;
  onBotStoppedSpeaking: () => void;
  onBotOutput: (text: string) => void;
  onUserTranscript: (text: string, final: boolean) => void;
  onRemoteAudioTrack: (track: MediaStreamTrack) => void;
  onServerMessage: (data: unknown) => void;
  onError: (message: string) => void;
}

const RTVI_LABEL = "rtvi-ai";

let roomCtor: Promise<typeof import("livekit-client")> | null = null;

/** Load livekit-client lazily so a SmallWebRTC-only page never downloads it. */
function loadLiveKit(): Promise<typeof import("livekit-client")> {
  if (!roomCtor) {
    roomCtor = import("livekit-client");
    roomCtor.catch(() => {
      roomCtor = null;
    });
  }
  return roomCtor;
}

/**
 * A LiveKit-backed session.
 *
 * The gateway hands us `{url, token, room}` and the LiveKit client SDK owns
 * everything underneath — ICE, TURN, reconnection, track subscription. That is
 * the whole point of preferring it: an integrator stops hand-rolling peer
 * connections and inventing ICE config.
 *
 * The bot on the other side is the same Pipecat pipeline as the SmallWebRTC
 * path, so it speaks the same RTVI protocol — just over LiveKit's data channel
 * instead of a raw one. We translate those envelopes into the same callbacks
 * `PipecatClient` would have fired, so `WhissleAgent` cannot tell the difference.
 */
export class LiveKitSession {
  private room: LiveKitRoom | null = null;
  private micEnabled = true;

  async connect(info: LiveKitConnectInfo, cb: SessionCallbacks): Promise<void> {
    const { Room, RoomEvent } = await loadLiveKit();
    const room = new Room({ adaptiveStream: false, dynacast: false });
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track: { kind: string; mediaStreamTrack: MediaStreamTrack }) => {
      if (track?.kind === "audio" && track.mediaStreamTrack) {
        cb.onRemoteAudioTrack(track.mediaStreamTrack);
      }
    });
    room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
      this.handleData(payload, cb);
    });
    room.on(RoomEvent.Disconnected, () => cb.onDisconnected());

    await room.connect(info.url, info.token);
    await room.localParticipant.setMicrophoneEnabled(this.micEnabled);
    cb.onConnected();

    // Pipecat's RTVI processor waits for `client-ready` before it lets the bot
    // greet. Without this the room connects and nobody ever says anything.
    this.send(RTVIMessage.clientReady());
  }

  /** Publish an RTVI message on the room's reliable data channel. */
  private send(message: unknown): void {
    const room = this.room;
    if (!room) return;
    try {
      const body = { label: RTVI_LABEL, ...(message as Record<string, unknown>) };
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      void room.localParticipant.publishData(bytes, { reliable: true });
    } catch {
      /* the session survives a dropped control message */
    }
  }

  private handleData(payload: Uint8Array, cb: SessionCallbacks): void {
    let msg: { label?: string; type?: string; data?: unknown };
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return; // not ours (or not JSON) — ignore rather than break the session
    }
    if (!msg || (msg.label && msg.label !== RTVI_LABEL)) return;
    const data = (msg.data ?? {}) as Record<string, unknown>;
    switch (msg.type) {
      case RTVIMessageType.BOT_READY:
        cb.onBotReady(msg.data);
        break;
      case RTVIMessageType.BOT_STARTED_SPEAKING:
        cb.onBotStartedSpeaking();
        break;
      case RTVIMessageType.BOT_STOPPED_SPEAKING:
        cb.onBotStoppedSpeaking();
        break;
      case RTVIMessageType.BOT_OUTPUT:
      case RTVIMessageType.BOT_TRANSCRIPTION:
        cb.onBotOutput(String(data.text ?? ""));
        break;
      case RTVIMessageType.USER_TRANSCRIPTION:
        cb.onUserTranscript(String(data.text ?? ""), Boolean(data.final));
        break;
      case RTVIMessageType.SERVER_MESSAGE:
        // Pipecat nests the payload one level deep under `data.data`.
        cb.onServerMessage((data as { data?: unknown }).data ?? data);
        break;
      case RTVIMessageType.ERROR:
        cb.onError(String(data.error ?? data.message ?? "Connection error."));
        break;
      default:
        break;
    }
  }

  setMuted(muted: boolean): void {
    this.micEnabled = !muted;
    void this.room?.localParticipant.setMicrophoneEnabled(this.micEnabled)?.catch?.(() => undefined);
  }

  disconnect(): void {
    const room = this.room;
    this.room = null;
    try {
      void room?.disconnect();
    } catch {
      /* already gone */
    }
  }
}
