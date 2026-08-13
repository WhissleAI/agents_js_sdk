# Signal Console

Everything a Whissle voice agent knows about a conversation, while the conversation is
happening — on one screen, built to be screen-recorded.

A normal chat widget shows you two things: what you said and what it replied. The
pipeline knows far more than that, and all of it is already on the wire: the recogniser's
provisional guesses before it commits, an acoustic read of the speaker, every bet the
turn-taking machinery places and whether the bet held, which tools ran with what
arguments and what came back, and the latency of each hop. This console draws all of it,
live, and can replay a recorded session exactly.

```
npm start                       # → http://localhost:4100
```

Needs a workspace **secret** key (`wsk_…`) in `WHISSLE_API_KEY`, or a file of
`KEY=value` lines named by `WHISSLE_KEY_FILE`. The key stays in `server.mjs`; the browser
only ever receives a 15-minute session token for one agent.

```bash
WHISSLE_API_KEY=wsk_… npm start
# or
WHISSLE_KEY_FILE=~/.whissle/key.env npm start
```

By default it points at the first agent whose name matches `demo`. Override with
`WHISSLE_AGENT_ID=<uuid>` or `WHISSLE_AGENT_NAME=<regex>`.

Run from inside this repo it serves the SDK build sitting next door (`../../dist`), so it
exercises **this checkout** in a real browser rather than whatever npm last published.

---

## The panels, and what drives each one

