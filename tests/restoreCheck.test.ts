import { describe, expect, it } from "vitest";
import { restoreProblems } from "../src/ui/restoreCheck";
import type { MemberEntry, SpaceDefinition } from "../src/types";

function space(extra: Partial<SpaceDefinition> = {}, members: MemberEntry[] = []): SpaceDefinition {
  return { id: "s", name: "s", icon: "box", color: "#aabbcc", members, ...extra };
}

const has = (...paths: string[]) => (p: string) => paths.includes(p);

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
