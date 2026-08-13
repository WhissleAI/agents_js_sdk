# A small Whissle app

Four agents, live voice calls with or without a face, and every past session with
its transcript and score — and the browser never holds a Whissle key.

It doubles as the **reference for everything `@whissle/agents` can do**: one page
wiring every event the SDK emits, so "what does `tool-finished` look like" has an
answer you can watch rather than read.

```bash
npm install
export WHISSLE_API_KEY=wsk_live_…      # whissle.ai → Settings → API keys
npm start                              # http://localhost:4000
```

No database, no build step, no framework. Open the page, pick an agent, allow the
microphone.

**Which SDK does it run?** The one next door. `server.mjs` serves this repo's
`dist/` at `/sdk/index.js`, so `npm start` from inside the repo loads your working
tree into a real browser — the only way to find out whether a change actually
works before it is published. Copy this directory out on its own and there is no
local build, so it falls back to the published package on esm.sh; both run, only
the first proves anything.

The page resolves the SDK with an **import map** rather than a bundler, which is
also why a plain `<script src>` cannot work here: the SDK imports its dependency by
bare name (`@pipecat-ai/client-js`), and a browser fetching the module raw throws
"Failed to resolve module specifier" before a line of it runs. In an app with a
build step none of this exists — `npm i @whissle/agents` and import it by name.

Three views:

| | |
|---|---|
| **Agents** | what `agents.json` declared, provisioned on the platform |
| **Call** | a live conversation — avatar on or off, per call |
| **Sessions** | what has happened, with transcripts and scores |

---

## What happens when you click an agent

```
browser                    this server                      Whissle
   │  POST /api/sessions        │
   ├───────────────────────────►│  who is this user?        (your auth)
   │                            │  may they talk to this agent?
   │                            ├──────────────────────────────►  create it, once
   │                            ├──────────────────────────────►  mint a session
   │◄───────────────────────────┤  token + transport + ICE
   │                                                          
   ├─────────────────  join the session directly  ───────────────►
        voice, avatar, transcripts — the server is out of the loop
```

The server's job ends once the token is issued. Media never passes through it.

---

## The three files

| | |
|---|---|
| **`agents.json`** | Every agent the app owns. Editing this file is how you change the app. |
| **`server.mjs`** | ~200 lines. Provisions agents, mints session tokens, reads sessions back. Holds the secret key. |
| **`index.html`** | One page, three views. Runs the conversation with `@whissle/agents`. Holds nothing. |

### `agents.json`

Four kinds, to show the range — two graded interviews, a tutor, and a voice-only
assistant:

```jsonc
{
  "id": "line-cook",
  "name": "Interview — Line Cook",
  "type": "skills_exam",          // whissle agents types, for the full catalogue
  "avatar": "F2-TL",              // omit for voice only
  "knowledge": "Poultry to 74 °C…",   // what makes it know YOUR domain
  "interview": {                  // present → prompt + rubric are built from it
    "skills": ["Food safety and HACCP", …],
    "questions": ["What are the safe internal temperatures…", …]
  }
}
```

An entry with an `interview` block becomes a graded examiner: its prompt and its
scoring rubric are both generated from the same skills, so the two cannot drift
apart. An entry without one just uses `prompt` and `greeting` — that is all a
tutor or an assistant needs.

---

## The one rule

A `wsk_` secret key carries full authority over your workspace. **It stays on
the server.** The browser gets a session token that names one agent and expires
in fifteen minutes.

```js
// server — behind YOUR auth
const session = await whissle.embed.sessionToken(agentId, {
  metadata: { user, agent },          // yours; lands on the call record
});
```

```js
// browser — no key
new WhissleAgent({
  getToken: () => fetch("/api/sessions", { method: "POST", … }).then((r) => r.json()),
});
```

Return the **whole** mint response from `getToken`, not just `.token`. It also
carries `transport` (which transport to use) and `ice_servers` (belonging to the
box on the other end of the connection). Hand back only the token and the SDK has
to guess at both — which is how a client ends up pinned to a TURN server that was
decommissioned a year ago, failing in the worst way available: ICE never
completes and never errors, so the page just sits there.

