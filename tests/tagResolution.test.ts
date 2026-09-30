import { describe, expect, it } from "vitest";
import { buildVisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { createTreeVaultIndex } from "../src/visibility/VaultIndex";
import { tagIndexOf } from "./helpers/tagIndex";
import { compileIgnore, canonicalPath } from "../src/visibility/glob";
import { resolveMembers } from "../src/controller/resolveMembers";
import type { MemberEntry, MemberKind, SpaceDefinition } from "../src/types";

const vault = createTreeVaultIndex(
  new Map<string, MemberKind>([
    ["Work", "folder"],
    ["Work/a.md", "file"],
    ["Personal", "folder"],
    ["Personal/b.md", "file"],
    ["Loose.md", "file"],
  ])
);

const tags = tagIndexOf(
  new Map([
    ["Work/a.md", ["project"]],
    ["Personal/b.md", ["project/atlas"]],
    ["Loose.md", ["person"]],
  ])
);

function space(members: MemberEntry[], exclude?: string[]): SpaceDefinition {
  return { id: "s", name: "S", icon: "box", color: "#808080", members, ...(exclude ? { exclude } : {}) };
}

function visible(s: SpaceDefinition): Set<string> {
  return buildVisibilitySnapshot(
    vault,
    { ...s, members: [...resolveMembers(s, tags)] },
    new Set<string>(),
    compileIgnore([]),
    new Set((s.exclude ?? []).map(canonicalPath))
  ).visiblePaths();
}

describe("a tag member", () => {
  it("brings in every note carrying the tag, wherever it lives", () => {
    const v = visible(space([{ kind: "tag", tag: "project" }]));
    expect(v.has("Work/a.md")).toBe(true);
    expect(v.has("Personal/b.md")).toBe(true);
    expect(v.has("Loose.md")).toBe(false);
  });

  it("shows the folders those notes live in as scaffolding", () => {
    const v = visible(space([{ kind: "tag", tag: "project" }]));
    expect(v.has("Work")).toBe(true);
    expect(v.has("Personal")).toBe(true);
  });

  it("mixes with hand picked notes", () => {
    const v = visible(
      space([
        { kind: "tag", tag: "project" },
        { kind: "file", path: "Loose.md" },
      ])
    );
    expect(v.has("Loose.md")).toBe(true);
    expect(v.has("Work/a.md")).toBe(true);
  });

  it("leaves out a note the space excludes", () => {
    const v = visible(space([{ kind: "tag", tag: "project" }], ["Personal/b.md"]));
    expect(v.has("Work/a.md")).toBe(true);
    expect(v.has("Personal/b.md")).toBe(false);
  });

  // Review Focus item 5 names a sticky-exclusion hazard: a note excluded,
  // then untagged, then tagged again, should stay excluded. It is not
  // pinned here. `resolveMembers` is pure and `space.exclude` is a frozen
  // literal in this file, so there is no state a re-tag could clear — a test
  // built at this layer cannot fail for "the exclusion cleared itself" no
  // matter how it is written, which is what an earlier version of this test
  // tried and could not actually distinguish. The real hazard lives wherever
  // a later write path removes a path from `exclude` (an "Add back to
  // space" action, say) and could accidentally do so on a re-tag too — that
  // is a later task's code and a later task's test. Not pinned here so it is
  // not mistaken for coverage that does not exist.
});

describe("resolveMembers", () => {
  // Review Focus item 3.
  it("does not emit the same path twice when a tag and a hand-added file both match the same note", () => {
    const out = resolveMembers(
      space([
        { kind: "tag", tag: "project" },
        { kind: "file", path: "Work/a.md" },
      ]),
      tags
    );
    expect(out.filter((m) => m.path === "Work/a.md")).toHaveLength(1);
  });

  // Review Focus item 3, the canonical-path half: `seen` keys on
  // `canonicalPath`, so two spellings of the same file must collide too, not
  // just two byte-identical paths. A `seen` keyed on the raw path would let
  // both spellings seed, putting a duplicate row in the user's file tree.
  it("does not emit the same path twice when a tag match and a hand-added file differ only in case", () => {
    const out = resolveMembers(
      space([
        { kind: "tag", tag: "project" },
        { kind: "file", path: "work/a.md" },
      ]),
      tags
    );
    expect(out.filter((m) => canonicalPath(m.path) === canonicalPath("Work/a.md"))).toHaveLength(1);
  });

  // Review Focus item 1.
  it("asks the tag index once per tag member, not once per note", () => {
    let calls = 0;
    const counting = {
      pathsMatching(tag: string): string[] {
        calls += 1;
        return tags.pathsMatching(tag);
      },
    };
    resolveMembers(
      space([
        { kind: "tag", tag: "project" },
        { kind: "tag", tag: "person" },
      ]),
      counting
    );
    expect(calls).toBe(2);
  });

  it("passes a space with no tag members through unchanged", () => {
    const s = space([{ kind: "folder", path: "Work" }]);
    expect(resolveMembers(s, tags)).toEqual([{ kind: "folder", path: "Work" }]);
  });
});
