import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildConfigFrame,
  downsampleTo16k,
  floatTo16BitPCM,
  parseTranscript,
  transcribe,
  type Transcript,
} from "../src/transcribe";

/**
 * Whissle's metadata ASR, driven from a browser.
 *
 * The thing most worth pinning here is not the happy path — it is the REFUSAL.
 * The streaming door takes its credential as a query parameter (a browser cannot
 * set a header on a WebSocket), the scope it needs is `models:invoke`, and a
 * publishable key can never hold that scope. So the easy thing to do — paste the
 * workspace secret into the URL — is exactly the wrong thing, and it has to throw
 * rather than work in development and leak in production.
 *
 * The rest is the audio maths, which is pure and therefore actually testable in
 * Node, and the wire framing. The microphone graph and a real socket need a
 * browser; see README "What isn't tested".
 */

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 1;
  binaryType = "";
  sent: unknown[] = [];
  closed = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed++;
  }
  /** Everything the socket sent that was JSON text, parsed. */
  jsonSent() {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  binarySent() {
    return this.sent.filter((s) => typeof s !== "string");
  }
}

function stubBrowser() {
  vi.stubGlobal("WebSocket", FakeSocket as never);
  const track = { stop: vi.fn() };
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  });
  const processor = {
    onaudioprocess: null as ((ev: unknown) => void) | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const ctx = {
    sampleRate: 48000,
    destination: {},
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
    createScriptProcessor: () => processor,
    close: vi.fn(),
  };
  vi.stubGlobal(
    "AudioContext",
    function () {
      return ctx;
    } as never,
  );
  return { processor, ctx, track };
}

/** The last JSON frame the socket sent. (`Array.at` is newer than this tsconfig's lib.) */
function lastJson(sock: FakeSocket) {
  const all = sock.jsonSent();
  return all[all.length - 1];
}

/** Let the constructor's async open() run to completion. */
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  FakeSocket.last = null;
});

