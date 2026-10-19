/**
 * The stall message itself. Pure, so plain node.
 *
 * The wiring — when it is shown and who is spared it — is
 * `tests/parseStallWiring.test.ts`, which drives `main.ts`.
 */
import { describe, expect, it } from "vitest";
import { parseStallMessage } from "../src/lifecycle/parseStallNotice";

describe("the parse stall message", () => {
  it("says nothing when no note is unparsed", () => {
    expect(parseStallMessage(0, "")).toBeNull();
    expect(parseStallMessage(0, "a.md")).toBeNull();
    // A count with no culprit cannot name anything, so it says nothing rather
    // than drawing a sentence with an empty pair of quotes in it.
    expect(parseStallMessage(3, "")).toBeNull();
  });

  it("names the one note when there is only one", () => {
    const message = parseStallMessage(1, "Logs/export.md");
    expect(message).toContain('"Logs/export.md"');
    // The singular must not imply others, or claim a ranking among one.
    expect(message).not.toContain("largest");
    expect(message).not.toContain("notes,");
  });

  it("counts the notes and names the largest when there are several", () => {
    const message = parseStallMessage(3, "Logs/export.md");
    expect(message).toContain("3 notes");
    expect(message).toContain('The largest is "Logs/export.md"');
  });

  it("names the LARGEST rather than the first, which was wrong advice", () => {
    // A real Obsidian on a 33 MB jammed vault put a sixty-byte note first in
    // `getMarkdownFiles()` order, and the notice told the user to split THAT.
    // The caller picks by size now; this pins the wording that depends on it.
    expect(parseStallMessage(21, "0000 huge.md")).toContain('The largest is "0000 huge.md"');
    expect(parseStallMessage(21, "0000 huge.md")).not.toContain("first in line");
  });

  it("tells the reader what to do, conditionally", () => {
    // Not decoration, and not an order: being wrong here costs somebody a
    // note, so the advice is hedged on the stall persisting.
    for (const [n, c] of [
      [1, "one.md"],
      [2, "one.md"],
    ] as const) {
      const m = parseStallMessage(n, c);
      expect(m).toContain("If it stays that way");
      expect(m).toContain("move that note out of the vault or split it into smaller notes.");
    }
  });

  it("is prefixed so it is attributable in a crowded corner", () => {
    for (const [n, c] of [
      [1, "one.md"],
      [2, "one.md"],
    ] as const) {
      expect(parseStallMessage(n, c)?.startsWith("Spaces: ")).toBe(true);
    }
  });
});
