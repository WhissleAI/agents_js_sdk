import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

const DEFAULT_BASE_URL = "https://gateway-backend.whissle.ai/bot";
const DEFAULT_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export interface WhissleAgentOptions {
  /** Your publishable Whissle key (from the agent's Embed & SDK settings). Safe
   *  to ship in client code — it's origin-restricted and only authorizes a
   *  metered session with this agent. */
  apiKey: string;
  /** The agent to talk to (from platform.whissle.ai). */
  agentId?: string;
  /** Override the API base URL (self-hosted / staging). */
  baseUrl?: string;
  /** Override the ICE servers used for WebRTC. */
  iceServers?: RTCIceServer[];
}

export type WhissleEvent =
  | "connecting"
  | "connected"
  | "disconnected"
  | "speaking-started"
  | "speaking-stopped"
  | "user-transcript"
  | "agent-transcript"
  | "error";

type Handler = (payload?: unknown) => void;

/**
 * A single voice conversation with one Whissle agent.
 *
 *   const agent = new WhissleAgent({ apiKey: "wpk_…", agentId: "…" });
 *   agent.on("agent-transcript", (t) => console.log(t));
 *   await agent.start();      // asks for the mic, connects
 *   …
 *   agent.stop();
 *
 * Framework-agnostic: emits plain events you can wire into React/Vue/vanilla, or
 * use WhissleAgent.mount() for a ready-made widget.
 */
export class WhissleAgent {
  private opts: Required<Pick<WhissleAgentOptions, "apiKey" | "baseUrl" | "iceServers">> &
    WhissleAgentOptions;
  private client: PipecatClient | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private handlers = new Map<WhissleEvent, Set<Handler>>();
  private _state: "idle" | "connecting" | "connected" = "idle";

  constructor(options: WhissleAgentOptions) {
    if (!options?.apiKey) throw new Error("WhissleAgent: `apiKey` is required.");
    this.opts = {
      baseUrl: DEFAULT_BASE_URL,
      iceServers: DEFAULT_ICE,
      ...options,
      apiKey: options.apiKey,
    };
  }

  get state() {
    return this._state;
  }

  on(event: WhissleEvent, handler: Handler): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }

  off(event: WhissleEvent, handler: Handler): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  private emit(event: WhissleEvent, payload?: unknown) {
    this.handlers.get(event)?.forEach((h) => {
      try {
        h(payload);
      } catch (err) {
        console.error(`[whissle] handler for "${event}" threw`, err);
      }
    });
  }

  /** Mint a short-lived session token for this agent + origin. */
  private async mintToken(): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl}/api/embed/session-token`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // A publishable key (wpk_) resolves the org; agent_id picks the agent.
        // A per-agent embed key (wek_) is accepted too, for convenience.
        ...(this.opts.apiKey.startsWith("wek_")
          ? { embed_key: this.opts.apiKey }
          : { api_key: this.opts.apiKey }),
        agent_id: this.opts.agentId,
        parent_origin: typeof location !== "undefined" ? location.origin : undefined,
      }),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 403
          ? "This site isn't allowed to embed this agent. Add its origin in the agent's Embed settings."
          : "Couldn't start the agent (check the key + agent id).",
      );
    }
    const data = (await res.json()) as { token: string };
    return data.token;
  }

  /** Ask for the microphone and connect the live session. */
  async start(): Promise<void> {
    if (this._state !== "idle") return;
    this._state = "connecting";
    this.emit("connecting");
    try {
      const token = await this.mintToken();

      // Hidden element that plays the agent's audio.
      if (typeof document !== "undefined" && !this.audioEl) {
        this.audioEl = document.createElement("audio");
        this.audioEl.autoplay = true;
        this.audioEl.style.display = "none";
        document.body.appendChild(this.audioEl);
      }

      const client = new PipecatClient({
        enableMic: true,
        enableCam: false,
        transport: new SmallWebRTCTransport({ iceServers: this.opts.iceServers }),
        callbacks: {
          onConnected: () => {
            this._state = "connected";
            this.emit("connected");
          },
          onDisconnected: () => {
            this._state = "idle";
            this.emit("disconnected");
          },
          onBotStartedSpeaking: () => this.emit("speaking-started"),
          onBotStoppedSpeaking: () => this.emit("speaking-stopped"),
          onTrackStarted: (track: MediaStreamTrack, participant?: { local?: boolean }) => {
            if (participant?.local) return;
            if (track.kind === "audio" && this.audioEl) {
              this.audioEl.srcObject = new MediaStream([track]);
              this.audioEl.play().catch(() => {
                this.emit("error", "Browser blocked audio autoplay — a user gesture is required.");
              });
            }
          },
          onUserTranscript: (data: { text: string; final?: boolean }) => {
            if (data.final) this.emit("user-transcript", data.text);
          },
          onBotOutput: (data: { text: string }) => this.emit("agent-transcript", data.text),
          onServerMessage: (data: unknown) => {
            const msg = data as { type?: string; error?: string; message?: string };
            if (msg?.type === "error" && msg?.error === "no_credits") {
              this.emit("error", msg.message || "This agent has run out of credits.");
            }
          },
          onError: (message: { data?: unknown }) => {
            const text = typeof message?.data === "string" ? message.data : "Connection error.";
            this.emit("error", text);
          },
        },
      });
      this.client = client;

      const endpoint = `${this.opts.baseUrl}/api/embed/offer?token=${encodeURIComponent(token)}`;
      await client.connect({
        webrtcRequestParams: {
          endpoint: new Request(endpoint, {
            method: "POST",
            credentials: "omit",
            headers: { "Content-Type": "application/json" },
          }),
        },
      });
    } catch (err) {
      this._state = "idle";
      this.emit("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Mute / unmute the caller's microphone. */
  setMuted(muted: boolean): void {
    try {
      this.client?.enableMic(!muted);
    } catch {
      /* not connected yet */
    }
  }

  /** End the session and clean up. */
  stop(): void {
    try {
      this.client?.disconnect();
    } catch {
      /* already gone */
    }
    this.client = null;
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.remove();
      this.audioEl = null;
    }
    this._state = "idle";
  }
}
