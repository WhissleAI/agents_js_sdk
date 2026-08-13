// Tool earcons for an embedded agent.
//
// The problem this exists to solve: when the agent calls a tool it stops talking. On
// whissle.ai you hear a short cue and know it went to go and look something up; in an
// embed you heard nothing at all — several seconds of dead air with no explanation,
// which every caller reads as "it hung". The pipeline has been sending the cue all
// along (`services/tool_events.py` puts a `sound` on the `phase:"started"` event) and
// this SDK was throwing it away.
//
// WHY SYNTHESISED, NOT THE MP3 BANK
//
// The dashboard plays 56 mastered clips out of its own `public/sounds/tool/`. An embed
// cannot: `/sounds/tool/search_0.mp3` on a customer's origin is a 404, and the gateway
// does not serve the bank (verified — every candidate path 404s). The three ways out
// are (a) bundle ~230 KB of audio as base64 into a widget SDK, (b) fetch it from a CDN
// on first tool call, or (c) synthesise it. (a) triples the bundle for a feature many
// pages never hit; (b) means the cue arrives AFTER a network round-trip, which is an
// echo, not a cue — the exact failure `tool-sounds.ts` was written to avoid. So (c):
// a handful of oscillators, zero bytes, zero requests, and the first cue is as fast as
// the thousandth.
//
// The trade is honest and worth naming: these are not byte-identical to the dashboard's
// clips. They are the same LANGUAGE — same categories, same meanings, same
// name→category→variant mapping, so the same tool always makes the same sound and
// different kinds of work sound different. If you want the exact bank, host it and pass
// `earcons: { bankUrl: "/sounds/tool" }`; this module will fetch and prefer it.
//
// The backend sends a NAME (`"search_3"`), never audio and never a URL. That name is
// `<category>_<variant>` and it is resolved server-side by a total function over every
// possible tool name, including tools invented mid-call. Keeping the name as the
// contract is what lets the two sides ship independently.

/** `<category>_<variant>`, the only shape the backend emits. Anything else came from
 *  somewhere we should not be turning into sound. */
const CLIP_NAME = /^([a-z]+)_(\d+)$/;

/**
 * Peak amplitude of a cue, linear. The mp3 bank is mastered to a -20 dBFS ceiling so it
 * sits well under speech; 0.1 is that same ceiling, applied here instead of at
 * mastering time. Loud enough to hear over a talking agent on a phone speaker, quiet
 * enough that a tool-heavy turn is not a xylophone solo.
 */
const PEAK = 0.1;

/** The families the backend can name, and what each is meant to convey. Kept in step
 *  with `sounds/tool/MANIFEST.json` — the strings are the contract. */
export type EarconCategory =
  | "search"
  | "create"
  | "update"
  | "send"
  | "handoff"
  | "media"
  | "capture"
  | "generic"
  | "error";

/** One partial in a cue: a pitch sweep with its own envelope, mixed with the others. */
interface Tone {
  /** Start frequency, Hz. */
  from: number;
  /** End frequency, Hz. Equal to `from` for a steady tone. */
  to?: number;
  /** Seconds after cue start. */
  at: number;
  /** Seconds. Cues are short by design — the bank caps at 350 ms. */
  dur: number;
  type?: OscillatorType;
  /** Relative level, 0..1, before the global PEAK trim. */
  level?: number;
}

/**
 * The voice of each category, written to mean what the manifest says it means.
 *
 * Intervals do the semantic work, because interval is the part of a cue a listener
 * actually decodes without being taught:
 *
 *   search   two rising plucks, a fourth apart — an open question, unresolved
 *   create   a rising major third into a fifth — the shape of a confirmation
 *   update   one flat mid tone, no movement — something changed, nothing new
 *   send     a fast upward sweep — departure
 *   handoff  a wide falling leap — the conversation going elsewhere
 *   media    two bright close tones — a shimmer, something appearing
 *   capture  one short dry blip — a keypress, input taken
 *   generic  one soft neutral tone — work is happening, that is all we know
 *   error    a falling minor second, low and dull — the only cue on a RESULT, and the
 *            one that has to be unmistakable, because the agent is about to be vague
 */
