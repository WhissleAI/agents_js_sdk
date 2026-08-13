// The text half of an omni-channel agent.
//
// A Whissle agent is one brain with several mouths: the same prompt, knowledge base
// and tools answer a phone call, a browser voice session and a typed message. Until
// 0.5.0 this SDK could only reach the voice one, which left an embedder with no answer
// for the two most common cases on a public page — a visitor who denies the microphone,
// and a visitor who simply doesn't want to talk out loud (an open-plan office, a train,
// a shared room). Their only option was to drop the widget.
//
// The wire is `POST /api/embed/chat/turn`, authorised by the SAME session token the
// voice path uses. It is deliberately NOT single-use — a thread is many turns over one
// widget load — so one mint carries a whole conversation, bounded by the token's expiry,
// the origin binding and a per-token burst limit.
//
// Streaming, honestly: this endpoint answers with one JSON body. The SSE envelope
// (`open` → `delta`* → `done`) lives on the authenticated `/api/chat` route, which a
// browser holding a publishable key cannot call and should not be able to. So
// `sendText` resolves once, with the whole reply. When the embed route grows a
// streaming sibling this is where it will land; until then the SDK does not pretend to
// stream, because a fake stream that arrives all at once is a worse lie than no stream.

/** What `POST /api/embed/chat/turn` returns. */
export interface TextTurn {
  /** The agent's reply, in full. */
  reply: string;
  /**
   * The gateway's `conversations` row id for this thread.
   *
   * Useful for correlating with the session history API — and **not** what resumes a
   * conversation. The gateway keys a thread on `external_id`, which it reads from the
   * request's `session_id`; it has no parameter that takes a conversation row id at
   * all. Use `threadId` (and `agent.resumeTextThread`) to come back to this thread.
   */
  conversationId: string;
  /**
   * The key this thread is filed under — what to persist and hand back to resume it
   * on a later page load. Sent as `session_id`, which is the field the gateway reads.
   */
  threadId: string | null;
  /** The session id from the mint, echoed. */
  sessionId?: string;
  /** Names of the tools that ran during this turn, in order. */
  toolsUsed: string[];
  /** Sources behind the reply, when the tools produced citations. */
  evidence: unknown[];
}

/** An image to send with a text turn — a `data:` URL, or raw base64 with its type. */
export type TextImage = string | { base64: string; media_type: string };

export interface SendTextOptions {
  /**
   * Images the visitor attached. A photo of the part they need, the error on their
   * screen, the form they're stuck on — the reason this belongs on a public widget.
   * Up to four; the same shape every other Whissle surface accepts.
   */
  images?: TextImage[];
  /**
   * Continue a specific thread — a `threadId` from an earlier turn. Defaults to the
   * one this channel is already on, so ordinary back-and-forth needs nothing here.
   */
  threadId?: string;
}

/** Thrown by `sendText`. `code` is the HTTP status, so a caller can branch on it. */
export class WhissleTextError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "WhissleTextError";
  }
}

/**
 * Why a text turn failed, said in words a visitor can act on.
 *
 * The raw statuses are unhelpful on a widget — "402" tells a visitor nothing and tells
 * the developer who embedded it almost as little. Each of these is a genuinely
 * different situation with a genuinely different fix, and collapsing them into
 * "something went wrong" is what makes an embedded agent impossible to debug from the
 * outside.
 */
function explain(status: number, detail: string | undefined): string {
  switch (status) {
    case 400:
    case 413:
      return detail || "That message couldn't be sent.";
    case 401:
      return "This session has expired — start a new one.";
    case 403:
      return "This site isn't allowed to use this agent. Add its origin in the agent's Embed settings.";
    case 402:
      return "This agent is out of credit and can't reply right now.";
    case 404:
      return "This agent isn't set up for text. Turn on text replies in its Embed settings.";
    case 429:
      return detail || "Too many messages — please slow down a moment.";
    case 503:
      return "Embedding isn't available right now.";
    default:
      return detail || `Couldn't reach the agent (${status}).`;
  }
}

