import { beforeEach, describe, expect, it, vi } from "vitest";
import { type SessionCallbacks } from "../src/livekit";
import { TextChannel } from "../src/text";
import { parseToolEvent, type AffordanceResolution, type ToolFinished } from "../src/tool-events";
import { WhissleAgent } from "../src/WhissleAgent";
import { WIDGET_INTERNALS } from "../src/widget";

/**
 * Card affordances, P0. A tool that DEFERS its side effect — the drafted email, the
 * tentative booking — ships the choices on its result card, and every modality (a tap
 * here, a spoken "send it", the operator's inbox) fires the SAME affordance and lands
 * as the SAME resolution event. These pin the parse on both doors, the firing API's
 * routing per transport, the 409-is-an-answer rule, and the widget's card state
 * machine — the parts of the contract a race would otherwise find first.
 */

/** A result card with pending actions, exactly as the wire ships it. */
const CARD = {
  kind: "tool",
  phase: "result",
  tool_call_id: "call-1",
  function_name: "send_email",
  ok: true,
  result: { _display: "Draft to anna@example.com — \"Your quote\"" },
  affordances: [
    { id: "aff_1", label: "Send email", kind: "approve", action_id: "act_1", primary: true },
    { id: "aff_2", label: "Discard", kind: "reject", action_id: "act_1" },
  ],
};

/** The resolution envelope, as the live channel delivers it from any surface. */
const RESOLUTION = {
  kind: "tool",
  phase: "action",
  tool_call_id: "call-1",
  affordance_id: "aff_1",
  action_id: "act_1",
  disposition: "approve",
  status: "approved",
  source: "tap",
};

const PARSED_AFFORDANCES = [
  {
    id: "aff_1",
    label: "Send email",
    kind: "approve",
    actionId: "act_1",
    primary: true,
    raw: CARD.affordances[0],
  },
  { id: "aff_2", label: "Discard", kind: "reject", actionId: "act_1", raw: CARD.affordances[1] },
];

