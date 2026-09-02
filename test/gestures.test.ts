import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveTarget,
  GestureDwell,
  GestureEngine,
  rejectTarget,
  type CameraLike,
  type CameraTrackLike,
  type GestureEngineHooks,
  type GestureEngineOptions,
  type GestureEvent,
  type VisionModule,
} from "../src/gestures";
import { type SessionCallbacks } from "../src/livekit";
import { type Affordance, type ToolFinished } from "../src/tool-events";
import { WhissleAgent, type FireAffordanceOptions } from "../src/WhissleAgent";
import { WIDGET_INTERNALS } from "../src/widget";

/**
 * Card affordances, P2: gesture input. A gesture can approve a side effect
 * without a tap or a word, so what these pin is mostly the ways it must NOT
 * fire: every arming gate individually, the confidence + dwell bar, the closed
 * three-gesture vocabulary, ambiguity-never-fires, the open-palm hold that is
 * never a disposition, and the graceful no-op when the optional dependency or
 * its assets are missing — gestures must never break a session.
 */

const aff = (over: Partial<Affordance> & Pick<Affordance, "id" | "kind">): Affordance => ({
  label: over.id,
  actionId: `act_${over.id}`,
  raw: {},
  ...over,
});

/** The canonical card: one primary approve, one reject. */
const CARD_AFFS = [aff({ id: "yes", kind: "approve", primary: true }), aff({ id: "no", kind: "reject" })];
const card = (affordances: Affordance[] = CARD_AFFS, id = "call-1"): ToolFinished => ({
  id,
  affordances,
  raw: {},
});

const liveTrack = () => ({
  readyState: "live",
  stop: vi.fn<() => void>(),
});
const camera = (track: CameraTrackLike = liveTrack()): CameraLike => ({
  getVideoTracks: () => [track],
  getTracks: () => [track],
});

/** A fake `@mediapipe/tasks-vision` that serves whatever `sample` holds. */
function fakeVision(sample: () => { name?: string; score?: number }) {
  const assetUrls: string[] = [];
  const module: VisionModule = {
    FilesetResolver: {
      forVisionTasks: async (path: string) => {
        assetUrls.push(path);
        return {};
      },
    },
    GestureRecognizer: {
      createFromOptions: async (_fileset, options) => {
        assetUrls.push(
          (options as { baseOptions: { modelAssetPath: string } }).baseOptions.modelAssetPath,
        );
        return {
          recognizeForVideo: () => {
            const s = sample();
            return {
              gestures: s.name ? [[{ categoryName: s.name, score: s.score ?? 0.99 }]] : [],
            };
          },
        };
      },
    },
  };
  return { module, assetUrls };
}

function makeEngine(overrides: Partial<GestureEngineOptions> = {}) {
  const events: GestureEvent[] = [];
  const fired: FireAffordanceOptions[] = [];
  let sample: { name?: string; score?: number } = {};
  const vision = fakeVision(() => sample);
  let failFiring = false;
  const base: GestureEngineOptions = {
    assetsUrl: "https://host.app/gestures",
    visual: () => ({ camera: true }),
    fire: async (o) => {
      fired.push(o);
      if (failFiring) throw new Error("dropped");
      return {};
    },
    emit: (e) => events.push(e),
    loadVision: async () => vision.module,
    openCamera: async () => camera(),
  };
  const engine = new GestureEngine({ ...base, ...overrides });
  return {
    engine,
    events,
    fired,
    vision,
    setSample: (s: { name?: string; score?: number }) => (sample = s),
    setFailFiring: (v: boolean) => (failFiring = v),
  };
}

const states = (events: GestureEvent[]) => events.map((e) => e.armed_state);

/** Arm and settle: card in, async import/camera flushed. */
async function armed(overrides: Partial<GestureEngineOptions> = {}) {
  const t = makeEngine(overrides);
  t.engine.cardFinished(card());
  await vi.advanceTimersByTimeAsync(0);
  return t;
}

