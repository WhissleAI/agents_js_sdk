import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PacedPcmQueue } from "../src/avatar";

/**
 * The avatar's PCM does not reach the browser at the rate it is spoken. The bot
 * mirrors its TTS at one 187.5 ms chunk per 187.5 ms, but by the time it lands
 * the stream alternates starving (~400 ms between chunks for seconds at a time)
 * and dumping (2.6 s of audio inside 310 ms), because it shares an output queue
 * with the WebRTC track and then rides a reliable ordered data channel. Simli
 * renders a real-time stream and visibly stutters on either.
 *
 * These cover the thing that smooths it: the release rate, what gets dropped
 * when the queue blows up, and that a barge-in empties it.
 */

/** One 187.5 ms chunk of 16 kHz Int16 mono, tagged so we can tell them apart. */
const CHUNK_MS = 187.5;
function chunk(tag: number, ms = CHUNK_MS): Uint8Array {
  const bytes = new Uint8Array(ms * 32);
  bytes[0] = tag;
  return bytes;
}

/** A queue wired to a controllable clock, with the bucket/ceiling under test. */
function harness(opts: { burst?: number; maxBacklogMs?: number; hidden?: boolean } = {}) {
  const sent: number[] = [];
  let hidden = opts.hidden ?? false;
  const q = new PacedPcmQueue(
    (c) => sent.push(c[0]),
    () => Date.now(),
    () => hidden,
    opts.burst ?? 375,
    opts.maxBacklogMs ?? 30_000,
    1.5,
  );
  return { q, sent, hide: (v: boolean) => (hidden = v) };
}

