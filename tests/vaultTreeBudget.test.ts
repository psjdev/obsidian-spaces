import { describe, expect, it } from "vitest";
import { buildVaultTree, isBranchByKind, visibleRows } from "../src/ui/vaultTree";

const folder = (path: string) => ({ path, kind: "folder" as const });
const file = (path: string) => ({ path, kind: "file" as const });

/** One fat branch that sorts first, plus roots that sort after it. */
function vaultWithFatBranch(children: number) {
  const entries: { path: string; kind: "file" | "folder" }[] = [folder("Afat")];
  for (let i = 0; i < children; i++) entries.push(file(`Afat/n${String(i).padStart(4, "0")}.md`));
  entries.push(folder("Zebra"), file("Zebra/z.md"), file("zoo.md"));
  return buildVaultTree(entries, "folder", isBranchByKind);
}

const depthsOf = (rows: { depth: number }[]) => rows.map((r) => r.depth);

describe("the picker's row budget", () => {
  it("never drops a shallower row while drawing a deeper one", () => {
    const tree = vaultWithFatBranch(500);
    const rows = visibleRows(tree, {
      expanded: new Set(["Afat"]),
      filter: "",
      selected: new Set(),
      budget: 20,
    });
    const drawnDepths = depthsOf(rows);
    const maxDrawn = Math.max(...drawnDepths);
    // Every row at a depth shallower than the deepest drawn row must be present.
    const rootsDrawn = rows.filter((r) => r.depth === 0).length;
    expect(maxDrawn).toBeGreaterThan(0);
    expect(rootsDrawn).toBe(3);
  });

  it("keeps sibling roots when a branch is expanded past the budget", () => {
    const tree = vaultWithFatBranch(500);
    const rows = visibleRows(tree, {
      expanded: new Set(["Afat"]),
      filter: "",
      selected: new Set(),
      budget: 20,
    });
    const paths = rows.filter((r) => r.kind !== "overflow").map((r) => (r as { path: string }).path);
    expect(paths).toContain("Zebra");
    expect(paths).toContain("zoo.md");
  });

  it("puts the overflow row inside the branch it describes", () => {
    const tree = vaultWithFatBranch(500);
    const rows = visibleRows(tree, {
      expanded: new Set(["Afat"]),
      filter: "",
      selected: new Set(),
      budget: 20,
    });
    const overflow = rows.find((r) => r.kind === "overflow");
    expect(overflow).toBeDefined();
    expect(overflow).toMatchObject({ parent: "Afat", depth: 1 });
    expect((overflow as { hidden: number }).hidden).toBeGreaterThan(0);
  });

  it("caps the root level itself on a flat vault", () => {
    const entries: { path: string; kind: "file" | "folder" }[] = [];
    for (let i = 0; i < 400; i++) entries.push(file(`n${String(i).padStart(4, "0")}.md`));
    const tree = buildVaultTree(entries, "folder", isBranchByKind);
    const rows = visibleRows(tree, {
      expanded: new Set(),
      filter: "",
      selected: new Set(),
      budget: 50,
    });
    const overflow = rows.filter((r) => r.kind === "overflow");
    expect(overflow).toHaveLength(1);
    expect(overflow[0]).toMatchObject({ parent: "", depth: 0 });
    expect(rows.filter((r) => r.kind !== "overflow")).toHaveLength(49);
    // The overflow row spends a slot of the budget, so the total is the budget.
    expect(rows).toHaveLength(50);
  });

  it("draws everything and no overflow row when it all fits", () => {
    const tree = vaultWithFatBranch(3);
    const rows = visibleRows(tree, {
      expanded: new Set(["Afat"]),
      filter: "",
      selected: new Set(),
      budget: 200,
    });
    expect(rows.some((r) => r.kind === "overflow")).toBe(false);
  });

  it("keeps the total inside the budget when a branch is cut", () => {
    const tree = vaultWithFatBranch(500);
    const rows = visibleRows(tree, {
      expanded: new Set(["Afat"]),
      filter: "",
      selected: new Set(),
      budget: 20,
    });
    // 3 roots, 16 children, 1 marker.
    expect(rows).toHaveLength(20);
  });

  it("still marks a branch the budget never reached", () => {
    // Three roots use the whole budget, so Afat's children get no slot at all.
    // Silence under an open branch is the defect, so it gets a marker anyway.
    const tree = vaultWithFatBranch(5);
    const rows = visibleRows(tree, {
      expanded: new Set(["Afat"]),
      filter: "",
      selected: new Set(),
      budget: 3,
    });
    expect(rows.filter((r) => r.depth === 0 && r.kind !== "overflow")).toHaveLength(3);
    expect(rows.find((r) => r.kind === "overflow")).toMatchObject({ parent: "Afat", hidden: 5, depth: 1 });
  });
});