| Panel | Driven by | What to look for |
|---|---|---|
| **What you said** | `user-interim`, `user-transcript` | The interim stack, each revision on its own line with the new words lit. When the final lands it replaces them with the words the final **corrected** marked in gold, plus interim count, how long you spoke, and how long after your last interim the recogniser committed. |
| **Acoustic read** | `user-metadata`, `signal` (`emotion` / `intent`) | Distributions, not labels. A frame counter, so "no frames arrived" and "frames arrived and carried nothing confident" never look the same. See [The NEUTRAL problem](#the-neutral-problem). |
| **The agent** | `agent-word`, `agent-partial`, `agent-transcript`, `gist`, `thinking` | The caption keeps time with the voice (one word per `agent-word`); the reply builds sentence by sentence. Images, video or audio a tool returned are rendered inline. |
| **Tool calls** | `tool-started` / `tool-progress` / `tool-finished` | Name, arguments, progress lines, result, citations, the earcon that fired, and the round-trip. A failure is coral; a tool that came back without saying whether it worked reads **ok not reported**, never "failed". |
| **Predictions** | `signal` events carrying `prediction_id` / `resolves` | Every bet with its outcome and age: endpointing (`held` / `false_cut`), barge-in (`committed` / `recovered` / `held` / `bystander`), speculative tools, shadow drafts. An unresolved bet stays **in flight** — no outcome is invented. |
| **Signal stream** | every `signal` | The pipeline narrating itself. The roster along the top is the stream's own opening frame (`stream.start`), so the console never needs a compiled-in list of types; lanes that are declared but never fill stay dim. |
| **Event stream** | *everything* | Every event with its offset, newest at the bottom. Click any row for the exact JSON off the wire. Frames the SDK has no type for render as **unmodelled** — nothing is dropped for being unrecognised. |
| **Timeline** | all of the above | Six lanes on one time axis: your speech (VAD spans, interim ticks, a triangle at each final), predictions, thinking, tool spans, the agent speaking with a triangle at its first word, and signal ticks. A barge-in is a dashed coral rule through every lane. |
| **Latency tiles** | client clock | interim → final, final → first word, final → tool call, tool round-trip, barge-in → silence. Last value and median, with `n`. |

Every latency is measured **in the browser**, at the moment the event reached the page.
It includes network and playout queue. It is not server compute time, and the console
says so in the footer rather than quietly implying otherwise.

## Can it hear me?

The strip under the toolbar answers that without being asked:

- **the source** — `MICROPHONE`, or `SYNTHETIC` with a full-width striped banner when a
  rehearsal script is running;
- **a live level meter** fed by the *same track the session is publishing* (the console
  wraps `getUserMedia` to keep a reference; it never opens a second capture, because two
  captures of one device can differ and a meter on the wrong one bounces happily while
  the session hears silence);
- **the device name**, and a picker that switches input mid-session on LiveKit;
- **the track's real state** — permission granted/denied, `muted`, `ended`;
- **a warning in plain words** when the session is up and no audio is arriving, naming
  the device and the fix. Silence never looks like a working session.

## The NEUTRAL problem

The platform writes `NEUTRAL` for two completely different situations: a genuinely calm
speaker, and the fallback when no reading was produced at all. The wire is identical, so
the SDK reports `emotion: undefined` for both — a `NEUTRAL` supports exactly one honest
statement, *nothing was detected*.

A card that renders only non-neutral emotions therefore renders nothing on a normal
conversation, which looks broken. This one renders what genuinely exists:

- the **distribution** — `probs.emotion` on a metadata frame, `top_k` on a live signal —
  because a distribution is the honest output and it is never blank;
- the **intent** read, which has no NEUTRAL ambiguity;
- an explicit **"no confident reading"** line when the top of the distribution is
  NEUTRAL, with one sentence saying why, as deliberate content rather than an empty box;
- a **frame count**, so a dark lane can be told apart from a broken panel.

It never fabricates a reading to look alive, and a top label is never presented as a
verdict — the emotion head's ceiling is about 63% on low-arousal states.

## Record, export, replay

Filming a live take is a gamble. Recording one is not.

- **Export JSON** downloads the session — every event with its millisecond offset.
- **Save for replay** writes it to `sessions/` and adds it to the picker.
- **Replay** re-drives the *same* renderer from the recording at the recorded offsets, so
  a replay is a re-shoot rather than an animation of a summary. 0.5× / 1× / 2×, pause,
  and `?replay=<file>` opens the console straight into a take.

```bash
npm start
open "http://localhost:4100/?replay=sample-rehearsal-session.json"
```

A recording made with a synthetic source carries that fact into every replay of it —
the striped banner comes back. A rehearsal take can never be mistaken for a live one.

The same stream is mirrored to the terminal and to `sessions/live-<timestamp>.log`, one
line per event at the same offsets the timeline shows, so there is a greppable text
record beside the video.

## Rehearsal input (opt-in, and loud about it)

`?rehearse=1` replaces the microphone with a MediaStream fed from wav files on a
schedule — same WebRTC path, same server-side VAD and ASR, same events. It exists for
testing without a permanent microphone grant, **not** for demos: whenever it is active a
full-width banner reads `REHEARSAL — SYNTHETIC AUDIO, NOT A LIVE MIC`, and the fact is
stamped into the recording.

```bash
npm run rehearsal      # synthesises rehearsal.json's lines into r1/r2/r3.wav (say / espeak-ng)
open "http://localhost:4100/?rehearse=1"
```

Edit the lines in `rehearsal.json`. Plain `http://localhost:4100/` is always the real
microphone.

## Filming checklist

1. `npm start`, open `http://localhost:4100/` — **no query string**.
2. Press **Start session** and click **Allow** on Chrome's microphone prompt.
3. Watch the level meter move as you talk. If it doesn't, the strip says why.
4. Speak. Panels fill left to right; the timeline scrolls a 45-second window.
5. **Stop**, then **Save for replay** — and re-shoot the take as many times as you like
   from the recording.

Full screen at 1080p, dark room. The console is dark-only by design: it films far better
than a light one, and every colour is painted explicitly so it holds on any ground.

## Layout of this directory

```
server.mjs        agent lookup, token mint, SDK + static serving, recordings, terminal log
index.html        the page — panels only, no logic
console.css       the house system (Whissle green + coral, Sora / Inter / JetBrains Mono)
console.js        one event bus, one reducer, one renderer; live and replay share all three
mic.js            the microphone tap: level, device, permission, silence diagnosis
rehearsal.js      the scripted microphone
rehearsal.json    what it says, and when
sessions/         recordings and logs
```
