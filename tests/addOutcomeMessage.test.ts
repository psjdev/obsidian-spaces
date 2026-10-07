/**
 * What the user is told after an add.
 *
 * Layer 1: a pure string, tested apart from the write. The add dedupes
 * silently, so before this the notice claimed an add that had not happened --
 * it read "Added plan.md to Work" for a file the space already held.
 */
import { describe, expect, it } from "vitest";
import type { TAbstractFile } from "obsidian";
import { addOutcomeMessage, alreadyInMessage, subject } from "../src/actions/membership";

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

/**
 * The two naming rules, in one place rather than written out at each notice.
 *
 * They live in `membership.ts` because they are rules, not lookups: the ledger
 * settled that at R11 for this branch, after a fourth hand-written copy had
 * already drifted and was joining every filename with commas, which is the
 * unbounded list `subject` exists to prevent. That copy belonged to the
 * folder-space move, which has since been removed; the rules outlived it
 * because the add path says the same things.
 */
describe("subject", () => {
  it("names one", () => {
    expect(subject([file("plan.md")])).toBe("plan.md");
  });

  it("counts several rather than listing them", () => {
    expect(subject([file("a.md"), file("b.md"), file("c.md")])).toBe("3 notes and folders");
  });

  // Thirty collisions in one toast is the case this caps.
  it("still counts rather than listing a long batch", () => {
    const many = Array.from({ length: 30 }, (_, i) => file(`n-${i}.md`));
    expect(subject(many)).toBe("30 notes and folders");
  });

  /**
   * The count can exceed the list. A dragged folder carries its contents, and
   * those arrive without a rename of their own, so one `moved` entry can stand
   * for a folder and everything inside it.
   */
});

describe("alreadyInMessage", () => {
  it("names one and agrees in number", () => {
    expect(alreadyInMessage([file("plan.md")], "Clients")).toBe("plan.md is already in Clients");
  });

  it("counts several and agrees in number", () => {
    expect(alreadyInMessage([file("a.md"), file("b.md")], "Clients")).toBe(
      "2 notes and folders are already in Clients"
    );
  });
});