describe("the secret-key refusal", () => {
  it("throws when the URL carries a wsk_, because a browser cannot hold one", async () => {
    stubBrowser();
    const errors: unknown[] = [];
    transcribe({ url: "wss://aws-gateway-backend.whissle.ai/listen?token=wsk_live_abc" }).on(
      "error",
      (e) => errors.push(e),
    );
    await settle();
    expect(String(errors[0])).toMatch(/SECRET key \(wsk_\)/);
    // And it never opened a socket with the secret in it.
    expect(FakeSocket.last).toBeNull();
  });

  it("names the reason a publishable key is not an alternative", async () => {
    stubBrowser();
    const errors: unknown[] = [];
    transcribe({ url: "wss://x/listen?token=wsk_live_abc" }).on("error", (e) => errors.push(e));
    await settle();
    expect(String(errors[0])).toMatch(/models:invoke/);
    expect(String(errors[0])).toMatch(/your own server/);
  });

  it("refuses a URL that is not a WebSocket", async () => {
    stubBrowser();
    const errors: unknown[] = [];
    transcribe({ url: "https://example.com/asr" }).on("error", (e) => errors.push(e));
    await settle();
    expect(String(errors[0])).toMatch(/must be a ws:\/\/ or wss:\/\//);
  });

  it("refuses to construct with no url at all", () => {
    expect(() => transcribe({ url: "" })).toThrow(/needs a `url`/);
  });
});

describe("float → int16", () => {
  it("clamps above 1.0 instead of wrapping to a large negative", () => {
    // The bug this prevents: 1.2 * 0x7fff overflows int16 and two's-complement
    // wraps it negative, so a loud moment arrives as a click.
    const out = floatTo16BitPCM(new Float32Array([1.2, -1.5]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
  });

  it("maps silence to zero and full scale to the rails", () => {
    const out = floatTo16BitPCM(new Float32Array([0, 1, -1]));
    expect(Array.from(out)).toEqual([0, 32767, -32768]);
  });
});

describe("resampling to 16 kHz", () => {
  it("averages each window rather than dropping samples", () => {
    // 32 kHz → 16 kHz is a ratio of 2: each output is the mean of a pair.
    const out = downsampleTo16k(new Float32Array([0, 1, 0.5, 0.5]), 32000);
    expect(Array.from(out)).toEqual([0.5, 0.5]);
  });

  it("returns a rate at or below the target untouched, never upsampling", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(downsampleTo16k(input, 16000)).toBe(input);
    expect(downsampleTo16k(input, 8000)).toBe(input);
  });

  it("produces the right length for a 48 kHz buffer", () => {
    expect(downsampleTo16k(new Float32Array(4800), 48000).length).toBe(1600);
  });
});

describe("the config frame", () => {
  it("always declares 16 kHz, because that is what we resampled to", () => {
    // Declaring the microphone's native rate would describe bytes we don't send.
    expect(buildConfigFrame({ url: "wss://x" }).sample_rate).toBe(16000);
  });

  it("omits everything the caller did not ask for", () => {
    expect(buildConfigFrame({ url: "wss://x" })).toEqual({ type: "config", sample_rate: 16000 });
  });

  it("carries language, tags and hotwords under the engine's own names", () => {
    const f = buildConfigFrame({
      url: "wss://x",
      language: "en",
      metadataTags: ["emotion", "intent"],
      hotwords: ["Acme Corp"],
      hotwordWeight: 10,
    });
    expect(f).toMatchObject({
      language: "en",
      metadata_tags: ["emotion", "intent"],
      hotwords: ["Acme Corp"],
      hotword_weight: 10,
    });
  });

  it("lets `config` override, so a new engine flag needs no SDK release", () => {
    const f = buildConfigFrame({ url: "wss://x", language: "en", config: { language: "hi", use_lm: true } });
    expect(f.language).toBe("hi");
    expect(f.use_lm).toBe(true);
  });
});

describe("parsing an engine event", () => {
  /** A minimal real event: the engine always sends these five. */
  const wire = (extra: Record<string, unknown> = {}) => ({
    type: "transcript",
    channel: "microphone",
    text: "hello",
    audioOffset: 1.25,
    is_final: true,
    utterance_end: true,
    ...extra,
  });

  it("reads is_final — the engine has no `final` field at all", () => {
    expect(parseTranscript(wire())).toMatchObject({ text: "hello", final: true });
    expect(parseTranscript(wire({ is_final: false, utterance_end: false }))?.final).toBe(false);
  });

  it("does not accept a bare `final`, which the engine never sends", () => {
    // Guessing at a field the wire does not have is how a consumer ends up
    // branching on a flag that is always false.
    expect(parseTranscript(wire({ is_final: undefined, final: true }))?.final).toBe(false);
  });

  it("only treats a type:transcript event as a transcript", () => {
    expect(parseTranscript({ type: "end" })).toBeNull();
    expect(parseTranscript({ type: "flush_done" })).toBeNull();
    expect(parseTranscript({ type: "error", message: "boom" })).toBeNull();
    // Text alone is not enough — an error frame carries a message, not a transcript.
    expect(parseTranscript({ text: "hello" })).toBeNull();
    expect(parseTranscript(null)).toBeNull();
    expect(parseTranscript("hello")).toBeNull();
  });

  it("is not fooled by an event with no text", () => {
    expect(parseTranscript(wire({ text: "" }))).toBeNull();
  });

  it("carries the channel, the offset and utterance_end", () => {
    expect(parseTranscript(wire())).toMatchObject({
      channel: "microphone",
      audioOffset: 1.25,
      utteranceEnd: true,
    });
  });

  it("keeps metadata as strings and drops what isn't", () => {
    const t = parseTranscript(wire({ metadata: { emotion: "EMOTION_HAPPY", score: 3 } }));
    expect(t?.metadata).toEqual({ emotion: "EMOTION_HAPPY" });
  });

  it("leaves metadata absent rather than empty when no head reported", () => {
    // So "did any head report" is one truthiness check, not a length check.
    expect(parseTranscript(wire({ metadata: {} }))?.metadata).toBeUndefined();
    expect(parseTranscript(wire())?.metadata).toBeUndefined();
  });

  it("reads the distribution under the engine's own `token` name", () => {
    const t = parseTranscript(
      wire({ metadata_probs: { emotion: [{ token: "EMOTION_HAPPY", probability: 0.62 }] } }),
    );
    expect(t?.metadataProbs).toEqual({
      emotion: [{ token: "EMOTION_HAPPY", probability: 0.62 }],
    });
  });

  it("reads entities as {type, value, raw} and skips malformed ones", () => {
    const t = parseTranscript(
      wire({
        entities: [
          { type: "PERSON", value: "Ada", raw: "ENTITY_PERSON Ada" },
          { value: "no type" },
        ],
      }),
    );
    expect(t?.entities).toEqual([{ type: "PERSON", value: "Ada", raw: "ENTITY_PERSON Ada" }]);
  });

  it("never synthesises a confidence the engine did not send", () => {
    // An interim carries no confidence at all; a default would be a fabricated one.
    expect(parseTranscript(wire())?.confidence).toBeUndefined();
    expect(parseTranscript(wire({ confidence: 0.9 }))?.confidence).toBe(0.9);
  });

  it("hands back the whole event untouched on `raw`", () => {
    const w = wire({ something_new: [1, 2] });
    expect(parseTranscript(w)?.raw).toBe(w);
  });
});

describe("a live stream", () => {
  it("sends the config frame first, then audio", async () => {
    const { processor, ctx } = stubBrowser();
    const s = transcribe({ url: "wss://my-server.example/asr", language: "en" });
    await settle();
    FakeSocket.last!.onopen!();

    expect(FakeSocket.last!.jsonSent()[0]).toMatchObject({ type: "config", sample_rate: 16000 });

    processor.onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array(ctx.sampleRate / 10) },
    });
    // 4800 samples at 48 kHz → 1600 at 16 kHz → 3200 bytes of int16.
    expect((FakeSocket.last!.binarySent()[0] as ArrayBuffer).byteLength).toBe(3200);
    s.stop();
  });

  it("emits typed transcripts and the raw message for the same event", async () => {
    stubBrowser();
    const transcripts: Transcript[] = [];
    const messages: unknown[] = [];
    transcribe({ url: "wss://my-server.example/asr" })
      .on("transcript", (t) => transcripts.push(t as Transcript))
      .on("message", (m) => messages.push(m));
    await settle();
    FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: "transcript", text: "hello", is_final: true }) });

    expect(transcripts[0]).toMatchObject({ text: "hello", final: true });
    expect(messages).toHaveLength(1);
  });

  it("passes through an event that is not a transcript without inventing one", async () => {
    stubBrowser();
    const transcripts: Transcript[] = [];
    const messages: unknown[] = [];
    transcribe({ url: "wss://my-server.example/asr" })
      .on("transcript", (t) => transcripts.push(t as Transcript))
      .on("message", (m) => messages.push(m));
    await settle();
    FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: "ready", model: "en-full" }) });

    expect(transcripts).toHaveLength(0);
    expect(messages).toHaveLength(1);
  });

  it("survives a frame that isn't JSON", async () => {
    stubBrowser();
    const messages: unknown[] = [];
    transcribe({ url: "wss://my-server.example/asr" }).on("message", (m) => messages.push(m));
    await settle();
    expect(() => FakeSocket.last!.onmessage!({ data: "<html>502</html>" })).not.toThrow();
    expect(messages).toHaveLength(0);
  });

  it("surfaces the engine's own error frame as an error, not as a stray message", async () => {
    stubBrowser();
    const errors: unknown[] = [];
    transcribe({ url: "wss://my-server.example/asr" }).on("error", (e) => errors.push(e));
    await settle();
    FakeSocket.last!.onmessage!({
      data: JSON.stringify({ type: "error", message: "Frame too large (max 1MB)" }),
    });
    expect(errors).toEqual(["Frame too large (max 1MB)"]);
  });

  it("keeps backpressure a warning, because the session is still running", async () => {
    // Treating it as fatal tears down a working stream; ignoring it loses words.
    stubBrowser();
    const warnings: unknown[] = [];
    const errors: unknown[] = [];
    const s = transcribe({ url: "wss://my-server.example/asr" })
      .on("warning", (w) => warnings.push(w))
      .on("error", (e) => errors.push(e));
    await settle();
    FakeSocket.last!.onopen!();
    FakeSocket.last!.onmessage!({
      data: JSON.stringify({ type: "warning", message: "Audio backpressure — some frames dropped" }),
    });
    expect(warnings).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(s.state).toBe("open");
  });

  it("closes as soon as the engine acknowledges the flush with {type:end}", async () => {
    stubBrowser();
    let closes = 0;
    const s = transcribe({ url: "wss://my-server.example/asr" }).on("close", () => closes++);
    await settle();
    FakeSocket.last!.onopen!();
    s.stop();
    FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: "end" }) });
    expect(s.state).toBe("closed");
    expect(closes).toBe(1);
  });

  it("names the two refusals that arrive only as a close code", async () => {
    stubBrowser();
    const errors: unknown[] = [];
    transcribe({ url: "wss://my-server.example/asr" }).on("error", (e) => errors.push(e));
    await settle();
    (FakeSocket.last!.onclose as (ev: unknown) => void)({ code: 1013 });
    expect(String(errors[0])).toMatch(/concurrent-session limit/);
  });

  it("sends {type:flush} without ending the session", async () => {
    stubBrowser();
    const s = transcribe({ url: "wss://my-server.example/asr" });
    await settle();
    FakeSocket.last!.onopen!();
    s.flush();
    expect(lastJson(FakeSocket.last!)).toEqual({ type: "flush" });
    expect(s.state).toBe("open");
    s.stop();
  });

  it("flushes with {type:end} on stop, so the last utterance is not lost", async () => {
    stubBrowser();
    const s = transcribe({ url: "wss://my-server.example/asr" });
    await settle();
    FakeSocket.last!.onopen!();
    s.stop();

    expect(lastJson(FakeSocket.last!)).toEqual({ type: "end" });
  });

  it("stops being idempotent about it", async () => {
    stubBrowser();
    const s = transcribe({ url: "wss://my-server.example/asr" });
    await settle();
    FakeSocket.last!.onopen!();
    s.stop();
    s.stop();
    s.stop();

    expect(FakeSocket.last!.jsonSent().filter((f) => f.type === "end")).toHaveLength(1);
  });

  it("releases the microphone on stop", async () => {
    const { track } = stubBrowser();
    const s = transcribe({ url: "wss://my-server.example/asr" });
    await settle();
    FakeSocket.last!.onopen!();
    s.stop();

    expect(track.stop).toHaveBeenCalled();
  });

  it("sends nothing while muted, and resumes on unmute", async () => {
    const { processor, ctx } = stubBrowser();
    const s = transcribe({ url: "wss://my-server.example/asr" });
    await settle();
    FakeSocket.last!.onopen!();
    const frame = { inputBuffer: { getChannelData: () => new Float32Array(ctx.sampleRate / 10) } };

    s.mute();
    processor.onaudioprocess!(frame);
    expect(FakeSocket.last!.binarySent()).toHaveLength(0);

    s.unmute();
    processor.onaudioprocess!(frame);
    expect(FakeSocket.last!.binarySent()).toHaveLength(1);
    s.stop();
  });

  it("takes a url function, so a reconnect can fetch a fresh one", async () => {
    stubBrowser();
    transcribe({ url: () => Promise.resolve("wss://minted.example/asr?t=abc") });
    await settle();
    expect(FakeSocket.last!.url).toBe("wss://minted.example/asr?t=abc");
  });

  it("refuses a wsk_ that arrives from the url function, not just a literal", async () => {
    stubBrowser();
    const errors: unknown[] = [];
    transcribe({ url: () => "wss://x/listen?token=wsk_live_leaked" }).on("error", (e) =>
      errors.push(e),
    );
    await settle();
    expect(String(errors[0])).toMatch(/SECRET key/);
    expect(FakeSocket.last).toBeNull();
  });

  it("fires close exactly once when the far side goes away", async () => {
    stubBrowser();
    let closes = 0;
    transcribe({ url: "wss://my-server.example/asr" }).on("close", () => closes++);
    await settle();
    FakeSocket.last!.onopen!();
    FakeSocket.last!.onclose!();
    FakeSocket.last!.onclose!();

    expect(closes).toBe(1);
  });

  it("reports state through its life", async () => {
    stubBrowser();
    const s = transcribe({ url: "wss://my-server.example/asr" });
    expect(s.state).toBe("connecting");
    await settle();
    FakeSocket.last!.onopen!();
    expect(s.state).toBe("open");
    FakeSocket.last!.onclose!();
    expect(s.state).toBe("closed");
  });

  it("does not let a throwing handler take down the stream", async () => {
    stubBrowser();
    const seen: string[] = [];
    transcribe({ url: "wss://my-server.example/asr" })
      .on("transcript", () => {
        throw new Error("consumer bug");
      })
      .on("message", () => seen.push("message"));
    await settle();
    expect(() =>
      FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: "transcript", text: "hi", is_final: true }) }),
    ).not.toThrow();
    expect(seen).toEqual(["message"]);
  });
});