/** Two qualifying samples = one dwell-complete gesture. */
async function hold(t: { setSample: (s: { name?: string; score?: number }) => void }, name: string, score = 0.99) {
  t.setSample({ name, score });
  await vi.advanceTimersByTimeAsync(600);
  t.setSample({});
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("arming preconditions — each gate alone keeps it off", () => {
  it("arms when every gate passes: opt-in, mint camera, live track, exactly one card", async () => {
    const { events } = await armed();
    expect(events).toEqual([{ name: null, armed_state: "armed" }]);
  });

  it("never arms without a gestureAssetsUrl — one warn, no CDN fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { engine, events } = await armed({ assetsUrl: undefined });
    expect(events).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/gestureAssetsUrl/);
    // A second evaluation neither arms nor warns again.
    engine.cardResolved({ affordanceId: "yes", raw: {} });
    engine.cardFinished(card());
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never arms when the mint's visual descriptor doesn't allow a camera", async () => {
    for (const visual of [() => ({ camera: false }), () => undefined]) {
      const { events } = await armed({ visual });
      // An audio-only session (no `visual` at all) is the second case.
      expect(events).toEqual([]);
    }
  });

  it("never arms without a camera — denied, absent, or dead on arrival", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const none = await armed({ openCamera: async () => null });
    expect(none.events).toEqual([]);
    const dead = liveTrack();
    dead.readyState = "ended";
    const ended = await armed({ openCamera: async () => camera(dead) });
    expect(ended.events).toEqual([]);
    expect(dead.stop).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("never arms with zero cards, or with a render-only card", async () => {
    const t = makeEngine();
    t.engine.cardFinished({ raw: {} }); // no affordances — doesn't count
    await vi.advanceTimersByTimeAsync(0);
    expect(t.events).toEqual([]);
  });

  it("never arms with TWO unresolved cards, and arms when one resolves", async () => {
    const t = makeEngine();
    t.engine.cardFinished(card());
    t.engine.cardFinished(card([aff({ id: "b", kind: "approve", primary: true })], "call-2"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.events).toEqual([]);
    t.engine.cardResolved({ affordanceId: "yes", raw: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.events).toEqual([{ name: null, armed_state: "armed" }]);
  });

  it("disarms when a second card arrives while armed", async () => {
    const t = await armed();
    t.engine.cardFinished(card([aff({ id: "b", kind: "approve" })], "call-2"));
    expect(states(t.events)).toEqual(["armed", "disarmed"]);
  });

  it("disarms — and stops the camera — when the track dies mid-arming", async () => {
    const track = liveTrack();
    const t = await armed({ openCamera: async () => camera(track) });
    track.readyState = "ended";
    await vi.advanceTimersByTimeAsync(300);
    expect(states(t.events)).toEqual(["armed", "disarmed"]);
    expect(track.stop).toHaveBeenCalled();
  });

  it("disarms and stops sampling when the only card resolves from any surface", async () => {
    const t = await armed();
    t.engine.cardResolved({ actionId: "act_no", disposition: "reject", raw: {} });
    expect(states(t.events)).toEqual(["armed", "disarmed"]);
    // Sampling has stopped: a held gesture after disarm fires nothing.
    await hold(t, "Thumb_Up");
    expect(t.fired).toEqual([]);
  });
});

describe("confidence and dwell", () => {
  it("fires on two consecutive samples at ≥ 0.75 — a ~600 ms hold", async () => {
    const t = await armed();
    await hold(t, "Thumb_Up", 0.75);
    expect(t.fired).toHaveLength(1);
  });

  it("a single sample is not a gesture", async () => {
    const t = await armed();
    t.setSample({ name: "Thumb_Up", score: 0.99 });
    await vi.advanceTimersByTimeAsync(300);
    t.setSample({});
    await vi.advanceTimersByTimeAsync(600);
    expect(t.fired).toEqual([]);
  });

  it("confidence below the bar never accumulates", async () => {
    const t = await armed();
    t.setSample({ name: "Thumb_Up", score: 0.74 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.fired).toEqual([]);
  });

  it("a different gesture in between resets the dwell", async () => {
    const t = await armed();
    for (const name of ["Thumb_Up", "Thumb_Down", "Thumb_Up", "Thumb_Down"]) {
      t.setSample({ name, score: 0.99 });
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(t.fired).toEqual([]);
  });

  it("skips sampling while the document is hidden", async () => {
    const t = await armed();
    vi.stubGlobal("document", { hidden: true });
    await hold(t, "Thumb_Up");
    expect(t.fired).toEqual([]);
    vi.stubGlobal("document", { hidden: false });
    await hold(t, "Thumb_Up");
    expect(t.fired).toHaveLength(1);
  });
});

describe("exactly three gestures", () => {
  it("nothing outside Thumb_Up / Thumb_Down / Open_Palm does anything, at any confidence", async () => {
    const t = await armed();
    for (const name of ["Victory", "ILoveYou", "Pointing_Up", "Closed_Fist", "wave", ""]) {
      t.setSample({ name, score: 0.99 });
      await vi.advanceTimersByTimeAsync(900);
    }
    expect(t.fired).toEqual([]);
    expect(states(t.events)).toEqual(["armed"]); // never paused, never fired
  });
});

describe("what each gesture means", () => {
  it("thumbs-up fires the focused card's primary approve, source gesture", async () => {
    const t = await armed();
    await hold(t, "Thumb_Up");
    expect(t.fired).toEqual([
      { actionId: "act_yes", affordanceId: "yes", disposition: "approve", source: "gesture" },
    ]);
    expect(t.events).toEqual([
      { name: null, armed_state: "armed" },
      { name: "Thumb_Up", armed_state: "fired" },
    ]);
  });

  it("falls back to a SINGLE unmarked approve when no primary is marked", async () => {
    const affs = [aff({ id: "send", kind: "approve" }), aff({ id: "no", kind: "reject" })];
    const t = makeEngine();
    t.engine.cardFinished(card(affs));
    await vi.advanceTimersByTimeAsync(0);
    await hold(t, "Thumb_Up");
    expect(t.fired[0]).toMatchObject({ affordanceId: "send", disposition: "approve" });
  });

  it("ambiguity never fires: several unmarked choices leave a thumbs-up meaningless", async () => {
    const affs = [aff({ id: "slot1", kind: "choice" }), aff({ id: "slot2", kind: "choice" })];
    const t = makeEngine();
    t.engine.cardFinished(card(affs));
    await vi.advanceTimersByTimeAsync(0);
    await hold(t, "Thumb_Up");
    expect(t.fired).toEqual([]);
    expect(states(t.events)).toEqual(["armed"]); // still armed, nothing claimed to fire
  });

  it("a primary choice among choices IS the thumbs-up target, fired as approve", async () => {
    const affs = [aff({ id: "s1", kind: "choice" }), aff({ id: "s2", kind: "choice", primary: true })];
    const t = makeEngine();
    t.engine.cardFinished(card(affs));
    await vi.advanceTimersByTimeAsync(0);
    await hold(t, "Thumb_Up");
    expect(t.fired[0]).toMatchObject({ affordanceId: "s2", disposition: "approve" });
  });

  it("thumbs-down fires the card's single reject", async () => {
    const t = await armed();
    await hold(t, "Thumb_Down");
    expect(t.fired).toEqual([
      { actionId: "act_no", affordanceId: "no", disposition: "reject", source: "gesture" },
    ]);
  });

  it("thumbs-down against several rejects — or none — fires nothing", async () => {
    for (const affs of [
      [aff({ id: "a", kind: "reject" }), aff({ id: "b", kind: "reject" })],
      [aff({ id: "only", kind: "approve", primary: true })],
    ]) {
      const t = makeEngine();
      t.engine.cardFinished(card(affs));
      await vi.advanceTimersByTimeAsync(0);
      await hold(t, "Thumb_Down");
      expect(t.fired).toEqual([]);
    }
  });

  it("after a firing, further thumbs do nothing until the card resolves", async () => {
    const t = await armed();
    await hold(t, "Thumb_Up");
    await hold(t, "Thumb_Down");
    await hold(t, "Thumb_Up");
    expect(t.fired).toHaveLength(1);
  });

  it("a firing that fails to land re-arms rather than wedging", async () => {
    const t = await armed();
    t.setFailFiring(true);
    await hold(t, "Thumb_Up");
    await vi.advanceTimersByTimeAsync(0);
    expect(states(t.events)).toEqual(["armed", "fired", "armed"]);
    t.setFailFiring(false);
    await hold(t, "Thumb_Up");
    expect(t.fired).toHaveLength(2);
  });
});

describe("open palm — the hold", () => {
  it("pauses for 30 s, is NEVER a disposition, and thumbs are ignored meanwhile", async () => {
    const t = await armed();
    await hold(t, "Open_Palm");
    expect(states(t.events)).toEqual(["armed", "paused"]);
    expect(t.fired).toEqual([]); // never a disposition
    await hold(t, "Thumb_Up");
    expect(t.fired).toEqual([]); // paused: thumbs do nothing
    // The pause lapses on its own…
    await vi.advanceTimersByTimeAsync(30_000);
    expect(states(t.events)).toEqual(["armed", "paused", "armed"]);
    // …and thumbs work again.
    await hold(t, "Thumb_Up");
    expect(t.fired).toHaveLength(1);
  });

  it("a palm held up keeps extending the pause", async () => {
    const t = await armed();
    t.setSample({ name: "Open_Palm", score: 0.99 });
    await vi.advanceTimersByTimeAsync(25_000);
    t.setSample({});
    // 25 s of palm: the original 30 s window has been pushed out, not lapsed.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states(t.events)).toEqual(["armed", "paused"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(states(t.events)).toEqual(["armed", "paused", "armed"]);
  });
});

describe("graceful no-op — gestures must never break a session", () => {
  it("warns ONCE and goes permanently quiet when the module doesn't load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await armed({
      loadVision: async () => {
        throw new Error("blocked by CSP");
      },
    });
    expect(t.events).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/tasks-vision/);
    // Another card cycle: broken stays broken, silently.
    t.engine.cardResolved({ affordanceId: "yes", raw: {} });
    t.engine.cardFinished(card());
    await vi.advanceTimersByTimeAsync(0);
    expect(t.events).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a module without the expected shape counts as not loading", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await armed({ loadVision: async () => ({}) as VisionModule });
    expect(t.events).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("assets that fail to build the recognizer warn once and stay off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken: VisionModule = {
      FilesetResolver: {
        forVisionTasks: async () => {
          throw new Error("404");
        },
      },
      GestureRecognizer: { createFromOptions: async () => ({ recognizeForVideo: () => ({}) }) },
    };
    const t = await armed({ loadVision: async () => broken });
    expect(t.events).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/host\.app\/gestures/);
  });

  it("loads the wasm and the task from the host's OWN assets URL, slash-tolerant", async () => {
    const t = await armed({ assetsUrl: "https://host.app/gestures/" });
    expect(t.vision.assetUrls).toEqual([
      "https://host.app/gestures/wasm",
      "https://host.app/gestures/gesture_recognizer.task",
    ]);
    expect(t.events).toEqual([{ name: null, armed_state: "armed" }]);
  });
});

