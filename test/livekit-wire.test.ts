import { describe, expect, it, vi } from "vitest";
import { RTVIMessageType } from "@pipecat-ai/client-js";
import { LiveKitSession, type SessionCallbacks } from "../src/livekit";

/**
 * LiveKit is the transport every production embed actually uses — the live gateway's
 * session mint answers `transport.kind: "livekit"` — and two things on it were wrong
 * in a way nothing could report:
 *
 *  1. OUTBOUND control messages used an envelope the bot does not read, so
 *     `agent.send(…)` published a datagram into the room that the far side dropped on
 *     the floor. No error, no log, no way to tell from the page.
 *  2. INBOUND, the two unlabelled notices that END a session (out of credit, demo cap)
 *     were mis-parsed into a generic "Connection error." and silence respectively.
 *
 * These tests drive the real `LiveKitSession` against a fake room, so they pin the
 * bytes rather than our intentions about them.
 */

/** A LiveKit room that records published datagrams and can replay inbound ones. */
class FakeRoom {
  published: unknown[] = [];
  handlers = new Map<string, (arg: unknown) => void>();
  localParticipant = {
    setMicrophoneEnabled: () => Promise.resolve(),
    publishData: (bytes: Uint8Array) => {
      this.published.push(JSON.parse(new TextDecoder().decode(bytes)));
      return Promise.resolve();
    },
    audioTrackPublications: new Map(),
  };
  on(event: string, handler: (arg: unknown) => void) {
    this.handlers.set(event, handler);
    return this;
  }
  connect() {
    return Promise.resolve();
  }
  disconnect() {
    return Promise.resolve();
  }
  fire(event: string, arg: unknown) {
    this.handlers.get(event)?.(arg);
  }
}

function noopCallbacks(over: Partial<SessionCallbacks> = {}): SessionCallbacks {
  return {
    onConnected: () => {},
    onDisconnected: () => {},
    onBotReady: () => {},
    onBotStartedSpeaking: () => {},
    onBotStoppedSpeaking: () => {},
    onBotOutput: () => {},
    onBotLegacyOutput: () => {},
    onBotWord: () => {},
    onUserTranscript: () => {},
    onUserStartedSpeaking: () => {},
    onUserStoppedSpeaking: () => {},
    onRemoteAudioTrack: () => {},
    onServerMessage: () => {},
    onError: () => {},
    ...over,
  };
}

/** Bring a `LiveKitSession` up against a fake room. */
async function connected(cb: SessionCallbacks = noopCallbacks()) {
  const room = new FakeRoom();
  vi.doMock("livekit-client", () => ({
    Room: function () {
      return room;
    },
    RoomEvent: {
      TrackSubscribed: "trackSubscribed",
      DataReceived: "dataReceived",
      Disconnected: "disconnected",
    },
  }));
  vi.resetModules();
  const { LiveKitSession: Session } = await import("../src/livekit");
  const lk = new Session();
  await lk.connect({ url: "wss://x", token: "t" }, cb);
  return { lk, room };
}

/** Deliver an inbound datagram the way the room does. */
function inbound(room: FakeRoom, message: unknown) {
  room.fire("dataReceived", new TextEncoder().encode(JSON.stringify(message)));
}

describe("outbound: the envelope the bot actually reads", () => {
  it("wraps a control message as {type:'client-message', data:{t, d}}", async () => {
    // The bot's handler is literally `if msg.get("type") != "client-message": return`
    // and then reads `data.t`. Anything else is dropped in silence.
    const { lk, room } = await connected();
    room.published.length = 0;
    lk.sendClientMessage("wrap-up", { reason: "time" });
    expect(room.published).toEqual([
      { label: "rtvi-ai", type: "client-message", data: { t: "wrap-up", d: { reason: "time" } } },
    ]);
  });

  it("omits `d` entirely for a bare message", async () => {
    const { lk, room } = await connected();
    room.published.length = 0;
    lk.sendClientMessage("pause");
    expect(room.published).toEqual([
      { label: "rtvi-ai", type: "client-message", data: { t: "pause" } },
    ]);
  });

  it("does NOT use the old {type:<yourType>} shape", async () => {
    // The regression this file exists for.
    const { lk, room } = await connected();
    room.published.length = 0;
    lk.sendClientMessage("wrap-up");
    expect(room.published[0]).not.toMatchObject({ type: "wrap-up" });
  });

  it("sends `client-ready` on connect so the bot is allowed to greet", async () => {
    const { room } = await connected();
    expect(room.published).toContainEqual(
      expect.objectContaining({ label: "rtvi-ai", type: RTVIMessageType.CLIENT_READY }),
    );
  });

  it("sends `playback-ready` once the bot's audio track is subscribed", async () => {
    // The greeting handshake. Without it the bot falls back to a 2.5s timer, so an
    // embed's opening line was both late and — on a slow join — spoken into a track
    // nobody had subscribed to yet.
    const { room } = await connected();
    room.published.length = 0;
    room.fire("trackSubscribed", { kind: "audio", mediaStreamTrack: {} as MediaStreamTrack });
    expect(room.published).toEqual([
      { label: "rtvi-ai", type: "client-message", data: { t: "playback-ready" } },
    ]);
  });

  it("does not claim playback readiness for a video track", async () => {
    const { room } = await connected();
    room.published.length = 0;
    room.fire("trackSubscribed", { kind: "video", mediaStreamTrack: {} as MediaStreamTrack });
    expect(room.published).toEqual([]);
  });
});

