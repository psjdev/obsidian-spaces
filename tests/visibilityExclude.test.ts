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
    ["Projects/sub", "folder"],
    ["Projects/sub/c.md", "file"],
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

  // This does not exercise the 3b pruning fixpoint: `Projects` is the seed,
  // and 3b spares seeds unconditionally (`if (seeds.has(p)) continue;`), so
  // it never becomes a pruning candidate regardless of what step 3b does.
  // The children never entering `included` is enough on its own to explain
  // both assertions. Kept because "a seed survives total exclusion of its
  // children" is still a real, distinct thing worth pinning; renamed so it
  // no longer claims to cover pruning.
  it("spares the seed folder even when every child is excluded", () => {
    const s = snap(
      [{ kind: "folder", path: "Projects" }],
      ["Projects/a.md", "Projects/b.md"]
    );
    expect(s.visiblePaths().has("Projects")).toBe(true);
    expect(s.visiblePaths().has("Projects/a.md")).toBe(false);
    expect(s.visiblePaths().has("Projects/b.md")).toBe(false);
  });

  // The case the test above cannot cover: a NON-seed folder emptied by
  // exclusions. `Projects/sub` is only reached by inheriting from the
  // `Projects` seed, so once its lone note is excluded it holds no visible
  // descendant and step 3b's fixpoint prunes it, exactly as it already does
  // for a folder emptied by an ignore rule. `Projects` itself is exempt from
  // that fixpoint only because it IS the seed (3b skips seeds unconditionally,
  // `if (seeds.has(p)) continue;`) — not because of anything about
  // exclusions — which is why the seed-survival assertion above needs its
  // own test rather than riding on this one.
  it("prunes a subfolder emptied by exclusions, and spares the seed", () => {
    const s = snap(
      [{ kind: "folder", path: "Projects" }],
      ["Projects/sub/c.md"]
    );
    expect(s.visiblePaths().has("Projects/sub")).toBe(false);
    expect(s.visiblePaths().has("Projects")).toBe(true);
    expect(s.visiblePaths().has("Projects/a.md")).toBe(true);
  });

  it("changes nothing when there are no exclusions", () => {
    const s = snap([{ kind: "folder", path: "Projects" }]);
    expect(s.visiblePaths().has("Projects/a.md")).toBe(true);
    expect(s.visiblePaths().has("Projects/b.md")).toBe(true);
  });
});