class Probe extends WhissleAgent {
  cb: SessionCallbacks = this.callbacks();
  events: Array<[string, unknown]> = [];
  constructor(opts: Record<string, unknown> = {}) {
    super({ sessionToken: "t", earcons: false, ...opts });
    for (const e of [
      "server-message",
      "tool-started",
      "tool-finished",
      "affordance-resolved",
      "thinking",
      "error",
    ] as const) {
      this.on(e, (p) => this.events.push([e, p]));
    }
  }
  of(name: string) {
    return this.events.filter(([e]) => e === name).map(([, p]) => p);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("parsing a card's affordances", () => {
  it("reads them off a result, camel-cased, with the wire object kept on raw", () => {
    const e = parseToolEvent(CARD);
    expect(e?.phase).toBe("result");
    expect((e?.data as ToolFinished).affordances).toEqual(PARSED_AFFORDANCES);
  });

  it("leaves a card without them exactly as it was — absent, not []", () => {
    // Absent/empty affordances = today's render-only card. "Has affordances" must
    // stay one truthiness check for every renderer already shipping.
    const { affordances: _omitted, ...plain } = CARD;
    expect((parseToolEvent(plain)?.data as ToolFinished).affordances).toBeUndefined();
    expect(
      (parseToolEvent({ ...CARD, affordances: [] })?.data as ToolFinished).affordances,
    ).toBeUndefined();
  });

  it("skips what it cannot fire or cannot name, rather than rendering it broken", () => {
    // A button without an action_id fires nothing; one with an unknown kind has
    // semantics this build doesn't know and must not be drawn as one it does.
    const e = parseToolEvent({
      ...CARD,
      affordances: [
        { id: "a", label: "No action row", kind: "approve" },
        { id: "b", label: "Novel kind", kind: "escalate", action_id: "act_9" },
        { label: "No id", kind: "approve", action_id: "act_9" },
        "garbage",
        null,
        CARD.affordances[0],
      ],
    });
    expect((e?.data as ToolFinished).affordances).toEqual([PARSED_AFFORDANCES[0]]);
  });

  it("reads a phase:action envelope as a resolution", () => {
    const e = parseToolEvent(RESOLUTION);
    expect(e?.phase).toBe("action");
    expect(e?.data).toEqual({
      id: "call-1",
      affordanceId: "aff_1",
      actionId: "act_1",
      disposition: "approve",
      status: "approved",
      source: "tap",
      raw: RESOLUTION,
    });
  });

  it("leaves absent resolution fields absent rather than inventing them", () => {
    const e = parseToolEvent({ kind: "tool", phase: "action", action_id: "act_1" });
    expect(e?.phase).toBe("action");
    expect((e?.data as AffordanceResolution).disposition).toBeUndefined();
    expect((e?.data as AffordanceResolution).source).toBeUndefined();
  });
});

describe("the voice channel", () => {
  it("hands the affordances out on tool-finished", () => {
    const p = new Probe();
    p.cb.onServerMessage(CARD);
    expect((p.of("tool-finished")[0] as ToolFinished).affordances).toEqual(PARSED_AFFORDANCES);
  });

  it("emits a resolution as affordance-resolved, and still forwards it raw", () => {
    const p = new Probe();
    p.cb.onServerMessage(RESOLUTION);
    expect(p.of("affordance-resolved")[0]).toMatchObject({
      affordanceId: "aff_1",
      actionId: "act_1",
      disposition: "approve",
      status: "approved",
      source: "tap",
    });
    // The compatibility rule every other family on this channel obeys.
    expect(p.of("server-message")).toEqual([RESOLUTION]);
  });

  it("treats a resolution as a resolution — not as a tool finishing", () => {
    // Before phase:"action" existed, the parser's fall-through would have read this
    // envelope as a result: a phantom tool-finished, and a thinking tracker debited
    // for a tool that never started.
    const p = new Probe();
    p.cb.onServerMessage(RESOLUTION);
    expect(p.of("tool-finished")).toEqual([]);
    expect(p.of("thinking")).toEqual([]);
  });
});

describe("the text door", () => {
  it("parses affordances on a typed turn's cards with the same parser", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        reply: "I've drafted it — want me to send it?",
        conversation_id: "conv-1",
        session_id: "sess-1",
        tool_events: [CARD],
      }),
    );
    const c = new TextChannel("https://gw.test/x", "tok", "sess-1", fetchImpl);
    const turn = await c.send("email anna the quote");
    expect(turn.toolEvents[0].affordances).toEqual(PARSED_AFFORDANCES);
  });
});

