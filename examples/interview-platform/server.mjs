/**
 * A complete interview platform, server side. About 150 lines.
 *
 * It does the three things every real integration does, and nothing else:
 *
 *   1. turns each role you define into a Whissle agent, once
 *   2. mints a short-lived session token per candidate, behind YOUR auth
 *   3. reads back what happened when the interview ends
 *
 * The secret key lives here and only here. The browser gets a token that names
 * one agent and expires in fifteen minutes — never a key. That is the whole
 * security model, and it is the one thing to copy exactly.
 *
 * Deliberately has no database. Roles are a JSON file, sessions are a Map, and
 * "auth" is a header. Swap those three for your own and this is production
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

const roles = JSON.parse(readFileSync(join(here, "roles.json"), "utf8"));

/**
 * role id → Whissle agent id.
 *
 * A Map because this example has no database. Put it in yours and agents
 * survive a restart; leave it here and the first interview after a restart
 * re-provisions, which is slower but never wrong.
 */
const agents = new Map();

/** What the examiner is told to do. Your rules for the conversation. */
const interviewerPrompt = (role) =>
  `You are a professional interviewer for the role "${role.title}" ` +
  `(${role.level} level). Assess: ${role.skills.join(", ")}.\n\n` +
  `Ask ONE question at a time and let the candidate finish. Follow up when an ` +
  `answer is thin, move on when it is solid. Keep it under ten minutes.\n\n` +
  `Draw your questions from:\n${role.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n` +
  `When you move to a new question, call it out with a server message so the ` +
  `page can display it: {"t":"question","index":<0-based>,"text":"<the question>"}. ` +
  `When the interview is over, send {"t":"complete"}.`;

/** How the finished conversation gets graded. Your rubric. */
const scoringPrompt = (role) =>
  `Grade this interview for "${role.title}". Score each of these 0-5 on what the ` +
  `candidate actually demonstrated: ${role.skills.join(", ")}. A candidate who ` +
  `barely engaged scores low — say so plainly. Return per-skill scores, strengths, ` +
  `areas to improve, and a two-sentence summary.`;

/**
 * The role's agent, created on first use.
 *
 * Creating an agent does NOT apply its type's default prompt — whatever you
 * send IS its brain — so everything the examiner knows has to be in the prompt
 * above. Embedding must be enabled or the session mint refuses, and enabling it
 * requires an origin list even though a secret-key mint ignores origins.
 */
async function agentFor(role) {
  if (agents.has(role.id)) return agents.get(role.id);

  const existing = (await whissle.agents.list()).find((a) => a.name === `Interview — ${role.title}`);
  const agent =
    existing ??
    (await whissle.agents.create({
      name: `Interview — ${role.title}`,
      agentType: "skills_exam",
      direction: "inbound",
      systemPrompt: interviewerPrompt(role),
      greeting: `Hello, thanks for coming in. I'll be interviewing you for the ${role.title} role. Ready to begin?`,
      scoring_prompt: scoringPrompt(role),
    }));

  if (!existing) {
    await whissle.embed.enable(agent.id, { origins: [`http://localhost:${PORT}`], text: true });
    // Reference material the examiner can draw on. Optional, and the reason a
    // role's agent knows your trade rather than trades in general.
    if (role.reference) {
      await whissle.kb.addSnippet(agent.id, role.reference, `${role.title} — reference`);
    }
    console.log(`  provisioned "${agent.name}" (${agent.id})`);
  }
  agents.set(role.id, agent.id);
  return agent.id;
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
 * is this, and are they allowed to interview for this role? That decision is
 * yours because your app is the only thing that knows the answer — which is
 * exactly why the key lives on this side.
 */
const candidateFrom = (req) => req.headers["x-candidate"] || "demo-candidate";

const routes = {
  "GET /api/roles": async (_req, res) =>
    json(res, 200, roles.map(({ id, title, level, description }) => ({ id, title, level, description }))),

  /** The one call the browser makes before a session. */
  "POST /api/interviews": async (req, res, body) => {
    const role = roles.find((r) => r.id === body.role);
    if (!role) return json(res, 404, { error: `No role "${body.role}".` });

    const candidate = candidateFrom(req);
    const agentId = await agentFor(role);
    const session = await whissle.embed.sessionToken(agentId, {
      // Your identifiers, attached to the call record — so afterwards you look
      // the session up instead of guessing which one it was.
      metadata: { candidate, role: role.id },
    });

    console.log(`  ${candidate} → ${role.title}  (session ${session.session_id})`);
    // Hand the page the whole descriptor. `transport` and `ice_servers` are how
    // it connects and with what; sending only the token would make the browser
    // invent its own ICE config, which is how clients end up pinned to a TURN
    // server that was retired a year ago.
    return json(res, 200, { ...session, role: role.title, questions: role.questions });
  },

  /** What actually happened. `ready:false` is normal — scoring runs after the call. */
  "GET /api/interviews": async (_req, res) => {
    const calls = await whissle.calls.list({ limit: 20 });
    return json(res, 200, calls);
  },
};

createServer(async (req, res) => {
  const [path] = req.url.split("?");
  const route = routes[`${req.method} ${path}`];

  if (route) {
    let body = {};
    if (req.method !== "GET") {
      const raw = await new Promise((r) => {
        let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d));
      });
      try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { error: "Bad JSON." }); }
    }
    try {
      return await route(req, res, body);
    } catch (err) {
      // WhissleError carries the platform's own status: 402 is out of credit,
      // 403 is a missing scope. Passing it through beats a blanket 500, which
      // sends people hunting a bug that isn't there.
      const status = err?.status || 500;
      console.error(`  ${status} ${err?.message ?? err}`);
      return json(res, status, { error: String(err?.message ?? err) });
    }
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
}).listen(PORT, () => {
  console.log(`\n  Interview platform → http://localhost:${PORT}`);
  console.log(`  ${roles.length} role(s): ${roles.map((r) => r.title).join(", ")}`);
  console.log(`  Agents are provisioned on the first interview for each role.\n`);
});
