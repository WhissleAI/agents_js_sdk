// Gesture input for card affordances — P2 of the affordance contract.
//
// EXACTLY three gestures, and no free-form vocabulary:
//
//   👍 Thumb_Up    → fire the focused card's primary approve
//   👎 Thumb_Down  → fire its reject
//   ✋ Open_Palm   → hold: pause gesture firing for 30 s. NEVER a disposition.
//
// A gesture is the highest-stakes input modality this SDK has — it can approve a
// side effect without a tap or a word — so everything here is built to make a
// firing deliberate and an accident structurally impossible:
//
//   * **Opt-in.** Nothing runs unless the integrator passed `gestures: true`.
//   * **Gated on the mint.** The session's `visual` descriptor must say a camera
//     reaches something (`visual.camera`). An audio-only session never arms.
//   * **Gated on a live camera.** The engine opens its own low-res camera stream
//     and arms only once a video track is actually live; the track dying disarms.
//   * **Gated on focus.** Armed only while EXACTLY ONE card holds unresolved
//     affordances — the newest card is the focused one, and requiring the count
//     to be one means "which card did that thumbs-up mean?" can never arise.
//   * **Confidence + dwell.** A gesture fires on two consecutive samples at
//     ≥ 0.75 confidence, sampled every ~300 ms — a ~600 ms deliberate hold, not a
//     hand passing the lens. Sampling skips while the tab is hidden and stops
//     entirely whenever disarmed.
//   * **Ambiguity never fires.** A thumbs-up against a card with no single
//     approve target, or a thumbs-down against several rejects, does nothing.
//
// **On-device only.** Recognition runs in the page via MediaPipe's gesture
// recognizer: no frame, landmark, or gesture datum ever leaves the browser. The
// camera stream is never attached to the session's transport — the only thing
// that goes anywhere is the same `card-action` firing a tap would have sent,
// attributed `source: "gesture"` in the actions queue.
//
// **The dependency is optional.** `@mediapipe/tasks-vision` is an optional peer
// dependency, loaded with a lazy dynamic `import()` — a bundler resolves it when
// the host app installed it, and when the import fails (package absent, host CSP
// blocking the loader) the engine warns once on the console and no-ops. Gestures
// must never break a session. The model + wasm are loaded from the host app's
// OWN `gestureAssetsUrl` — there is deliberately no third-party CDN default, so
// an unset URL also means gestures stay off, with a warn.

/// <reference path="./mediapipe-tasks-vision.d.ts" />
// ^ the ambient declaration for the optional peer, referenced explicitly so any
//   compilation that starts from the entry point (check:readme builds one) sees
//   it without depending on tsconfig's `include` sweeping the directory.

import type { Affordance, AffordanceResolution, ToolFinished } from "./tool-events";
import type { FireAffordanceOptions } from "./WhissleAgent";

/** The whole vocabulary. Closed on purpose — see the module comment. */
const GESTURES = ["Thumb_Up", "Thumb_Down", "Open_Palm"] as const;

export type GestureName = (typeof GESTURES)[number];

/** Where the gesture engine is, as the `gesture` event reports it. */
export type GestureArmedState = "armed" | "paused" | "fired" | "disarmed";

/**
 * Payload of the `gesture` event — enough for a host app to render its own
 * arming indicator instead of (or as well as) the widget's chip.
 *
 * `armed_state` is the edge: `"armed"` (a gesture could fire the focused card),
 * `"paused"` (an open palm held firing for 30 s), `"fired"` (a gesture just
 * fired — `name` says which), `"disarmed"` (no longer watching). `name` is set
 * on the transitions a specific gesture caused and `null` on the ones none did.
 */
export interface GestureEvent {
  name: GestureName | null;
  armed_state: GestureArmedState;
}

/** A sample must clear this to count toward a firing. */
const CONFIDENCE = 0.75;
/** ~600 ms dwell: two consecutive qualifying samples at this cadence. */
const SAMPLE_INTERVAL_MS = 300;
/** How long an open palm holds firing. */
const PAUSE_MS = 30_000;

/**
 * What a thumbs-up means on this card — or `null`, which means DON'T fire.
 *
 * The contract's rule: the `primary` affordance is the gesture-default target,
 * and it is an approve or a choice. A card without one falls back to a SINGLE
 * unmarked approve/choice — the card where "yes" is unambiguous without the
 * marker. Several candidates and no primary is ambiguity, and an ambiguous
 * gesture must do nothing rather than guess: a tap can see the labels, a
 * thumbs-up cannot.
 */
