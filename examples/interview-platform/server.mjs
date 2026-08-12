/**
 * A small but complete Whissle application, server side. About 200 lines.
 *
 * It does the four things every real integration does, and nothing else:
 *
 *   1. turns each entry in agents.json into a Whissle agent, once
 *   2. lists the agents this app owns
 *   3. mints a short-lived session token per user, behind YOUR auth
 *   4. reads back the sessions that have happened, with transcripts and scores
 *
 * The secret key lives here and only here. The browser gets a token that names
 * one agent and expires in fifteen minutes — never a key. That is the whole
 * security model, and it is the one thing to copy exactly.
 *
 * Deliberately has no database. Agents are a JSON file, the id cache is a Map,
 * and "auth" is a header. Swap those three for your own and this is production
 * shaped; keep reading past them and there is nothing else to swap.
 *
 *   npm install && npm start        →  http://localhost:4000
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WhissleClient } from "@whissle/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);

const apiKey = process.env.WHISSLE_API_KEY;
if (!apiKey) {
  console.error(
    "\n  Set WHISSLE_API_KEY to a workspace secret key (wsk_…).\n" +
      "  Create one at whissle.ai → Settings → API keys, with scopes:\n" +
      "  agents:read agents:write kb:read kb:write calls:read\n",
  );
  process.exit(1);
}
const whissle = new WhissleClient({ apiKey });

/** Every agent this app owns, declared. Edit this file to change the app. */
const defs = JSON.parse(readFileSync(join(here, "agents.json"), "utf8"));

/**
 * definition id → Whissle agent id.
 *
 * A Map because this example has no database. Put it in yours and agents
 * survive a restart; leave it here and the first session after a restart
 * re-provisions, which is slower but never wrong.
 */
const provisioned = new Map();

// ── turning a definition into an agent ───────────────────────────────────────

/** An interview agent's rules come from its skills and question bank. */
const interviewPrompt = (d) =>
  `You are a professional interviewer for "${d.name.replace(/^Interview — /, "")}" ` +
  `(${d.interview.level} level). Assess: ${d.interview.skills.join(", ")}.\n\n` +
  `Ask ONE question at a time and let the candidate finish. Follow up when an ` +
  `answer is thin, move on when it is solid. Keep it under ten minutes.\n\n` +
  `Draw your questions from:\n` +
  d.interview.questions.map((q, i) => `${i + 1}. ${q}`).join("\n") +
  `\n\nWhen you move to a new question, announce it so the page can display it: ` +
  `send a server message {"t":"question","index":<0-based>,"text":"<the question>"}. ` +
  `When the interview is over, send {"t":"complete"}.`;

/** …and its rubric from the same skills, so the two cannot drift apart. */
const interviewRubric = (d) =>
  `Grade this interview. Score each of these 0-5 on what the candidate actually ` +
  `demonstrated: ${d.interview.skills.join(", ")}. A candidate who barely engaged ` +
  `scores low — say so plainly. Return per-skill scores, strengths, areas to ` +
  `improve, and a two-sentence summary.`;

/**
 * The agent for a definition, created on first use.
 *
 * Creating an agent does NOT apply its type's default prompt — whatever you
 * send IS its brain — so everything it knows has to be in the prompt. Embedding
 * must be enabled or the session mint refuses, and enabling it requires an
 * origin list even though a secret-key mint ignores origins.
 */
async function agentFor(def) {
  if (provisioned.has(def.id)) return provisioned.get(def.id);

  // Adopt an agent from a previous run rather than making a second one.
  const existing = (await whissle.agents.list()).find((a) => a.name === def.name);
  const agent =
    existing ??
    (await whissle.agents.create({
      name: def.name,
      agentType: def.type,
      direction: "inbound",
      systemPrompt: def.interview ? interviewPrompt(def) : def.prompt,
      greeting: def.greeting ?? `Hello — I'm ready when you are.`,
      ...(def.interview ? { scoring_prompt: interviewRubric(def) } : {}),
    }));

  if (!existing) {
    await whissle.embed.enable(agent.id, { origins: [`http://localhost:${PORT}`], text: true });
    // What makes this agent know YOUR domain rather than the domain in general.
    if (def.knowledge) {
      await whissle.kb.addSnippet(agent.id, def.knowledge, `${def.name} — reference`);
    }
    console.log(`  provisioned "${agent.name}"  (${agent.id})`);
  }
  provisioned.set(def.id, agent.id);
  return agent.id;
}

