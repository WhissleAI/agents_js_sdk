/**
 * The Signal Console, server side. Four jobs, no dependencies, no build step.
 *
 *   1. find the agent to talk to (by id, by name, or the first one this key owns)
 *   2. mint a short-lived session token — the secret key never reaches the page
 *   3. serve the SDK build sitting next door, so the console exercises THIS checkout
 *   4. store and list recorded sessions, which is what makes replay possible
 *
 * The key lives here and only here. The browser gets a token that names one agent
 * and expires in fifteen minutes. Nothing in this file ever prints it.
 *
 *   WHISSLE_API_KEY=wsk_… npm start      →  http://localhost:4100
 */
import { readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4100);
const BASE_URL = process.env.WHISSLE_BASE_URL || "https://aws-gateway-backend.whissle.ai/bot";
const SDK_VERSION = "0.5";
const RECORDINGS = join(here, "sessions");

/** One log file per run of the page, opened on the first event. */
let logFile = null;

// ── the key ──────────────────────────────────────────────────────────────────
// Either in the environment, or in a file of KEY=value lines (WHISSLE_KEY_FILE).
// The file path is convenient; the key itself is never echoed, logged or sent to
// the browser under any circumstances.
function loadKey() {
  if (process.env.WHISSLE_API_KEY) return process.env.WHISSLE_API_KEY.trim();
  const file = process.env.WHISSLE_KEY_FILE;
  if (!file) return null;
  const line = readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("WHISSLE_API_KEY="));
  return line ? line.slice("WHISSLE_API_KEY=".length).replace(/^["']|["']$/g, "").trim() : null;
}

const apiKey = loadKey();
if (!apiKey) {
  console.error(
    "\n  Set WHISSLE_API_KEY to a workspace secret key (wsk_…), or point\n" +
      "  WHISSLE_KEY_FILE at a file containing WHISSLE_API_KEY=…\n" +
      "  Create one at whissle.ai → Settings → API keys (scopes: agents:read).\n",
  );
  process.exit(1);
}
if (apiKey.startsWith("wpk_")) {
  console.error("\n  That is a publishable key. This server mints tokens and needs a secret (wsk_) key.\n");
  process.exit(1);
}

// ── the platform ─────────────────────────────────────────────────────────────
async function platform(path, init = {}) {
  const r = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body?.detail ?? body?.error ?? `${path} → ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return body;
}

/**
 * Which agent this console is pointed at.
 *
 * An id wins. Otherwise the first agent whose name matches WHISSLE_AGENT_NAME
 * (default: anything with "demo" in it), otherwise the first agent the key owns.
 * Resolved once at boot so the page never waits for it.
 */
let target = null;
async function resolveAgent() {
  const list = await platform("/api/agents");
  const rows = Array.isArray(list) ? list : (list.agents ?? list.items ?? []);
  const wanted = process.env.WHISSLE_AGENT_ID;
  const pattern = new RegExp(process.env.WHISSLE_AGENT_NAME ?? "demo", "i");
  const agent =
    (wanted && rows.find((a) => a.id === wanted)) ||
    rows.find((a) => pattern.test(a.name ?? "")) ||
    rows[0];
  if (!agent) throw new Error("This key owns no agents.");

  target = {
    id: agent.id,
    name: agent.name,
    type: agent.agent_type ?? agent.type ?? null,
    greeting: agent.greeting ?? null,
    // The transcriber. NOT a verdict on the affect lanes: the metadata head can run
    // as a sidecar beside a Deepgram ear, and on this deployment it does — a Deepgram
    // agent still delivered emotion and intent distributions. Only the frames that
    // actually arrive can say, which is why the console counts them on screen.
    stt: agent.stt_provider ?? null,
    tools: (agent.tools ?? []).filter((t) => t?.enabled !== false).map((t) => t.name ?? t),
  };
  return target;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const routes = {
  /** What the console is pointed at. No credential of any kind in this payload. */
  "GET /api/agent": async (_req, res) => {
    if (!target) await resolveAgent();
    return json(res, 200, target);
  },

  /** The one call the browser makes before a session. */
  "POST /api/session": async (_req, res) => {
    if (!target) await resolveAgent();
    const session = await platform("/api/embed/session-token", {
      method: "POST",
      body: JSON.stringify({
        api_key: apiKey,
        agent_id: target.id,
        metadata: { app: "signal-console" },
      }),
    });
    console.log(`  session ${session.session_id} → ${target.name} (${session.transport?.kind ?? "webrtc"})`);
    // Hand the page the whole descriptor: the token alone would make the browser
    // invent its own ICE config and ignore the transport the platform advertises.
    return json(res, 200, { ...session, agent: target });
  },

  /**
   * The live event stream, mirrored to the terminal and to a log file.
   *
   * The page is being filmed, so the operator wants a text record beside the video —
   * something greppable afterwards, at the same offsets the timeline showed. The
   * browser batches; this just prints what arrives, in order, one line each.
   */
  "POST /api/log": async (_req, res, body) => {
    const events = Array.isArray(body?.events) ? body.events : [];
    if (!events.length) return json(res, 200, { ok: true });
    if (!logFile) {
      mkdirSync(RECORDINGS, { recursive: true });
      logFile = join(RECORDINGS, `live-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`);
      console.log(`\n  logging this session → sessions/${basename(logFile)}\n`);
    }
    const lines = events.map(
      (e) => `[${String((e.t / 1000).toFixed(3)).padStart(8)}s] ${String(e.type).padEnd(18)} ${e.summary ?? ""}`,
    );
    for (const l of lines) console.log(l);
    appendFileSync(logFile, lines.join("\n") + "\n");
    return json(res, 200, { ok: true, file: basename(logFile) });
  },

  /** Every recording on disk, newest first — what the replay picker lists. */
  "GET /api/recordings": async (_req, res) => {
    if (!existsSync(RECORDINGS)) return json(res, 200, []);
    const files = readdirSync(RECORDINGS).filter((f) => f.endsWith(".json"));
    return json(
      res,
      200,
      files
        .map((f) => {
          try {
            const r = JSON.parse(readFileSync(join(RECORDINGS, f), "utf8"));
            return {
              file: f,
              recordedAt: r.recordedAt ?? null,
              agent: r.agent?.name ?? null,
              durationMs: r.durationMs ?? 0,
              events: r.events?.length ?? 0,
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt))),
    );
  },

  /** Save a recording so the same run can be re-shot as many times as it takes. */
  "POST /api/recordings": async (_req, res, body) => {
    if (!Array.isArray(body?.events)) return json(res, 400, { error: "No events." });
    mkdirSync(RECORDINGS, { recursive: true });
    // basename() so a name from the page can never write outside this directory.
    const name = basename(String(body.name ?? "").replace(/[^\w.-]+/g, "-") || `session-${Date.now()}`);
    const file = name.endsWith(".json") ? name : `${name}.json`;
    writeFileSync(join(RECORDINGS, file), JSON.stringify(body, null, 1));
    console.log(`  recorded ${body.events.length} events → sessions/${file}`);
    return json(res, 200, { file });
  },
};

createServer(async (req, res) => {
  const [path] = req.url.split("?");
  try {
    const route = routes[`${req.method} ${path}`];
    if (route) {
      let body = {};
      if (req.method !== "GET") {
        const raw = await new Promise((r) => {
          let d = "";
          req.on("data", (c) => (d += c));
          req.on("end", () => r(d));
        });
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return json(res, 400, { error: "Bad JSON." });
        }
      }
      return await route(req, res, body);
    }
  } catch (err) {
    const status = err?.status || 500;
    console.error(`  ${status} ${err?.message ?? err}`);
    return json(res, status, { error: String(err?.message ?? err) });
  }

  // The SDK itself — served from the dist/ next door, so this console exercises the
  // code on this branch in a real browser rather than whatever npm last published.
  if (path === "/sdk/index.js" || path === "/sdk/index.js.map") {
    const local = resolve(here, "../..", "dist", path.slice("/sdk/".length));
    try {
      const body = readFileSync(local);
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(body);
    } catch {
      return res.writeHead(302, { location: `https://esm.sh/@whissle/agents@${SDK_VERSION}` }).end();
    }
  }

  // Static. Read before writing a status — a 200 written ahead of a missing file
  // leaves nothing to answer 404 with, and the second writeHead takes the server down.
  const file = resolve(here, "." + (path === "/" ? "/index.html" : path));
  if (!file.startsWith(here + sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  let body;
  try {
    body = readFileSync(file);
  } catch {
    res.writeHead(404).end("Not found");
    return;
  }
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
  // No caching. This is a development console people edit while it is open, and a
  // stylesheet served from the disk cache is an hour of debugging a fix that shipped.
  res.writeHead(200, { "content-type": types[extname(file)] ?? "text/plain", "cache-control": "no-store" });
  res.end(body);
}).listen(PORT, async () => {
  console.log(`\n  Whissle Signal Console → http://localhost:${PORT}\n`);
  try {
    const a = await resolveAgent();
    console.log(`  agent   ${a.name}  (${a.id})`);
    // Deliberately NOT a claim about what the affect lanes will carry. `stt_provider`
    // is the transcriber; the metadata head can be running beside it as a sidecar, and
    // on this deployment it demonstrably is (a Deepgram agent still delivered emotion
    // and intent distributions). Only the frames that actually arrive can say.
    console.log(`  ear     ${a.stt ?? "unknown"}`);
    console.log(`  tools   ${a.tools.join(", ") || "none declared"}\n`);
  } catch (err) {
    console.error(`  could not reach the platform: ${err?.message ?? err}\n`);
  }
});
