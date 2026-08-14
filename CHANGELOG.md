# Changelog

All notable changes to `@whissle/agents`. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); while the major
version is `0`, a minor bump may carry a breaking change and will say so here.

## 0.5.0 — 2026-08-13

An embedded agent got a strictly worse experience than the one on whissle.ai, and
could not tell you why. Three of the reasons were silent by construction. This
release closes that gap. Everything here is additive — existing one-argument
`error` handlers and hand-rolled `server-message` parsing are untouched.

### Added

- **Tool events** — `tool-started`, `tool-progress` and `tool-finished`, with
  `ok`, `result`, `evidence` (citations) and `sound`. Correlate by `id`
  (`tool_call_id`), never by `name`: two calls to the same tool can be in flight
  at once. `ok` is `undefined`, not `false`, when the tool didn't say.
- **`thinking`** — one boolean for "it's working, that's why it's quiet",
  collapsing however many tools are in flight into a single edge each way. When
  an agent calls a tool it stops talking, and without this an embed went silent
  for seconds with nothing to explain it, which every caller reads as a hang.
- **Tool earcons, on by default.** The platform picks a sound per tool —
  deterministically, including for tools invented at runtime — and this SDK plays
  it. **The default is now the real mastered clip bank at
  `https://www.whissle.ai/sounds/tool`** (public, `access-control-allow-origin:
  *`), so an embed sounds like the dashboard with no hosting and no
  configuration. Browser synthesis remains the fallback for the three cases a
  fetch cannot cover: a clip that isn't warm yet, an offline or blocked network,
  and a CSP that forbids `connect-src` to whissle.ai. A cue **never waits on the
  network**. `bankUrl: "/your/copy"` serves it from your origin; `bankUrl: null`
  opts out of the network entirely and uses the oscillators alone.
- **`agent-partial`** (the reply so far, re-emitted as each sentence lands) and
  **`agent-word`** (one word at the moment the voice says it — the only
  granularity fine enough for a caption that keeps time with the audio).
- **`listening-started` / `listening-stopped`** — the server's VAD edges, which
  is what makes barge-in observable: a `listening-started` between
  `speaking-started` and `speaking-stopped` *is* one.
- **`signal`** — the pipeline's live signal stream (barge-in, endpointing,
  language switches, entities, flow state). Versioned and additive-only.
- **`user-metadata`** — the live acoustic read of the caller. See the NEUTRAL
  note under *Changed*.
- **`gist`** — a one-line caption of the reply being spoken right now.
- **`demo-limit`** — this session hit the anonymous demo cap and is ending.
- **`sendText()`** — the same agent, typed. With no call up it runs an HTTP turn
  (the visitor who denies the microphone still gets the agent); during a live
  call it injects into the *same* conversation and is answered out loud.
  Resolves `TextTurn | null` — `null` means the reply is coming as speech.
  Images can ride along on the HTTP path.
- **Thread resume** — persist `agent.textThread`, hand it to
  `resumeTextThread(id)`. Use `threadId`, **not** `conversationId`: the embed
  chat endpoint keys a thread on `session_id` and its request model drops every
  other field, so handing back the wrong one silently starts the agent cold.
- **Coded errors** — `error` now carries a `WhissleErrorDetail` as a *second*
  argument, so "top up your wallet" and "this domain isn't allowlisted" stop
  looking identical from a page.
- **Microphone preflight**, on by default. `start()` checks the mic before
  connecting, because `enableMic: true` runs its own `getUserMedia` and does not
  reliably throw — the session came up, the server received zero audio frames,
  and the visitor talked to a widget that ignored them for the whole call. Only a
  `blocking` problem stops `start()`; anything the check is unsure about is a
  `warning` and connects anyway. Plus `checkMicrophone()`, `listMicrophones()`
  and `setMicrophone()`.
- **`destroy()`** — like `stop()`, but also drops event handlers. Call it on
  component unmount so a long-lived page doesn't accumulate handlers and
  everything they close over.
- **Transport fallbacks** — `transport: "auto"` follows the mint and, on failure,
  takes **exactly one hop** to a fallback the same mint named. No retry loop:
  that is a good way to bill someone twice for a call they never had.
- A second worked example, `examples/observability-console` — everything the
  pipeline knows while the conversation is happening, on one screen, with
  deterministic replay.

### Changed

- **`emotion` is `undefined` whenever the platform said `NEUTRAL`**, deliberately.
  The platform writes `NEUTRAL` both when the head genuinely read a calm speaker
  and as the *fallback* when no reading was produced at all — no metadata sidecar
  on that deployment, an untrusted language, a classifier call that failed — and
  the wire is identical in both cases. Surfacing it as a reading would let a UI
  draw "the caller is calm" out of "we don't know". The full distribution stays
  on `raw.probs.emotion`. Intent is *not* suppressed. Please do not "fix" this.
- `error` is emitted with a code for the out-of-credit notice and the demo cap,
  which previously arrived unlabelled with their fields at the top level and fell
  into the RTVI `error` case — so someone whose wallet emptied mid-sentence was
  told "Connection error."
- `engines.node` is now `>=20`.

### Fixed

- **`agent.send()` never worked in production.** On LiveKit — the transport the
  live mint actually returns — it published `{label, type, data}`, and the bot
  reads `{type:"client-message", data:{t,d}}` and returns early on anything else.
  Every control message reached the room and none reached the agent. It now works
  on both transports.
- **The greeting raced the join.** The bot holds its opening line until the
  browser sends `playback-ready`; the dashboard sent it and an embed never did, so
  every session fell back to a 2.5 s timer that is both slower and still a guess.

### Bundle size

+7.0 KB gzip on your app's entry chunk for all of the above. The avatar (Simli)
and LiveKit chunks are byte-identical and still loaded on demand.

### Testing

245 cases across 17 files (up from 74), Vitest, no browser needed. New:
`npm run check:readme` compiles every TypeScript snippet in the README against
`src/` under `--strict`.

Note that Vitest runs in Node, so the WebRTC handshake, the LiveKit room join,
the Simli render loop, real autoplay policy, real microphone devices and how the
cues actually sound remain **unverified by the suite** — see *What isn't tested*
in the README, and the two examples that exist to make checking them a
one-command job.

## 0.4.2 — 2026-08-12

- The agent was too quiet on phones; boost the playout graph on mobile.
  `window.__whissleAudioBoost()` reports the live measurement from the device.

## 0.4.1 — 2026-08-12

- Grow `examples/interview-platform` into a small but complete app.

## 0.4.0 — 2026-08-11

- `agent.send()` and the `server-message` event: let the app and the agent talk
  about their own business over the session data channel.

## 0.3.1 — 2026-08-11

- Send PCM before `start()` resolves, so the greeting moves the avatar's mouth.

## 0.3.0 — 2026-08-11

- `user-interim` (provisional speech while the caller is still talking) and
  `mic-lost` / `mic-restored` (the microphone dying mid-session). Both were
  previously silent.

## 0.2.1 — 2026-08-11

- Smooth the PCM hand-off to Simli so a burst of audio doesn't stutter the face;
  say each reply once.

## 0.2.0 — 2026-08-11

- Embed a talking avatar in three words, and let the session mint pick the
  transport. Bundle the SmallWebRTC transport with its lodash specifier rewritten
  so `import("@whissle/agents")` no longer throws under raw Node ESM / SSR.

## 0.1.0 — 2026-08-10

Initial release: embed a Whissle voice agent, as a ready-made widget or headless.