describe("fireAffordance over a live session", () => {
  function liveProbe() {
    const p = new Probe();
    const sent: Array<{ t: string; d?: unknown }> = [];
    (p as unknown as { lk: unknown }).lk = {
      sendClientMessage: (t: string, d?: unknown) => sent.push({ t, d }),
    };
    (p as unknown as { _state: string })._state = "connected";
    return { p, sent };
  }

  it("says it on the data channel, in the card-action envelope", async () => {
    const { p, sent } = liveProbe();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("must not be called");
    }));
    const fired = p.fireAffordance({
      actionId: "act_1",
      affordanceId: "aff_1",
      disposition: "approve",
    });
    expect(sent).toEqual([
      {
        t: "card-action",
        d: { action_id: "act_1", affordance_id: "aff_1", disposition: "approve", source: "tap" },
      },
    ]);
    // …and resolves with the pipeline's own confirmation, not optimistically:
    // `send` drops rather than throws, so resolving early would report firings
    // that never left the browser.
    p.cb.onServerMessage(RESOLUTION);
    await expect(fired).resolves.toMatchObject({ affordanceId: "aff_1", status: "approved" });
  });

  it("waits for ITS resolution, not the first one that goes by", async () => {
    const { p } = liveProbe();
    const fired = p.fireAffordance({
      actionId: "act_1",
      affordanceId: "aff_1",
      disposition: "approve",
    });
    // Another card resolving (the operator's inbox, say) must not satisfy this tap.
    p.cb.onServerMessage({ ...RESOLUTION, affordance_id: "aff_OTHER", action_id: "act_OTHER" });
    p.cb.onServerMessage(RESOLUTION);
    await expect(fired).resolves.toMatchObject({ affordanceId: "aff_1" });
  });

  it("gives the promise back rather than hanging forever", async () => {
    // The data channel drops rather than throws, so a confirmation that never comes
    // must become a rejection — the card itself can still resolve later, and the
    // affordance-resolved listener is how it would say so.
    vi.useFakeTimers();
    try {
      const { p } = liveProbe();
      const outcome = p
        .fireAffordance({ actionId: "act_1", affordanceId: "aff_1", disposition: "approve" })
        .then(
          () => "resolved",
          (e: Error) => e.message,
        );
      await vi.advanceTimersByTimeAsync(10_001);
      await expect(outcome).resolves.toMatch(/wasn't confirmed/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fireAffordance with no session up", () => {
  const mint = { token: "tok", session_id: "sess-1", text_enabled: true };

  function stubGateway(cardAction: (init?: RequestInit) => Response) {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("card-action")) {
          seen.push({ path: new URL(url).pathname, body: JSON.parse(String(init?.body)) });
          return cardAction(init);
        }
        return jsonResponse(mint);
      }),
    );
    return seen;
  }

  it("POSTs the token door and resolves with the mirrored resolution", async () => {
    const seen = stubGateway(() => jsonResponse(RESOLUTION));
    const agent = new WhissleAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: "https://gw.test/bot" });
    const resolutions: unknown[] = [];
    agent.on("affordance-resolved", (r) => resolutions.push(r));
    const r = await agent.fireAffordance({
      actionId: "act_1",
      affordanceId: "aff_1",
      disposition: "approve",
    });
    expect(seen).toEqual([
      {
        path: "/bot/api/embed/card-action",
        body: {
          token: "tok",
          action_id: "act_1",
          affordance_id: "aff_1",
          disposition: "approve",
          source: "tap",
        },
      },
    ]);
    expect(r).toMatchObject({ affordanceId: "aff_1", disposition: "approve", status: "approved" });
    expect(r.alreadyResolved).toBeUndefined();
    // Also emitted, so a card renderer needs one code path whatever fired it.
    expect(resolutions).toEqual([r]);
  });

  it("treats a 409 as the answer it is — resolved, flagged, never an error", async () => {
    // Someone else got there first (another tab, a spoken "send it", the operator's
    // inbox). The body is the standing state; clients render it, not a toast.
    stubGateway(() =>
      jsonResponse(
        { action_id: "act_1", affordance_id: "aff_9", disposition: "reject", status: "rejected" },
        409,
      ),
    );
    const agent = new WhissleAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: "https://gw.test/bot" });
    const resolutions: unknown[] = [];
    agent.on("affordance-resolved", (r) => resolutions.push(r));
    const r = await agent.fireAffordance({
      actionId: "act_1",
      affordanceId: "aff_1",
      disposition: "approve",
    });
    expect(r).toMatchObject({
      alreadyResolved: true,
      // The SERVER's state, not what we asked for — first write wins.
      affordanceId: "aff_9",
      disposition: "reject",
      status: "rejected",
    });
    expect(resolutions).toHaveLength(1);
  });

  it("carries the source through, for the modality that isn't a tap", async () => {
    const seen = stubGateway(() => jsonResponse(RESOLUTION));
    const agent = new WhissleAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: "https://gw.test/bot" });
    await agent.fireAffordance({
      actionId: "act_1",
      affordanceId: "aff_1",
      disposition: "reject",
      source: "gesture",
    });
    expect(seen[0].body).toMatchObject({ disposition: "reject", source: "gesture" });
  });

  it("rejects a real failure with the status and a sentence, and says it as an error", async () => {
    // 404 is the scoping rule showing: a token-authed firing only reaches actions
    // of the session that saw the card.
    stubGateway(() => jsonResponse({ detail: "Unknown action." }, 404));
    const agent = new WhissleAgent({ apiKey: "wpk_x", agentId: "a", baseUrl: "https://gw.test/bot" });
    const details: unknown[] = [];
    agent.on("error", (_m, d) => details.push(d));
    await expect(
      agent.fireAffordance({ actionId: "act_x", affordanceId: "aff_x", disposition: "approve" }),
    ).rejects.toMatchObject({ code: 404 });
    expect(details).toEqual([{ code: "not-found", status: 404 }]);
  });
});

