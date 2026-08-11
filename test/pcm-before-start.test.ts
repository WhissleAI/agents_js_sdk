import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The greeting is spoken the instant the session connects — which is while the
 * face is still starting. So the first audio of every conversation arrives
 * before Simli can take it.
 *
 * It used to be dropped, and that had two consequences, both reported from a
 * live interview: the greeting was the one reply the avatar never moved for,
 * and — because dropping it also meant never recording that the gateway DOES
 * mirror clean PCM — the track fallback could fire and switch the face to the
 * raw WebRTC track permanently, after which every later chunk of good PCM was
 * discarded and the mouth barely moved for the rest of the call.
 */

// SimliAvatar builds two media elements in its constructor. Only the handful of
// properties it touches are needed, so stub those rather than pull in a DOM.
function el() {
  return {
    autoplay: false,
    playsInline: false,
    muted: false,
    srcObject: null,
    addEventListener() {},
    removeEventListener() {},
    play: () => Promise.resolve(),
    remove() {},
  };
}
vi.stubGlobal("document", { createElement: () => el() });

const { SimliAvatar } = await import("../src/avatar");

/** An avatar with a fake simli-client, so `start` is ours to trigger. */
function harness() {
  const sent: number[] = [];
  // Pacing off: this is about WHICH chunks arrive, not when.
  const avatar = new SimliAvatar(el() as unknown as HTMLVideoElement, false);
  const a = avatar as unknown as {
    client: { sendAudioData: (b: Uint8Array) => void; listenToMediastreamTrack: () => void };
    started: boolean;
    gotPcm: boolean;
    usingTrack: boolean;
    fire(): void;
  };
  a.client = {
    sendAudioData: (b: Uint8Array) => sent.push(b[0]),
    listenToMediastreamTrack: () => {},
  };
  return {
    avatar,
    sent,
    /** What `client.on("start")` does when Simli reports the face is live. */
    start() {
      a.started = true;
      const pending = (avatar as unknown as { pendingPcm: Uint8Array[] }).pendingPcm;
      (avatar as unknown as { pendingPcm: Uint8Array[] }).pendingPcm = [];
      (avatar as unknown as { pendingPcmBytes: number }).pendingPcmBytes = 0;
      for (const c of pending) avatar.sendPcm(c);
    },
    get gotPcm() {
      return a.gotPcm;
    },
  };
}

const chunk = (tag: number, bytes = 6000) => {
  const b = new Uint8Array(bytes);
  b[0] = tag;
  return b;
};

describe("PCM that arrives before the face is live", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("is kept and played once the face starts", () => {
    const h = harness();
    h.avatar.sendPcm(chunk(1));
    h.avatar.sendPcm(chunk(2));
    // Nothing can reach Simli yet — there is no face to move.
    expect(h.sent).toEqual([]);

    h.start();
    // …and nothing was lost: this is the greeting.
    expect(h.sent).toEqual([1, 2]);
  });

  it("counts as proof the gateway mirrors PCM, before the face starts", () => {
    const h = harness();
    h.avatar.sendPcm(chunk(1));
    // This is what stops the track fallback taking over. Left false, the
    // fallback fires, `usingTrack` latches, and every later chunk of clean PCM
    // is dropped for the rest of the session.
    expect(h.gotPcm).toBe(true);
  });

  it("keeps flowing normally after the face is live", () => {
    const h = harness();
    h.start();
    h.avatar.sendPcm(chunk(7));
    expect(h.sent).toEqual([7]);
  });

  it("drops the oldest audio rather than growing without limit", () => {
    const h = harness();
    // A face that never starts must not buffer forever. 320 kB cap, 32 kB
    // chunks: the early ones go, the recent ones stay.
    for (let i = 1; i <= 20; i++) h.avatar.sendPcm(chunk(i, 32_000));
    h.start();
    expect(h.sent.length).toBeLessThanOrEqual(11);
    // What survives is the END of the speech, not the start of it — a late
    // greeting is worth less than the words after it.
    expect(h.sent[h.sent.length - 1]).toBe(20);
  });
});
