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
  /**
   * A `bot-output` segment. `spoken` is the message's own flag: true when the
   * aggregation came off the TTS stream (the words as they are said), false
   * when it came off the LLM stream. A gateway emits BOTH for every sentence,
   * so the flag is the only thing that tells the two copies apart.
   */
  onBotOutput: (text: string, spoken: boolean) => void;
  /**
   * `bot-transcription`, the message `bot-output` replaced. Kept apart from
   * `onBotOutput` on purpose — a gateway sends both, so merging them adds a
   * third copy of the same reply. See the handler below.
   */
  onBotLegacyOutput: (text: string) => void;
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
  send(message: unknown): void {
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
        cb.onBotOutput(String(data.text ?? ""), data.spoken === true);
        break;
      // `bot-transcription` is NOT a second copy of `bot-output` arriving late —
      // it is a third view of the same reply, cut on LLM tokens at sentence
      // boundaries, and pipecat's RTVI observer emits it alongside the other
      // two. It lands earlier and in generation order, so folding it into
      // `onBotOutput` is what scrambled the doubled text. Pass it on its own
      // channel; the agent uses it only when a gateway sends nothing better.
      case RTVIMessageType.BOT_TRANSCRIPTION:
        cb.onBotLegacyOutput(String(data.text ?? ""));
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

  /**
   * The caller's published mic track, so the agent can watch it for the device
   * dying. Null before connect, or if the mic was never published.
   */
  micTrack(): MediaStreamTrack | null {
    const pubs = this.room?.localParticipant?.audioTrackPublications;
    if (!pubs) return null;
    for (const pub of pubs.values()) {
      const t = (pub as { track?: { mediaStreamTrack?: MediaStreamTrack } })?.track?.mediaStreamTrack;
      if (t) return t;
    }
    return null;
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
