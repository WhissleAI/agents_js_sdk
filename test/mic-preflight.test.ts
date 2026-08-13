import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkMicrophone } from "../src/mic";
import { WhissleAgent } from "../src/WhissleAgent";

/**
 * The preflight is ON BY DEFAULT and a problem THROWS out of `start()`, on other
 * people's sites. That combination is why these exist: the check has to be right about
 * a broken microphone (the session would otherwise come up deaf and silent, which is
 * invisible from inside the page) and it has to be very sure before it refuses one that
 * works, because a visitor turned away at the door never finds out why.
 *
 * The sharp edge is `MediaStreamTrack.muted`. It does NOT mean "the user muted this";
 * per spec it means "not currently providing data", which is the ordinary state of a
 * track for the first moments of its life. Reading it synchronously out of
 * `getUserMedia` fails working hardware on the browsers that set it until the first
 * sample arrives.
 */

const LIVE = "https://gw.test/bot";

/** A MediaStreamTrack that can flip `muted` the way a real one does. */
function fakeTrack(opts: { muted?: boolean; readyState?: string } = {}) {
  const listeners: Record<string, Array<() => void>> = {};
  const track = {
    kind: "audio",
    muted: opts.muted ?? false,
    readyState: opts.readyState ?? "live",
    stop: vi.fn(),
    addEventListener: (t: string, fn: () => void) => {
      (listeners[t] ??= []).push(fn);
    },
    removeEventListener: (t: string, fn: () => void) => {
      listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn);
    },
    /** The first sample arriving — what a real track does a few ms in. */
    deliverFirstSample() {
      track.muted = false;
      (listeners.unmute ?? []).slice().forEach((f) => f());
    },
  };
  return track;
}

function installMic(result: { tracks?: unknown[] } | Error) {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        if (result instanceof Error) throw result;
        return {
          getAudioTracks: () => result.tracks ?? [],
          getTracks: () => result.tracks ?? [],
        };
      }),
      enumerateDevices: vi.fn(async () => []),
    },
  });
}

const named = (name: string) => Object.assign(new Error(name), { name });

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("what the preflight refuses", () => {
  it("passes a healthy microphone and hands the track straight back", async () => {
    const track = fakeTrack();
    installMic({ tracks: [track] });
    expect(await checkMicrophone()).toBeNull();
    // Holding it would make us the app the "another app is using your microphone"
    // message tells people to go and close.
    expect(track.stop).toHaveBeenCalled();
  });

  it.each([
    ["NotAllowedError", "denied"],
    ["NotReadableError", "in-use"],
    ["NotFoundError", "not-found"],
  ])("treats %s as blocking (%s)", async (domException, code) => {
    installMic(named(domException));
    const problem = await checkMicrophone();
    expect(problem).toMatchObject({ code, severity: "blocking" });
  });

  it("treats a track that never went live as blocking", async () => {
    installMic({ tracks: [fakeTrack({ readyState: "ended" })] });
    expect(await checkMicrophone()).toMatchObject({ code: "in-use", severity: "blocking" });
  });
});

describe("the `muted` flag, which is not what it sounds like", () => {
  it("waits for the first sample instead of failing a track that is merely starting", async () => {
    // The regression this is here for. A brand-new track reporting `muted: true` is
    // the NORMAL case on several browsers; judging it synchronously turned a working
    // microphone into a refused session, on a check that is on by default.
    const track = fakeTrack({ muted: true });
    installMic({ tracks: [track] });
    const pending = checkMicrophone();
    await Promise.resolve();
    track.deliverFirstSample();
    expect(await pending).toBeNull();
  });

  it("reports a track still muted after the grace as a WARNING, never blocking", async () => {
    // It probably is a system mute — but a browser that simply never clears the flag
    // looks identical from here, and we do not get to end someone's session on a
    // guess. The server's own `{t:"mic_dead"}` is the check that can actually tell.
    vi.useFakeTimers();
    try {
      installMic({ tracks: [fakeTrack({ muted: true })] });
      const pending = checkMicrophone();
      await vi.advanceTimersByTimeAsync(500);
      expect(await pending).toMatchObject({ code: "muted", severity: "warning" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what start() does with it", () => {
  class TestAgent extends WhissleAgent {
    opened = 0;
    protected async openWebRTC(): Promise<void> {
      this.opened++;
    }
  }

  const mintOk = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ token: "t" }), {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

  it("refuses to connect when the microphone is genuinely blocked", async () => {
    vi.stubGlobal("window", {});
    installMic(named("NotAllowedError"));
    mintOk();
    const agent = new TestAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: LIVE });
    const seen: unknown[] = [];
    agent.on("error", (_m, d) => seen.push(d));
    await expect(agent.start()).rejects.toThrow(/blocking the microphone/i);
    expect(agent.opened).toBe(0);
    expect(seen).toEqual([{ code: "microphone" }]);
  });

  it("connects anyway on a warning, and still says so", async () => {
    // A default-on preflight that can refuse a working microphone would be a new way
    // to break a third-party site. It gets to warn; it does not get to veto.
    vi.useFakeTimers();
    try {
      vi.stubGlobal("window", {});
      installMic({ tracks: [fakeTrack({ muted: true })] });
      mintOk();
      const agent = new TestAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: LIVE });
      const messages: string[] = [];
      agent.on("error", (m) => messages.push(String(m)));
      const started = agent.start();
      await vi.advanceTimersByTimeAsync(500);
      await started;
      expect(agent.opened).toBe(1);
      expect(messages[0]).toMatch(/reports itself muted/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
