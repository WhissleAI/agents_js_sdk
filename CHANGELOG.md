# Changelog

All notable changes to `@whissle/agents`. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); while the major
version is `0`, a minor bump may carry a breaking change and will say so here.

## 0.9.0 — 2026-09-20

Whissle's own metadata speech-to-text, driven from a browser — and a round of
corrections where this SDK's documentation disagreed with the platform.
Everything is additive; no 0.8.x call changes behaviour.

### Added

- **`transcribe(options)`** → `TranscriptionStream` — stream the microphone to
  Whissle's ASR engine and get transcripts back with the metadata heads
  attached (emotion, intent, entity, age, gender, dialect, behavior, eval,
  role). No agent, no room, no LiveKit. Events: `open`, `transcript`
  (`Transcript`), `message` (every engine event, untouched), `warning`,
  `error`, `close`. Controls: `mute()`, `unmute()`, `flush()`, `stop()`.
  Options: `url` (string or function), `language`, `metadataTags`, `hotwords`,
  `hotwordWeight`, `deviceId`, and `config` as an escape hatch for engine flags
  this build has never heard of.

  **You supply the URL, and it must not be Whissle's.** A publishable (`wpk_`)
  key can never open the ASR socket: the scope is `models:invoke` and a
  publishable key is capped to `{sessions:write, embed:mint, chat:invoke,
  agents:read}`, with the cap applied at authentication rather than only at
  mint. The only credential the door accepts is a `wsk_` workspace secret, and
  there is no short-lived stand-in to mint — no ASR equivalent of
  `POST /api/embed/session-token` exists. So `url` should point at a WebSocket
  endpoint on your own server, which holds the `wsk_` and relays. A URL
  carrying a `wsk_` throws, on both the literal and the function form.

  What the SDK owns is the browser's half: the microphone graph, resampling to
  the 16 kHz mono int16 PCM the engine requires, the config frame, the flush,
  and typed events. `floatTo16BitPCM`, `downsampleTo16k`, `buildConfigFrame`
  and `parseTranscript` are exported for anyone doing their own plumbing.

  **Billed per second of audio** to the workspace whose key your server used,
  for as long as the socket is open.

  Deliberately **not** named `listen()`: this SDK already has one, and it opens
  a LiveKit room for an agent listen session. The gateway's `/listen` WebSocket
  is the `transcribe()` feature. Both docs now say so.