If your product has no backend and no users, you can put a **publishable**
`wpk_` key in the page instead and let the SDK mint. Never a `wsk_` — the SDK
throws if you try, because the mint would otherwise accept it and the mistake
would be silent.

---

## Definitions become agents

On boot, each entry becomes an agent — or is adopted if one with that name
already exists, so restarting never makes a second copy.

```js
await whissle.agents.create({
  name: def.name,
  agentType: def.type,
  systemPrompt: def.interview ? interviewPrompt(def) : def.prompt,
  scoring_prompt: interviewRubric(def),      // graded agents only
});
await whissle.embed.enable(agent.id, { origins: [...] });
await whissle.kb.addSnippet(agent.id, def.knowledge, `${def.name} — reference`);
```

Adoption matches on **name**, so an agent your workspace already has under the
same name is reused rather than duplicated — and its sessions show up in this
app's history. Rename in `agents.json` if you want a separate one.

Two things that surprise people:

- **Creating an agent does not apply its type's default prompt.** Whatever you
  send *is* its brain. If you want the `skills_exam` blueprint's behaviour, read
  it from `whissle.agentTypes()` and compose your section onto it — otherwise
  you have silently replaced everything the type knew how to do.
- **Embedding must be enabled or the mint refuses**, and enabling it requires an
  origin list even though a secret-key mint ignores origins. Supply the hosts
  your app runs on.

The knowledge base is what makes an agent know *your* domain rather than the
domain in general. Ask the line-cook examiner a food-safety question and it
answers with the temperatures from `agents.json`, because they are in its
knowledge — not because a model happened to remember them.

---

## A face, or not

The avatar is rendered in the browser, so whether a call has one is a decision
the page makes — same agent, same session, one option different:

```js
new WhissleAgent({
  getToken,
  ...(withAvatar ? { avatar: { id: "F2-TL", container: faceEl } } : {}),
});
```

The container must exist **before** `start()`. If the face fails to come up the
call continues audio-only and you get `avatar-failed` — a missing face should
never cost someone the conversation.

## The agent drives your UI

The examiner is told, in its prompt, to announce each question as a structured
message. The page listens:

```js
agent.on("server-message", (m) => {
  if (m.t === "question") showQuestion(m.text);
  if (m.t === "complete") finish();
});

agent.send("wrap-up");     // and you can talk back
```

Anything the SDK doesn't consume itself reaches you untouched. This is the seam
for whatever your product needs — a progress bar, a form filling itself in, a
supervisor's dashboard.

---

## When the interviewer goes quiet

An agent that stops talking to look something up is the most alarming thing in a
mock interview: the candidate assumes they broke it, and starts talking over the
answer. Two things say otherwise, and both come free.

```js
agent.on("thinking", (s) => {
  thinkingStrip.hidden = !s.active;
  thinkingStrip.textContent = s.label ?? "Checking something…";
});
```

`thinking` is already one edge each way however many tools the turn fired, so
there is nothing to debounce. The audible half — a short cue per tool, chosen by
the platform and played from whissle.ai's own mastered bank — the SDK plays for
you; the **Tool sounds** checkbox is `agent.setEarconsMuted()`.

And when you want the detail rather than the boolean, the same turn arrives as
three events you can render — including what it answered *from*:

```js
agent
  .on("tool-started",  (t) => row(t.id, t.name, t.arguments))
  .on("tool-progress", (t) => progress(t.id, t.display))   // "Reading source 2 of 3…"
  // `ok === undefined` means it timed out and whether it worked is genuinely
  // unknown — which is not the same as failing.
  .on("tool-finished", (t) => done(t.id, t.ok, t.evidence));
```

Correlate by `t.id` (the `tool_call_id`), never by name: two calls to the same
tool can be in flight at once.

---

## The rest of what this page shows

| what you see | the event behind it |
|---|---|
| the caption keeping time with the voice | `agent-word` — one word as the TTS says it |
| the reply appearing sentence by sentence | `agent-partial` — the turn so far. `agent-transcript` only fires when the agent *stops*, so a long answer built from it alone sits empty and then dumps a paragraph |
| the caption turning red | `listening-started` arriving *between* `speaking-started` and `speaking-stopped` — the candidate talked over the interviewer. That is the barge-in edge |
| the one-line summary of what is being said | `gist`, on agents configured to emit one |
| `sounds hesitant · 41%` | `user-metadata` — the live acoustic read |
| the grey ticker of `endpoint`, `barge_in`, `flow_state` | `signal` — the pipeline's live prediction stream |
| "Demo limit reached" | `demo-limit` — the anonymous cap, said out loud instead of the call just stopping |

