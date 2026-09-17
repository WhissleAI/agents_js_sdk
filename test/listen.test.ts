import { describe, expect, it, vi } from "vitest";
import { RTVIMessageType } from "@pipecat-ai/client-js";

/**
 * A listen session is the visitor speaking with nobody answering — the platform
 * transcribes and reads the delivery, and that is the whole product. What makes it
 * usable rather than merely connected is `turn_id`: the id every final transcript
 * carries, and that the emotion/intent signals for the same utterance carry too.
 * These pin that it reaches both events, on both spellings of the wire, and that
 * the session does what a session must (ready handshake, close, error).
 *
 * Driven against a fake LiveKit room, like `livekit-wire.test.ts`, so what is pinned
 * is the bytes the real transport would have handed us.
 */

class FakeRoom {
  published: unknown[] = [];
  handlers = new Map<string, (arg: unknown) => void>();
  disconnected = 0;
  micEnabled: boolean[] = [];
  localParticipant = {
    setMicrophoneEnabled: (on: boolean) => {
      this.micEnabled.push(on);
      return Promise.resolve();
    },
    publishData: (bytes: Uint8Array) => {
      this.published.push(JSON.parse(new TextDecoder().decode(bytes)));
      return Promise.resolve();
    },
    audioTrackPublications: new Map(),
  };
  switched: string[] = [];
  switchActiveDevice(_kind: MediaDeviceKind, id: string) {
    this.switched.push(id);
    return Promise.resolve();
  }
  on(event: string, handler: (arg: unknown) => void) {
    this.handlers.set(event, handler);
    return this;
  }
  connect() {
    return Promise.resolve();
  }
  disconnect() {
    this.disconnected++;
    return Promise.resolve();
  }
  fire(event: string, arg: unknown) {
    this.handlers.get(event)?.(arg);
  }
}

async function joined(opts: Record<string, unknown> = {}) {
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
  const { listen } = await import("../src/listen");
  const events: Array<[string, unknown]> = [];
  const l = listen({ url: "wss://lk.test", token: "t", room: "listen-1" }, opts);
  for (const e of ["connected", "disconnected", "transcript", "signal", "user-metadata", "server-message", "error"] as const) {
    l.on(e, (p) => events.push([e, p]));
  }
  // Let the lazy import + connect settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const of = (name: string) => events.filter(([e]) => e === name).map(([, p]) => p);
  const inbound = (message: unknown) =>
    room.fire("dataReceived", new TextEncoder().encode(JSON.stringify(message)));
  return { l, room, events, of, inbound };
}

const rtvi = (type: string, data: unknown) => ({ label: "rtvi-ai", type, data });

describe("joining", () => {
  it("connects, publishes the mic, says client-ready, and fires `connected`", async () => {
    const { l, room, of } = await joined();
    expect(l.state).toBe("connected");
    expect(of("connected")).toHaveLength(1);
    expect(room.micEnabled).toEqual([true]);
    expect(room.published).toContainEqual(
      expect.objectContaining({ label: "rtvi-ai", type: RTVIMessageType.CLIENT_READY }),
    );
  });

  it("refuses to start without a url and token", async () => {
    const { listen } = await import("../src/listen");
    expect(() => listen({ url: "", token: "t" })).toThrow(/url, token/);
    expect(() => listen({ url: "wss://x", token: "" })).toThrow(/url, token/);
  });

  it("honours `muted` and `deviceId`", async () => {
    const { room } = await joined({ muted: true, deviceId: "mic-2" });
    expect(room.micEnabled).toEqual([false]);
    expect(room.switched).toEqual(["mic-2"]);
  });
});

describe("transcripts", () => {
  it("emits a final with the frame's turn_id", async () => {
    const { of, inbound } = await joined();
    inbound(rtvi(RTVIMessageType.USER_TRANSCRIPTION, { text: "I'd like a refund", final: true, turn_id: "turn_7" }));
    expect(of("transcript")).toEqual([
      {
        text: "I'd like a refund",
        final: true,
        turnId: "turn_7",
        raw: { text: "I'd like a refund", final: true, turn_id: "turn_7" },
      },
    ]);
  });

  it("emits an interim as final:false, with no turnId invented for it", async () => {
    const { of, inbound } = await joined();
    inbound(rtvi(RTVIMessageType.USER_TRANSCRIPTION, { text: "I'd like", final: false }));
    inbound(rtvi(RTVIMessageType.USER_TRANSCRIPTION, { text: "I'd like a", final: false }));
    const got = of("transcript") as Array<{ final: boolean; turnId?: string }>;
    expect(got.map((t) => t.final)).toEqual([false, false]);
    expect(got.every((t) => !("turnId" in t))).toBe(true);
  });

  it("does not stamp an empty turn_id", async () => {
    const { of, inbound } = await joined();
    inbound(rtvi(RTVIMessageType.USER_TRANSCRIPTION, { text: "hi", final: true, turn_id: "" }));
    expect(of("transcript")[0]).not.toHaveProperty("turnId");
  });
});

