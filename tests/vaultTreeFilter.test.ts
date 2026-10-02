import { describe, expect, it } from "vitest";
import { buildVaultTree, isBranchByChildren, isBranchByKind, visibleRows } from "../src/ui/vaultTree";

const folder = (path: string) => ({ path, kind: "folder" as const });
const file = (path: string) => ({ path, kind: "file" as const });
const tag = (path: string) => ({ path, kind: "tag" as const });

const TAGS = buildVaultTree(
  [tag("project"), tag("project/atlas"), tag("project/console"), tag("project/atlas/phase-1"), tag("archive")],
  "tag",
  isBranchByChildren
);

const FILES = buildVaultTree(
  [folder("Projects"), folder("Projects/Console 2030"), file("Projects/Roadmap.md"), file("Top.md")],
  "folder",
  isBranchByKind
);

// No budget, so this is the overload that returns plain rows with no overflow.
const show = <K extends string>(tree: Parameters<typeof visibleRows<K>>[0], filter: string) =>
  visibleRows(tree, { expanded: new Set(), filter, selected: new Set() }).map((r) => r.path);

describe("the picker's filter", () => {
  it("finds a nested tag by its parent and partial child", () => {
    expect(show(TAGS, "project/at")).toContain("project/atlas");
  });

  it("finds a nested folder by its parent and partial child", () => {
    expect(show(FILES, "Projects/Cons")).toContain("Projects/Console 2030");
  });

  it("still matches the last segment alone", () => {
    expect(show(TAGS, "atlas")).toContain("project/atlas");
    expect(show(FILES, "Roadmap")).toContain("Projects/Roadmap.md");
  });

  it("is case insensitive on both sides of the separator", () => {
    expect(show(TAGS, "PROJECT/AT")).toContain("project/atlas");
  });

  it("a query of only a separator matches every nested thing and nothing flat", () => {
    const rows = show(TAGS, "/");
    expect(rows).toContain("project/atlas");
    expect(rows).not.toContain("archive");
    // `project` is kept as the ancestor of its matches, not matched itself.
    expect(rows).toEqual(["project", "project/atlas", "project/atlas/phase-1", "project/console"]);
  });

  it("a deep query keeps the matched node's whole subtree", () => {
    expect(show(TAGS, "project/atlas")).toContain("project/atlas/phase-1");
  });

  it("a query matching nothing returns nothing rather than throwing", () => {
    expect(show(TAGS, "project/zzz")).toEqual([]);
  });
});
