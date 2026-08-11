# @whissle/agents

Embed a **Whissle voice agent** into any web app. Build or configure the agent on
[platform.whissle.ai](https://platform.whissle.ai), grab a publishable key, and
run a live spoken conversation in the browser — as a ready-made widget or wired
into your own UI.

Sessions run on Whissle's realtime infrastructure and are metered against your
workspace. The publishable key is safe to ship in client code: it's restricted to
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

### Events

| Event | Payload | When |
|---|---|---|
| `connecting` | — | `start()` called, negotiating |
| `connected` | — | live session established |
| `disconnected` | — | session ended |
| `speaking-started` / `speaking-stopped` | — | agent turn boundaries |
| `user-transcript` | `string` | a finalized user utterance |
| `agent-transcript` | `string` | agent reply text |
| `error` | `string` | mic denied, origin not allowed, credits out, … |

## Inside a product that already has users

The setup above puts a publishable key in the page — right for a widget on a
public site, where every visitor is anonymous and the origin allowlist is the
control.

If your app already knows who the user is, you want the other shape: **your**
server decides who may talk to which agent, and the browser holds no Whissle
credential at all. Mint the session behind your own auth and hand back the token:

```ts
// your API route (server) — @whissle/sdk, secret key never leaves here
const session = await whissle.embed.sessionToken(agentId);
return Response.json({ token: session.token });     // 900s
```

```ts
// your page — no key
const agent = new WhissleAgent({
  getToken: () =>
    fetch("/api/voice-token", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => d.token),
});
await agent.start();
```

`getToken` runs on every `start()`, so a reconnect after a long idle fetches a
fresh token instead of reusing an expired one. With it, `apiKey` and `agentId`
are unnecessary — the token already names the agent.

A token minted server-side with a secret key is *server-trusted*: it carries no
origin, so there is no allowlist to keep in step with your deploy URLs.

## Options

```ts
new WhissleAgent({
  apiKey: "wpk_…",       // your publishable key — required unless getToken is set
  getToken: () => …,     // or: fetch a session token from your own backend
  agentId: "…",          // which agent to talk to (not needed with getToken)
  baseUrl: "…",          // optional — override the API host
  iceServers: [ … ],     // optional — custom ICE/TURN
});
```

Passing a **secret** (`wsk_`) key throws at construction. It would otherwise work
— the mint accepts it — while shipping full workspace authority to every visitor.

## Notes

- **Microphone**: the browser prompts for mic access on `start()`. Serve your
  page over HTTPS (WebRTC + mic require a secure context).
- **Allowed origins**: with a publishable key, a session is refused (403) from a
  site you haven't listed in the agent's Embed settings. Add your domain there.
  Tokens minted server-side with `getToken` are exempt — they carry no origin.
- **Metering**: each session debits your Whissle workspace wallet; a session ends
  automatically if credit runs out.

## License

MIT