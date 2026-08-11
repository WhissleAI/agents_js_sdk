import { describe, expect, it } from "vitest";
import { type SessionCallbacks } from "../src/livekit";
import { WhissleAgent } from "../src/WhissleAgent";

/**
 * Two things a caller can't see from inside a call, and the SDK is the only
 * place that can tell them:
 *
 *   - their own speech, while it is still being recognised
 *   - their microphone dying mid-session
 *
 * Both were silent before. Somebody talking with nothing on screen assumes they
 * aren't being heard and starts over; somebody whose mic was grabbed by another
 * app waits for a reply that can never come.
 */

/** Reaches `callbacks()`, where the transcript logic lives. */
class Probe extends WhissleAgent {
  cb: SessionCallbacks = this.callbacks();
  final: string[] = [];
  interim: string[] = [];
  constructor() {
    super({ sessionToken: "t" });
    this.on("user-transcript", (t) => this.final.push(String(t)));
    this.on("user-interim", (t) => this.interim.push(String(t)));
  }
}

describe("user speech", () => {
  it("emits interim text on its own channel, not as a transcript", () => {
    const p = new Probe();
    p.cb.onUserTranscript("what is", false);
    p.cb.onUserTranscript("what is earth", false);
    p.cb.onUserTranscript("what is earthing", true);

    // The provisional guesses must never reach `user-transcript` — a caller
    // appending that event to a log would record the same sentence three times,
    // in three states of wrongness.
    expect(p.final).toEqual(["what is earthing"]);
    expect(p.interim).toEqual(["what is", "what is earth"]);
  });

  it("still emits a final with no interim before it", () => {
    const p = new Probe();
    p.cb.onUserTranscript("yes", true);
    expect(p.final).toEqual(["yes"]);
    expect(p.interim).toEqual([]);
  });
});

/** A MediaStreamTrack stand-in — only the event surface the watcher uses. */
class FakeTrack {
  private listeners = new Map<string, Set<(e?: unknown) => void>>();
  addEventListener(type: string, fn: (e?: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e?: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string) {
    this.listeners.get(type)?.forEach((fn) => fn());
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

/** A WhissleAgent whose "published mic track" is one we control. */
class MicProbe extends WhissleAgent {
  cb: SessionCallbacks = this.callbacks();
  events: string[] = [];
  track = new FakeTrack();
  constructor() {
    super({ sessionToken: "t" });
    this.on("mic-lost", () => this.events.push("lost"));
    this.on("mic-restored", () => this.events.push("restored"));
    // Stand in for whichever transport published the track.
    (this as unknown as { lk: { micTrack: () => unknown } }).lk = {
      micTrack: () => this.track,
    };
  }
}

describe("microphone loss", () => {
  it("reports a track that ends, and only once", () => {
    const p = new MicProbe();
    p.cb.onConnected();
    p.track.fire("ended");
    p.track.fire("ended");
    // A device can fire both `ended` and `mute`; the caller should be told once.
    p.track.fire("mute");
    expect(p.events).toEqual(["lost"]);
  });

  it("reports a device going silent and coming back", () => {
    const p = new MicProbe();
    p.cb.onConnected();
    p.track.fire("mute");
    p.track.fire("unmute");
    expect(p.events).toEqual(["lost", "restored"]);
  });

  it("says nothing about a mic that was never lost", () => {
    const p = new MicProbe();
    p.cb.onConnected();
    p.track.fire("unmute");
    expect(p.events).toEqual([]);
  });

  it("watches once, however many times connect fires", () => {
    const p = new MicProbe();
    p.cb.onConnected();
    p.cb.onConnected();
    p.cb.onConnected();
    // Re-arming per reconnect would emit one `mic-lost` per listener, so the
    // app would show the warning two and three times over.
    expect(p.track.listenerCount).toBe(3); // ended + mute + unmute, one set
    p.track.fire("ended");
    expect(p.events).toEqual(["lost"]);
  });
});
