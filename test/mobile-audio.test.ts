import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SessionCallbacks } from "../src/livekit";

/**
 * The agent's voice is too quiet on a phone.
 *
 * Two platform reasons, and they stack: iOS Safari plays a bare
 * `<audio srcObject=remoteTrack>` through the earpiece at a capped level with a
 * read-only `volume`, and Android Chrome — while a WebRTC session with a live
 * microphone is up — hands browser output to the platform's *voice-call* stream,
 * whose volume slider is not the one the visitor has ever touched and which no web
 * API can read or set. Routing the same stream through WebAudio plays it via the
 * media path and is the only lever a page has over the level.
 *
 * These tests pin the decisions. The graph's *loudness* was measured by rendering
 * real speech through it in Chrome, not asserted here — see the PR body.
 */

type Fake = FakeNode;
class FakeNode {
  connections: Fake[] = [];
  constructor(public kind: string) {}
  connect(n: Fake) {
    this.connections.push(n);
    return n;
  }
  disconnect() {
    this.connections = [];
  }
}
class FakeCompressor extends FakeNode {
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  constructor() {
    super("compressor");
  }
}
class FakeGain extends FakeNode {
  gain = { value: 1 };
  constructor() {
    super("gain");
  }
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  constructor() {
    super("analyser");
  }
  getFloatTimeDomainData(b: Float32Array) {
    b.fill(0.5);
  }
}
class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  state = "suspended";
  onstatechange: (() => void) | null = null;
  destination = new FakeNode("destination");
  closed = false;
  resumeCalls = 0;
  nodes: FakeNode[] = [];
  constructor() {
    FakeAudioContext.last = this;
  }
  setState(s: string) {
    this.state = s;
    this.onstatechange?.();
  }
  resume() {
    this.resumeCalls++;
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
  createMediaStreamSource() {
    const n = new FakeNode("source");
    this.nodes.push(n);
    return n;
  }
  createDynamicsCompressor() {
    const n = new FakeCompressor();
    this.nodes.push(n);
    return n;
  }
  createGain() {
    const n = new FakeGain();
    this.nodes.push(n);
    return n;
  }
  createAnalyser() {
    const n = new FakeAnalyser();
    this.nodes.push(n);
    return n;
  }
}

const listeners: Record<string, Array<() => void>> = {};
function installBrowser(ua: string, uaDataMobile?: boolean) {
  for (const k of Object.keys(listeners)) delete listeners[k];
  FakeAudioContext.last = null;
  vi.stubGlobal("window", {
    AudioContext: FakeAudioContext,
    location: { search: "" },
  });
  vi.stubGlobal("navigator", {
    userAgent: ua,
    platform: "",
    maxTouchPoints: 0,
    ...(uaDataMobile === undefined ? {} : { userAgentData: { mobile: uaDataMobile } }),
  });
  vi.stubGlobal("document", {
    addEventListener: (t: string, fn: () => void) => {
      (listeners[t] ??= []).push(fn);
    },
    removeEventListener: (t: string, fn: () => void) => {
      listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn);
    },
  });
}
const fire = (t: string) => (listeners[t] ?? []).slice().forEach((f) => f());

async function mod() {
  vi.resetModules();
  return import("../src/mobile-audio");
}
const audioEl = () => ({ muted: false }) as unknown as HTMLAudioElement;
const stream = () => ({}) as unknown as MediaStream;

afterEach(() => vi.unstubAllGlobals());

