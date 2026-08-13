import { afterEach, describe, expect, it, vi } from "vitest";
import { EARCON_INTERNALS, EarconPlayer } from "../src/earcons";

/**
 * The earcon is the difference between "the agent is looking that up" and "the agent
 * has hung". An embed had no cue at all, so these pin the two things that make one
 * work: it has to be DETERMINISTIC (the same tool always sounds the same, or it is
 * noise rather than a signal) and it has to be SAFE with whatever arrives on the wire
 * (the clip name is attacker-influenced input that used to be interpolated into a URL).
 */

/** A minimal AudioContext that records what was scheduled instead of making sound. */
class FakeContext {
  state: AudioContextState = "running";
  currentTime = 0;
  destination = {} as AudioNode;
  oscillators: Array<{ type: string; freqs: number[]; start: number; stop: number }> = [];
  gainsCreated = 0;
  closed = false;

  createGain() {
    this.gainsCreated++;
    return {
      gain: { value: 1, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: () => {},
      disconnect: () => {},
    } as unknown as GainNode;
  }
  createOscillator() {
    const rec = { type: "sine", freqs: [] as number[], start: 0, stop: 0 };
    this.oscillators.push(rec);
    return {
      set type(v: string) {
        rec.type = v;
      },
      get type() {
        return rec.type;
      },
      frequency: {
        setValueAtTime: (v: number) => rec.freqs.push(v),
        exponentialRampToValueAtTime: (v: number) => rec.freqs.push(v),
      },
      connect: () => {},
      disconnect: () => {},
      start: (t: number) => (rec.start = t),
      stop: (t: number) => (rec.stop = t),
      onended: null,
    } as unknown as OscillatorNode;
  }
  buffersPlayed = 0;
  createBufferSource() {
    const self = this;
    return {
      buffer: null,
      connect: () => {},
      start: () => {
        self.buffersPlayed++;
      },
    } as unknown as AudioBufferSourceNode;
  }
  decodeAudioData(bytes: ArrayBuffer) {
    return Promise.resolve({ duration: 0.3, bytes } as unknown as AudioBuffer);
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

let ctx: FakeContext;

function withAudio(): FakeContext {
  ctx = new FakeContext();
  vi.stubGlobal("window", { AudioContext: function () { return ctx; } as never });
  return ctx;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clip names off the wire", () => {
  const bad = [
    "",
    "search",
    "SEARCH_1",
    "../../etc/passwd",
    "search_1.mp3",
    "search-1",
    "http://evil/x_1",
    "search_1/../..",
  ];

  it.each(bad)("refuses to make a sound for %o", (name) => {
    const c = withAudio();
    const p = new EarconPlayer();
    p.prime();
    p.play(name);
    expect(c.oscillators).toHaveLength(0);
  });

  it("plays a well-formed one", () => {
    const c = withAudio();
    const p = new EarconPlayer();
    p.prime();
    p.play("search_3");
    expect(c.oscillators.length).toBeGreaterThan(0);
  });

  it("never throws, whatever it is handed", () => {
    withAudio();
    const p = new EarconPlayer();
    p.prime();
    for (const v of [null, undefined, "", "{}", "a_b", "generic_999999"]) {
      expect(() => p.play(v as string)).not.toThrow();
    }
  });
});

describe("the cue is a signal, not noise", () => {
  /** Every oscillator's first scheduled frequency, which is the cue's identity. */
  function pitches(name: string): number[] {
    const c = withAudio();
    const p = new EarconPlayer();
    p.prime();
    p.play(name);
    return c.oscillators.map((o) => Math.round(o.freqs[0]));
  }

  it("gives the same tool the same sound every time", () => {
    expect(pitches("search_3")).toEqual(pitches("search_3"));
  });

  it("gives different CATEGORIES different sounds", () => {
    // The categories are what a listener actually learns: "it went to look something
    // up" vs "it sent something". Two families that sounded alike would be worse than
    // one sound for everything, because it would teach a distinction that isn't there.
    const heard = new Set(
      (["search", "create", "update", "send", "handoff", "media", "capture", "generic", "error"] as const).map(
        (c) => pitches(`${c}_1`).join(","),
      ),
    );
    expect(heard.size).toBe(9);
  });

  it("gives different VARIANTS of one category different sounds", () => {
    // The backend hashes custom tool names onto variants so two tools in the same
    // family stay apart. Collapsing them here would throw that away.
    const heard = new Set([0, 1, 2, 3, 4, 5].map((v) => pitches(`generic_${v}`).join(",")));
    expect(heard.size).toBe(6);
  });

  it("keeps an unknown category audible rather than silent", () => {
    // A category this build predates must still make a sound — silence is the failure
    // mode the whole feature exists to remove.
    expect(pitches("teleport_2").length).toBeGreaterThan(0);
  });

  it("wraps an out-of-range variant instead of falling silent", () => {
    expect(pitches("search_97").length).toBeGreaterThan(0);
  });

  it("stays under the -20 dBFS ceiling the bank is mastered to", () => {
    // Loud enough to hear over the agent, quiet enough not to duck it.
    expect(EARCON_INTERNALS.PEAK).toBeLessThanOrEqual(0.1);
  });
});

/** Drain microtasks: a fetch + arrayBuffer + decode is several ticks deep. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the real bank", () => {
  /** Record every URL fetched and answer with something decodable. */
  function withBank(status = 200) {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response(status === 200 ? new ArrayBuffer(8) : null, { status });
      }),
    );
    return urls;
  }

  it("defaults to whissle.ai's own bank, so an embed sounds like the dashboard", () => {
    // The premise this replaced was that no bank was reachable and synthesis was the
    // only option. It is served publicly with `access-control-allow-origin: *` —
    // verified against production — so a third-party embed can have the exact clips.
    expect(EARCON_INTERNALS.DEFAULT_BANK_URL).toBe("https://www.whissle.ai/sounds/tool");
  });

  it("warms the reserved clips on prime, inside the user gesture", async () => {
    const urls = withBank();
    withAudio();
    new EarconPlayer().prime();
    await Promise.resolve();
    // Variant 0 of each category is reserved server-side for the hand-pinned tools —
    // search_knowledge_base, book_appointment, send_email … — i.e. the ones that fire
    // on nearly every call, plus error_0, the cue for every failure.
    expect(urls).toEqual(
      EARCON_INTERNALS.PRELOAD.map((n) => `https://www.whissle.ai/sounds/tool/${n}.mp3`),
    );
  });

  it("warms nine clips, not the whole bank", () => {
    // 52 requests on start(), for cues most sessions never fire, on somebody else's
    // page. The rest arrive on first use and are cached from the second.
    expect(EARCON_INTERNALS.PRELOAD).toHaveLength(9);
  });

  it("guards preload with the same clip-name check as play", async () => {
    // A name is the one part of this module's input that reaches a URL, and the guard
    // is the only thing stopping a server-supplied string from choosing that URL.
    // `play()` had the check and `preload()` did not — dead code while there was no
    // default bank, live the moment there is one.
    const urls = withBank();
    withAudio();
    const p = new EarconPlayer();
    p.preload(["../../etc/passwd", "search_1.mp3", "http://evil/x_1", "SEARCH_1", "search_3"]);
    await Promise.resolve();
    expect(urls).toEqual(["https://www.whissle.ai/sounds/tool/search_3.mp3"]);
  });

  it("plays the synthesised cue immediately and the real clip from then on", async () => {
    const urls = withBank();
    const c = withAudio();
    const p = new EarconPlayer();
    p.prime();
    p.play("handoff_4");
    // No waiting on the network: a cue that arrives after a round-trip is an echo.
    expect(c.oscillators.length).toBeGreaterThan(0);
    expect(urls).toContain("https://www.whissle.ai/sounds/tool/handoff_4.mp3");

    await flush(); // let the fetch + decode land
    const synthesised = c.oscillators.length;
    p.play("handoff_4");
    expect(c.buffersPlayed).toBe(1); // the mastered clip
    expect(c.oscillators.length).toBe(synthesised); // and no oscillator this time
  });

  it("falls back to the oscillators when the bank 404s, and stops re-asking", async () => {
    const urls = withBank(404);
    const c = withAudio();
    const p = new EarconPlayer();
    p.prime();
    urls.length = 0;
    p.play("media_2");
    await flush();
    expect(urls).toHaveLength(1);
    const first = c.oscillators.length;
    expect(first).toBeGreaterThan(0);
    p.play("media_2");
    await Promise.resolve();
    // Still audible — a hole in the bank must never become a hole in the conversation
    // — and the miss is remembered rather than re-fetched on every cue.
    expect(c.oscillators.length).toBeGreaterThan(first);
    expect(urls).toHaveLength(1);
  });

  it("touches the network not at all with bankUrl: null", async () => {
    const urls = withBank();
    const c = withAudio();
    const p = new EarconPlayer({ bankUrl: null });
    p.prime();
    p.play("search_0");
    await Promise.resolve();
    expect(urls).toEqual([]);
    expect(c.oscillators.length).toBeGreaterThan(0);
  });

  it("takes a bank of your own", async () => {
    const urls = withBank();
    withAudio();
    new EarconPlayer({ bankUrl: "/sounds/tool/" }).prime();
    await Promise.resolve();
    expect(urls[0]).toBe("/sounds/tool/search_0.mp3");
  });
});

