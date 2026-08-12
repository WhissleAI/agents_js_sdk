import { describe, expect, it, vi } from "vitest";

/**
 * simli-client reports a session ready only from a `requestVideoFrameCallback`
 * — it waits for a frame to be PAINTED. A backgrounded, occluded or throttled
 * tab paints nothing, so its start promise never settles even while the media
 * is flowing: the session is live, the server has said so, and the caller is
 * still told the avatar "didn't come up in time" and drops to voice for the
 * rest of the call.
 *
 * Observed exactly that way — a live session logging P2P connected, an SDP
 * answer, video_metadata and START, followed by the avatar being declared dead.
 *
 * So readiness takes whichever proof arrives first: a painted frame, or the
 * server's own `start` event.
 */

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

// Read at construction time, so one memoized constructor can play both cases.
const cfg = vi.hoisted(() => ({ emitStart: true, startResolves: false }));

vi.mock("simli-client/dist/client.js", () => ({
  SimliClient: class {
    private handlers = new Map<string, (...a: unknown[]) => void>();
    on(event: string, fn: (...a: unknown[]) => void) {
      this.handlers.set(event, fn);
    }
    start() {
      if (cfg.emitStart) setTimeout(() => this.handlers.get("start")?.(), 0);
      // Not resolving is the whole point: the frame never paints.
      return cfg.startResolves ? Promise.resolve() : new Promise<void>(() => undefined);
    }
    sendAudioData() {}
    listenToMediastreamTrack() {}
    close() {}
  },
}));

const { SimliAvatar } = await import("../src/avatar");

/** Did `start()` settle, or is it still waiting? */
async function outcome(opts: { emitStart: boolean; startResolves: boolean }) {
  cfg.emitStart = opts.emitStart;
  cfg.startResolves = opts.startResolves;
  const avatar = new SimliAvatar(el() as unknown as HTMLVideoElement, false);
  return Promise.race([
    avatar.start({ session_token: "t" } as never).then(() => "ready"),
    new Promise((r) => setTimeout(() => r("hung"), 250)),
  ]);
}

describe("avatar readiness", () => {
  it("goes live on the server's start event even when no frame ever paints", async () => {
    // Without racing the `start` event, this waits on a paint that never comes.
    expect(await outcome({ emitStart: true, startResolves: false })).toBe("ready");
  });

  it("still goes live when a frame paints and no start event arrives", async () => {
    expect(await outcome({ emitStart: false, startResolves: true })).toBe("ready");
  });

  it("keeps waiting when neither the server nor a frame says anything", async () => {
    expect(await outcome({ emitStart: false, startResolves: false })).toBe("hung");
  });
});