describe("who gets boosted", () => {
  it("nobody on desktop — no context is ever created", async () => {
    installBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome", false);
    const m = await mod();
    const el = audioEl();
    m.primeBoostedPlayout();
    expect(m.attachBoostedPlayout(stream(), el)).toBe(false);
    expect(el.muted).toBe(false);
    expect(FakeAudioContext.last).toBeNull();
  });

  it("the client hint beats the UA string, in both directions", async () => {
    // Desktop Chrome emulating a phone: a mobile UA, but the browser says it is
    // not mobile. Boosting here would make the agent shout on a laptop.
    installBrowser("Mozilla/5.0 (Linux; Android 14) Mobile Chrome", false);
    expect((await mod()).isMobileBrowser()).toBe(false);
    installBrowser("Mozilla/5.0 (something unrecognisable)", true);
    expect((await mod()).isMobileBrowser()).toBe(true);
  });

  it("falls back to the UA where there is no client hint (WebKit ships none)", async () => {
    installBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari");
    expect((await mod()).isMobileBrowser()).toBe(true);
  });

  it("an integrator can switch it off", async () => {
    installBrowser("Mozilla/5.0 (Linux; Android 14) Mobile Chrome", true);
    (globalThis as unknown as { window: { __whissleNoAudioBoost?: boolean } }).window.__whissleNoAudioBoost =
      true;
    const m = await mod();
    const el = audioEl();
    expect(m.attachBoostedPlayout(stream(), el)).toBe(false);
    expect(el.muted).toBe(false);
    expect(FakeAudioContext.last).toBeNull();
  });
});

describe("the graph", () => {
  beforeEach(() => installBrowser("Mozilla/5.0 (Linux; Android 14) Mobile Chrome", true));

  it("is source -> compressor -> gain -> limiter -> destination, at the measured values", async () => {
    const m = await mod();
    m.primeBoostedPlayout();
    const ctx = FakeAudioContext.last!;
    ctx.setState("running");
    const el = audioEl();
    expect(m.attachBoostedPlayout(stream(), el)).toBe(true);
    expect(el.muted).toBe(true);

    const src = ctx.nodes.find((n) => n.kind === "source")!;
    const [compressor, limiter] = ctx.nodes.filter(
      (n) => n.kind === "compressor",
    ) as FakeCompressor[];
    const gain = ctx.nodes.find((n) => n.kind === "gain") as FakeGain;

    expect(src.connections).toContain(compressor);
    expect(compressor.connections).toContain(gain);
    expect(gain.connections).toContain(limiter);
    expect(limiter.connections).toContain(ctx.destination);

    // The compressor has to actually compress: a knee of 30 against a threshold
    // of -24 keeps speech inside the knee for ever, which is how the first
    // version of this ended up hard-clipping a fifth of every sample.
    expect(compressor.threshold.value).toBe(-24);
    expect(compressor.knee.value).toBe(6);
    expect(gain.gain.value).toBe(3.5);
    expect(limiter.threshold.value).toBe(-3);
    expect(limiter.knee.value).toBe(0);
    expect(limiter.attack.value).toBe(0);
  });

  it("keeps the analyser as a tap — it observes, it is not in the path", async () => {
    const m = await mod();
    m.primeBoostedPlayout();
    FakeAudioContext.last!.setState("running");
    m.attachBoostedPlayout(stream(), audioEl());
    expect(FakeAudioContext.last!.nodes.find((n) => n.kind === "analyser")!.connections).toEqual([]);
  });
});

describe("autoplay policy and interruptions", () => {
  beforeEach(() => installBrowser("Mozilla/5.0 (Linux; Android 14) Mobile Chrome", true));

  it("plays through the element while the context is suspended — quiet, never silent", async () => {
    const m = await mod();
    const el = audioEl();
    el.muted = true;
    expect(m.attachBoostedPlayout(stream(), el)).toBe(false);
    expect(FakeAudioContext.last!.state).toBe("suspended");
    expect(el.muted).toBe(false);
  });

  it("upgrades itself when the context starts, with no second track event", async () => {
    const m = await mod();
    const el = audioEl();
    m.attachBoostedPlayout(stream(), el);
    FakeAudioContext.last!.setState("running");
    expect(el.muted).toBe(true);
    expect(FakeAudioContext.last!.nodes.some((n) => n.kind === "gain")).toBe(true);
  });

  it("gives the audio back if the context is suspended mid-call, and takes it again after", async () => {
    const m = await mod();
    m.primeBoostedPlayout();
    const ctx = FakeAudioContext.last!;
    ctx.setState("running");
    const el = audioEl();
    m.attachBoostedPlayout(stream(), el);
    expect(el.muted).toBe(true);
    ctx.setState("suspended"); // backgrounded / a real call came in
    expect(el.muted).toBe(false);
    ctx.setState("running");
    expect(el.muted).toBe(true);
  });

  it("retries on the next tap and on the tab coming back", async () => {
    const m = await mod();
    m.primeBoostedPlayout();
    const ctx = FakeAudioContext.last!;
    const before = ctx.resumeCalls;
    fire("pointerdown");
    fire("visibilitychange");
    expect(ctx.resumeCalls).toBeGreaterThan(before);
  });

  it("hands the element back and stops listening once the session is torn down", async () => {
    const m = await mod();
    m.primeBoostedPlayout();
    const ctx = FakeAudioContext.last!;
    ctx.setState("running");
    const el = audioEl();
    m.attachBoostedPlayout(stream(), el);
    expect(el.muted).toBe(true);
    m.teardownBoostedPlayout();
    // A still-muted element after the graph is gone is a silent NEXT session.
    expect(el.muted).toBe(false);
    expect(ctx.closed).toBe(true);
    const after = ctx.resumeCalls;
    fire("pointerdown");
    expect(ctx.resumeCalls).toBe(after);
  });
});

