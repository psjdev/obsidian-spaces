/**
 * `inheritedFromFolder` after the move out of `actions/membershipMenu.ts`.
 *
 * A move needs a different kind of evidence from a fix: that the symbol still
 * behaves the same, and that every previous importer still reaches the same
 * function object rather than a second copy. The predicate had no direct test
 * before — `spaceAddTargets.test.ts` and `memberList.test.ts` exercised it
 * only through their own callers — so these cases are new coverage as well as
 * move evidence.
 *
 * Layer 1: pure, no `obsidian`.
 */
import { describe, expect, it } from "vitest";
import {
  coveringFolder,
  coveringFolderIn,
  coveringTagIn,
  inheritedFromFolder,
  memberFolderSet,
  memberTagSet,
} from "../src/definitions/membership";
import { inheritedFromFolder as viaMembershipMenu } from "../src/actions/membershipMenu";
import type { SpaceDefinition } from "../src/types";

function space(members: SpaceDefinition["members"]): SpaceDefinition {
  return { id: "s", name: "S", icon: "box", color: "#5b5bff", members };
}

describe("inheritedFromFolder", () => {
  it("returns the folder member that covers the path", () => {
    const s = space([{ path: "Projects", kind: "folder" }]);
    expect(inheritedFromFolder(s, "Projects/Console/notes.md")).toBe("Projects");
  });

  it("returns the INNERMOST covering folder when several nest", () => {
    // The innermost is the one that explains the row: naming "Projects" when
    // "Projects/Console" is also a member would send the user to the wrong
    // entry in Settings.
    const s = space([
      { path: "Projects", kind: "folder" },
      { path: "Projects/Console", kind: "folder" },
    ]);
    expect(inheritedFromFolder(s, "Projects/Console/notes.md")).toBe("Projects/Console");
  });

  it("ignores a FILE member with the same path as an ancestor segment", () => {
    // Only folder members confer inheritance; a file member named
    // "Projects" is not a folder and covers nothing below it.
    const s = space([{ path: "Projects", kind: "file" }]);
    expect(inheritedFromFolder(s, "Projects/notes.md")).toBeNull();
  });

  it("does not treat the path itself as its own covering folder", () => {
    const s = space([{ path: "Projects", kind: "folder" }]);
    expect(inheritedFromFolder(s, "Projects")).toBeNull();
  });

  it("returns null when nothing covers the path", () => {
    expect(inheritedFromFolder(space([]), "Inbox/today.md")).toBeNull();
  });

  it("does not match a sibling folder that merely shares a name prefix", () => {
    // "Projects2" is not an ancestor of "Projects/notes.md", and a prefix
    // comparison rather than a segment walk would say it is.
    const s = space([{ path: "Projects2", kind: "folder" }]);
    expect(inheritedFromFolder(s, "Projects/notes.md")).toBeNull();
  });

  it("is the same function object the old import path still hands out", () => {
    // The re-export in `actions/membershipMenu.ts` is a compatibility shim for
    // the two importers owned by other branches. A second copy of the
    // predicate would let the two import paths silently diverge over time.
    expect(viaMembershipMenu).toBe(inheritedFromFolder);
  });
});

/**
 * The same walk, asked of a member list that is not a space yet. The create
 * panel's picker holds `CreateFormState.items` and marks everything a selected
 * folder covers, so this is the shape it needs.
 */
describe("coveringFolder", () => {
  it("answers for a bare member list, as inheritedFromFolder does for a space", () => {
    const members: SpaceDefinition["members"] = [{ path: "Projects", kind: "folder" }];
    expect(coveringFolder(members, "Projects/Console/notes.md")).toBe("Projects");
    expect(inheritedFromFolder(space(members), "Projects/Console/notes.md")).toBe(
      coveringFolder(members, "Projects/Console/notes.md")
    );
  });

  it("covers a descendant any number of levels down", () => {
    const members: SpaceDefinition["members"] = [{ path: "Projects", kind: "folder" }];
    expect(coveringFolder(members, "Projects/Console/2030/Q1/notes.md")).toBe("Projects");
  });

  it("folds case on both sides, and hands back the LIVE ancestor", () => {
    // The reason the panel shares this rather than writing its own: a picker
    // that compared paths as typed would leave a covered row unmarked and
    // clickable on exactly the vaults this folding exists for. The folder
    // named in the row's title has to be the one the user can see in the tree,
    // which is the live spelling, not the stored one.
    const members: SpaceDefinition["members"] = [{ path: "INBOX", kind: "folder" }];
    expect(coveringFolder(members, "Inbox/today.md")).toBe("Inbox");
  });

  it("ignores tag members, which name no path to inherit from", () => {
    const members: SpaceDefinition["members"] = [
      { kind: "tag", tag: "project" },
      { path: "Projects", kind: "folder" },
    ];
    expect(coveringFolder(members, "Projects/notes.md")).toBe("Projects");
    expect(coveringFolder(members, "Inbox/today.md")).toBeNull();
  });

  it("returns null for a sibling outside every selected folder", () => {
    const members: SpaceDefinition["members"] = [{ path: "Projects", kind: "folder" }];
    expect(coveringFolder(members, "Archive/old.md")).toBeNull();
    expect(coveringFolder([], "Projects/notes.md")).toBeNull();
  });
});

