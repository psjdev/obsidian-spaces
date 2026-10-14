import { describe, expect, it } from "vitest";
import { createTreeVaultIndex } from "../src/visibility/VaultIndex";
import { canonicalPath, compileIgnore } from "../src/visibility/glob";
import { includedPaths } from "../src/visibility/includedPaths";
import { resolveMembers } from "../src/controller/resolveMembers";
import { createPropertyIndex } from "../src/visibility/PropertyIndex";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { buildPreview } from "../src/ui/previewSeam";
import type { MemberEntry, MemberKind, SpaceDefinition } from "../src/types";

const vaultOf = (e: [string, MemberKind][]) => createTreeVaultIndex(new Map(e));

const tagIndex = (hits: Record<string, string[]>) => ({
  pathsMatching: (t: string): readonly string[] => hits[t] ?? [],
});

describe("the create panel's preview runs the engine's own resolution", () => {
  it("counts notes under a folder member", () => {
    const vault = vaultOf([
      ["Projects", "folder"],
      ["Projects/a.md", "file"],
      ["Projects/b.md", "file"],
    ]);
    const p = buildPreview(vault, compileIgnore([]), tagIndex({}), () => null);
    expect(p([{ kind: "folder", path: "Projects" }]).notes).toBe(2);
  });

  it("honours globalIgnore, which the old preview did not", () => {
    const vault = vaultOf([
      ["Projects", "folder"],
      ["Projects/a.md", "file"],
      ["Projects/secret.md", "file"],
    ]);
    const p = buildPreview(vault, compileIgnore(["**/secret.md"]), tagIndex({}), () => null);
    expect(p([{ kind: "folder", path: "Projects" }]).notes).toBe(1);
  });

  it("does not treat Docs as covering docs, which the old preview did", () => {
    const vault = vaultOf([
      ["Docs", "folder"],
      ["Docs/a.md", "file"],
      ["docs", "folder"],
      ["docs/b.md", "file"],
    ]);
    const p = buildPreview(vault, compileIgnore([]), tagIndex({}), () => null);
    expect(p([{ kind: "folder", path: "Docs" }]).notes).toBe(1);
  });

  it("counts a note carried by two members once", () => {
    const vault = vaultOf([
      ["Projects", "folder"],
      ["Projects/a.md", "file"],
    ]);
    const p = buildPreview(vault, compileIgnore([]), tagIndex({ work: ["Projects/a.md"] }), () => null);
    const members: MemberEntry[] = [
      { kind: "folder", path: "Projects" },
      { kind: "tag", tag: "work" },
    ];
    expect(p(members).notes).toBe(1);
  });

  it("promises nothing for a folder whose every note is ignored", () => {
    const vault = vaultOf([
      ["Archive", "folder"],
      ["Archive/a.md", "file"],
    ]);
    const p = buildPreview(vault, compileIgnore(["Archive/**"]), tagIndex({}), () => null);
    expect(p([{ kind: "folder", path: "Archive" }]).notes).toBe(0);
  });

  it("agrees with includedPaths exactly", () => {
    const vault = vaultOf([
      ["Projects", "folder"],
      ["Projects/a.md", "file"],
      ["Projects/Deep", "folder"],
      ["Projects/Deep/c.md", "file"],
      ["Top.md", "file"],
    ]);
    const ignore = compileIgnore(["**/c.md"]);
    const p = buildPreview(vault, ignore, tagIndex({}), () => null);
    const got = p([{ kind: "folder", path: "Projects" }, { kind: "file", path: "Top.md" }]);
    const want = includedPaths(vault, ["Projects", "Top.md"], ignore, new Set()).included;
    expect([...got.paths].sort()).toEqual([...want].sort());
  });

  it("counts two spellings of one note once, as a recompute does", () => {
    // A case-sensitive filesystem can hold both. resolveMembers keys its
    // de-duplication on the folded path, so the first spelling wins and the
    // second never reaches the engine.
    const vault = vaultOf([
      ["Docs", "folder"],
      ["Docs/a.md", "file"],
      ["docs", "folder"],
      ["docs/a.md", "file"],
    ]);
    const p = buildPreview(vault, compileIgnore([]), tagIndex({ t: ["docs/a.md"] }), () => null);
    expect(
      p([
        { kind: "file", path: "Docs/a.md" },
        { kind: "file", path: "docs/a.md" },
      ]).notes
    ).toBe(1);
    expect(
      p([
        { kind: "file", path: "Docs/a.md" },
        { kind: "tag", tag: "t" },
      ]).notes
    ).toBe(1);
  });

  it("seeds exactly what a recompute seeds, over every member kind at once", () => {
    // Preview and tree run ONE expansion (`expandMembers`), rather than a
    // copy each. This is that agreement asserted end to end: the same members,
    // the same exclusion, the same property index, compared against what
    // `resolveMembers` hands the engine. The preview's copy had already
    // drifted once — it had no exhaustive tail, so a fifth member kind would
    // have gone missing from the count with nothing to say so.
    const vault = vaultOf([
      ["Work", "folder"],
      ["Work/a.md", "file"],
      ["Work/b.md", "file"],
      ["Work/tagged.md", "file"],
      ["Loose.md", "file"],
      ["Notes", "folder"],
      ["Notes/n.md", "file"],
    ]);
    const tags = createMapTagIndex(new Map([["t", ["Work/tagged.md"]]]));
    const index = createPropertyIndex(
      [
        { path: "Work/a.md", frontmatter: { status: "active" } },
        { path: "Work/b.md", frontmatter: { status: "active" } },
      ],
      1
    );
    const members: MemberEntry[] = [
      { kind: "folder", path: "Notes" },
      { kind: "file", path: "Loose.md" },
      { kind: "tag", tag: "t" },
      { kind: "property", key: "status", value: "active" },
    ];
    // Drops the property match and NOT the hand-picked file, which is the
    // precedence both sides have to give them.
    const exclude = ["Work/b.md", "Loose.md"];
    const excluded = new Set(exclude.map(canonicalPath));
    const space: SpaceDefinition = {
      id: "s",
      name: "S",
      icon: "box",
      color: "#808080",
      members,
      exclude,
    };
    const ignore = compileIgnore([]);

    const got = buildPreview(vault, ignore, tags, () => index, excluded)(members);
    const want = includedPaths(
      vault,
      resolveMembers(space, tags, index).map((m) => m.path),
      ignore,
      excluded
    ).included;
    expect([...got.paths].sort()).toEqual([...want].sort());
    // Notes/n.md, Loose.md (hand-picked, so its own exclusion does not drop
    // it), Work/tagged.md and Work/a.md. Work/b.md is the excluded match.
    expect(got.notes).toBe(4);
  });

  it("counts two spellings of one folder member once, as a recompute does", () => {
    const vault = vaultOf([
      ["Docs", "folder"],
      ["Docs/a.md", "file"],
      ["docs", "folder"],
      ["docs/b.md", "file"],
    ]);
    const p = buildPreview(vault, compileIgnore([]), tagIndex({}), () => null);
    expect(
      p([
        { kind: "folder", path: "Docs" },
        { kind: "folder", path: "docs" },
      ]).notes
    ).toBe(1);
  });
});