const VOICES: Record<EarconCategory, Tone[]> = {
  search: [
    { from: 880, at: 0, dur: 0.09, type: "triangle" },
    { from: 1174.7, at: 0.075, dur: 0.11, type: "triangle", level: 0.85 },
  ],
  create: [
    { from: 659.3, at: 0, dur: 0.1, type: "sine" },
    { from: 830.6, at: 0.07, dur: 0.1, type: "sine", level: 0.9 },
    { from: 987.8, at: 0.14, dur: 0.16, type: "sine", level: 0.8 },
  ],
  update: [
    { from: 523.3, at: 0, dur: 0.13, type: "square", level: 0.35 },
    { from: 523.3, at: 0, dur: 0.13, type: "sine", level: 0.7 },
  ],
  send: [
    { from: 420, to: 1400, at: 0, dur: 0.18, type: "sawtooth", level: 0.45 },
    { from: 840, to: 2800, at: 0.01, dur: 0.16, type: "sine", level: 0.35 },
  ],
  handoff: [
    { from: 1046.5, at: 0, dur: 0.09, type: "triangle" },
    { from: 523.3, at: 0.08, dur: 0.16, type: "triangle", level: 0.9 },
  ],
  media: [
    { from: 1568, at: 0, dur: 0.07, type: "sine", level: 0.8 },
    { from: 1760, at: 0.05, dur: 0.09, type: "sine", level: 0.7 },
    { from: 2093, at: 0.1, dur: 0.12, type: "sine", level: 0.5 },
  ],
  capture: [{ from: 1318.5, at: 0, dur: 0.055, type: "square", level: 0.5 }],
  generic: [
    { from: 698.5, at: 0, dur: 0.12, type: "sine" },
    { from: 1397, at: 0, dur: 0.12, type: "sine", level: 0.25 },
  ],
  error: [
    { from: 311.1, at: 0, dur: 0.12, type: "triangle" },
    { from: 293.7, at: 0.1, dur: 0.2, type: "triangle", level: 0.9 },
  ],
};

/**
 * Variant → semitone offset.
 *
 * The backend hashes a tool name onto one of ~6 variants per category so two custom
 * tools in the same family stay distinguishable. Transposing by these keeps that
 * distinction audible while staying inside one family — every offset is a consonant
 * interval against 0, so no variant sounds like a mistake. Deterministic and total:
 * an unknown variant index wraps rather than falling silent.
 */
const VARIANT_SEMITONES = [0, 3, -2, 5, -4, 7, 2, -5, 4, -7, 9, -9];

export interface EarconOptions {
  /**
   * Play tool cues at all. Default `true`.
   *
   * Off is a legitimate choice for a page that already has its own audio language —
   * but note that off means a caller hears NOTHING while a tool runs, which is the
   * state this feature exists to fix. Prefer `volume` if it is only too loud.
   */
  enabled?: boolean;
  /** Trim, 0..2, applied on top of the built-in -20 dBFS ceiling. Default `1`. */
  volume?: number;
  /**
   * Serve the real mastered clips from here instead of synthesising, e.g.
   * `"/sounds/tool"` if you have copied the bank into your own `public/`. Clips are
   * fetched as `<bankUrl>/<name>.mp3` and decoded once. A clip that fails to load
   * falls back to the synthesised cue rather than to silence, so a partial bank or a
   * version skew is never audible as a hole.
   */
  bankUrl?: string;
}

/**
 * Turns the clip names the pipeline sends into sound.
 *
 * One instance per session, primed from the click that starts the call — browsers
 * leave an AudioContext suspended without a gesture, and a suspended context makes
 * every cue a silent no-op with nothing in the console to explain it.
 */
export class EarconPlayer {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer | null>();
  private inflight = new Map<string, Promise<AudioBuffer | null>>();
  private muted = false;
  private readonly enabled: boolean;
  private readonly volume: number;
  private readonly bankUrl: string | null;

  constructor(opts: EarconOptions = {}) {
    this.enabled = opts.enabled !== false;
    this.volume = typeof opts.volume === "number" ? Math.max(0, Math.min(2, opts.volume)) : 1;
    this.bankUrl = opts.bankUrl ? opts.bankUrl.replace(/\/+$/, "") : null;
  }

  /** Start the audio context. Call from the user gesture that starts the session. */
  prime(): void {
    if (!this.enabled) return;
    const ctx = this.context();
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
  }

