import { describe, expect, it } from "vitest";
import { WIDGET_INTERNALS } from "../src/widget";

/**
 * The thinking strip needs a line for a tool nobody has written copy for. The platform
 * invents tools at run time — a user builds one by talking to the Companion, the
 * Knowledge Compiler arms one per spreadsheet ingested, a partner adds one over the
 * API — so this has to be a total function over every possible identifier, and it has
 * to stay readable when it has nothing to work with.
 */
const { working } = WIDGET_INTERNALS;

describe("what the strip says while a tool runs", () => {
  it.each([
    ["search_knowledge_base", "Searching knowledge base…"],
    ["book_appointment", "Booking appointment…"],
    ["send_email", "Sending email…"],
    ["update_agent", "Updating agent…"],
    ["check-availability", "Checking availability…"],
    ["transfer_call", "Transferring call…"],
    ["look", "Looking…"],
    // e-drop
    ["schedule_visit", "Scheduling visit…"],
    ["issue_certificate", "Issuing certificate…"],
    // short CVC stems double
    ["set_reminder", "Setting reminder…"],
    ["get_hours", "Getting hours…"],
    ["run_report", "Running report…"],
    // …and longer ones must NOT, which is where a naive rule goes wrong
    ["register_user", "Registering user…"],
    ["edit_agent", "Editing agent…"],
    ["visit_page", "Visiting page…"],
    ["collect_digits", "Collecting digits…"],
  ])("turns %o into %o", (tool, expected) => {
    expect(working(tool)).toBe(expected);
  });

  it("says something honest when the name says nothing", () => {
    expect(working(undefined)).toBe("Working…");
    expect(working("")).toBe("Working…");
  });

  it("never returns an empty line for any identifier", () => {
    for (const t of ["x", "___", "a_b_c_d", "9", "ünïcode_tool"]) {
      expect(working(t).length).toBeGreaterThan(1);
    }
  });
});

/**
 * The session-ceiling countdown. The mint's `limits.max_session_seconds` is real on
 * every anonymous embed, and until it was reported the widget went silent mid-sentence
 * at exactly the cap — which reads as the agent freezing, not the free session ending.
 * The clock and the end-card are the two lines a visitor actually sees, so pin them.
 */
const { formatRemaining, sessionEnded } = WIDGET_INTERNALS;

describe("what the countdown reads", () => {
  it.each([
    [120, "2:00"],
    [125, "2:05"],
    [61, "1:01"],
    [60, "1:00"],
    [59, "0:59"],
    [9, "0:09"],
    [600, "10:00"],
    [0, "0:00"],
  ])("shows %i seconds as %o", (seconds, expected) => {
    expect(formatRemaining(seconds)).toBe(expected);
  });

  it("floors at zero rather than counting negative", () => {
    // A clock reading "-0:03" says the widget lost track — worse than "0:00" while
    // the server's own end signal is in flight.
    expect(formatRemaining(-3)).toBe("0:00");
  });
});

describe("what the end-card says", () => {
  it("names the demo ending as the demo ending", () => {
    expect(sessionEnded("demo")).toMatch(/demo/i);
  });

  it("calls a public cap a time limit, not a demo", () => {
    expect(sessionEnded("public")).toMatch(/time limit/i);
    expect(sessionEnded("public")).not.toMatch(/demo/i);
  });

  it("is total over reasons this build has never heard of", () => {
    // The rule sets grow server-side; an unknown reason must land on honest copy,
    // never on "undefined".
    for (const r of [undefined, null, "trial", ""]) {
      expect(sessionEnded(r as never).length).toBeGreaterThan(10);
    }
  });
});