**On the acoustic read.** `emotion` is deliberately `undefined` whenever the
platform said `NEUTRAL`, because the platform writes `NEUTRAL` both for a genuinely
calm speaker and as the fallback when nothing was read at all — the wire is
identical. Rendering it would turn "we don't know" into "they are calm". So it is
shown as a leaning with its own probability, and never as a score. In an assessment
product that distinction is not a nicety.

---

## Typing to the agent

The composer under the transcript is one method with two behaviours, and the
difference is the point:

```js
// with a call up: injected into the SAME conversation, answered OUT LOUD.
// Resolves null — the reply arrives as speech, through agent-transcript.
await agent.sendText("k.singla@example.com");

// with no call: a text turn over HTTP, resolving with the reply and its receipts.
// No microphone, no WebRTC.
const turn = await agent.sendText("what's the marking scheme?");
turn.reply; turn.toolsUsed; turn.evidence;
```

The first is the voice↔text handoff — spell an email rather than repeating it four
times. The second is the visitor who refused the microphone, which is why this page
leaves the composer working after `start()` fails.

**Coming back later.** Persist `turn.threadId` and hand it to
`agent.resumeTextThread(id)` on the next page load (this page uses
`localStorage`). Use `threadId`, not `conversationId`: the latter is the gateway's
conversation row id and resumes nothing, so handing back the wrong one is an agent
that silently starts cold.

---

## The microphone

**Test microphone** is `agent.checkMicrophone()` — worth calling *before* showing
someone a Start button that needs it. It returns `null` when the microphone is
fine, and otherwise a problem whose message names the fix rather than the fault.

The picker below it is `listMicrophones()` + `setMicrophone()`. It stays hidden
until the labels are real: before permission is granted a browser returns one
unlabelled placeholder, so a picker drawn from it is a menu of nothing.

---

## Making it yours

1. **Replace `agents.json`.** An app for accountants, or for triage nurses, is
   this code with different entries.
2. **Rewrite the prompt builders in `server.mjs`.** How strict an examiner is,
   what the rubric rewards.
3. **Swap `userFrom()` for real authentication.** It is a header today. It only
   has to answer *who is this, and may they talk to this agent* — which is
   exactly why the key lives on your side.
4. **Put the `provisioned` Map in your database** so agents survive a restart.

Everything else can stay.

---

## Reading what happened

The **Sessions** view is `whissle.calls.list()` filtered to this app's agents,
with `calls.get()` for the transcript and `calls.result()` for the score.
Scoring runs after a call ends, so `ready: false` is a normal answer, not a
failure — the page shows it as pending.

The same data from a terminal:

```bash
whissle calls list --limit 10
whissle calls transcript <call-id>
whissle calls result <call-id> --wait     # the scorer's full evaluation
```

The CLI and this server speak the same REST contract, so what you see at a
prompt and what your app shows cannot drift apart.

---

## When it doesn't work

| | |
|---|---|
| **Hangs on connecting, no error** | Almost always ICE. Don't hard-code ICE or TURN — use what the mint returns. |
| **`402`** | The workspace is out of credit. `whissle usage`. |
| **`403 … missing required scope`** | Scopes are fixed when a key is created. Mint a new one. |
| **Avatar never appears** | Needs `@whissle/agents` ≥ 0.3.1, and the container must exist *before* `start()`. |
| **`Failed to resolve module specifier`** | The import map didn't load. It must come *before* the module script, and the page must be served over HTTP — opening `index.html` from the filesystem won't work. |
| **The agent replies but there is no cue** | Tool sounds are unchecked, or the agent is set to `tool_sounds: "call"` (the cue is mixed into the audio server-side instead, and the SDK stays out of the way). |
| **Microphone refused** | `localhost` is a secure context; a LAN IP is not. Serve over HTTPS to test from a phone. |

Sessions are metered against the workspace behind your key.