/** How many chunks a fresh queue releases in the same tick as a 20-chunk dump. */
function harnessSendsAtOnce(opts: { burst: number }): number {
  const { q, sent } = harness(opts);
  for (let i = 0; i < 20; i++) q.push(chunk(i));
  return sent.length;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("PacedPcmQueue — release rate", () => {
  it("spreads a dump over seconds instead of milliseconds, in order", () => {
    const { q, sent } = harness();
    // 20 chunks (3.75 s of speech) dumped in the same millisecond — the exact
    // shape the live session logged.
    for (let i = 0; i < 20; i++) q.push(chunk(i));

    // Only the burst allowance goes straight out; the rest waits its turn.
    expect(sent).toEqual([0, 1, 2]);

    // Then one chunk per 125 ms — 187.5 ms of audio at 1.5x real time.
    vi.advanceTimersByTime(125);
    expect(sent).toEqual([0, 1, 2, 3]);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    // Nothing is lost: the whole dump is out after ~2.1 s, not 0.14 s and not
    // the 3.75 s a strict metronome would have taken.
    vi.advanceTimersByTime(1_500);
    expect(sent).toHaveLength(20);
    expect(q.snapshot().dropped).toBe(0);
  });

  it("releases at 1.5x real time, so Simli gains a cushion for the next stall", () => {
    // Faster than real time on purpose. At exactly 1x the queue would still be
    // empty when the next 4-second stall arrives, and Simli would run dry.
    // Measured past the opening burst allowance, so this is the sustained rate.
    const { q, sent } = harness();
    for (let i = 0; i < 30; i++) q.push(chunk(i));
    vi.advanceTimersByTime(1_000);
    const at1s = sent.length;
    vi.advanceTimersByTime(2_000);
    const audioOutMs = (sent.length - at1s) * CHUNK_MS;
    expect(audioOutMs / 2_000).toBeCloseTo(1.5, 1);
    expect(q.snapshot().dropped).toBe(0);
  });

  it("adds no delay at all when audio already arrives in real time", () => {
    const { q, sent } = harness();
    for (let i = 0; i < 12; i++) {
      q.push(chunk(i));
      // Every chunk is forwarded in the same tick it arrived.
      expect(sent).toHaveLength(i + 1);
      vi.advanceTimersByTime(CHUNK_MS);
    }
    // Nothing was ever held, so nothing can be out of sync.
    expect(q.snapshot().maxQueuedMs).toBeLessThanOrEqual(CHUNK_MS);
  });

  it("hands over the burst allowance immediately, so Simli is never left waiting", () => {
    // Underrunning Simli looks worse than bursting it, so a run opens with two
    // chunks in hand rather than one metronome tick at a time.
    expect(harnessSendsAtOnce({ burst: 375 })).toBe(3);
    expect(harnessSendsAtOnce({ burst: 0 })).toBe(1);
  });
});

describe("PacedPcmQueue — backlog policy", () => {
  it("drops the OLDEST audio when the backlog blows past the ceiling", () => {
    // 1 s ceiling = 5 chunks (the 6th push overflows).
    const { q, sent } = harness({ maxBacklogMs: 1_000, burst: 0 });
    vi.setSystemTime(0);
    q.push(chunk(0)); // released immediately (due now)
    expect(sent).toEqual([0]);
    for (let i = 1; i <= 10; i++) q.push(chunk(i));

    const stats = q.snapshot();
    expect(stats.dropped).toBeGreaterThan(0);
    expect(stats.queuedMs).toBeLessThanOrEqual(1_000);

    // Drain and check WHICH survived: the newest, so the face catches up with
    // the conversation instead of falling further behind reciting stale audio.
    vi.advanceTimersByTime(CHUNK_MS * 20);
    const survivors = sent.slice(1);
    expect(survivors[survivors.length - 1]).toBe(10);
    expect(survivors).not.toContain(1);
    expect(sent.length + stats.dropped).toBe(11);
  });

  it("restarts the clock after a drop so the survivors are not paced out late", () => {
    const { q, sent } = harness({ maxBacklogMs: 1_000, burst: 0 });
    for (let i = 0; i < 12; i++) q.push(chunk(i));
    // Every overflow releases a survivor in the same tick: what is left is
    // already behind the conversation, so it must not also wait its old turn.
    expect(sent.length).toBeGreaterThan(1);
  });

  it("counts the deepest backlog it ever saw, so a burst is visible after the fact", () => {
    const { q } = harness();
    for (let i = 0; i < 20; i++) q.push(chunk(i));
    // A real-time feed never holds more than a chunk; 3.3 s held is the burst.
    expect(q.snapshot().maxQueuedMs).toBeGreaterThan(3_000);
    expect(q.snapshot().received).toBe(20);
  });
});

describe("PacedPcmQueue — interruption", () => {
  it("throws the queue away on flush, so the avatar stops talking over the user", () => {
    const { q, sent } = harness();
    for (let i = 0; i < 20; i++) q.push(chunk(i));
    const beforeFlush = sent.length;

    q.flush();
    vi.advanceTimersByTime(CHUNK_MS * 40);

    expect(sent).toHaveLength(beforeFlush); // not one more chunk went out
    expect(q.snapshot().flushed).toBe(20 - beforeFlush);
    expect(q.snapshot().queuedMs).toBe(0);
  });

  it("accepts audio again after a flush", () => {
    const { q, sent } = harness();
    for (let i = 0; i < 20; i++) q.push(chunk(i));
    q.flush();
    q.push(chunk(99));
    expect(sent[sent.length - 1]).toBe(99); // next turn starts instantly
  });

  it("sends nothing more once stopped", () => {
    const { q, sent } = harness();
    for (let i = 0; i < 20; i++) q.push(chunk(i));
    const beforeStop = sent.length;
    q.stop();
    q.push(chunk(99));
    vi.advanceTimersByTime(CHUNK_MS * 40);
    expect(sent).toHaveLength(beforeStop);
  });
});

describe("PacedPcmQueue — backgrounded tab", () => {
  it("hands everything straight through while the tab is hidden", () => {
    // A hidden tab throttles timers to ~1 Hz; pacing there would starve Simli
    // and grow the queue without bound. Nobody can see the face, so don't pace.
    const { q, sent } = harness({ hidden: true });
    for (let i = 0; i < 20; i++) q.push(chunk(i));
    expect(sent).toHaveLength(20);
    expect(q.snapshot().queuedMs).toBe(0);
  });

  it("releases everything ALLOWED on a late wake-up, not one chunk per tick", () => {
    // The bucket is absolute, so a timer that fires a second late finds a
    // second and a half of allowance accrued — the throttled case degrades to
    // pass-through rather than falling permanently behind.
    const { q, sent } = harness();
    for (let i = 0; i < 20; i++) q.push(chunk(i));
    const immediate = sent.length;
    vi.advanceTimersByTime(1_000); // one throttled tick
    expect(sent.length).toBeGreaterThanOrEqual(immediate + 5);
  });

  it("resumes pacing when the tab comes back", () => {
    const { q, sent, hide } = harness({ hidden: true });
    q.push(chunk(0));
    expect(sent).toHaveLength(1);
    hide(false);
    for (let i = 1; i < 20; i++) q.push(chunk(i));
    expect(sent.length).toBeLessThan(20);
  });
});
