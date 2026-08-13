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