describe("the target-selection rules, directly", () => {
  it("approveTarget: primary wins; single unmarked is the fallback; ambiguity is null", () => {
    const p = aff({ id: "p", kind: "approve", primary: true });
    const a = aff({ id: "a", kind: "approve" });
    const c = aff({ id: "c", kind: "choice" });
    const r = aff({ id: "r", kind: "reject" });
    expect(approveTarget([p, a, r])).toBe(p);
    expect(approveTarget([a, r])).toBe(a);
    expect(approveTarget([c, r])).toBe(c);
    expect(approveTarget([a, c])).toBeNull();
    expect(approveTarget([r])).toBeNull();
    expect(approveTarget([])).toBeNull();
  });

  it("rejectTarget: exactly one reject, else null", () => {
    const r1 = aff({ id: "r1", kind: "reject" });
    const r2 = aff({ id: "r2", kind: "reject" });
    expect(rejectTarget([aff({ id: "a", kind: "approve" }), r1])).toBe(r1);
    expect(rejectTarget([r1, r2])).toBeNull();
    expect(rejectTarget([aff({ id: "a", kind: "approve" })])).toBeNull();
  });

  it("the dwell gate, directly: three-only, confidence-gated, reset on anything else", () => {
    const d = new GestureDwell();
    expect(d.feed("Thumb_Up", 0.99)).toBeNull();
    expect(d.feed("Thumb_Up", 0.99)).toBe("Thumb_Up");
    // Fired = reset: a third sample starts a new dwell.
    expect(d.feed("Thumb_Up", 0.99)).toBeNull();
    expect(d.feed("Victory", 0.99)).toBeNull();
    expect(d.feed("Thumb_Up", 0.99)).toBeNull();
    expect(d.feed("Thumb_Up", 0.7)).toBeNull(); // under the bar: resets too
    expect(d.feed("Thumb_Up", 0.99)).toBeNull();
    expect(d.feed("Thumb_Up", 0.75)).toBe("Thumb_Up");
  });
});

