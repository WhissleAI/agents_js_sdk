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
  createBufferSource() {
    return { buffer: null, connect: () => {}, start: () => {} } as unknown as AudioBufferSourceNode;
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

describe("switches", () => {
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