describe("the avatar path is not touched", () => {
  it("an avatar session never reaches the boost — Simli owns playback there", async () => {
    installBrowser("Mozilla/5.0 (Linux; Android 14) Mobile Chrome", true);
    const boost = vi.fn();
    vi.resetModules();
    vi.doMock("../src/mobile-audio", () => ({
      attachBoostedPlayout: boost,
      primeBoostedPlayout: () => {},
      teardownBoostedPlayout: () => {},
      resumeBoostedPlayout: () => {},
      isMobileBrowser: () => true,
      boostDiagnostics: () => ({ active: false, state: "none", gain: 3.5, rmsDb: null }),
    }));
    const { WhissleAgent } = await import("../src/WhissleAgent");
    vi.stubGlobal("MediaStream", class {});

    class Probe extends WhissleAgent {
      cb: SessionCallbacks = this.callbacks();
    }
    const p = new Probe({ sessionToken: "t" });
    // Stand in for a live avatar and an element that a voice-only session would use.
    (p as unknown as { avatar: unknown }).avatar = { sendPcm() {}, clearBuffer() {} };
    (p as unknown as { audioEl: unknown }).audioEl = audioEl();

    p.cb.onRemoteAudioTrack({ kind: "audio" } as unknown as MediaStreamTrack);

    // Nothing was wired into the playback graph: the raw track is not played at
    // all with an avatar (Simli would double every word), and the PCM that drives
    // the face comes off the data channel, which this graph never sees.
    expect(boost).not.toHaveBeenCalled();
    vi.doUnmock("../src/mobile-audio");
  });

  it("a voice-only session does reach the boost", async () => {
    installBrowser("Mozilla/5.0 (Linux; Android 14) Mobile Chrome", true);
    const boost = vi.fn();
    vi.resetModules();
    vi.doMock("../src/mobile-audio", () => ({
      attachBoostedPlayout: boost,
      primeBoostedPlayout: () => {},
      teardownBoostedPlayout: () => {},
      resumeBoostedPlayout: () => {},
      isMobileBrowser: () => true,
      boostDiagnostics: () => ({ active: false, state: "none", gain: 3.5, rmsDb: null }),
    }));
    const { WhissleAgent } = await import("../src/WhissleAgent");
    vi.stubGlobal("MediaStream", class {});

    class Probe extends WhissleAgent {
      cb: SessionCallbacks = this.callbacks();
    }
    const p = new Probe({ sessionToken: "t" });
    const el = { muted: false, srcObject: null, play: () => Promise.resolve() };
    (p as unknown as { audioEl: unknown }).audioEl = el;

    p.cb.onRemoteAudioTrack({ kind: "audio" } as unknown as MediaStreamTrack);
    expect(boost).toHaveBeenCalledTimes(1);
    // The SAME stream the element was given — one source, not a second copy of
    // the track pulled independently.
    expect(boost.mock.calls[0][0]).toBe(el.srcObject);
    expect(boost.mock.calls[0][1]).toBe(el);
    vi.doUnmock("../src/mobile-audio");
  });
});
