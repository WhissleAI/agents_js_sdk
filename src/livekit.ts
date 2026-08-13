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
  /**
   * One word of the reply, at the moment the TTS speaks it (`bot-tts-text`).
   *
   * The finest granularity the pipeline offers, and the only one that can drive a
   * caption that keeps time with the voice — `bot-output` is cut at sentences, which
   * on a long reply means the screen sits still for several seconds and then jumps.
   */
  onBotWord: (word: string) => void;
  onUserTranscript: (text: string, final: boolean) => void;
  /** The VAD heard the caller start. The barge-in edge: if the bot is speaking, this
   *  is the moment it is being interrupted. */
  onUserStartedSpeaking: () => void;
  onUserStoppedSpeaking: () => void;
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
        // The other half of the greeting handshake. The bot holds its opening line
        // until the browser says it is subscribed and playing, because audio sent
        // before that goes into a track nobody is listening to and is simply gone —
        // the intermittent "it connected and then said nothing" report.
        //
        // Without it the runner falls back to a 2.5 s timer (bot/runners.py
        // "join-fallback"), which is both slower than it needs to be and still a
        // guess: a join that takes longer than that loses the first words anyway.
        // Our own dashboard has always sent this; an embed never did.
        this.sendClientMessage("playback-ready");
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

  /**
   * Send an application message to the running bot.
   *
   * The envelope is NOT negotiable and this SDK had it wrong: the bot reads
   * `{type:"client-message", data:{t, d}}` and drops anything else on the floor
   * (bot/runners.py `_on_data` — `if msg.get("type") != "client-message": return`).
   * What went out instead was `{label:"rtvi-ai", type:<yourType>, data:<yourData>}`,
   * which matches nothing, so on LiveKit — the transport every production session
   * has been using — `agent.send(...)` was a silent no-op. Pausing an interview,
   * telling it to wrap up, handing it typed text: all of it reached the room and
   * none of it reached the agent, with no error anywhere to say so.
   *
   * `sendClientMessage` is exactly the shape `PipecatClient.sendClientMessage(t, d)`
   * produces on the SmallWebRTC path, which is why that path always worked.
   */
  sendClientMessage(t: string, d?: unknown): void {
    this.send({
      type: RTVIMessageType.CLIENT_MESSAGE,
      data: { t, ...(d !== undefined ? { d } : {}) },
    });
  }

  private handleData(payload: Uint8Array, cb: SessionCallbacks): void {
    let msg: { label?: string; type?: string; data?: unknown };
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return; // not ours (or not JSON) — ignore rather than break the session
    }
    if (!msg) return;
    if (msg.label && msg.label !== RTVI_LABEL) return;
    // Three messages travel WITHOUT the `rtvi-ai` label and with their fields at the
    // top level rather than under `data`: `{type:"bot-ready"}`, the out-of-credit
    // notice, and the demo cap. Two of the three END the session.
    //
    // They used to fall through into the switch below, where `"error"` collided with
    // the RTVI error type and was read as `data.error` — undefined, because the real
    // field is `msg.error`. So a caller who ran out of credit mid-sentence was told
    // "Connection error.", and the demo cap was dropped entirely. Both are cases
    // where the visitor can actually do something, and both looked like a bug in the
    // embedder's page.
    if (!msg.label) {
      const raw = msg as Record<string, unknown>;
      if (raw.type === "error" || raw.type === "demo-limit") {
        cb.onServerMessage(raw);
        return;
      }
    }
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
      // One word, at the moment it is spoken. The only message fine-grained enough
      // to caption a reply in time with the voice.
      case RTVIMessageType.BOT_TTS_TEXT:
        cb.onBotWord(String(data.text ?? ""));
        break;
      case RTVIMessageType.USER_TRANSCRIPTION:
        cb.onUserTranscript(String(data.text ?? ""), Boolean(data.final));
        break;
      case RTVIMessageType.USER_STARTED_SPEAKING:
        cb.onUserStartedSpeaking();
        break;
      case RTVIMessageType.USER_STOPPED_SPEAKING:
        cb.onUserStoppedSpeaking();
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

  /**
   * Switch to another microphone mid-session.
   *
   * `switchActiveDevice` replaces the track on the SAME sender rather than acquiring a
   * second one — the rule that matters here is never to hold two tracks on one input,
   * because a parallel acquisition is how the device ends up locked and the session
   * ends up deaf.
   */
  setMicrophone(deviceId: string): boolean {
    const room = this.room as unknown as {
      switchActiveDevice?: (kind: MediaDeviceKind, id: string) => Promise<void>;
    } | null;
    if (!room?.switchActiveDevice) return false;
    try {
      void room.switchActiveDevice("audioinput", deviceId);
      return true;
    } catch {
      return false;
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
