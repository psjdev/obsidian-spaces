/**
 * What the create panel's preview says the space would hold.
 *
 * Layer 1: a pure function, no DOM, no `obsidian`. Tested apart from the panel
 * because the panel around it is one of three look-and-feel candidates and two
 * of the three will be thrown away; the rule that members are a UNION is the
 * spec's, not this prototype's, and is meant to survive it.
 */

import { describe, expect, it, vi } from "vitest";
import { previewLabel, previewPaths, type PreviewVault } from "../src/ui/memberPreview";
import type { MemberEntry } from "../src/types";

const VAULT: Record<string, "file" | "folder"> = {
  Archive: "folder",
  "Archive/old.md": "file",
  Projects: "folder",
  "Projects/Work": "folder",
  "Projects/Work/plan.md": "file",
  "Projects/notes.md": "file",
  "Projects Archive": "folder",
  "Projects Archive/stale.md": "file",
  "inbox.md": "file",
};

const vault = (over: Partial<PreviewVault> = {}): PreviewVault => ({
  allPaths: () => Object.keys(VAULT),
  kindOf: (path) => VAULT[path] ?? null,
  ...over,
});

const TAGGED: Record<string, string[]> = {
  project: ["Projects/notes.md", "Projects/Work/plan.md"],
  inbox: ["inbox.md"],
  empty: [],
};
const tagged = (tag: string): string[] => TAGGED[tag] ?? [];

const sorted = (m: readonly MemberEntry[], v = vault()): string[] =>
  [...previewPaths(m, v, tagged).paths].sort();

describe("previewPaths", () => {
  it("resolves a tag to the notes carrying it", () => {
    expect(sorted([{ kind: "tag", tag: "project" }])).toEqual([
      "Projects/Work/plan.md",
      "Projects/notes.md",
    ]);
  });

  it("UNIONS its members rather than intersecting them", () => {
    // The spec is explicit that a list of members means "any of these". This
    // is the assertion the whole preview rests on: a candidate tag ADDS to
    // what is already chosen, and previewing it alone, or intersecting, would
    // describe a space that does not exist.
    expect(sorted([{ kind: "tag", tag: "project" }, { kind: "tag", tag: "inbox" }])).toEqual([
      "Projects/Work/plan.md",
      "Projects/notes.md",
      "inbox.md",
    ]);
  });

  it("gives a folder member its descendants as well as itself", () => {
    expect(sorted([{ kind: "folder", path: "Projects" }])).toEqual([
      "Projects",
      "Projects/Work",
      "Projects/Work/plan.md",
      "Projects/notes.md",
    ]);
  });

  it("does not let a folder swallow a sibling whose name it prefixes", () => {
    // Without the trailing slash `Projects` takes `Projects Archive` with it.
    expect(sorted([{ kind: "folder", path: "Projects" }])).not.toContain("Projects Archive");
  });

  it("takes a file member as itself and nothing else", () => {
    expect(sorted([{ kind: "file", path: "inbox.md" }])).toEqual(["inbox.md"]);
  });

  it("counts a note once however many members carry it", () => {
    const members: MemberEntry[] = [
      { kind: "tag", tag: "project" },
      { kind: "file", path: "Projects/notes.md" },
      { kind: "folder", path: "Projects" },
    ];
    const { paths, notes } = previewPaths(members, vault(), tagged);
    expect([...paths].filter((p) => p === "Projects/notes.md")).toHaveLength(1);
    // A number that disagreed with the rows under it would be worse than none.
    // `plan.md` and `notes.md`: the file member and the tag both name one the
    // folder member already brought in.
    expect(notes).toBe(2);
  });

  it("counts notes, not the folders that carry them", () => {
    expect(previewPaths([{ kind: "folder", path: "Projects" }], vault(), tagged).notes).toBe(2);
  });

  it("is empty for no members at all", () => {
    const { paths, notes } = previewPaths([], vault(), tagged);
    expect([...paths]).toEqual([]);
    expect(notes).toBe(0);
  });

  it("survives a tag nothing carries", () => {
    const { paths, notes } = previewPaths([{ kind: "tag", tag: "empty" }], vault(), tagged);
    expect([...paths]).toEqual([]);
    expect(notes).toBe(0);
  });

  it("leaves the vault unread when no member is a folder", () => {
    // The picker redraws this on every step through the tag list, and the
    // common case is tags alone. `allPaths` is the one O(vault) call here.
    const allPaths = vi.fn(() => Object.keys(VAULT));
    previewPaths([{ kind: "tag", tag: "project" }], vault({ allPaths }), tagged);
    expect(allPaths).not.toHaveBeenCalled();
  });

  it("reads the vault once however many folder members there are", () => {
    const allPaths = vi.fn(() => Object.keys(VAULT));
    previewPaths(
      [
        { kind: "folder", path: "Projects" },
        { kind: "folder", path: "Archive" },
      ],
      vault({ allPaths }),
      tagged
    );
    expect(allPaths).toHaveBeenCalledTimes(1);
  });

  it("keeps a path the vault no longer knows the kind of, but does not count it", () => {
    // The tag index is a snapshot and the vault is live; a note deleted
    // between the two is a real state. Dropping the row silently would be a
    // preview that disagrees with the space it is previewing.
    const { paths, notes } = previewPaths(
      [{ kind: "file", path: "gone.md" }],
      vault(),
      tagged
    );
    expect([...paths]).toEqual(["gone.md"]);
    expect(notes).toBe(0);
  });
});

describe("previewLabel", () => {
  it("names what is being counted", () => {
    expect(previewLabel(12)).toBe("12 notes");
  });

  it("uses the singular for one", () => {
    expect(previewLabel(1)).toBe("1 note");
  });

  it("words zero rather than numbering it", () => {
    expect(previewLabel(0)).toBe("nothing yet");
  });

  it("groups the digits", () => {
    expect(previewLabel(1234)).toBe((1234).toLocaleString() + " notes");
  });
});