describe("switches", () => {
  it("stays silent when the server is already mixing the cue into the call audio", () => {
    // An agent on `tool_sounds: "call"` has the cue mixed into its outgoing audio by
    // services/tool_cue.py, while services/tool_events.py still ships the clip NAME
    // (only "off" suppresses that). Playing it here too gives two cues a few hundred
    // milliseconds apart, which reads as a stutter rather than a signal.
    const c = withAudio();
    const p = new EarconPlayer();
    p.prime();
    p.setSuppressed(true);
    p.play("search_0");
    expect(c.oscillators).toHaveLength(0);
    // And un-muting must not resurrect it: mute is the visitor's, suppression is the
    // session's, and they are not the same switch.
    p.setMuted(false);
    p.play("search_0");
    expect(c.oscillators).toHaveLength(0);
  });

  it("makes no sound at all when disabled", () => {
    const c = withAudio();
    const p = new EarconPlayer({ enabled: false });
    p.prime();
    p.play("search_0");
    expect(c.oscillators).toHaveLength(0);
  });

  it("makes no sound while muted, and resumes after", () => {
    const c = withAudio();
    const p = new EarconPlayer();
    p.prime();
    p.setMuted(true);
    p.play("search_0");
    expect(c.oscillators).toHaveLength(0);
    p.setMuted(false);
    p.play("search_0");
    expect(c.oscillators.length).toBeGreaterThan(0);
  });

  it("stays silent while the context is suspended", () => {
    // A context created outside a user gesture never starts. Playing into it is a
    // silent no-op anyway; not scheduling is how we avoid a queue of ghosts.
    const c = withAudio();
    c.state = "suspended";
    const p = new EarconPlayer();
    p.play("search_0");
    expect(c.oscillators).toHaveLength(0);
  });

  it("closes the context when the session ends", () => {
    const c = withAudio();
    const p = new EarconPlayer();
    p.prime();
    p.release();
    expect(c.closed).toBe(true);
  });

  it("does nothing outside a browser", () => {
    // SSR / a Node import must not touch WebAudio.
    vi.stubGlobal("window", undefined);
    const p = new EarconPlayer();
    expect(() => {
      p.prime();
      p.play("search_0");
      p.release();
    }).not.toThrow();
  });
});
