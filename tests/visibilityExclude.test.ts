import { describe, expect, it } from "vitest";
import { buildVisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { createTreeVaultIndex } from "../src/visibility/VaultIndex";
import { compileIgnore, canonicalPath } from "../src/visibility/glob";
import type { MemberEntry, MemberKind, SpaceDefinition } from "../src/types";

const vault = createTreeVaultIndex(
  new Map<string, MemberKind>([
    ["Projects", "folder"],
    ["Projects/a.md", "file"],
    ["Projects/b.md", "file"],
    ["Loose.md", "file"],
  ])
);

function space(members: MemberEntry[], exclude?: string[]): SpaceDefinition {
  return { id: "s", name: "S", icon: "box", color: "#808080", members, ...(exclude ? { exclude } : {}) };
}

function snap(members: MemberEntry[], exclude: string[] = []) {
  return buildVisibilitySnapshot(
    vault,
    space(members, exclude),
    new Set<string>(),
    compileIgnore([]),
    new Set(exclude.map(canonicalPath))
  );
}

describe("exclusions", () => {
  it("hides a note inherited from a member folder", () => {
    const s = snap([{ kind: "folder", path: "Projects" }], ["Projects/b.md"]);
    expect(s.visiblePaths().has("Projects/a.md")).toBe(true);
    expect(s.visiblePaths().has("Projects/b.md")).toBe(false);
  });

  // Exclusion beats everything EXCEPT an explicit path member. Removing a
  // hand-added note removes the member; it does not write an exclusion, so
  // this state is reachable only by hand-editing the document.
  it("does not hide a note the user added by hand", () => {
    const s = snap([{ kind: "file", path: "Loose.md" }], ["Loose.md"]);
    expect(s.visiblePaths().has("Loose.md")).toBe(true);
  });

  it("compares case-insensitively, like every other path comparison", () => {
    const s = snap([{ kind: "folder", path: "Projects" }], ["projects/B.MD"]);
    expect(s.visiblePaths().has("Projects/b.md")).toBe(false);
  });

  it("prunes a member folder left empty by exclusions", () => {
    const s = snap(
      [{ kind: "folder", path: "Projects" }],
      ["Projects/a.md", "Projects/b.md"]
    );
    // The folder is a seed, so it survives as the space's own root.
    expect(s.visiblePaths().has("Projects/a.md")).toBe(false);
    expect(s.visiblePaths().has("Projects/b.md")).toBe(false);
  });

  it("changes nothing when there are no exclusions", () => {
    const s = snap([{ kind: "folder", path: "Projects" }]);
    expect(s.visiblePaths().has("Projects/a.md")).toBe(true);
    expect(s.visiblePaths().has("Projects/b.md")).toBe(true);
  });
});