describe("through the agent — the wiring, both doors to one ledger", () => {
  const CARD_WIRE = {
    kind: "tool",
    phase: "result",
    tool_call_id: "call-1",
    function_name: "send_email",
    ok: true,
    result: {},
    affordances: [
      { id: "aff_1", label: "Send email", kind: "approve", action_id: "act_1", primary: true },
      { id: "aff_2", label: "Discard", kind: "reject", action_id: "act_1" },
    ],
  };

  let hooks: GestureEngineHooks = {};

  class GestureProbe extends WhissleAgent {
    cb: SessionCallbacks = this.callbacks();
    constructor() {
      super({
        sessionToken: { token: "t", visual: { mode: "hybrid", camera: true, vision: true } },
        earcons: false,
        gestures: true,
        gestureAssetsUrl: "https://host.app/gestures",
      });
      // The mint normally lands in start(); the suite has no transport.
      (this as unknown as { _session: unknown })._session = {
        token: "t",
        visual: { mode: "hybrid", camera: true, vision: true },
      };
    }
    // Called from the super constructor — reads the module-level box, not fields.
    protected gestureHooks(): GestureEngineHooks {
      return hooks;
    }
  }

  it("a card on the live channel arms; a held 👍 fires fireAffordance with source gesture; the resolution disarms", async () => {
    let sample: { name?: string; score?: number } = {};
    const vision = fakeVision(() => sample);
    hooks = { loadVision: async () => vision.module, openCamera: async () => camera() };
    const p = new GestureProbe();
    const sent: Array<{ t: string; d?: unknown }> = [];
    (p as unknown as { lk: unknown }).lk = {
      sendClientMessage: (t: string, d?: unknown) => sent.push({ t, d }),
      disconnect: () => {},
    };
    (p as unknown as { _state: string })._state = "connected";
    const gestures: GestureEvent[] = [];
    p.on("gesture", (g) => gestures.push(g as GestureEvent));

    p.cb.onServerMessage(CARD_WIRE);
    await vi.advanceTimersByTimeAsync(0);
    expect(states(gestures)).toEqual(["armed"]);

    sample = { name: "Thumb_Up", score: 0.9 };
    await vi.advanceTimersByTimeAsync(600);
    sample = {};
    expect(sent).toEqual([
      {
        t: "card-action",
        d: { action_id: "act_1", affordance_id: "aff_1", disposition: "approve", source: "gesture" },
      },
    ]);
    expect(states(gestures)).toEqual(["armed", "fired"]);

    // The pipeline's confirmation comes back around — the SAME resolution event a
    // tap would produce — and takes the arming down with the card.
    p.cb.onServerMessage({
      kind: "tool",
      phase: "action",
      tool_call_id: "call-1",
      affordance_id: "aff_1",
      action_id: "act_1",
      disposition: "approve",
      status: "approved",
      source: "gesture",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(states(gestures)).toEqual(["armed", "fired", "disarmed"]);
    p.destroy();
  });

  it("never arms when the option is off — no engine exists at all", async () => {
    class PlainProbe extends WhissleAgent {
      cb: SessionCallbacks = this.callbacks();
      constructor() {
        super({ sessionToken: { token: "t", visual: { camera: true } }, earcons: false });
      }
    }
    const p = new PlainProbe();
    const gestures: unknown[] = [];
    p.on("gesture", (g) => gestures.push(g));
    p.cb.onServerMessage(CARD_WIRE);
    await vi.advanceTimersByTimeAsync(0);
    expect(gestures).toEqual([]);
    expect((p as unknown as { gestureEngine: unknown }).gestureEngine).toBeNull();
  });

  it("never arms on an audio-only session — the mint has no visual descriptor", async () => {
    let sample: { name?: string; score?: number } = {};
    const vision = fakeVision(() => sample);
    hooks = { loadVision: async () => vision.module, openCamera: async () => camera() };
    const p = new GestureProbe();
    (p as unknown as { _session: unknown })._session = { token: "t" }; // audio-only mint
    const gestures: unknown[] = [];
    p.on("gesture", (g) => gestures.push(g));
    p.cb.onServerMessage(CARD_WIRE);
    await vi.advanceTimersByTimeAsync(0);
    expect(gestures).toEqual([]);
  });
});

describe("the widget chip — the visible arming", () => {
  const { AffordanceRow, gestureChip } = WIDGET_INTERNALS;
  const affs = CARD_AFFS;

  it("armed shows the ✋ chip with all three glyphs; paused and fired read differently", () => {
    expect(gestureChip("armed", null)).toEqual({
      state: "armed",
      line: "✋ gesture armed · 👍 approve · 👎 reject",
    });
    expect(gestureChip("paused", null)).toEqual({ state: "paused", line: "✋ paused" });
    expect(gestureChip("fired", "Thumb_Up")).toEqual({ state: "fired", line: "👍 firing…" });
    expect(gestureChip("fired", "Thumb_Down")).toEqual({ state: "fired", line: "👎 firing…" });
    expect(gestureChip(null, null)).toBeNull();
  });

  it("setGesture drives the chip through the view, and only reports real changes", () => {
    const row = new AffordanceRow(affs);
    expect(row.view).not.toHaveProperty("chip"); // no chip until the engine says so
    expect(row.setGesture({ name: null, armed_state: "armed" })).toBe(true);
    let view = row.view;
    if (view.state === "resolved") throw new Error("not resolved");
    expect(view.chip).toEqual({ state: "armed", line: "✋ gesture armed · 👍 approve · 👎 reject" });
    // The same state again is not a repaint.
    expect(row.setGesture({ name: null, armed_state: "armed" })).toBe(false);
    expect(row.setGesture({ name: "Open_Palm", armed_state: "paused" })).toBe(true);
    expect(row.setGesture({ name: "Thumb_Up", armed_state: "fired" })).toBe(true);
    view = row.view;
    if (view.state === "resolved") throw new Error("not resolved");
    expect(view.chip).toEqual({ state: "fired", line: "👍 firing…" });
  });

  it("a disarm — or null — takes the chip away", () => {
    const row = new AffordanceRow(affs);
    row.setGesture({ name: null, armed_state: "armed" });
    expect(row.setGesture({ name: null, armed_state: "disarmed" })).toBe(true);
    expect(row.view).not.toHaveProperty("chip");
    row.setGesture({ name: null, armed_state: "armed" });
    expect(row.setGesture(null)).toBe(true);
    expect(row.view).not.toHaveProperty("chip");
  });

  it("resolution removes the chip with the buttons, and a late gesture can't bring it back", () => {
    const row = new AffordanceRow(affs);
    row.setGesture({ name: null, armed_state: "armed" });
    expect(row.resolve({ affordanceId: "yes", disposition: "approve", raw: {} })).toBe(true);
    expect(row.view).toEqual({ state: "resolved", line: "Approved · sent" });
    expect(row.setGesture({ name: null, armed_state: "armed" })).toBe(false);
    expect(row.view).toEqual({ state: "resolved", line: "Approved · sent" });
  });
});