export function approveTarget(affordances: Affordance[]): Affordance | null {
  const candidates = affordances.filter((a) => a.kind === "approve" || a.kind === "choice");
  const primary = candidates.filter((a) => a.primary === true);
  if (primary.length === 1) return primary[0];
  if (primary.length === 0 && candidates.length === 1) return candidates[0];
  return null;
}

/** What a thumbs-down means — the card's single reject, else nothing. */
export function rejectTarget(affordances: Affordance[]): Affordance | null {
  const rejects = affordances.filter((a) => a.kind === "reject");
  return rejects.length === 1 ? rejects[0] : null;
}

/**
 * The dwell gate: a gesture fires on the SECOND consecutive qualifying sample.
 *
 * Anything else — a name outside the three, a score under the bar, an empty
 * frame, a different gesture — resets the run. At the ~300 ms cadence two
 * consecutive samples is a ~600 ms deliberate hold.
 */
export class GestureDwell {
  private pending: GestureName | null = null;

  feed(name: string | undefined, score: number | undefined): GestureName | null {
    const g =
      name && (GESTURES as readonly string[]).includes(name) && (score ?? 0) >= CONFIDENCE
        ? (name as GestureName)
        : null;
    if (!g) {
      this.pending = null;
      return null;
    }
    if (this.pending === g) {
      // Fired. Reset, so a held gesture needs another full dwell to fire again —
      // not that it gets the chance: a fired engine ignores thumbs until the card
      // resolves, and a pausing palm only ever extends the pause.
      this.pending = null;
      return g;
    }
    this.pending = g;
    return null;
  }

  reset(): void {
    this.pending = null;
  }
}

/** The slice of `@mediapipe/tasks-vision` this engine touches, typed by hand —
 *  the package is an optional peer and may not be installed where this compiles. */
export interface VisionModule {
  FilesetResolver: { forVisionTasks(path: string): Promise<unknown> };
  GestureRecognizer: {
    createFromOptions(fileset: unknown, options: unknown): Promise<GestureRecognizerLike>;
  };
}

export interface GestureRecognizerLike {
  recognizeForVideo(
    video: unknown,
    timestampMs: number,
  ): { gestures?: Array<Array<{ categoryName?: string; score?: number }>> };
  close?(): void;
}

/** The camera, reduced to what the engine needs — a stubbable sliver of
 *  `MediaStream`, because the suite runs in Node. */
export interface CameraTrackLike {
  readyState?: string;
  stop(): void;
}
export interface CameraLike {
  getVideoTracks(): CameraTrackLike[];
  getTracks(): CameraTrackLike[];
}

/**
 * The engine's I/O seams. `WhissleAgent` fills them with the real thing; the
 * suite (which runs in Node, with no camera and no wasm) injects fakes.
 */
export interface GestureEngineHooks {
  /** Import the recognizer module. Default: `import("@mediapipe/tasks-vision")`. */
  loadVision?: () => Promise<VisionModule | null>;
  /** Open the camera. Default: a low-res, low-fps `getUserMedia({ video })`. */
  openCamera?: () => Promise<CameraLike | null>;
}

export interface GestureEngineOptions extends GestureEngineHooks {
  /** The host app's own base URL for `/wasm` and `/gesture_recognizer.task`.
   *  Unset = gestures stay off, with one console.warn. No CDN default. */
  assetsUrl?: string;
  /** The mint's `visual` descriptor, read at every gate evaluation — an
   *  audio-only session (no camera in the descriptor) never arms. */
  visual: () => { camera?: boolean } | undefined;
  /** The one door out: the same `fireAffordance` a tap uses, `source: "gesture"`. */
  fire: (opts: FireAffordanceOptions) => Promise<unknown>;
  /** Where `gesture` events go. */
  emit: (event: GestureEvent) => void;
}

/** The default import, isolated so the literal specifier appears exactly once.
 *  Bundlers resolve it when the optional peer is installed; when it isn't (or a
 *  CSP blocks the chunk) the rejection is caught and becomes the single warn. */
function importVision(): Promise<VisionModule | null> {
  return import("@mediapipe/tasks-vision").then(
    (m) => m as unknown as VisionModule,
    () => null,
  );
}

/** The default camera: the smallest stream that can carry a hand. */
async function openDefaultCamera(): Promise<CameraLike | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 10 } },
    });
  } catch {
    return null;
  }
}

