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
  /** The thread this turn belongs to. Passed back automatically on later turns. */
  conversationId: string;
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
   * Continue a specific thread. Defaults to the one this channel is already on, so
   * ordinary back-and-forth needs nothing here.
   */
  conversationId?: string;
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
 * Holds the thread id so consecutive turns continue the same conversation rather than
 * starting the agent cold on every message — the difference between an assistant and a
 * search box.
 */
export class TextChannel {
  private conversationId: string | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    /** The mint's session id — what resumes this visitor's thread on a later page load. */
    private readonly sessionId?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The thread so far, if any turns have happened. */
  get thread(): string | null {
    return this.conversationId;
  }

  /** Resume a thread from a previous page load. */
  resume(conversationId: string): void {
    this.conversationId = conversationId;
  }

  async send(message: string, opts: SendTextOptions = {}): Promise<TextTurn> {
    const body: Record<string, unknown> = { token: this.token, message };
    // The gateway prefers an explicit thread and falls back to the mint's session id,
    // so send whichever we have. Sending neither starts a new thread every turn, which
    // reads to a visitor as an agent with no memory.
    const thread = opts.conversationId ?? this.conversationId;
    if (thread) body.conversation_id = thread;
    if (this.sessionId) body.session_id = this.sessionId;
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
    return {
      reply: String(j.reply ?? ""),
      conversationId: String(j.conversation_id ?? ""),
      sessionId: j.session_id,
      toolsUsed: Array.isArray(j.tools_used) ? j.tools_used.map(String) : [],
      evidence: Array.isArray(j.evidence) ? j.evidence : [],
    };
  }
}
