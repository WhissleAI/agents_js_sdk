# @whissle/agents

Embed a **Whissle voice agent** — with or without a talking avatar — into any web
app. Build or configure the agent on [whissle.ai](https://whissle.ai),
grab a key, and run a live spoken conversation in the browser: as a ready-made
widget or wired into your own UI.

Sessions run on Whissle's realtime infrastructure and are metered against your
workspace. A publishable key is safe to ship in client code: it's restricted to
the origins you allow and only authorizes a session with the agent you chose.

## Which Whissle package do I want?

We publish three, they are routinely confused, and the difference is which key
they hold — which is a security boundary, not a preference.

| Package | Runs in | Key | What it's for |
| --- | --- | --- | --- |
| **`@whissle/agents`** (this one) | the **browser** | `wpk_` **publishable** | Embed a live voice or text agent in a page |
| [`@whissle/sdk`](https://www.npmjs.com/package/@whissle/sdk) | **server-side Node** | `wsk_` **workspace secret** | Configure agents; read back calls, sessions, traces and usage |
| [`@whissle/cli`](https://www.npmjs.com/package/@whissle/cli) | your **terminal** | `wsk_` **workspace secret** | The control plane over the same API |

**`@whissle/sdk` must never appear in client code.** A `wsk_` key carries full
workspace authority — it can dial phone numbers, buy numbers, read every
transcript — and anything shipped to a browser is public. This package refuses
one: passing a `wsk_` as `apiKey` throws at construction. What belongs in a page
is a `wpk_` publishable key or, better, a short-lived token your server mints
(see [Keeping credentials off the page](#keeping-credentials-off-the-page)).

There is also a **Python client** for the server-side API, in the Whissle
monorepo at `SDKs/whissle-python` (imports as `whissle_sdk`, takes the same
`wsk_` secret). It is aimed at eval harnesses and notebooks, and is not on PyPI
yet.

## The flow

1. **Create or configure an agent** on whissle.ai (e.g. an AI Tutor,
   receptionist, or your own).
2. Open the agent → **Embed & SDK** → turn on embedding, add the site(s) allowed
   to use it, and copy your **publishable key**.
3. Drop the SDK into your site.

## Two complete examples

Everything in this README that a Node test suite cannot verify — the WebRTC
handshake, the LiveKit join, the avatar's frames, autoplay, how the cues sound —
can only be confirmed by running it in a browser. These two exist to make that a
one-command job. Both serve the SDK build sitting next to them when run from
inside this repo, so they exercise **your** working tree rather than whatever npm
last published.

[**`examples/interview-platform`**](https://github.com/WhissleAI/agents_js_sdk/tree/main/examples/interview-platform)
— a small but complete app: agents declared in a JSON file, live calls with or
without a face, and every past session with its transcript and score. No
database, no build step — `npm install && npm start`. It also exercises the whole
0.5.0 surface in one page: the live caption from `agent-word`, the reply-so-far
from `agent-partial`, tool activity with its citations, the barge-in edge, the
acoustic read, the live signal ticker, typing to the agent with and without a
call up, a microphone picker, and the tool-cue toggle.

[**`examples/observability-console`**](https://github.com/WhissleAI/agents_js_sdk/tree/main/examples/observability-console)
— one screen showing everything the pipeline knows *while the conversation is
happening*: the recogniser's provisional guesses before it commits, the acoustic
read as a distribution rather than a label, every turn-taking bet and whether it
held, each tool with its arguments and result, and per-hop latency. It can also
replay a recorded session deterministically, which is the only way to look at a
race twice. It needs a **secret** key server-side (the browser still only gets a
session token).

## Install

```bash
npm install @whissle/agents
```

…or use it straight from a CDN with a plain `<script>`:

```html
<script src="https://unpkg.com/@whissle/agents"></script>
```

ESM and CJS, with types. Node 20+ to build with — the runtime target is the
browser, and importing the package on a server is safe (see
[Node ESM and SSR](#node-esm-and-ssr)), but a session needs a browser to run.

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
visitors who won't or can't talk. Pass `accent: "#7c3aed"` to match your brand.

The message box is shown by default and **withdrawn** as soon as the agent turns
out not to support text — the session mint says `text_enabled: false`, or a send
comes back 404. `mount()` has no session yet, so it cannot know up front, and
minting one on page load would spend a metered token for a conversation most
visitors never start. `text: false` never renders it; `text: true` keeps it
whatever the agent says.

## A talking avatar

```ts
import { WhissleAgent, type AvatarReady } from "@whissle/agents";

const agent = new WhissleAgent({
  apiKey: "wpk_…",
  agentId: "…",
  avatar: "F1-HR",              // a code from GET /api/avatars
});
agent.on("avatar-ready", (ready) => {
  const { video } = ready as AvatarReady;
  document.querySelector("#face")?.append(video);
});
await agent.start();
```

(The cast is not decoration — see [Typing an event
payload](#typing-an-event-payload).)

…or let the widget place it for you:

```ts
import { mount } from "@whissle/agents";

mount("#assistant", { apiKey: "wpk_…", agentId: "…", avatar: "F1-HR" });
```

From a plain `<script>` tag the same function is `WhissleAgents.mount(…)`.

Three shapes are accepted:

```ts
import { WhissleAgent } from "@whissle/agents";

new WhissleAgent({ apiKey, agentId, avatar: "F1-HR" });   // a specific face
new WhissleAgent({ apiKey, agentId, avatar: true });      // whatever the agent is configured with
new WhissleAgent({
  apiKey,
  agentId,
  avatar: { id: "M2-TL", container: "#face", required: false, timeoutMs: 15000, pacing: true },
});
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

> **Untested in a browser.** The suite covers the mint, the audio-only fallback
> when it fails, and the PCM pacing arithmetic. The Simli render loop itself — the
> part that puts pixels on screen — is exercised only by running it. See
> [What isn't tested](#what-isnt-tested).

## Headless — wire it into your own UI

```ts
import {
  WhissleAgent,
  type ThinkingState,
  type WhissleErrorDetail,
} from "@whissle/agents";

const agent = new WhissleAgent({
  apiKey: "wpk_your_publishable_key",
  agentId: "your-agent-id",
});

agent
  .on("connected", () => console.log("live"))
  .on("user-transcript", (t) => console.log("you:", t))
  .on("agent-partial", (t) => render(String(t)))      // the reply as it happens
  .on("agent-transcript", (t) => console.log("agent:", t))
  // Why it just went quiet. Without this a tool call is several seconds of
  // nothing, which every visitor reads as a hang.
  .on("thinking", (s) => {
    const { active, label } = s as ThinkingState;
    strip.toggle(active, label);
  })
  .on("error", (m, detail) => console.error((detail as WhissleErrorDetail)?.code, m));

await agent.start();   // asks for the mic, checks it, connects
// agent.setMuted(true);
// agent.setEarconsMuted(true);
// await agent.sendText("or just type");
// agent.stop();
```

### Typing an event payload

`on()` is one signature for 26 events, so **TypeScript hands every payload to
your handler as `unknown`** — `(payload?: unknown, detail?: unknown) => void`.
The Payload column in [Events](#events) is what arrives at *runtime*, and it is
accurate; it is not what the compiler infers. Cast at the handler boundary, using
the exported type for that event:

```ts
import type { ToolFinished, UserMetadata } from "@whissle/agents";

agent.on("tool-finished", (payload) => {
  const tool = payload as ToolFinished;
  if (tool.ok === false) showRetry(tool.name);
});

agent.on("user-metadata", (payload) => {
  const meta = payload as UserMetadata;
  if (meta.emotion) showLeaning(meta.emotion.label, meta.emotion.confidence);
});
```

Plain JavaScript is unaffected. Every payload type named in the table is exported
from the package root, so the cast never means inventing a shape by hand.

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
import { WhissleAgent } from "@whissle/agents";

new WhissleAgent({ sessionToken: token });

// or re-fetch on every start(), so a reconnect gets a fresh token:
new WhissleAgent({
  getToken: () => fetch("/api/voice-token", { credentials: "include" })
    .then((r) => r.json()).then((d) => d.token as string),
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
import { WhissleAgent } from "@whissle/agents";

new WhissleAgent({ apiKey, agentId, transport: "auto" });     // default — follow the mint, else SmallWebRTC
new WhissleAgent({ apiKey, agentId, transport: "webrtc" });   // always SmallWebRTC
new WhissleAgent({ apiKey, agentId, transport: "livekit" });  // always LiveKit (POST /api/embed/livekit)
```

With LiveKit the client SDK owns ICE, TURN, reconnection and track subscription,
so you stop hand-rolling peer connections and inventing ICE config. `"auto"`
deliberately never *probes* for LiveKit: a probe would spend the session token's
single-use nonce and start a metered bot. Forcing `"livekit"` against a gateway
that doesn't have it enabled fails loudly rather than silently downgrading.

**The fallback is exactly one hop, and only under `"auto"`.** If the mint's
transport fails to come up, the SDK tries the first entry in that same mint's
`fallbacks` list whose kind differs from the one that just failed — and if that
fails too, it gives up. There is no retry loop, because a retry loop is a good
way to bill someone twice for a call they never had. Naming a transport
explicitly disables the hop entirely.

> **Partly untested in a browser.** The suite covers which transport is chosen,
> what is asked for, and the fallback — all the decisions made before media flows.
> The handshakes themselves (a real SmallWebRTC negotiation, a real LiveKit room
> join) need a browser. See [What isn't tested](#what-isnt-tested).

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
| `server-message` | `unknown` | structured messages from the agent, passed through untouched. Everything the SDK parses into a typed event below is **also** delivered here, so nothing you already parse by hand goes away. **Four wire shapes are consumed and never forwarded** — see below |
| `error` | `string`, `WhissleErrorDetail` | see [Errors](#errors) |

**What `server-message` does not carry.** Exactly four message shapes are
consumed and never re-emitted:

| Wire shape | Why | What you get instead |
|---|---|---|
| `{ t: "simli-audio", pcm }` | avatar lip-sync frames, several a second | nothing — they drive the face |
| `{ t: "simli-clear" }` | avatar buffer reset | nothing |
| `{ type: "error", error: "no_credits" }` | a failure, not application data | `error` with `code: "no-credit"` |
| `{ type: "demo-limit" }` | a failure, not application data | `demo-limit`, then `error` with `code: "demo-limit"` |

Everything else falls through, including the tool, signal, metadata, `gist`,
`mic_dead` and `agent_error` families that 0.5.0 also parses into typed events —
forwarding them was the only way to reach them before 0.5.0, and taking it away
to make the routing tidier would break every integrator parsing them by hand.

What the agent is **doing** — new in 0.5.0, and the reason an embedded agent used
to go silent for seconds at a time with no explanation:

| Event | Payload | When |
|---|---|---|
| `thinking` | `{ active, tool?, label? }` | one boolean for "it's working, that's why it's quiet". Collapses however many tools are in flight into a single edge each way, and clears when the agent starts speaking. This is what a "thinking strip" hangs off. |
| `tool-started` | `ToolStarted` — `{ id?, name?, arguments?, sound?, raw }` | the agent called a tool. The SDK plays the earcon itself; `sound` is exposed so you can do your own. |
| `tool-progress` | `ToolProgress` — `{ id?, name?, display?, data?, raw }` | an interim line from inside a long tool ("Reading source 2 of 3…"). `display` is written to be shown as-is. |
| `tool-finished` | `ToolFinished` — `{ id?, name?, ok?, result?, evidence?, sound?, raw }` | it came back. `ok` is `undefined` — not `false` — when the tool didn't say, so its success is genuinely unknown. `evidence` carries citations when it answered from a document. `sound` is set **only on failure**: the agent is about to speak the answer, so a chime on every success would turn the bank into wallpaper. |
| `gist` | `string` | a one-line caption of the reply being spoken right now. Only on agents configured to emit one. |
| `user-metadata` | `UserMetadata` | the live acoustic read of the caller — see [Emotion](#emotion-and-the-neutral-problem) before you render it. **Not emitted at all** when neither an emotion nor an intent survived the read; the raw payload still reaches `server-message`. |
| `signal` | `LiveSignal` | one event from the pipeline's live signal stream (barge-in, endpointing, language switches, entities, flow state). The stream is versioned and additive-only, so a future schema arrives as the same fields plus ones this build ignores — `signal.version` if you care, `signal.raw` for the rest. |
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
import { WhissleAgent } from "@whissle/agents";

new WhissleAgent({ apiKey: "wpk_…", agentId: "…", earcons: false });             // silent
new WhissleAgent({ apiKey: "wpk_…", agentId: "…", earcons: { volume: 0.6 } });   // quieter
new WhissleAgent({ apiKey: "wpk_…", agentId: "…", earcons: { bankUrl: "/sounds/tool" } });
new WhissleAgent({ apiKey: "wpk_…", agentId: "…", earcons: { bankUrl: null } }); // no network

agent.setEarconsMuted(true);             // wire this to your mute button
```

**You get the real clips, from whissle.ai's own bank.** It is served publicly with
`access-control-allow-origin: *`, so an embed on your origin plays the exact mp3s
the dashboard does — no hosting, no configuration. **Nine clips are warmed inside
`start()`** (which is already inside your click): one per category — `search_0`,
`create_0`, `update_0`, `send_0`, `handoff_0`, `media_0`, `capture_0`,
`generic_0` and the failure cue `error_0`. Variant `0` is reserved for the tools
that fire on nearly every call (`search_knowledge_base`, `book_appointment`,
`send_email` …); everything else arrives on first use. That warm set is ~18 KB,
and the whole bank is 52 clips / ~85 KB.

A clip name is always `<category>_<variant>` — the nine categories are `search`,
`create`, `update`, `send`, `handoff`, `media`, `capture`, `generic` and `error`.
The platform resolves every tool name, including one invented mid-call, to one of
them; the SDK only validates the shape and never invents a mapping of its own.

A cue **never waits on the network**. If a clip isn't decoded yet the SDK plays a
synthesised equivalent immediately and warms the cache for next time — so the first
cue is as prompt as the thousandth, and an offline visitor, a strict CSP or a hole
in the bank is never audible as silence. The synthesised cues are not byte-identical
to the mastered ones, but they are the same language: same categories, same
meanings, same tool-to-sound mapping.

Point `bankUrl` at your own copy to serve it from your origin, or set it to `null`
to make no third-party request at all and use the oscillators alone.

> **Untested in a browser.** The suite pins the clip-name guard, the preload set,
> the fallback and the caching, all against a fake `AudioContext`. How the cues
> actually *sound*, and whether autoplay policy lets them through on a given
> browser, is not something these tests can tell you. See
> [What isn't tested](#what-isnt-tested).

## Text

The same agent, typed. One brain, several mouths — same prompt, knowledge base
and tools as the voice channel.

```ts
// No call up: an HTTP turn. Needs no microphone and no WebRTC at all.
const turn = await agent.sendText("what's your refund policy?");
if (turn) {
  turn.reply;        // the whole reply
  turn.toolsUsed;    // ["search_knowledge_base"]
  turn.evidence;     // citations, when it answered from a document
}

// During a live call: injected into the SAME conversation, answered out loud.
// Resolves with null — the reply arrives as speech, via agent-transcript.
await agent.sendText("k.singla@example.com");
```

**`sendText` returns `TextTurn | null`, and the `null` is load-bearing** — it is
how you tell the two channels apart. A `null` means a voice session was up and
the message went into it, so the reply will arrive as speech on
`agent-transcript` rather than in this promise. An empty or whitespace-only
message also returns `null`, without spending a metered turn. Narrow before you
read `.reply`; a snippet that skips the check compiles only because someone
turned `strict` off.

Images can ride along on the HTTP path:
`sendText(text, { images: ["data:image/png;base64,…"] })`.

**Resuming a thread.** Consecutive messages continue one conversation on their own.
To pick it up again on a *later page load*, persist `agent.textThread` and hand it
back:

```ts
const saved = localStorage.getItem("whissle-thread");
if (saved) agent.resumeTextThread(saved);          // no network — applied on first send

const turn = await agent.sendText("hi again");
if (turn?.threadId) localStorage.setItem("whissle-thread", turn.threadId);
```

`threadId` is `string | null` — the gateway has not always filed a thread by the
time it answers — so persist it only when it is there rather than writing
`"null"` into storage and resuming cold on the next visit.

Use `threadId`, **not** `conversationId`. `conversationId` is the gateway's
conversation row id, useful for correlating with the session history API and
accepted as an input by nothing: the embed chat endpoint keys a thread on
`session_id` and its request model drops every other field. Handing back the wrong
one is a resume that silently starts the agent cold — which is the whole reason
this distinction is spelled out rather than smoothed over.

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
import type { WhissleErrorDetail } from "@whissle/agents";

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

`detail.status` carries the HTTP status when the failure came from a request.

**Two different things are called `code`.** `WhissleErrorDetail.code` is the
string union above. `WhissleTextError.code` — thrown by `sendText`, not delivered
on the `error` event — is an **HTTP status number**, so a caller can branch on
`404` directly. `sendText` does both: it emits a coded `error` event *and*
rejects with a `WhissleTextError`.

## Microphone

`start()` opens the microphone and checks it **before** connecting, because
`enableMic: true` runs its own `getUserMedia` and does not reliably throw when it
fails — the session comes up, the server receives zero audio frames, and the
visitor talks to a widget that ignores them for the whole call. Now that is a
sentence instead, with the fix in it ("click the padlock, choose Allow, then
reload").

```ts
const problem = await agent.checkMicrophone();   // null when it's fine
problem?.severity;                               // "blocking" | "warning"
const mics = await agent.listMicrophones();      // labels are real only after permission
agent.setMicrophone(mics[0].deviceId);           // LiveKit; no-op + false on SmallWebRTC
```

**Only a `blocking` problem stops `start()`.** Permission refused, no device, the
device held by another app, no API at all — those demonstrably cannot deliver audio
and the session would come up deaf. Anything the check is *not* sure about is
reported as a `warning`: it goes out as an ordinary `error` event and the session
connects anyway.

The one that matters is `MediaStreamTrack.muted`, which does not mean what it looks
like. Per spec it means "not currently providing data" — the ordinary state of a
track for its first moments — and several browsers set it until the first sample
arrives. So the check waits for that sample before judging, and even then only
warns. A preflight that is on by default and can refuse a working microphone would
be a worse failure than the deaf session it prevents, because the visitor never gets
far enough to find out.

`checkMicrophone()` never throws — every failure comes back as a `MicProblem`,
and `null` means the mic is usable. It also releases every track it opened
immediately, so the check itself never becomes the app holding the microphone.

Pass `micPreflight: false` if your page manages permission itself.

> **Untested in a browser.** The preflight's decision table is unit-tested
> against a stubbed `navigator.mediaDevices`, including the `muted`-grace race.
> Real devices are not: `listMicrophones()` and `setMicrophone()` have never run
> against actual hardware in CI, and device labels only become real after the
> user grants permission. See [What isn't tested](#what-isnt-tested).

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

Suppression is about not *asserting* a reading, not about hiding numbers. **The
full distribution stays on `raw`** — `meta.raw.probs.emotion`, an array of
`{ token, probability }` with the platform's own unstripped tokens
(`EMOTION_NEUTRAL` and all), alongside `age` and `gender`. When a non-neutral
emotion *is* reported, the same distribution is also parsed onto
`meta.emotion.candidates` with labels prefix-stripped (`EMOTION_HAPPY` → `HAPPY`)
and `NEUTRAL` still in the list.

```ts
import type { UserMetadata } from "@whissle/agents";

agent.on("user-metadata", (payload) => {
  const meta = payload as UserMetadata;
  if (!meta.emotion) return;            // nothing was detected — say nothing
  showLeaning(meta.emotion.label, meta.emotion.confidence);
});
```

Two consequences worth knowing before you build a UI on this:

- **Intent is not suppressed.** Only `emotion` has the NEUTRAL problem;
  `intent` is reported exactly as sent, `INTENT_OTHER` included.
- **When neither survives, no `user-metadata` event fires at all** — the SDK
  won't wake a handler to hand it two `undefined`s. So "no frames arrived" and
  "frames arrived carrying nothing confident" look the same on this event. If you
  need to tell them apart, count the raw messages on
  [`server-message`](#events), which still receives every one of them.

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
import { WhissleAgent } from "@whissle/agents";

new WhissleAgent({
  apiKey: "wpk_…",       // a publishable key — or use sessionToken / getToken
  sessionToken: "…",     // a token your backend already minted
  getToken: () => "…",   // …or a function that fetches one, called on every start()
  agentId: "…",          // which agent to talk to (not needed with a token)
  avatar: "F1-HR",       // string | true | { id, container, required, timeoutMs, pacing }
  transport: "auto",     // "auto" | "webrtc" | "livekit"
  baseUrl: "…",          // override the API host (self-hosted / staging)
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],  // wins over the mint's
  earcons: true,         // true | false | { enabled, volume, bankUrl }
  micPreflight: true,    // check the mic before connecting
});
```

Defaults: `baseUrl` is `https://aws-gateway-backend.whissle.ai/bot` (**both the
`aws-` prefix and the `/bot` suffix are load-bearing** — see [Base
URL](#base-url)); `transport` is `"auto"`; `earcons` and `micPreflight` are on;
`iceServers` falls back to three public STUN servers unless the mint or you say
otherwise. `avatar` is off.

Read-only: `agent.state`, `agent.transport`, `agent.session` (what the mint said —
agent name, greeting, TTL, `text_enabled`), `agent.videoElement`,
`agent.textThread`.

`stop()` ends the session and keeps your event handlers, so the same instance can be
started again. `destroy()` also drops them — call it when the component unmounts, so
a long-lived page doesn't accumulate handlers and everything they close over.

`transport: "auto"` follows the transport the session mint describes — today
LiveKit — and, if that fails to come up, takes the fallback the *same mint* named
(SmallWebRTC). Naming a transport explicitly opts out of that: you asked for a
specific one, so it fails loudly rather than quietly moving you somewhere else.

## Base URL

```
https://aws-gateway-backend.whissle.ai/bot
```

That is the default; you only pass `baseUrl` for a self-hosted or staging
gateway. **Both halves are load-bearing.**

- **`aws-`** names the live host. The older `gateway-backend.whissle.ai` was
  retired *and its static IP released*, so it can be reassigned to a stranger.
  Nothing should be sent there.
- **`/bot`** is the gateway's mount prefix for the platform API, not decoration.
  Drop it and every request 404s.

**Do not smoke-test the prefix with `/health`** — it answers `200` **with and
without** it, so the obvious check cannot detect a missing prefix. Only an API
route discriminates:

```bash
curl -o /dev/null -w '%{http_code}\n' https://aws-gateway-backend.whissle.ai/bot/api/whoami  # 401 — right host, no key
curl -o /dev/null -w '%{http_code}\n' https://aws-gateway-backend.whissle.ai/api/whoami      # 404 — prefix missing
```

Unlike [`@whissle/sdk`](https://www.npmjs.com/package/@whissle/sdk), this SDK
does **not** validate `baseUrl` or reject the retired host — it concatenates what
you give it, without even normalising a trailing slash. Getting it wrong shows up
as a 404 from the session mint, surfaced as an `error` with `code: "not-found"`.

## Bundle size

The avatar and LiveKit renderers are heavy and most pages use neither, so they
are loaded on demand.

Measured against **0.4.0**, the version actually on npm. (Numbers are exact bytes
from `gzip -9`; the entry-chunk rows are esbuild `--bundle --splitting --minify`
over a trivial app that imports `WhissleAgent` and `mount`.)

| build | 0.4.0 gzip | 0.5.0 gzip | delta |
|---|---|---|---|
| your app's entry chunk | 119,527 | **126,736** | **+7,209 B (+7.0 KB)** |
| avatar chunk (Simli) | 147,662 | 147,662 | — |
| LiveKit chunk | 142,702 | 142,702 | — |
| `dist/index.js` (ESM) | 99,886 | 107,223 | +7,337 B |
| `dist/index.cjs` | 99,938 | 107,293 | +7,355 B |
| `dist/index.global.js` (`<script>`) | 120,786 | 128,010 | +7,224 B |
| `dist/index.full.global.js` | 414,022 | 421,284 | +7,262 B |

**+7.0 KB gzip on the entry chunk** buys the whole of 0.5.0: earcons, tool events,
the live signal stream, the text channel, mic checks and the mobile playout graph.
The avatar and LiveKit chunks are byte-identical — nothing in this release touched
them, and neither is downloaded unless you ask for it.

The earcons contribute almost nothing: a handful of oscillator tables and a fetch.
The mastered clips are *fetched* from whissle.ai's bank at runtime (~18 KB warmed
per session), not bundled — shipping the bank in the package would have cost
~85 KB of audio that most pages never play.

`unpkg`/`jsdelivr` still resolve to the **lean** global, so nothing you already
ship gets bigger. For an avatar or LiveKit from a plain `<script>` tag, point at
the full build:

```html
<script src="https://unpkg.com/@whissle/agents/dist/index.full.global.js"></script>
```

If you ask the lean build for an avatar it emits `avatar-failed` telling you to
use the full build, and the session continues audio-only.

## Node ESM and SSR

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

```bash
npm test              # 245 cases across 17 files, Vitest, no browser needed
npm run typecheck     # src and tests, --strict, --skipLibCheck false
npm run check:readme  # every TypeScript snippet in this file, compiled against src/
```

The suite covers the decisions `start()` makes before any media flows (credential
selection, transport choice and fallback, the query params the gateway is asked
for, the mic preflight and its severity split, the audio-only path when an avatar
mint fails), the transcript/turn de-duplication, and the wire formats: the
outbound `client-message` envelope, the earcon clip-name guard and bank fallback,
the tool-event parse, the thinking bookkeeping, the `NEUTRAL` suppression, the
signal envelope's forward compatibility, and the text channel's thread key.

`npm run check:readme` exists because this README is API surface: a snippet a
reader pastes first and that does not compile is a bug report from someone who
has already decided the library is careless. It rewrites `@whissle/agents` to
`src/index.ts`, so the snippets are checked against **this checkout**, not a
published build. There is no skip marker — a block that cannot be made to compile
should be prose.

### What isn't tested

Vitest runs in Node. Everything below is therefore **unverified by the suite** and
can only be confirmed by loading the SDK in a real browser — which
[`examples/interview-platform`](https://github.com/WhissleAI/agents_js_sdk/tree/main/examples/interview-platform)
and
[`examples/observability-console`](https://github.com/WhissleAI/agents_js_sdk/tree/main/examples/observability-console)
exist to make a one-command job (`npm start`, and they serve the local build, not
a published one):

- **The WebRTC handshake.** The suite stubs the seam just above
  `PipecatClient.connect()`. A real SDP exchange, trickle ICE and the media path
  are not exercised.
- **The LiveKit room join.** Same seam. The outbound `client-message` envelope is
  pinned byte-for-byte against `bot/runners.py`, but the socket it goes down is not.
- **The Simli render loop.** The mint and the audio-only fallback are covered; the
  frames on screen are not.
- **Autoplay policy.** Partly covered, and the gap is specific: the
  suspended-`AudioContext` path *is* pinned against a fake context (the element
  plays unmuted while suspended, self-upgrades when it resumes, retries on a
  pointer event). What has **no test at all** is the other half — a real
  `<audio>.play()` rejection, which is what raises `code: "autoplay"`. Whether a
  given browser lets the agent's voice and the tool cues through is a
  per-browser, per-gesture decision no fake context can model.
- **How the cues sound.** The mapping is deterministic and pinned, and the fetch
  URLs are asserted; nothing in the suite renders or plays audio. Whether the
  bank is reachable, decodable and audible over speech is a listening test.
- **Microphone device switching.** `listMicrophones()` and `setMicrophone()` are
  never exercised against real devices — `getUserMedia` and `enumerateDevices`
  are stubbed throughout.
- **The mobile playout graph.** The node graph and its values are pinned against a
  fake context. Whether it is actually louder on an iPhone is a phone question —
  `window.__whissleAudioBoost()` reports the live measurement from the device.
- **The widget's DOM.** The copy rules are unit-tested; the rendered markup is not
  (there is no DOM environment in the suite).

## License

MIT