/**
 * The engine. `WhissleAgent` owns one when (and only when) `gestures: true`,
 * feeds it every card and every resolution — both doors — and hands it the mint's
 * `visual` descriptor to read. Everything else is internal: it arms and disarms
 * itself as the gates open and close, and its only outputs are `gesture` events
 * and `fireAffordance` calls.
 */
export class GestureEngine {
  /** Unresolved cards' affordances, oldest first. Armed only at length 1. */
  private cards: Affordance[][] = [];
  private phase: "off" | "armed" | "paused" | "fired" = "off";
  /** An arm() is in flight — don't start a second. */
  private starting = false;
  /** The import failed for good. One warn, then permanent no-op. */
  private broken = false;
  private disposed = false;
  private recognizer: GestureRecognizerLike | null = null;
  private camera: CameraLike | null = null;
  private track: CameraTrackLike | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pauseUntil = 0;
  private dwell = new GestureDwell();
  private warned = new Set<string>();
  private readonly assetsUrl: string | undefined;

  constructor(private readonly opts: GestureEngineOptions) {
    this.assetsUrl = opts.assetsUrl?.replace(/\/+$/, "") || undefined;
  }

  /** A tool-result card arrived (either door). Render-only cards don't count. */
  cardFinished(card: ToolFinished): void {
    if (!card.affordances?.length) return;
    this.cards.push(card.affordances);
    this.evaluate();
  }

  /** A card resolved (any surface, any modality). Removed from the ledger, and
   *  with it goes the arming — resolution is what takes the chip away. */
  cardResolved(r: AffordanceResolution): void {
    const i = this.cards.findIndex((affs) =>
      affs.some((a) => a.id === r.affordanceId || a.actionId === r.actionId),
    );
    if (i >= 0) this.cards.splice(i, 1);
    this.evaluate();
  }

  /** Every gate, re-checked. Called on card edges and by the agent on connect. */
  evaluate(): void {
    if (this.disposed) return;
    const want = this.wanted();
    if (want && this.phase === "off" && !this.starting) {
      if (!this.assetsUrl) {
        this.warn(
          "assets",
          "[whissle] gestures: no `gestureAssetsUrl` configured, so gestures stay off. " +
            "Host MediaPipe's /wasm directory and gesture_recognizer.task yourself and " +
            "pass their base URL — there is deliberately no third-party CDN default.",
        );
        return;
      }
      void this.arm();
    } else if (!want && this.phase !== "off") {
      this.disarm();
    }
  }

  /** Stop everything for good. Called from `WhissleAgent.destroy()`. */
  dispose(): void {
    this.disarm();
    this.disposed = true;
    try {
      this.recognizer?.close?.();
    } catch {
      /* already gone */
    }
    this.recognizer = null;
  }

  /** Option, mint, and focus gates — the async ones (import, camera) live in
   *  `arm()`, which re-checks this after every await. */
  private wanted(): boolean {
    return (
      !this.broken &&
      !this.disposed &&
      this.cards.length === 1 &&
      this.opts.visual()?.camera === true
    );
  }

  private async arm(): Promise<void> {
    this.starting = true;
    try {
      if (!this.recognizer) {
        this.recognizer = await this.load();
        if (!this.recognizer) {
          this.broken = true;
          return;
        }
      }
      if (!this.wanted()) return;
      const camera = await (this.opts.openCamera ?? openDefaultCamera)();
      const track = camera?.getVideoTracks()[0] ?? null;
      if (!camera || !track || (track.readyState && track.readyState !== "live")) {
        // No live camera track — the third gate. Denied, missing, or dead on
        // arrival: gestures stay off, the session is untouched.
        if (camera) for (const t of camera.getTracks()) t.stop();
        this.warn(
          "camera",
          "[whissle] gestures: couldn't open a camera, so gestures stay off for now.",
        );
        return;
      }
      if (!this.wanted()) {
        for (const t of camera.getTracks()) t.stop();
        return;
      }
      this.camera = camera;
      this.track = track;
      this.attachVideo();
      this.phase = "armed";
      this.dwell.reset();
      this.opts.emit({ name: null, armed_state: "armed" });
      this.timer = setInterval(() => this.tick(), SAMPLE_INTERVAL_MS);
    } finally {
      this.starting = false;
      // The gates may have closed while an await was pending.
      if (this.phase !== "off" && !this.wanted()) this.disarm();
    }
  }

