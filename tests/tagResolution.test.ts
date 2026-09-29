import { describe, expect, it } from "vitest";
import { buildVisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { createTreeVaultIndex } from "../src/visibility/VaultIndex";
import { createMapTagIndex } from "../src/visibility/TagIndex";
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

const tags = createMapTagIndex(
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

  // Review Focus item 5. The exclusion is sticky. The opposite is equally
  // arguable, so it is pinned here rather than left to fall out.
  it("keeps a note excluded after its tag goes and comes back", () => {
    const s = space([{ kind: "tag", tag: "project" }], ["Work/a.md"]);
    const through = (index: ReturnType<typeof createMapTagIndex>): boolean =>
      buildVisibilitySnapshot(
        vault,
        { ...s, members: [...resolveMembers(s, index)] },
        new Set<string>(),
        compileIgnore([]),
        new Set((s.exclude ?? []).map(canonicalPath))
      )
        .visiblePaths()
        .has("Work/a.md");

    const tagged = createMapTagIndex(new Map([["Work/a.md", ["project"]]]));
    const untagged = createMapTagIndex(new Map([["Work/a.md", []]]));

    expect(through(tagged)).toBe(false);
    expect(through(untagged)).toBe(false);
    // Re-tagged. Nothing in the resolution path clears an exclusion, so the
    // note stays out until the user puts it back.
    expect(through(tagged)).toBe(false);
  });
});

describe("resolveMembers", () => {
  // Review Focus item 3.
  it("does not emit the same path twice when a tag and a folder both match", () => {
    const out = resolveMembers(
      space([
        { kind: "tag", tag: "project" },
        { kind: "file", path: "Work/a.md" },
      ]),
      tags
    );
    expect(out.filter((m) => m.path === "Work/a.md")).toHaveLength(1);
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