/**
 * The hoisted halves of the same walk. `coveringFolder` now delegates, so the
 * block above is still the behaviour; these pin the split itself, because the
 * only reason it exists is a caller asking about a whole list of paths at once.
 */
describe("memberFolderSet and coveringFolderIn", () => {
  it("answer together exactly as coveringFolder does alone", () => {
    const members: SpaceDefinition["members"] = [
      { path: "INBOX", kind: "folder" },
      { path: "Projects", kind: "file" },
      { kind: "tag", tag: "project" },
    ];
    const folders = memberFolderSet(members);
    for (const path of ["Inbox/today.md", "Projects/notes.md", "Archive/old.md", "Inbox"]) {
      expect(coveringFolderIn(folders, path)).toBe(coveringFolder(members, path));
    }
  });

  it("is built once and read many times, which is the point of the split", () => {
    const folders = memberFolderSet([{ path: "Projects", kind: "folder" }]);
    expect(coveringFolderIn(folders, "Projects/a.md")).toBe("Projects");
    expect(coveringFolderIn(folders, "Projects/b/c.md")).toBe("Projects");
    expect(coveringFolderIn(folders, "Archive/a.md")).toBeNull();
  });
});

/**
 * The tag half of the same question, for the create panel's tag tree: a
 * selected parent tag covers everything nested under it, and the rows under it
 * are drawn directly below it, so the tree says so.
 *
 * Analogous to the folder pair rather than shared with it: a tag's ancestors
 * are its `/`-separated prefixes, so `ancestorsOf` answers for both, but the
 * fold is `normalizeTag` (which also drops the `#` a user can see) rather than
 * `canonicalPath`, and the ancestor returned is the OUTERMOST rather than the
 * innermost.
 */
describe("memberTagSet and coveringTagIn", () => {
  it("keeps the tag members and folds them to the stored spelling", () => {
    const members: SpaceDefinition["members"] = [
      { kind: "tag", tag: "#Project" },
      { path: "Projects", kind: "folder" },
      { path: "inbox.md", kind: "file" },
    ];
    expect([...memberTagSet(members)]).toEqual(["project"]);
  });

  it("names the selected ancestor that covers a nested tag", () => {
    const tags = memberTagSet([{ kind: "tag", tag: "project" }]);
    expect(coveringTagIn(tags, "project/alpha")).toBe("project");
    expect(coveringTagIn(tags, "project/alpha/beta")).toBe("project");
  });

  it("does not treat a tag as its own covering ancestor", () => {
    const tags = memberTagSet([{ kind: "tag", tag: "project" }]);
    expect(coveringTagIn(tags, "project")).toBeNull();
  });

  it("returns the OUTERMOST ancestor when several are selected", () => {
    // Opposite to the folder walk, and deliberately so: both ancestors are
    // rows in the same tree, and the outermost is the one whose coverage is
    // not itself covered. Deselect it and the whole branch is free in one
    // gesture.
    const tags = memberTagSet([
      { kind: "tag", tag: "project" },
      { kind: "tag", tag: "project/alpha" },
    ]);
    expect(coveringTagIn(tags, "project/alpha/beta")).toBe("project");
  });

  it("does not match a sibling tag that merely shares a name prefix", () => {
    // The segment boundary is the whole correctness argument, the same one
    // `tagMatches` makes: `proj` must not cover `project/alpha`.
    const tags = memberTagSet([{ kind: "tag", tag: "proj" }]);
    expect(coveringTagIn(tags, "project/alpha")).toBeNull();
  });

  it("ignores file and folder members, which name no tag to nest under", () => {
    const members: SpaceDefinition["members"] = [
      { path: "project", kind: "folder" },
      { path: "project/alpha.md", kind: "file" },
    ];
    expect(coveringTagIn(memberTagSet(members), "project/alpha")).toBeNull();
  });

  it("folds the asked-about tag too, so a `#` spelling still answers", () => {
    const tags = memberTagSet([{ kind: "tag", tag: "project" }]);
    expect(coveringTagIn(tags, "#Project/Alpha")).toBe("project");
    expect(coveringTagIn(new Set<string>(), "project/alpha")).toBeNull();
  });
});