  /** Import the module and build the recognizer off the host's own assets.
   *  Any failure → one warn, `null`, and the engine never tries again. */
  private async load(): Promise<GestureRecognizerLike | null> {
    let mod: VisionModule | null = null;
    try {
      mod = await (this.opts.loadVision ?? importVision)();
    } catch {
      mod = null;
    }
    if (!mod?.FilesetResolver?.forVisionTasks || !mod?.GestureRecognizer?.createFromOptions) {
      this.warn(
        "import",
        "[whissle] gestures: @mediapipe/tasks-vision didn't load (not installed, or its " +
          "chunk was blocked — a CSP, an offline page), so gestures are off. The optional " +
          "peer dependency must be installed for a bundler to resolve it.",
      );
      return null;
    }
    try {
      const fileset = await mod.FilesetResolver.forVisionTasks(`${this.assetsUrl}/wasm`);
      return await mod.GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${this.assetsUrl}/gesture_recognizer.task` },
        runningMode: "VIDEO",
        numHands: 1,
      });
    } catch {
      this.warn(
        "import",
        `[whissle] gestures: the recognizer assets didn't load from "${this.assetsUrl}" ` +
          "(expected /wasm and /gesture_recognizer.task there), so gestures are off.",
      );
      return null;
    }
  }

  /** One sample every ~300 ms while armed. The dwell gate does the judging. */
  private tick(): void {
    if (this.phase === "off") return;
    if (this.track?.readyState === "ended") {
      // The camera died mid-session (unplugged, revoked, grabbed). Disarm — the
      // "camera track is live" gate holds for the whole arming, not just its start.
      this.disarm();
      return;
    }
    // A hidden tab is a visitor who isn't looking at the card. A gesture made at a
    // page you cannot see must not approve anything on it.
    if (typeof document !== "undefined" && document.hidden) {
      this.dwell.reset();
      return;
    }
    if (this.phase === "paused" && Date.now() >= this.pauseUntil) {
      this.phase = "armed";
      this.dwell.reset();
      this.opts.emit({ name: null, armed_state: "armed" });
    }
    const { name, score } = this.read();
    const hit = this.dwell.feed(name, score);
    if (!hit) return;

    if (hit === "Open_Palm") {
      // The hold. Never a disposition — its whole meaning is "not now". A palm
      // held up keeps extending the pause; only silence lets it lapse.
      this.pauseUntil = Date.now() + PAUSE_MS;
      if (this.phase === "armed") {
        this.phase = "paused";
        this.opts.emit({ name: "Open_Palm", armed_state: "paused" });
      }
      return;
    }
    if (this.phase !== "armed") return; // paused or fired: thumbs do nothing

    const affordances = this.cards[0];
    if (!affordances) return;
    const target = hit === "Thumb_Up" ? approveTarget(affordances) : rejectTarget(affordances);
    if (!target) return; // ambiguous → no fire, stays armed

    this.phase = "fired";
    this.opts.emit({ name: hit, armed_state: "fired" });
    this.opts
      .fire({
        actionId: target.actionId,
        affordanceId: target.id,
        disposition: hit === "Thumb_Up" ? "approve" : "reject",
        source: "gesture",
      })
      .catch(() => {
        // The firing never landed (network, channel timeout). Re-arm — unless a
        // resolution arrived meanwhile and already disarmed us via the ledger.
        if (this.phase === "fired") {
          this.phase = "armed";
          this.dwell.reset();
          this.opts.emit({ name: null, armed_state: "armed" });
        }
      });
  }

  /** The top gesture on the current frame, read defensively. */
  private read(): { name?: string; score?: number } {
    try {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const result = this.recognizer!.recognizeForVideo(this.video ?? ({} as never), now);
      const top = result?.gestures?.[0]?.[0];
      return { name: top?.categoryName, score: top?.score };
    } catch {
      return {};
    }
  }

  /** Sampling stops, the camera closes, and — if we ever said "armed" — the
   *  disarm is announced so indicators come down. */
  private disarm(): void {
    const announced = this.phase !== "off";
    this.phase = "off";
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.camera) {
      for (const t of this.camera.getTracks()) {
        try {
          t.stop();
        } catch {
          /* already stopped */
        }
      }
    }
    this.camera = null;
    this.track = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
    this.dwell.reset();
    if (announced) this.opts.emit({ name: null, armed_state: "disarmed" });
  }

  /** A hidden, muted `<video>` for the recognizer to read frames from. Nothing
   *  is rendered and nothing is transmitted — the stream exists for sampling. */
  private attachVideo(): void {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return;
    try {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.style.display = "none";
      v.srcObject = this.camera as unknown as MediaStream;
      document.body?.appendChild(v);
      v.play?.()?.catch(() => {});
      this.video = v;
    } catch {
      this.video = null;
    }
  }

  private warn(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }
}
