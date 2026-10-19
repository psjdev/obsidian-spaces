/**
 * The stall message itself. Pure, so plain node.
 *
 * The wiring — when it is shown and who is spared it — is
 * `tests/parseStallWiring.test.ts`, which drives `main.ts`.
 */
import { describe, expect, it } from "vitest";
import { parseStallMessage } from "../src/lifecycle/parseStallNotice";

describe("the parse stall message", () => {
  it("says nothing when no path is unparsed", () => {
    expect(parseStallMessage([])).toBeNull();
  });

  it("names the one note when there is only one", () => {
    const message = parseStallMessage(["Logs/export.md"]);
    expect(message).toContain('"Logs/export.md"');
    // The singular form must not claim a queue position it cannot know, and
    // must not read as though more notes are involved.
    expect(message).not.toContain("first in the queue");
    expect(message).not.toContain("notes,");
  });

  it("counts the notes and names the first when there are several", () => {
    const message = parseStallMessage(["a.md", "b.md", "c.md"]);
    expect(message).toContain("3 notes");
    expect(message).toContain('"a.md"');
    expect(message).toContain("first in the queue");
    // The ones behind it are not named: the list can be the whole vault, and
    // the only one worth acting on is the one at the head.
    expect(message).not.toContain("b.md");
    expect(message).not.toContain("c.md");
  });

  it("tells the reader what to do about it", () => {
    // Not decoration. A notice naming a file without saying what to do with
    // it leaves someone with a problem they cannot act on, which is the whole
    // reason this replaced a silent repair.
    for (const paths of [["one.md"], ["one.md", "two.md"]]) {
      expect(parseStallMessage(paths)).toContain("Move or split that note.");
    }
  });

  it("is prefixed so it is attributable in a crowded corner", () => {
    for (const paths of [["one.md"], ["one.md", "two.md"]]) {
      expect(parseStallMessage(paths)?.startsWith("Spaces: ")).toBe(true);
    }
  });
});