describe("the widget's card state machine", () => {
  const { AffordanceRow, resolvedLine, cardTitle } = WIDGET_INTERNALS;
  const parsed = parseToolEvent(CARD)!.data as ToolFinished;
  const affs = parsed.affordances!;

  it("fills the approve and keeps the reject quiet, so yes is findable without reading", () => {
    const row = new AffordanceRow(affs);
    const view = row.view;
    if (view.state === "resolved") throw new Error("not resolved yet");
    expect(view.buttons).toEqual([
      { id: "aff_1", label: "Send email", filled: true },
      { id: "aff_2", label: "Discard", filled: false },
    ]);
    expect(view.disabled).toBe(false);
  });

  it("fills only the primary among choices", () => {
    const choice = (id: string, primary?: boolean) => ({
      id,
      label: id,
      kind: "choice" as const,
      actionId: `act_${id}`,
      ...(primary ? { primary } : {}),
      raw: {},
    });
    const row = new AffordanceRow([choice("slot1"), choice("slot2", true), choice("slot3")]);
    const view = row.view;
    if (view.state === "resolved") throw new Error("not resolved yet");
    expect(view.buttons.map((b) => b.filled)).toEqual([false, true, false]);
  });

  it("a tap returns exactly what to fire, and spends the row at once", () => {
    // An affordance fires ONCE. Disabling on the tap — not on the response — is
    // what makes a double-tap one firing instead of two.
    const row = new AffordanceRow(affs);
    expect(row.tap("aff_2")).toEqual({
      actionId: "act_1",
      affordanceId: "aff_2",
      disposition: "reject",
      source: "tap",
    });
    const view = row.view;
    if (view.state === "resolved") throw new Error("not resolved yet");
    expect(view.disabled).toBe(true);
    expect(row.tap("aff_1")).toBeNull();
    expect(row.tap("aff_2")).toBeNull();
  });

  it("a choice fires as an approve of that variant", () => {
    const row = new AffordanceRow([
      { id: "c1", label: "Tue 10:00", kind: "choice", actionId: "act_c1", raw: {} },
    ]);
    expect(row.tap("c1")).toMatchObject({ disposition: "approve", actionId: "act_c1" });
  });

  it("re-arms after a failed firing — a network error must not brick the card", () => {
    const row = new AffordanceRow(affs);
    row.tap("aff_1");
    row.fail();
    expect(row.tap("aff_1")).not.toBeNull();
  });

  it("resolves from any surface, and the first resolution wins for good", () => {
    const row = new AffordanceRow(affs);
    // No local tap at all — this is the studio inbox resolving it.
    expect(row.resolve({ affordanceId: "aff_1", disposition: "approve", raw: {} })).toBe(true);
    expect(row.view).toEqual({ state: "resolved", line: "Approved · sent" });
    // A late mirror of the same resolution repaints nothing…
    expect(row.resolve({ affordanceId: "aff_1", disposition: "approve", raw: {} })).toBe(false);
    // …a tap after resolution fires nothing, and a stray fail() cannot re-open it.
    expect(row.tap("aff_2")).toBeNull();
    row.fail();
    expect(row.view.state).toBe("resolved");
  });

  it("ignores another card's resolution", () => {
    const row = new AffordanceRow(affs);
    expect(
      row.resolve({ affordanceId: "aff_ELSE", actionId: "act_ELSE", disposition: "approve", raw: {} }),
    ).toBe(false);
    expect(row.view.state).toBe("open");
  });

  it("matches on the action row when the resolution names no affordance", () => {
    const row = new AffordanceRow(affs);
    expect(row.resolve({ actionId: "act_1", disposition: "reject", raw: {} })).toBe(true);
    expect(row.view).toEqual({ state: "resolved", line: "Discarded" });
  });

  it("pins the resolved copy, total over dispositions it has never heard of", () => {
    expect(resolvedLine("approve")).toBe("Approved · sent");
    expect(resolvedLine("reject")).toBe("Discarded");
    for (const d of [undefined, "", "expire"]) {
      expect(resolvedLine(d).length).toBeGreaterThan(3);
    }
  });

  it("titles a card from its own display line, else its tool name, else honestly", () => {
    expect(cardTitle(parsed)).toBe('Draft to anna@example.com — "Your quote"');
    expect(cardTitle({ name: "book_appointment", raw: {} })).toBe("Book appointment");
    expect(cardTitle({ raw: {} }).length).toBeGreaterThan(3);
  });
});
