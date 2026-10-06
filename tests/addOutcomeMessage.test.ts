/**
 * What the user is told after an add.
 *
 * Layer 1: a pure string, tested apart from the write. The add dedupes
 * silently, so before this the notice claimed an add that had not happened --
 * it read "Added plan.md to Work" for a file the space already held.
 */
import { describe, expect, it } from "vitest";
import type { TAbstractFile } from "obsidian";
import { addOutcomeMessage } from "../src/actions/membership";

/** Only `name` is read, so the fake carries only `name`. */
function file(name: string): TAbstractFile {
  return { name } as TAbstractFile;
}

describe("addOutcomeMessage", () => {
  it("names one file that was added", () => {
    expect(addOutcomeMessage([file("plan.md")], [], "Work")).toBe("Added plan.md to Work");
  });

  it("counts several that were added", () => {
    expect(addOutcomeMessage([file("a.md"), file("b.md")], [], "Work")).toBe(
      "Added 2 notes and folders to Work"
    );
  });

  it("says so when one was already there", () => {
    expect(addOutcomeMessage([], [file("plan.md")], "Work")).toBe("plan.md is already in Work");
  });

  // Plural agreement, because "3 notes and folders is already in Work" reads
  // as a bug in the plugin rather than a fact about the space.
  it("agrees in number when several were already there", () => {
    expect(addOutcomeMessage([], [file("a.md"), file("b.md")], "Work")).toBe(
      "2 notes and folders are already in Work"
    );
  });

  // The partial case counts only what changed. Reporting the whole batch
  // would be the same lie in a smaller form.
  it("counts only what was new when some were already there", () => {
    expect(addOutcomeMessage([file("a.md")], [file("b.md"), file("c.md")], "Work")).toBe(
      "Added a.md to Work"
    );
  });

  it("says nothing happened when nothing was dragged", () => {
    expect(addOutcomeMessage([], [], "Work")).toBe("Nothing to add to Work");
  });
});
