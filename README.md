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

## Options

```ts
new WhissleAgent({
  apiKey: "wpk_…",       // required — your publishable key
  agentId: "…",          // which agent to talk to
  baseUrl: "…",          // optional — override the API host
  iceServers: [ … ],     // optional — custom ICE/TURN
});
```

## Notes

- **Microphone**: the browser prompts for mic access on `start()`. Serve your
  page over HTTPS (WebRTC + mic require a secure context).
- **Allowed origins**: a session is refused (403) from a site you haven't listed
  in the agent's Embed settings. Add your domain there.
- **Metering**: each session debits your Whissle workspace wallet; a session ends
  automatically if credit runs out.

## License

MIT