/** Provision everything up front so the first user doesn't wait for it. */
async function provisionAll() {
  for (const def of defs) {
    try {
      await agentFor(def);
    } catch (err) {
      // One bad definition must not stop the app booting; it just isn't offered.
      console.error(`  could not provision "${def.name}": ${err?.message ?? err}`);
    }
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * Stand-in for your authentication.
 *
 * Whatever replaces it must answer one question before a token is minted: who
 * is this, and may they talk to this agent? That decision is yours because your
 * app is the only thing that knows the answer — which is exactly why the key
 * lives on this side.
 */
const userFrom = (req) => req.headers["x-user"] || "demo-user";

/** The agent ids this app owns, so `sessions` never shows somebody else's. */
const ownIds = () => new Set(provisioned.values());

const routes = {
  /** What this user can talk to. */
  "GET /api/agents": async (_req, res) => {
    const live = await whissle.agents.list();
    const byId = new Map(live.map((a) => [a.id, a]));
    return json(
      res,
      200,
      defs
        .filter((d) => provisioned.has(d.id))
        .map((d) => {
          const a = byId.get(provisioned.get(d.id));
          return {
            id: d.id,
            agentId: provisioned.get(d.id),
            name: d.name,
            type: d.type,
            summary: d.summary,
            avatar: d.avatar ?? null,
            greeting: a?.greeting ?? d.greeting ?? null,
            questions: d.interview?.questions ?? [],
          };
        }),
    );
  },

  /** The one call the browser makes before a session. */
  "POST /api/sessions": async (req, res, body) => {
    const def = defs.find((d) => d.id === body.agent);
    if (!def) return json(res, 404, { error: `No agent "${body.agent}".` });

    const user = userFrom(req);
    const agentId = await agentFor(def);
    const session = await whissle.embed.sessionToken(agentId, {
      // Your identifiers, attached to the call record — so afterwards you look
      // the session up instead of guessing which one it was.
      metadata: { user, agent: def.id },
    });

    console.log(`  ${user} → ${def.name}  (session ${session.session_id})`);
    // Hand the page the whole descriptor. `transport` and `ice_servers` are how
    // to connect and with what; sending only the token would make the browser
    // invent its own ICE config, which is how clients end up pinned to a TURN
    // server that was retired a year ago.
    return json(res, 200, { ...session, agent: { id: def.id, name: def.name, avatar: def.avatar ?? null } });
  },

  /** Everything that has happened, newest first. */
  "GET /api/sessions": async (_req, res) => {
    const mine = ownIds();
    const calls = await whissle.calls.list({ limit: 50 });
    const names = new Map(defs.filter((d) => provisioned.has(d.id)).map((d) => [provisioned.get(d.id), d.name]));
    return json(
      res,
      200,
      calls
        .filter((c) => mine.has(c.agent_id))
        .map((c) => ({ ...c, agentName: names.get(c.agent_id) ?? c.agent_name })),
    );
  },
};

/** One session in full: the transcript, and the score once it exists. */
async function sessionDetail(id) {
  const [call, result] = await Promise.all([
    whissle.calls.get(id),
    // Scoring runs after a session ends, so "not yet" is a normal answer here,
    // not a failure. The page renders it as pending.
    whissle.calls.result(id).catch(() => null),
  ]);
  return { call, result };
}

createServer(async (req, res) => {
  const [path] = req.url.split("?");

  try {
    const route = routes[`${req.method} ${path}`];
    if (route) {
      let body = {};
      if (req.method !== "GET") {
        const raw = await new Promise((r) => {
          let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d));
        });
        try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { error: "Bad JSON." }); }
      }
      return await route(req, res, body);
    }

    const detail = req.method === "GET" && path.match(/^\/api\/sessions\/([\w-]+)$/);
    if (detail) return json(res, 200, await sessionDetail(detail[1]));
  } catch (err) {
    // WhissleError carries the platform's own status: 402 is out of credit, 403
    // a missing scope. Passing it through beats a blanket 500, which sends
    // people hunting a bug that isn't there.
    const status = err?.status || 500;
    console.error(`  ${status} ${err?.message ?? err}`);
    return json(res, status, { error: String(err?.message ?? err) });
  }

  // Static: the single page and its assets.
  const file = path === "/" ? "/index.html" : path;
  try {
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    res.writeHead(200, { "content-type": types[extname(file)] ?? "text/plain" });
    res.end(readFileSync(join(here, file)));
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(PORT, async () => {
  console.log(`\n  Whissle example app → http://localhost:${PORT}\n`);
  await provisionAll();
  console.log(`\n  ${provisioned.size}/${defs.length} agent(s) ready.\n`);
});
