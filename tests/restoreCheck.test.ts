import { describe, expect, it } from "vitest";
import { restoreProblems } from "../src/ui/restoreCheck";
import type { MemberEntry, SpaceDefinition } from "../src/types";

function space(extra: Partial<SpaceDefinition> = {}, members: MemberEntry[] = []): SpaceDefinition {
  return { id: "s", name: "s", icon: "box", color: "#aabbcc", members, ...extra };
}

/**
 * The vault, as the gate asks it: by KIND. A path occupied by the other kind
 * is as broken for the restored space as an empty one, and `pointProblem`
 * already refuses a typed path of the wrong kind.
 */
const has =
  (...paths: string[]) =>
  (p: string): "file" | "folder" | null => {
    if (!paths.includes(p)) return null;
    return p.endsWith(".md") ? "file" : "folder";
  };

describe("restoreProblems", () => {
  it("reports nothing when every member resolves", () => {
    const s = space({}, [
      { kind: "file", path: "a.md" },
      { kind: "folder", path: "Dir" },
    ]);
    expect(restoreProblems(s, has("a.md", "Dir"))).toEqual([]);
  });

  it("reports a file member whose note is gone", () => {
    const s = space({}, [{ kind: "file", path: "a.md" }]);
    expect(restoreProblems(s, has())).toEqual([
      { kind: "member", path: "a.md", memberKind: "file" },
    ]);
  });

  it("reports a folder member whose folder is gone", () => {
    const s = space({}, [{ kind: "folder", path: "Dir" }]);
    expect(restoreProblems(s, has())).toEqual([
      { kind: "member", path: "Dir", memberKind: "folder" },
    ]);
  });

  it("reports a folder space's missing root", () => {
    const s = space({ root: "Projects/Project X" });
    expect(restoreProblems(s, has())).toEqual([{ kind: "root", path: "Projects/Project X" }]);
  });

  it("reports nothing for a folder space whose root resolves", () => {
    const s = space({ root: "Projects/Project X" });
    expect(restoreProblems(s, has("Projects/Project X"))).toEqual([]);
  });

  it("treats an empty or slash root as no folder chosen", () => {
    expect(restoreProblems(space({ root: "" }), has())).toEqual([]);
    expect(restoreProblems(space({ root: "/" }), has())).toEqual([]);
  });

  it("never reports a tag member", () => {
    expect(restoreProblems(space({}, [{ kind: "tag", tag: "work" }]), has())).toEqual([]);
  });

  it("never reports a property member", () => {
    const s = space({}, [
      { kind: "property", key: "status" },
      { kind: "property", key: "status", value: "done" },
    ]);
    expect(restoreProblems(s, has())).toEqual([]);
  });

  it("ignores the exclude list", () => {
    const s = space({ exclude: ["gone.md"] }, [{ kind: "file", path: "a.md" }]);
    expect(restoreProblems(s, has("a.md"))).toEqual([]);
  });

  it("reports a member whose path is now the other kind", () => {
    // A folder space whose root path became a note used to pass the gate
    // silently, restore, and then produce a `no longer exists` Notice: the
    // design's named anti-goal, reached by a different door.
    const kindAt = (p: string): "file" | "folder" | null =>
      p === "Dir" ? "file" : p === "a.md" ? "folder" : null;
    const s = space({}, [
      { kind: "folder", path: "Dir" },
      { kind: "file", path: "a.md" },
    ]);
    expect(restoreProblems(s, kindAt)).toEqual([
      { kind: "member", path: "Dir", memberKind: "folder" },
      { kind: "member", path: "a.md", memberKind: "file" },
    ]);
  });

  it("reports a root whose path is now a note", () => {
    const s = space({ root: "Projects" });
    expect(restoreProblems(s, (p) => (p === "Projects" ? "file" : null))).toEqual([
      { kind: "root", path: "Projects" },
    ]);
  });

  it("reports members and a root together for a space that stores both", () => {
    const s = space({ root: "Root" }, [
      { kind: "file", path: "a.md" },
      { kind: "folder", path: "Dir" },
    ]);
    expect(restoreProblems(s, has())).toEqual([
      { kind: "member", path: "a.md", memberKind: "file" },
      { kind: "member", path: "Dir", memberKind: "folder" },
      { kind: "root", path: "Root" },
    ]);
  });
});
