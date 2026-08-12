# Interview platform

A complete, working interview platform in about 250 lines. A candidate picks a
role, talks to an examiner with a face, and gets graded — and the browser never
holds a Whissle key.

```bash
npm install
export WHISSLE_API_KEY=wsk_live_…      # whissle.ai → Settings → API keys
npm start                              # http://localhost:4000
```

No database, no build step, no framework. Open the page, pick a role, allow the
microphone.

---

## What happens when you click a role

```
browser                    this server                      Whissle
   │  POST /api/interviews      │
   ├───────────────────────────►│  who is this candidate?   (your auth)
   │                            │  does this role have an agent yet?
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
| **`roles.json`** | What you interview for. Title, skills, questions, reference material. Editing this is how you make it yours. |
| **`server.mjs`** | ~150 lines. Turns roles into agents, mints session tokens, reads results. Holds the secret key. |
| **`index.html`** | One page. Runs the conversation with `@whissle/agents`. Holds nothing. |

---

## The one rule

A `wsk_` secret key carries full authority over your workspace. **It stays on
the server.** The browser gets a session token that names one agent and expires
in fifteen minutes.

```js
// server — behind YOUR auth
const session = await whissle.embed.sessionToken(agentId, {
  metadata: { candidate, role },      // yours; lands on the call record
});
```

```js
// browser — no key
new WhissleAgent({
  getToken: () => fetch("/api/interviews", { method: "POST", … }).then((r) => r.json()),
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

## Roles become agents

The first interview for a role creates its agent and never creates it again.

```js
await whissle.agents.create({
  name: `Interview — ${role.title}`,
  agentType: "skills_exam",
  systemPrompt: interviewerPrompt(role),   // your rules for the conversation
  scoring_prompt: scoringPrompt(role),     // your rubric
});
await whissle.embed.enable(agent.id, { origins: [...] });
await whissle.kb.addSnippet(agent.id, role.reference, `${role.title} — reference`);
```

Two things that surprise people:

- **Creating an agent does not apply its type's default prompt.** Whatever you
  send *is* its brain. If you want the `skills_exam` blueprint's behaviour, read
  it from `whissle.agentTypes()` and compose your section onto it — otherwise
  you have silently replaced everything the type knew how to do.
- **Embedding must be enabled or the mint refuses**, and enabling it requires an
  origin list even though a secret-key mint ignores origins. Supply the hosts
  your app runs on.

The knowledge base is what makes an examiner know *your* trade rather than
trades in general. Ask this one a food-safety question and it answers with the
temperatures from `roles.json`, because they are in its knowledge — not because
a model happened to remember them.

---

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

## Making it yours

1. **Replace `roles.json`.** An interview platform for accountants is this code
   with different rows.
2. **Rewrite the two prompts in `server.mjs`.** How strict the examiner is, what
   the rubric rewards.
3. **Swap `candidateFrom()` for real authentication.** It is a header today. It
   only has to answer *who is this, and may they interview for this role* —
   which is exactly why the key lives on your side.
4. **Put the `agents` Map in your database** so agents survive a restart.

Everything else can stay.

---

## Reading what happened

Scoring runs after the call ends, so `ready: false` is a normal answer — poll it.

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
| **Microphone refused** | `localhost` is a secure context; a LAN IP is not. Serve over HTTPS to test from a phone. |

Sessions are metered against the workspace behind your key.
