# @whissle/agents

Embed a **Whissle voice agent** — with or without a talking avatar — into any web
app. Build or configure the agent on [platform.whissle.ai](https://platform.whissle.ai),
grab a key, and run a live spoken conversation in the browser: as a ready-made
widget or wired into your own UI.

Sessions run on Whissle's realtime infrastructure and are metered against your
workspace. A publishable key is safe to ship in client code: it's restricted to
the origins you allow and only authorizes a session with the agent you chose.

## The flow

1. **Create or configure an agent** on platform.whissle.ai (e.g. an AI Tutor,
   receptionist, or your own).
2. Open the agent → **Embed & SDK** → turn on embedding, add the site(s) allowed
   to use it, and copy your **publishable key**.
3. Drop the SDK into your site.

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

That renders a clean, theme-aware voice widget (Start button → mic → live
transcript). Pass `accent: "#7c3aed"` to match your brand.

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
  .on("agent-transcript", (t) => console.log("agent:", t))
  .on("error", (m) => console.error(m));

await agent.start();   // asks for the mic, connects
// agent.setMuted(true);
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

| Event | Payload | When |
|---|---|---|
| `connecting` | — | `start()` called, negotiating |
| `connected` | — | live session established |
| `bot-ready` | object | the agent's pipeline is up and listening |
| `disconnected` | — | session ended |
| `speaking-started` / `speaking-stopped` | — | agent turn boundaries |
| `user-transcript` | `string` | a finalized user utterance |
| `agent-transcript` | `string` | agent reply text |
| `avatar-ready` | `{ video, faceId }` | the face is live; `video` is an `HTMLVideoElement` |
| `avatar-failed` | `string` | no face this session — the reason. Not fatal |
| `error` | `string` | mic denied, origin not allowed, credits out, … |

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
});
```

Read-only: `agent.state`, `agent.transport`, `agent.session` (what the mint said —
agent name, greeting, TTL), `agent.videoElement`.

## Bundle size

The avatar and LiveKit renderers are heavy and most pages use neither, so they
are loaded on demand.

| build | size | notes |
|---|---|---|
| `dist/index.js` (ESM), `dist/index.cjs` | 350 KB | the SmallWebRTC transport is bundled in — see "Node ESM" below |
| your app's entry chunk | **+7.9 KB raw / +0.5 KB gzip** vs 0.1.0 | measured with esbuild + code splitting |
| avatar chunk | 571 KB raw / 148 KB gzip | fetched only when `avatar` is set |
| LiveKit chunk | 548 KB raw / 143 KB gzip | fetched only on the LiveKit transport |
| `dist/index.global.js` (`<script>`) | 436 KB raw / 120 KB gzip | voice only; +8 KB vs 0.1.0 |
| `dist/index.full.global.js` | 1.49 MB raw / 414 KB gzip | avatar + LiveKit bundled, for `<script>` pages |

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
  automatically if credit runs out.

## Testing

`npm test` covers the decisions `start()` makes before any media flows:
credential selection, transport choice, the query params the gateway is asked
for, and the audio-only fallback when an avatar mint fails. Anything needing a
real browser — the WebRTC handshake, the Simli render loop, LiveKit room join,
autoplay behaviour — is **not** covered by the suite and has to be exercised in a
browser.

## License

MIT