- **`SendTextOptions.context`** — ephemeral per-turn grounding, up to 16,000
  characters. Composed under the agent's own prompt and knowledge base, so it
  is extra grounding rather than a prompt override, and **not** stored on the
  thread: it never reaches history, recap or memory. The right place for a
  large rolling block (a livestream's state, the page being viewed) that would
  otherwise accumulate in the conversation forever. The field has existed on
  `POST /api/embed/chat/turn` and was simply unreachable from the browser. An
  empty string is omitted rather than sent as a blank block.

### Fixed

- **The `simli-token` 404 message described two impossible causes.** It said
  "unknown avatar" or "this agent has no avatar configured"; neither can
  happen — an unrecognised code is passed through as a raw provider face id,
  and a missing one falls back to a default. A 404 means a code the catalog
  knows that has no face for the active provider, which is what it now says.

- **"A browser holding a publishable key cannot call a streaming route"** was
  false as stated, in `src/text.ts` and the README. Two doors were conflated:
  `/api/chat` (the companion route) needs `companion:invoke`, which a `wpk_`
  genuinely cannot hold — but `POST /api/agents/{id}/chat/turn/stream` takes
  `chat:invoke`, which is inside the publishable cap. Both now say which is
  which, and that this SDK does not wrap the reachable one yet.

### Documented, not fixed

- **`avatar: "CODE"` does not choose the face.** The gateway resolves the
  avatar configured on the agent row and ignores the code off the wire, on
  purpose, so an embed cannot silently start paying for Simli minutes nobody
  configured. Worse: an agent with **no** avatar configured gets a face that
  never moves — the SDK renders a head and fires `avatar-ready`, but the bot is
  never switched into client-render mode and so never emits the frames that
  drive the lips. Configure the avatar on the agent, not only in code. The fix
  belongs on the gateway side; the option doc and README now warn.

- `/asr/translate` and `/asr/s2s` are deliberately not reachable with a
  workspace key and are not wrapped. They compose ASR with a language model and
  those legs have no per-second price, so a workspace key there would be an
  unbilled door.

### Tests

- 44 new cases. The ASR ones pin the refusal first — a `wsk_` in the URL, from
  a literal and from a function — then the int16 clamping (an unclamped sample
  over 1.0 wraps negative and arrives as a click), the resampling ratio, the
  config frame including the empty-`metadataTags` case, the parser against the
  engine's real field names, and the flush / warning / close routing.
- **400 cases across 21 files** (was 356 / 20).
- The bundle-size table is re-measured; the entry grew ~7.2 KB gzip across
  0.6.0–0.9.0 and `transcribe()` pulls in no dependency.

## 0.8.0 — 2026-09-16

Listen sessions, and one clock for a transcript and its signals. Everything is
additive; no 0.7.x call changes behaviour.

### Added

- **`listen(info, opts?)`** → `ListenSession` — join a listen room from the
  `{ url, token, room }` your server got from `@whissle/sdk`'s
  `whissle.listen.start(agentId)`. The visitor speaks, the platform transcribes
  and reads the delivery, and no agent answers. Events: `connected`,
  `transcript` (`ListenTranscript` — `{ text, final, turnId?, raw }`, interims
  and finals), `signal` (`LiveSignal`), `user-metadata`, `server-message`,
  `disconnected`, `error`. Controls `mute()` / `unmute()` /
  `setMicrophone(deviceId)` / `close()`; options `{ deviceId?, muted? }`. Bot-side
  frames are ignored rather than rendered as a phantom agent. Rides the same
  lazy `livekit-client` chunk as the LiveKit transport.
- **`turnId` on transcripts and signals.** Every final `user-transcription`
  frame carries the gateway's `turn_id`, and the emotion/intent signal frames
  for the same utterance carry the same one. `LiveSignal` and `UserMetadata`
  gain `turnId?`; the `user-transcript` / `user-interim` handlers get a second
  argument, `TranscriptMeta` (`{ turnId?, raw }`), with the string payload
  unchanged. `turnIdOf(message)` is exported for anyone parsing by hand.
- **Delivery fields on `LiveSignal`**: `wordsPerMinute?`, `speechMs?` and
  `entityDisagreements?: { label, kind }[]` (entities the metadata head tagged
  that the transcript lacks), read forgivingly from the signal's `data` with the
  envelope as a fallback. Absent — never zero — when the frame has none.

### Tests

- A regression pinning the card contract on typed turns: every `tool_events`
  card survives `sendText` verbatim — `affordances` (with each button's own
  wire object), `evidence`, and fields this build has never heard of — on
  `raw`, and each is re-emitted as `tool-finished` before the reply.
- 356 cases across 20 files (was 332 / 19).

## 0.7.0 — 2026-09-01

Card affordances, P0 + P2. Some tools don't act — they **prepare**: the drafted
email, the tentative booking, a side effect parked in the pending-actions queue
waiting for someone to say yes. The card now carries the choices, and this SDK
can render and fire them — by tap, and (opt-in) by gesture. Everything is
additive; a card without affordances is exactly what it always was.

### Added

- **`ToolFinished.affordances`** — the card's actionable buttons
  (`{ id, label, kind: "approve" | "reject" | "choice", actionId, primary? }`),
  parsed on **both** doors — the voice data channel and `sendText`'s
  `turn.toolEvents` — by the same code. Read forgivingly: an entry that cannot be
  fired or named, or whose `kind` this build has never heard of, is skipped
  rather than rendered broken. Absent/empty stays `undefined`, so "has
  affordances" is one truthiness check.
- **`affordance-resolved`** — a new event: a card's pending action was resolved
  (approved or rejected) from **any** surface — a tap here, a spoken
  confirmation, the operator's own console. Carries an `AffordanceResolution`
  (`{ id?, affordanceId?, actionId?, disposition?, status?, source?,
  alreadyResolved?, raw }`). Drive card buttons off this event, not off the local
  tap handler, or a firing from another surface leaves the card offering a
  choice that no longer exists. The raw envelope still reaches `server-message`,
  like every other family on the channel.
- **`agent.fireAffordance({ actionId, affordanceId, disposition, source? })`** —
  one call, routed by transport: during a live voice session it goes over the
  data channel (a `card-action` client message) and resolves on the pipeline's
  own confirmation (rejecting after 10 s rather than hanging forever — the
  channel drops rather than throws); with no session up it POSTs the token-authed
  `/api/embed/card-action` door and resolves with the mirrored resolution.
  **A 409 resolves, it does not reject**: an affordance fires once and races are
  settled server-side (first write wins), so "someone got there first" comes back
  as the standing state flagged `alreadyResolved: true` — render it, never toast
  it. Every successful firing is also emitted as `affordance-resolved`, so a card
  renderer needs exactly one code path whatever fired it.
- **The ready-made widget renders them.** A card with affordances appears in the
  log with its buttons — approve filled with the accent, reject quiet, a primary
  choice filled among quiet ones. A tap disables the row immediately (a
  double-tap must not fire twice), the resolution swaps the buttons for a line
  ("Approved · sent" / "Discarded"), a resolution from any other surface does the
  same, and a firing that failed to *send* re-arms the buttons — unless a
  resolution landed meanwhile, which outranks the delivery failure.
- **Gesture input (P2), opt-in** — `gestures: true` plus `gestureAssetsUrl` arms
  **exactly three** on-device gestures against the focused card: 👍 fires its
  `primary` approve (single-unmarked fallback; ambiguity never fires), 👎 its
  single reject, and a held ✋ pauses gesture firing for 30 s — a hold, never a
  disposition. Armed only when every gate holds at once: the option, the mint's
  `visual` descriptor allowing a camera (an audio-only session never arms), a
  live camera track, and **exactly one** card with unresolved affordances. A
  firing needs two consecutive samples at ≥ 0.75 confidence (~600 ms dwell,
  ~300 ms cadence); sampling skips hidden tabs and stops whenever disarmed.
  Fires through the same `fireAffordance`, attributed `source: "gesture"`.
  **On-device only**: no frame, landmark, or gesture datum leaves the browser.
- **`gesture`** — a new event (`GestureEvent` — `{ name, armed_state }`,
  `armed_state: "armed" | "paused" | "fired" | "disarmed"`), so host apps can
  render their own arming indicator. The ready-made widget renders it as a chip
  on the focused card ("✋ gesture armed · 👍 approve · 👎 reject" / "✋ paused" /
  "👍 firing…"), removed with the buttons when the card resolves.
- **`@mediapipe/tasks-vision` as an optional peer dependency**, loaded with a
  lazy `import()` — bundlers resolve it when the host installed it; when the
  import fails (package absent, CSP) the SDK warns once and gestures no-op:
  they never break a session. The recognizer assets load from the host's own
  `gestureAssetsUrl` (`<url>/wasm`, `<url>/gesture_recognizer.task`) — there is
  deliberately no third-party CDN default, and unset means off-with-a-warn. The
  `<script>`-tag builds alias the module to a stub that takes the same warn path.

### Testing

332 cases across 19 files (up from 267). The new ones pin the affordance parse on
both doors, both firing routes (envelope and body byte-for-byte), the
409-is-an-answer rule, the widget's card state machine — and, for gestures, every
arming gate individually, confidence + dwell, the closed three-gesture
vocabulary, ambiguity-never-fires, the open-palm hold, the `source: "gesture"`
firing envelope, the graceful no-op paths, and the chip state machine.
`check:readme` still compiles every README snippet under `--strict`.

## 0.6.0 — 2026-09-01

Embed parity, round two — the gaps between what the gateway says and what this
SDK let you hear. Everything is additive; nothing existing changes shape.

### Added

- **Tool cards on typed turns.** The embed chat endpoint returns `tool_events` —
  the structured per-tool cards, in the *same* `{kind:"tool", phase:"result", …}`
  envelope the voice pipeline ships on the data channel — and this SDK dropped
  them, so no artifact could ever render on the text widget: `tools_used` named
  what ran and carried none of what it produced. `TextTurn` now carries them as
  `toolEvents` (parsed into `ToolFinished`, the `tool-finished` payload shape),
  and `sendText` **re-emits each one as a `tool-finished` event** before the
  `agent-transcript`, so a card renderer wired for voice lights up for typed
  turns with no second code path. No earcon and no `thinking` edge on this path,
  deliberately — both exist to explain a silence that is still happening.
- **`session.limits`** — how long this session may run and why
  (`max_session_seconds`, `reason: "demo" | "public"`, and the `end_signal`
  envelope the pipeline sends before hanging up). Every anonymous embed session
  has a real ceiling, and a widget that didn't know simply went silent
  mid-sentence at exactly the cap — which reads as the agent freezing, not the
  free session ending. The ready-made widget now draws a **countdown** in the
  header and an **end-card** in the log, driven by the mint and confirmed by the
  existing `demo-limit` event; the local clock is only the backstop for that
  envelope never arriving.
- **`session.visual` and `session.location`** — typed descriptors for what the
  agent can see and whether it may know where the visitor is. A keyframe sent to
  a non-hybrid agent is accepted and dropped without a word, and a GPS prompt for
  a tier that can't hold a fix is a permission dialog for nothing — these say so
  *before* you offer a button. The `agent.send("location", { lat, lon, … })` door
  the bot has ingested all along is now documented in the README.
- **`metadata`** on `WhissleAgentOptions` — your own identifiers for the session
  (`{ student_id: "…" }`), sent with the mint, echoed back, and stamped onto the
  session record, so correlating a Whissle session to your user is a lookup
  instead of "list the agent's calls and match on timestamp".
- **`browser_id`** — a stable, anonymous per-visitor id (random, persisted in
  `localStorage`, derived from nothing about the visitor), sent with the mint.
  The gateway uses it for exactly one thing: the free landing demo's daily cap,
  per browser as well as per IP — without it, everyone behind one corporate NAT
  shares an allowance. Storage unavailable degrades silently to IP-only capping,
  never to a failed mint.

### Fixed

- **A 403 from the mint always blamed the origin allowlist.** The gateway 403s
  distinctly for a key missing the embed-mint scope, an embed with no allowlist
  configured at all, and an origin that isn't on it — and only the last is fixed
  by adding this origin. The server's own `detail` is now preferred; the
  allowlist sentence (with the origin to add) remains the fallback for a gateway
  that sent none.

### Testing

267 cases across 17 files (up from 245). `check:readme` still compiles every
README snippet under `--strict`.

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