describe("inbound: the unlabelled notices that end a session", () => {
  it("hands the out-of-credit notice over intact, not as a generic error", async () => {
    // It arrives WITHOUT `label`, with `error` at the top level. It used to hit the
    // RTVI `error` case, which reads `data.error` — undefined — so someone whose
    // wallet emptied mid-sentence was told "Connection error."
    const seen: unknown[] = [];
    const errors: string[] = [];
    const { room } = await connected(
      noopCallbacks({ onServerMessage: (m) => seen.push(m), onError: (m) => errors.push(m) }),
    );
    const notice = { type: "error", error: "no_credits", message: "Credits exhausted." };
    inbound(room, notice);
    expect(seen).toEqual([notice]);
    expect(errors).toEqual([]);
  });

  it("delivers the demo cap instead of dropping it", async () => {
    const seen: unknown[] = [];
    const { room } = await connected(noopCallbacks({ onServerMessage: (m) => seen.push(m) }));
    inbound(room, { type: "demo-limit", reason: "time" });
    expect(seen).toEqual([{ type: "demo-limit", reason: "time" }]);
  });

  it("still reports a real RTVI error", async () => {
    const errors: string[] = [];
    const { room } = await connected(noopCallbacks({ onError: (m) => errors.push(m) }));
    inbound(room, { label: "rtvi-ai", type: "error", data: { error: "Pipeline failed." } });
    expect(errors).toEqual(["Pipeline failed."]);
  });

  it("accepts the unlabelled bot-ready the mint advertises", async () => {
    const ready: unknown[] = [];
    const { room } = await connected(noopCallbacks({ onBotReady: (d) => ready.push(d ?? null) }));
    inbound(room, { type: "bot-ready" });
    expect(ready).toHaveLength(1);
  });
});

describe("inbound: signals that were being dropped", () => {
  it("surfaces word-level TTS text", async () => {
    const words: string[] = [];
    const { room } = await connected(noopCallbacks({ onBotWord: (w) => words.push(w) }));
    inbound(room, { label: "rtvi-ai", type: RTVIMessageType.BOT_TTS_TEXT, data: { text: "Hello" } });
    expect(words).toEqual(["Hello"]);
  });

  it("surfaces the VAD edges that make barge-in observable", async () => {
    const seen: string[] = [];
    const { room } = await connected(
      noopCallbacks({
        onUserStartedSpeaking: () => seen.push("start"),
        onUserStoppedSpeaking: () => seen.push("stop"),
      }),
    );
    inbound(room, { label: "rtvi-ai", type: RTVIMessageType.USER_STARTED_SPEAKING, data: {} });
    inbound(room, { label: "rtvi-ai", type: RTVIMessageType.USER_STOPPED_SPEAKING, data: {} });
    expect(seen).toEqual(["start", "stop"]);
  });

  it("unwraps the doubly-nested server-message payload", async () => {
    const seen: unknown[] = [];
    const { room } = await connected(noopCallbacks({ onServerMessage: (m) => seen.push(m) }));
    inbound(room, {
      label: "rtvi-ai",
      type: RTVIMessageType.SERVER_MESSAGE,
      data: { data: { kind: "tool", phase: "started", function_name: "x" } },
    });
    expect(seen).toEqual([{ kind: "tool", phase: "started", function_name: "x" }]);
  });

  it("ignores a datagram from something else in the room", async () => {
    const seen: unknown[] = [];
    const { room } = await connected(noopCallbacks({ onServerMessage: (m) => seen.push(m) }));
    inbound(room, { label: "someone-else", type: "error", error: "no_credits" });
    room.fire("dataReceived", new TextEncoder().encode("not json at all"));
    expect(seen).toEqual([]);
  });
});

describe("LiveKitSession without a room", () => {
  it("drops control messages rather than throwing", () => {
    // Usually called from a click handler. Taking the page down over a lost control
    // message is worse than the message not arriving.
    const lk = new LiveKitSession();
    expect(() => lk.sendClientMessage("pause")).not.toThrow();
    expect(lk.setMicrophone("dev-1")).toBe(false);
  });
});