  /** Silence cues without tearing anything down (a user's mute toggle). */
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /**
   * Play the clip the backend named. Safe with anything — an unknown name, a category
   * this build has never heard of, `undefined`. A cue is a nicety; nothing here may
   * throw into a live conversation.
   */
  play(name: string | null | undefined): void {
    if (!this.enabled || this.muted || !name) return;
    const parsed = CLIP_NAME.exec(name);
    if (!parsed) return;
    const ctx = this.context();
    if (!ctx || ctx.state !== "running") return;
    if (this.bankUrl) {
      // Prefer the real clip, but never WAIT for it: if it isn't decoded yet the
      // synthesised cue plays now and the download warms the cache for next time.
      const cached = this.buffers.get(name);
      if (cached) {
        this.playBuffer(cached);
        return;
      }
      void this.loadClip(name);
    }
    this.synthesise(parsed[1] as EarconCategory, Number(parsed[2]));
  }

  /** Warm the context and, with a bank configured, the clips a call fires most. */
  preload(names: readonly string[]): void {
    if (!this.enabled || !this.bankUrl) return;
    for (const n of names) void this.loadClip(n);
  }

  /** Release the context at the end of the session. */
  release(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.out = null;
    this.buffers.clear();
    this.inflight.clear();
    if (ctx) void ctx.close().catch(() => {});
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === "undefined") return null;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      const ctx = new Ctor();
      const out = ctx.createGain();
      out.gain.value = this.volume;
      out.connect(ctx.destination);
      this.ctx = ctx;
      this.out = out;
      return ctx;
    } catch {
      return null;
    }
  }

  private async loadClip(name: string): Promise<AudioBuffer | null> {
    const done = this.buffers.get(name);
    if (done !== undefined) return done;
    const pending = this.inflight.get(name);
    if (pending) return pending;
    const ctx = this.context();
    if (!ctx) return null;
    const job = (async () => {
      try {
        const res = await fetch(`${this.bankUrl}/${name}.mp3`);
        if (!res.ok) throw new Error(String(res.status));
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        this.buffers.set(name, buf);
        return buf;
      } catch {
        // Remember the miss so we stop re-fetching it, and fall through to the
        // synthesised cue. A hole in someone's bank must not become a hole in the
        // conversation.
        this.buffers.set(name, null);
        return null;
      } finally {
        this.inflight.delete(name);
      }
    })();
    this.inflight.set(name, job);
    return job;
  }

  private playBuffer(buf: AudioBuffer): void {
    const ctx = this.ctx;
    if (!ctx || !this.out) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.out);
      src.start();
    } catch {
      /* a cue is never worth an exception */
    }
  }

  /**
   * Build the cue out of oscillators, right now.
   *
   * Each partial gets a short attack and an exponential decay — the envelope is what
   * makes it read as a chime rather than a beep, and a hard start/stop on an
   * oscillator is an audible click on every cue.
   */
  private synthesise(category: EarconCategory, variant: number): void {
    const ctx = this.ctx;
    const out = this.out;
    if (!ctx || !out) return;
    const voice = VOICES[category] ?? VOICES.generic;
    const semis = VARIANT_SEMITONES[Math.abs(variant) % VARIANT_SEMITONES.length];
    const shift = Math.pow(2, semis / 12);
    const t0 = ctx.currentTime;
    try {
      for (const tone of voice) {
        const osc = ctx.createOscillator();
        osc.type = tone.type ?? "sine";
        const start = t0 + tone.at;
        const end = start + tone.dur;
        osc.frequency.setValueAtTime(tone.from * shift, start);
        if (tone.to && tone.to !== tone.from) {
          osc.frequency.exponentialRampToValueAtTime(tone.to * shift, end);
        }
        const env = ctx.createGain();
        const peak = PEAK * (tone.level ?? 1);
        // 8 ms attack: long enough to kill the click, short enough to stay percussive.
        env.gain.setValueAtTime(0.0001, start);
        env.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.008, tone.dur / 3));
        env.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(env);
        env.connect(out);
        osc.start(start);
        osc.stop(end + 0.02);
        // Free the nodes rather than leaving one per cue attached for the life of the
        // call. A tool-heavy hour is thousands of them.
        osc.onended = () => {
          try {
            osc.disconnect();
            env.disconnect();
          } catch {
            /* already gone */
          }
        };
      }
    } catch {
      /* a cue is never worth an exception */
    }
  }
}

/** Exported for tests and for anyone who wants the mapping without a browser. */
export const EARCON_INTERNALS = { CLIP_NAME, VOICES, VARIANT_SEMITONES, PEAK };
