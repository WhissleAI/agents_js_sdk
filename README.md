# @whissle/agents

Embed a **Whissle voice agent** — with or without a talking avatar — into any web
app. Build or configure the agent on [whissle.ai](https://whissle.ai),
grab a key, and run a live spoken conversation in the browser: as a ready-made
widget or wired into your own UI.

Sessions run on Whissle's realtime infrastructure and are metered against your
workspace. A publishable key is safe to ship in client code: it's restricted to
the origins you allow and only authorizes a session with the agent you chose.

## The flow

1. **Create or configure an agent** on whissle.ai (e.g. an AI Tutor,
   receptionist, or your own).
2. Open the agent → **Embed & SDK** → turn on embedding, add the site(s) allowed
   to use it, and copy your **publishable key**.
3. Drop the SDK into your site.

## A complete example

[`examples/interview-platform`](examples/interview-platform) is a small but
complete app in ~300 lines: agents declared in a JSON file, live calls with or
without a face, and every past session with its transcript and score. No
database, no build step — `npm install && npm start`.

## Install

```bash
npm install @whissle/agents
```

…or use it straight from a CDN with a plain `<script>`:

```html
<script src="https://unpkg.com/@whissle/agents"></script>
```

## Ready-made widget (one line)

```html
<div id="assistant" style="height:520px"></div>
<script src="https://unpkg.com/@whissle/agents"></script>
<script>
  WhissleAgents.mount("#assistant", {
    apiKey: "wpk_your_publishable_key",
    agentId: "your-agent-id",
    title: "Ask our assistant",
  });
</script>
```

That renders a clean, theme-aware widget: a Start button, a live transcript, a
strip that says what the agent is doing when it goes quiet, and a message box for
visitors who won't or can't talk. Pass `accent: "#7c3aed"` to match your brand,
or `text: false` for voice only.

## A talking avatar

```ts
const agent = new WhissleAgent({
  apiKey: "wpk_…",
  agentId: "…",
  avatar: "F1-HR",              // a code from GET /api/avatars
});
agent.on("avatar-ready", ({ video }) => document.querySelector("#face").append(video));
await agent.start();
```

…or let the widget place it for you:

```ts
WhissleAgents.mount("#assistant", { apiKey: "wpk_…", agentId: "…", avatar: "F1-HR" });
```

Three shapes are accepted:

```ts
avatar: "F1-HR"                                  // a specific face
avatar: true                                     // whatever the agent is configured with
avatar: { id: "M2-TL", container: "#face", required: false, timeoutMs: 15000, pacing: true }
```

**Avatar codes** come from `GET https://aws-gateway-backend.whissle.ai/bot/api/avatars`:
`F1-HR`, `F2-TL`, `F3-SE`, `M1-HR`, `M2-TL`, `M3-SE` (F/M = gender). Anything
else is passed through to the provider as a raw face id.

**How it works.** The avatar is rendered *in your browser*, straight from Simli:
Whissle mints a short-lived, face-scoped session token server-side (its API key
never reaches the page) and the page opens its own connection for the video. No
Whissle node ever transcodes video, and the frames don't make a second trip. The
agent's speech is mirrored to the face as clean 16 kHz PCM over the session's
data channel, which is what makes the lip-sync accurate.

**Audio pacing.** The agent's speech does not arrive at the rate it is spoken —
it shares an output queue with the WebRTC track and then rides a reliable,
ordered data channel, so it alternates stalling and arriving in dumps (a live
session was measured delivering 2.6 s of audio inside 310 ms). The face renders
a real-time stream and stutters on a dump, so the SDK smooths the hand-off:
audio is released at up to 1.5× real time, fast enough that it always out-runs
playback — the pacing adds no latency to what the listener hears — but never in
a dump. Read `agent.avatarAudioStats` to see it working (`maxQueuedMs` is how
big a dump was absorbed); set `pacing: false` to hand chunks straight through.

**A missing face never costs you the session.** If the avatar can't be minted or
doesn't come up within `timeoutMs`, the conversation still connects **audio-only**
and you get an `avatar-failed` event with the reason. Set `required: true` to
make it fatal instead.

**Rendering requirements.** The `<video>` must be visible and allowed to play —
the avatar SDK only reports itself live once a frame has actually been painted.
A `display:none` or zero-size element will time out. The SDK sets `autoplay`,
`muted` and `playsinline` and calls `play()` for you; you only have to give it
somewhere on screen to live.

## Headless — wire it into your own UI

```ts
import { WhissleAgent } from "@whissle/agents";

const agent = new WhissleAgent({
  apiKey: "wpk_your_publishable_key",
  agentId: "your-agent-id",
});

agent
  .on("connected", () => console.log("live"))
  .on("user-transcript", (t) => console.log("you:", t))
  .on("agent-partial", (t) => render(t))              // the reply as it happens
  .on("agent-transcript", (t) => console.log("agent:", t))
  // Why it just went quiet. Without this a tool call is several seconds of
  // nothing, which every visitor reads as a hang.
  .on("thinking", (s) => strip.toggle(s.active, s.label))
  .on("error", (m, detail) => console.error(detail?.code, m));

await agent.start();   // asks for the mic, checks it, connects
// agent.setMuted(true);
// agent.setEarconsMuted(true);
// await agent.sendText("or just type");
// agent.stop();
```

## Keeping credentials off the page

The recommended production shape: **your** server mints the session behind
**your** auth, and the browser only ever holds a short-lived token.

```ts
// your server (Node) — the secret key never leaves it
const r = await fetch("https://aws-gateway-backend.whissle.ai/bot/api/embed/session-token", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ api_key: process.env.WHISSLE_SECRET_KEY, agent_id: AGENT_ID }),
});
const { token } = await r.json();     // hand `token` to the browser
```

```ts
// the browser — no Whissle credential of any kind
new WhissleAgent({ sessionToken: token });

// or re-fetch on every start(), so a reconnect gets a fresh token:
new WhissleAgent({
  getToken: () => fetch("/api/voice-token", { credentials: "include" })
    .then((r) => r.json()).then((d) => d.token),
});
```

A token minted with a **secret** (`wsk_`) key is server-trusted: it is not bound
to an origin, so it works from any page — you never have to allowlist a domain
for it. A token minted from a publishable key in the browser stays origin-bound.
Passing a `wsk_` key as `apiKey` throws at construction; it must never reach a
browser.

## Transports

By default the SDK uses whichever transport the session mint describes, and falls
back to SmallWebRTC — which is what every 0.1.x session used, so existing code is
unaffected.

```ts
transport: "auto"      // default — follow the mint, else SmallWebRTC
transport: "webrtc"    // always SmallWebRTC
transport: "livekit"   // always LiveKit (POST /api/embed/livekit)
```

With LiveKit the client SDK owns ICE, TURN, reconnection and track subscription,
so you stop hand-rolling peer connections and inventing ICE config. `"auto"`
deliberately never *probes* for LiveKit: a probe would spend the session token's
single-use nonce and start a metered bot. Forcing `"livekit"` against a gateway
that doesn't have it enabled fails loudly rather than silently downgrading.

## Events

The voice basics:

| Event | Payload | When |
|---|---|---|
| `connecting` | — | `start()` called, negotiating |
| `connected` | — | live session established |
| `bot-ready` | object | the agent's pipeline is up and listening |
| `disconnected` | — | session ended |
| `speaking-started` / `speaking-stopped` | — | agent turn boundaries |
| `user-transcript` | `string` | a finalized user utterance |
| `user-interim` | `string` | the caller's speech while still being recognised — provisional, replaced by the next one and finally by `user-transcript`. Render it greyed/italic; never store it. Without it a speaker sees nothing while they talk and assumes they aren't heard. |
| `agent-transcript` | `string` | the agent's reply, once per turn, when it stops speaking |
| `agent-partial` | `string` | the reply **so far** in this turn, re-emitted as each sentence lands. What to render mid-answer — `agent-transcript` fires at the end, so a transcript built from it alone sits empty and then dumps a paragraph. |
| `agent-word` | `string` | one word, at the moment the voice says it. The only granularity fine enough for a caption that keeps time with the audio. |
| `listening-started` / `listening-stopped` | — | the server's VAD heard the caller start/stop. A `listening-started` between `speaking-started` and `speaking-stopped` **is** a barge-in. |
| `avatar-ready` | `{ video, faceId }` | the face is live; `video` is an `HTMLVideoElement` |
| `avatar-failed` | `string` | no face this session — the reason. Not fatal |
| `mic-lost` / `mic-restored` | — | the microphone stopped producing audio mid-session (unplugged, taken by another app, permission revoked) and came back. The session stays up, so tell the caller rather than tearing down. |
| `server-message` | `unknown` | every structured message from the agent, passed through untouched — including the ones below, so nothing you already parse by hand goes away |
| `error` | `string`, `WhissleErrorDetail` | see [Errors](#errors) |

What the agent is **doing** — new in 0.5.0, and the reason an embedded agent used
to go silent for seconds at a time with no explanation:

| Event | Payload | When |
|---|---|---|
| `thinking` | `{ active, tool?, label? }` | one boolean for "it's working, that's why it's quiet". Collapses however many tools are in flight into a single edge each way, and clears when the agent starts speaking. This is what a "thinking strip" hangs off. |
| `tool-started` | `{ id, name, arguments, sound }` | the agent called a tool. The SDK plays the earcon itself; `sound` is exposed so you can do your own. |
| `tool-progress` | `{ id, name, display, data }` | an interim line from inside a long tool ("Reading source 2 of 3…") |
| `tool-finished` | `{ id, name, ok, result, evidence }` | it came back. `ok` is `undefined` — not `false` — when the tool timed out and its success is genuinely unknown. `evidence` carries citations when it answered from a document. |
| `gist` | `string` | a one-line caption of the reply being spoken right now. Only on agents configured to emit one. |
| `user-metadata` | `UserMetadata` | the live acoustic read of the caller — see [Emotion](#emotion-and-the-neutral-problem) before you render it |
| `signal` | `LiveSignal` | one event from the pipeline's live signal stream (barge-in, endpointing, language switches, entities, flow state). Schema v1. |
| `demo-limit` | `unknown` | this session hit the anonymous demo cap and is ending |

Correlate tool events by `id` (`tool_call_id`), never by `name` — two calls to the
same tool can be in flight at once.

## Tool earcons

When an agent calls a tool it stops talking for as long as the tool takes. Without
a cue that is dead air, and every caller reads dead air as a hang. The platform
picks a sound per tool — deterministically, including for tools invented at
runtime — and sends its name; this SDK plays it.

On by default. Prime happens inside `start()`, which is why `start()` must be
called from a click: browsers leave an `AudioContext` suspended otherwise and
every cue becomes a silent no-op.

```ts
new WhissleAgent({ apiKey: "wpk_…", agentId: "…",
  earcons: false,                        // silent tool calls
  earcons: { volume: 0.6 },              // quieter
  earcons: { bankUrl: "/sounds/tool" },  // your own copy of the real clips
});

agent.setEarconsMuted(true);             // wire this to your mute button
```

**The cues are synthesised, not sampled.** whissle.ai plays 56 mastered mp3s out
of its own `public/`; an embed can't — that path 404s on your origin, and the
gateway does not serve the bank. The alternatives were bundling ~230 KB of audio
into a widget SDK or fetching on first tool call, and a cue that arrives after a
network round-trip is an echo, not a cue. So the SDK builds them from
oscillators: zero bytes, no request, and the first cue is as fast as the
thousandth. They are not byte-identical to the dashboard's, but they are the same
language — same categories, same meanings, same tool-to-sound mapping, so one
tool always sounds the same and different kinds of work sound different. Point
`bankUrl` at a copy of the bank if you want the exact clips.

## Text

The same agent, typed. One brain, several mouths — same prompt, knowledge base
and tools as the voice channel.

```ts
// No call up: an HTTP turn. Needs no microphone and no WebRTC at all.
const turn = await agent.sendText("what's your refund policy?");
turn.reply;        // the whole reply
turn.toolsUsed;    // ["search_knowledge_base"]
turn.evidence;     // citations, when it answered from a document

// During a live call: injected into the SAME conversation, answered out loud.
// Resolves with null — the reply arrives as speech, via agent-transcript.
await agent.sendText("k.singla@example.com");
```

Consecutive calls continue one thread (`agent.textThread`, and
`agent.resumeTextThread(id)` to pick it up on a later page load). Images can ride
along on the HTTP path: `sendText(text, { images: ["data:image/png;base64,…"] })`.

Requires text to be enabled on the agent — the session mint reports
`agent.session.text_enabled`, and `sendText` rejects with a 404 saying so if it
isn't.

**No streaming here, deliberately.** The embed text endpoint answers with one
JSON body. The SSE envelope (`open` → `delta`* → `done`) lives on the
authenticated `/api/chat` route, which a browser holding a publishable key cannot
call and should not be able to. `sendText` resolves once, with the whole reply —
a fake stream that arrives all at once would be a worse lie than no stream.

## Errors

`error` carries the sentence it always has, plus a second argument you can branch
on. Existing one-argument handlers are unaffected.

```ts
agent.on("error", (message, detail) => {
  if ((detail as WhissleErrorDetail)?.code === "no-credit") showBillingLink();
  else show(String(message));
});
```

| `code` | Means |
|---|---|
| `no-credit` | the workspace wallet is empty (402, or mid-session) |
| `origin-not-allowed` | this domain isn't in the agent's Embed settings (403). The message names the origin to add. |
| `expired` | the key or session token isn't valid (401) |
| `not-found` | no such agent, or embedding is off (404) |
| `rate-limited` | too many sessions or messages (429) |
| `unavailable` | embedding is off on this gateway (503) |
| `microphone` | blocked, busy, missing, or the server is receiving no audio |
| `autoplay` | the browser blocked the agent's audio until a gesture |
| `agent-down` | the agent's model is failing |
| `demo-limit` | the anonymous demo cap |
| `connection` | anything else |

## Microphone

`start()` opens the microphone and checks it **before** connecting, because
`enableMic: true` runs its own `getUserMedia` and does not reliably throw when it
fails — the session comes up, the server receives zero audio frames, and the
visitor talks to a widget that ignores them for the whole call. Now that is a
sentence instead, with the fix in it ("click the padlock, choose Allow, then
reload").

```ts
const problem = await agent.checkMicrophone();   // null when it's fine
const mics = await agent.listMicrophones();      // labels are real only after permission
agent.setMicrophone(mics[0].deviceId);           // LiveKit; no-op + false on SmallWebRTC
```

Pass `micPreflight: false` if your page manages permission itself.

## Emotion and the NEUTRAL problem

`user-metadata` reports what the pipeline heard in the caller's voice. Read this
before rendering it.

**`emotion` is `undefined` whenever the platform said `NEUTRAL`,** and that is
deliberate. The platform writes `NEUTRAL` both when the head genuinely read a calm
speaker and as the *fallback* when no reading was produced at all — no metadata
sidecar on that deployment, a language the head isn't trusted on, a classifier
call that failed. The wire is identical in both cases. So a `NEUTRAL` supports
exactly one honest statement — *nothing was detected* — and surfacing it as a
reading would let you draw "the caller is calm" out of "we don't know".

`undefined` is therefore the whole answer for both "no reading" and "neutral".
When a real emotion *is* reported it comes with the model's own probability, which
tops out around 0.63 on low-arousal states — render it as a leaning, not a fact.
`raw` has the untouched payload, distributions included, if you want to decide for
yourself.

## Talking to the running agent

## Talking to the running agent

Some behaviour is your application's, not the SDK's: pausing an interview,
asking it to wrap up early, telling it the user is ready. `send` puts a message
on the session's data channel, and `server-message` delivers what comes back.

```ts
agent.on("server-message", (m) => {
  // e.g. { t: "question", index: 3, text: "Why CPVC?" }
});

agent.send("wrap-up");
agent.send("set-difficulty", { level: "hard" });
```

`send` is safe to call before the session is up — the message is dropped rather
than thrown, because a lost control message should never take down a live
conversation.

**Fixed in 0.5.0:** on the LiveKit transport — the one every production session
uses — `send` published an envelope the agent does not read, so every control
message was dropped by the far side with nothing anywhere to say so. `send` now
works on both transports.

## Options

```ts
new WhissleAgent({
  apiKey: "wpk_…",       // a publishable key — or use sessionToken / getToken
  sessionToken: "…",     // a token your backend already minted
  getToken: () => "…",   // …or a function that fetches one, called on every start()
  agentId: "…",          // which agent to talk to (not needed with a token)
  avatar: "F1-HR",       // string | true | { id, container, required, timeoutMs, pacing }
  transport: "auto",     // "auto" | "webrtc" | "livekit"
  baseUrl: "…",          // override the API host (self-hosted / staging)
  iceServers: [ … ],     // custom ICE/TURN — wins over anything the mint suggests
  earcons: true,         // true | false | { enabled, volume, bankUrl }
  micPreflight: true,    // check the mic before connecting
});
```

Read-only: `agent.state`, `agent.transport`, `agent.session` (what the mint said —
agent name, greeting, TTL, `text_enabled`), `agent.videoElement`,
`agent.textThread`.

`transport: "auto"` follows the transport the session mint describes — today
LiveKit — and, if that fails to come up, takes the fallback the *same mint* named
(SmallWebRTC). Naming a transport explicitly opts out of that: you asked for a
specific one, so it fails loudly rather than quietly moving you somewhere else.

## Bundle size

The avatar and LiveKit renderers are heavy and most pages use neither, so they
are loaded on demand.

| build | size | notes |
|---|---|---|
| `dist/index.js` (ESM), `dist/index.cjs` | 373 KB | the SmallWebRTC transport is bundled in — see "Node ESM" below |
| your app's entry chunk | 448 KB raw / **123 KB gzip** | measured with esbuild + code splitting. **+4.4 KB gzip vs 0.4.2** — the whole of 0.5.0 (earcons, tool events, signals, text, mic checks) |
| avatar chunk | 557 KB raw / 145 KB gzip | fetched only when `avatar` is set |
| LiveKit chunk | 535 KB raw / 140 KB gzip | fetched only on the LiveKit transport |
| `dist/index.global.js` (`<script>`) | 450 KB raw / 125 KB gzip | voice only |
| `dist/index.full.global.js` | 1.51 MB raw / 412 KB gzip | avatar + LiveKit bundled, for `<script>` pages |

The earcons contribute nothing measurable: they are oscillators and a table, not
audio. Shipping the real mp3 bank instead would have cost ~230 KB.

`unpkg`/`jsdelivr` still resolve to the **lean** global, so nothing you already
ship gets bigger. For an avatar or LiveKit from a plain `<script>` tag, point at
the full build:

```html
<script src="https://unpkg.com/@whissle/agents/dist/index.full.global.js"></script>
```

If you ask the lean build for an avatar it emits `avatar-failed` telling you to
use the full build, and the session continues audio-only.

## Node ESM / SSR

`import("@whissle/agents")` used to throw before any of our code ran:

```
Cannot find module '…/lodash/cloneDeep' imported from
@pipecat-ai/small-webrtc-transport/dist/index.module.js
```

The transport's ESM build imports a lodash subpath without its `.js` extension.
Bundlers and `require()` resolve that fine; raw Node ESM refuses — so a Next.js
server component, an SSR pass or a plain `node` script blew up on import. **Fixed
in 0.2.0**: that transport is now bundled into our own build with the specifier
rewritten, and nothing resolves lodash at runtime at all. Importing the package
in Node (ESM or CJS) is safe. Note the SDK still needs a browser to actually
*run* a session — importing it on the server just no longer throws.

## Notes

- **Microphone**: the browser prompts for mic access on `start()`. Serve your
  page over HTTPS (WebRTC + mic require a secure context).
- **Allowed origins**: a session minted in the browser is refused (403) from a
  site you haven't listed in the agent's Embed settings. Add your domain there,
  or mint server-side (above), where origins don't apply.
- **Metering**: each session debits your Whissle workspace wallet; a session ends
  automatically if credit runs out (`error` with `code: "no-credit"`).
- **Accessibility**: the built-in widget marks its error bar `role="alert"` and its
  thinking strip `aria-live="polite"`, labels the message box, and drops the
  pulsing dot under `prefers-reduced-motion`. Everything else about your UI is
  yours — the SDK is events, not markup.
- **SSR**: importing the package on a server is safe and every browser-only path
  (WebAudio, `navigator`, `document`) is guarded. It still needs a browser to run
  a session.

## Testing

`npm test` — 213 cases, Vitest, no browser needed. They cover the decisions
`start()` makes before any media flows (credential selection, transport choice
and fallback, the query params the gateway is asked for, the mic preflight, the
audio-only path when an avatar mint fails), the transcript/turn de-duplication,
and the wire formats: the outbound `client-message` envelope, the earcon clip-name
guard, the tool-event parse, the thinking bookkeeping, the `NEUTRAL` suppression,
and the text channel.

Anything needing a real browser — the WebRTC handshake, the Simli render loop, an
actual LiveKit room join, autoplay behaviour, and how the synthesised earcons
*sound* — is **not** covered by the suite and has to be exercised in a browser.

## License

MIT
