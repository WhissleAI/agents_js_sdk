import { describe, expect, it } from "vitest";
import { parseToolEvent, ThinkingTracker } from "../src/tool-events";

/**
 * The pipeline has always narrated its tool calls on the `server-message` channel and
 * this SDK forwarded the envelopes raw, so an embedder who wanted to explain a pause
 * had to reverse-engineer the wire off the console. These pin the parse, and the
 * bookkeeping behind the one boolean a UI actually needs.
 */

const started = {
  kind: "tool",
  phase: "started",
  tool_call_id: "call_1",
  function_name: "search_knowledge_base",
  arguments: { query: "refund policy" },
  sound: "search_0",
};

const result = {
  kind: "tool",
  phase: "result",
  tool_call_id: "call_1",
  function_name: "search_knowledge_base",
  ok: true,
  result: { _display: "Read Refunds.pdf" },
  evidence: [{ document_id: "d1", quote: "Refunds within 30 days." }],
};

describe("parsing a tool envelope", () => {
  it("reads a start, earcon and all", () => {
    const e = parseToolEvent(started);
    expect(e?.phase).toBe("started");
    expect(e?.data).toMatchObject({
      id: "call_1",
      name: "search_knowledge_base",
      sound: "search_0",
    });
  });

  it("reads a result with its citations", () => {
    const e = parseToolEvent(result);
    expect(e?.phase).toBe("result");
    expect(e?.data).toMatchObject({ id: "call_1", ok: true });
    expect((e?.data as { evidence?: unknown[] }).evidence).toHaveLength(1);
  });

  it("reads progress, which is the only phase carrying a line to show", () => {
    const e = parseToolEvent({
      kind: "tool",
      phase: "progress",
      tool_call_id: "call_1",
      function_name: "deep_research",
      display: "Reading source 2 of 3…",
      data: {},
    });
    expect(e?.phase).toBe("progress");
    expect((e?.data as { display?: string }).display).toBe("Reading source 2 of 3…");
  });

  it("keeps `ok: null` distinct from failure", () => {
    // The backend sends null when a tool TIMED OUT and its success is genuinely
    // unknown. Reading that as false tells someone a booking failed when it may well
    // have gone through, and they redo it — duplicate writes are the expensive wrong.
    expect((parseToolEvent({ ...result, ok: null })?.data as { ok?: boolean }).ok).toBeUndefined();
    expect((parseToolEvent({ ...result, ok: false })?.data as { ok?: boolean }).ok).toBe(false);
  });

  it("leaves absent optional fields absent rather than inventing them", () => {
    const e = parseToolEvent({ kind: "tool", phase: "result", function_name: "x", ok: true });
    expect((e?.data as { evidence?: unknown }).evidence).toBeUndefined();
    expect((e?.data as { sound?: unknown }).sound).toBeUndefined();
  });

  it("keeps the untouched envelope on `raw`", () => {
    expect(parseToolEvent(started)?.data.raw).toBe(started);
  });

  it("ignores everything that isn't a tool event", () => {
    for (const m of [
      null,
      undefined,
      "hello",
      42,
      {},
      { kind: "signal", v: 1, type: "barge_in" },
      { t: "simli-clear" },
      { t: "question", index: 2 },
      { kind: "tool", phase: "speculative" },
    ]) {
      expect(parseToolEvent(m)).toBeNull();
    }
  });
});

describe("thinking: one boolean out of many tools", () => {
  const start = (id: string, name = "t") => ({ id, name, raw: {} });
  const done = (id: string, name = "t") => ({ id, name, raw: {} });

  it("goes active on the first tool and back on its result", () => {
    const t = new ThinkingTracker();
    expect(t.start(start("a"))).toEqual({ active: true, tool: "t", label: undefined });
    expect(t.finish(done("a"))).toEqual({ active: false });
  });

  it("reports ONE edge each way for a turn that fans out to three tools", () => {
    // A turn firing three tools must not flicker a strip on and off three times.
    const t = new ThinkingTracker();
    const changes = [
      t.start(start("a")),
      t.start(start("b")),
      t.start(start("c")),
      t.finish(done("a")),
      t.finish(done("b")),
      t.finish(done("c")),
    ].filter(Boolean);
    expect(changes).toEqual([{ active: true, tool: "t", label: undefined }, { active: false }]);
  });

  it("carries a progress line without re-announcing the edge", () => {
    const t = new ThinkingTracker();
    t.start(start("a", "deep_research"));
    expect(t.progress({ id: "a", name: "deep_research", display: "Reading 2/3…", raw: {} })).toEqual(
      { active: true, tool: "deep_research", label: "Reading 2/3…" },
    );
  });

  it("ignores progress for a tool that never started", () => {
    expect(new ThinkingTracker().progress({ display: "x", raw: {} })).toBeNull();
  });

  it("clears when the bot starts speaking, even with a result still outstanding", () => {
    // The load-bearing case. A result frame can be dropped on the way to the browser;
    // audio cannot be faked. Without this, one lost result pins "working…" on screen
    // for the rest of the call.
    const t = new ThinkingTracker();
    t.start(start("a"));
    expect(t.clear()).toEqual({ active: false });
    expect(t.clear()).toBeNull();
  });

  it("survives tools that arrive with no id at all", () => {
    const t = new ThinkingTracker();
    expect(t.start({ name: "t", raw: {} })).toMatchObject({ active: true });
    expect(t.start({ name: "t", raw: {} })).toBeNull();
    expect(t.finish({ name: "t", raw: {} })).toBeNull();
    expect(t.finish({ name: "t", raw: {} })).toEqual({ active: false });
  });

  it("ignores a result for a tool it never saw start", () => {
    // A late duplicate must not drive the count negative and leave the next real tool
    // unable to turn the strip on.
    const t = new ThinkingTracker();
    expect(t.finish(done("ghost"))).toBeNull();
    expect(t.start(start("a"))).toMatchObject({ active: true });
  });
});