describe("signals carry the same turn_id as the transcript", () => {
  const emotion = {
    kind: "signal",
    v: 1,
    seq: 3,
    t_ms: 2100,
    type: "emotion",
    subsystem: "metadata",
    turn_id: "turn_7",
    data: {
      label: "ANGRY",
      words_per_minute: 168,
      speech_ms: 2400,
      entity_disagreements: [{ label: "PSA-12345", kind: "cert_id" }],
    },
  };

  it("reads a signal delivered inside pipecat's {data:{…}} wrapper", async () => {
    const { of, inbound } = await joined();
    inbound(rtvi(RTVIMessageType.SERVER_MESSAGE, { data: emotion }));
    expect(of("signal")).toEqual([
      expect.objectContaining({
        type: "emotion",
        turnId: "turn_7",
        wordsPerMinute: 168,
        speechMs: 2400,
        entityDisagreements: [{ label: "PSA-12345", kind: "cert_id" }],
        raw: emotion,
      }),
    ]);
    // …and the untouched envelope still reaches server-message.
    expect(of("server-message")).toEqual([emotion]);
  });

  it("reads the same signal delivered bare", async () => {
    const { of, inbound } = await joined();
    inbound(rtvi(RTVIMessageType.SERVER_MESSAGE, emotion));
    expect(of("signal")[0]).toMatchObject({ type: "emotion", turnId: "turn_7", wordsPerMinute: 168 });
  });

  it("lines a transcript up with its signals by turnId", async () => {
    const { of, inbound } = await joined();
    inbound(rtvi(RTVIMessageType.USER_TRANSCRIPTION, { text: "it's PSA twelve three four five", final: true, turn_id: "turn_7" }));
    inbound(rtvi(RTVIMessageType.SERVER_MESSAGE, { data: emotion }));
    inbound(rtvi(RTVIMessageType.SERVER_MESSAGE, { data: { ...emotion, type: "intent", seq: 4, data: { label: "INTENT_REFUND", turn_id: "turn_7" } } }));
    const t = of("transcript")[0] as { turnId: string };
    const ids = (of("signal") as Array<{ turnId?: string }>).map((s) => s.turnId);
    expect(ids).toEqual([t.turnId, t.turnId]);
  });

  it("routes user-metadata with its turn_id, and leaves the NEUTRAL rule intact", async () => {
    const { of, inbound } = await joined();
    inbound(rtvi(RTVIMessageType.SERVER_MESSAGE, { data: { t: "user-metadata", emotion: "EMOTION_HAPPY", intent: "INTENT_OTHER", turn_id: "turn_9" } }));
    inbound(rtvi(RTVIMessageType.SERVER_MESSAGE, { data: { t: "user-metadata", emotion: "NEUTRAL", turn_id: "turn_10" } }));
    expect(of("user-metadata")).toEqual([
      expect.objectContaining({ turnId: "turn_9", emotion: expect.objectContaining({ label: "HAPPY" }) }),
    ]);
    // The all-neutral frame is not a reading — but it still reaches server-message.
    expect(of("server-message")).toHaveLength(2);
  });
});

describe("no bot", () => {
  it("ignores bot-side frames rather than pretending an agent spoke", async () => {
    const { events, inbound } = await joined();
    events.length = 0;
    inbound(rtvi(RTVIMessageType.BOT_STARTED_SPEAKING, {}));
    inbound(rtvi(RTVIMessageType.BOT_OUTPUT, { text: "hello?", spoken: true }));
    inbound(rtvi(RTVIMessageType.BOT_STOPPED_SPEAKING, {}));
    expect(events).toEqual([]);
  });
});

describe("ending", () => {
  it("close() leaves the room once and emits disconnected once", async () => {
    const { l, room, of } = await joined();
    l.close();
    l.close();
    expect(room.disconnected).toBe(1);
    expect(of("disconnected")).toHaveLength(1);
    expect(l.state).toBe("closed");
  });

  it("a drop from the far side emits disconnected", async () => {
    const { l, room, of } = await joined();
    room.fire("disconnected", undefined);
    expect(of("disconnected")).toHaveLength(1);
    expect(l.state).toBe("closed");
    // …and a later close() is a no-op, not a second disconnected.
    l.close();
    expect(of("disconnected")).toHaveLength(1);
  });

  it("mute/unmute and setMicrophone reach the room", async () => {
    const { l, room } = await joined();
    l.mute();
    l.unmute();
    expect(room.micEnabled).toEqual([true, false, true]);
    expect(l.setMicrophone("mic-3")).toBe(true);
    expect(room.switched).toEqual(["mic-3"]);
  });

  it("surfaces a transport error as `error`", async () => {
    const { of, inbound } = await joined();
    inbound(rtvi(RTVIMessageType.ERROR, { error: "room closed by server" }));
    expect(of("error")).toEqual(["room closed by server"]);
  });
});