/**
 * A typed conversation with one agent, over one minted session.
 *
 * Holds the thread key so consecutive turns continue the same conversation rather than
 * starting the agent cold on every message — the difference between an assistant and a
 * search box.
 *
 * THE KEY IS `session_id`, AND ONLY `session_id`. This is worth stating because the
 * obvious guess is wrong and fails silently. The gateway's request model is
 * `ChatTurnRequest {token, message, session_id, images}` (`routes/embed.py`), pydantic
 * DROPS anything else, and the thread is opened as
 *
 *     external_id = (body.session_id or "").strip() or claims["sid"]
 *
 * so a `conversation_id` in the body — the field name the RESPONSE uses, and the one
 * this SDK used to send — is read by nothing at all. It looked like it worked, because
 * the fallback to the token's own `sid` keeps consecutive turns on one thread within a
 * single page load. It only breaks on the case resuming exists for: a visitor who comes
 * back, whose new page load minted a token with a NEW `sid`, and who therefore got a
 * cold agent while the SDK told the integrator it was resuming.
 */
export class TextChannel {
  /** The `external_id` this thread is filed under. `null` until we know one. */
  private threadKey: string | null;
  /** The gateway's conversation row id, for correlation only — never sent back. */
  private conversationId: string | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    /** The mint's session id. The default thread key, and what the gateway would fall
     *  back to on its own — sending it explicitly is what lets a caller REPLACE it. */
    sessionId?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.threadKey = sessionId || null;
  }

  /** The key that resumes this thread, once one is known. */
  get thread(): string | null {
    return this.threadKey;
  }

  /** The gateway's conversation row id for this thread, if a turn has happened. */
  get conversation(): string | null {
    return this.conversationId;
  }

  /** Resume a thread from a previous page load, by its `threadId`. */
  resume(threadId: string): void {
    if (threadId) this.threadKey = threadId;
  }

  async send(message: string, opts: SendTextOptions = {}): Promise<TextTurn> {
    const body: Record<string, unknown> = { token: this.token, message };
    // Whichever key we hold, under the ONE name the gateway reads. Sending none is
    // survivable — the gateway falls back to the token's `sid` — but it is exactly the
    // case that goes cold on the next page load, so we prefer to say it.
    const thread = opts.threadId || this.threadKey;
    if (thread) body.session_id = thread;
    if (opts.images?.length) body.images = opts.images;

    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new WhissleTextError(0, err instanceof Error ? err.message : "Network error.");
    }
    if (!res.ok) {
      let detail: string | undefined;
      try {
        const j = (await res.json()) as { detail?: unknown };
        if (typeof j?.detail === "string") detail = j.detail;
      } catch {
        /* a non-JSON error body is still an error */
      }
      throw new WhissleTextError(res.status, explain(res.status, detail));
    }
    const j = (await res.json()) as {
      reply?: string;
      conversation_id?: string;
      session_id?: string;
      tools_used?: unknown;
      evidence?: unknown;
    };
    if (j.conversation_id) this.conversationId = j.conversation_id;
    // Learn the key when we were minted without one. The response's `session_id` is
    // the token's own `sid` — precisely the `external_id` the gateway just filed this
    // thread under — so adopting it makes `threadId` resumable even for a caller who
    // handed us a bare token string with no session id in it. Only when we hold none:
    // if the caller CHOSE a key, the echo is the token's sid, not theirs, and taking
    // it would silently move them off their own thread.
    if (!this.threadKey && j.session_id) this.threadKey = j.session_id;
    return {
      reply: String(j.reply ?? ""),
      conversationId: String(j.conversation_id ?? ""),
      threadId: this.threadKey,
      sessionId: j.session_id,
      toolsUsed: Array.isArray(j.tools_used) ? j.tools_used.map(String) : [],
      evidence: Array.isArray(j.evidence) ? j.evidence : [],
    };
  }
}
