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

describe("the picker's row budget", () => {
  it("accounts for sibling roots a big branch used the budget of, in a root-level marker", () => {
    // Rows are spent in order, so the expanded branch gets its children and the
    // roots after it are cut. They are not lost silently: the root level ends
    // with a marker that counts them.
    const tree = vaultWithFatBranch(500);
    const rows = visibleRows(tree, {
      expanded: new Set(["Afat"]),
      filter: "",
      selected: new Set(),
      budget: 20,
    });
    const paths = rows.filter((r) => r.kind !== "overflow").map((r) => (r as { path: string }).path);
    expect(paths).not.toContain("Zebra");
    expect(rows.find((r) => r.kind === "overflow" && r.parent === "")).toMatchObject({
      depth: 0,
      hidden: 2,
    });
    expect(rows[rows.length - 1]).toMatchObject({ kind: "overflow", parent: "" });
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
    // 1 root drawn, 17 children, 1 marker for the children, 1 for the roots.
    expect(rows).toHaveLength(20);
    expect(rows.filter((r) => r.kind === "overflow")).toHaveLength(2);
  });

  it("collapses a branch the budget never reached instead of drawing it open and empty", () => {
    // Three roots use the whole budget, so Afat's children get no slot at all
    // and neither does a marker. Drawing Afat expanded with nothing under it
    // would tell a screen reader the branch is open and empty, which is false.
    // It is drawn closed and flagged `budgetClosed` instead, so the panel can
    // draw a leaf that says why rather than a caret that does nothing. The
    // budget fits the three roots exactly, so no root marker is needed.
    const tree = vaultWithFatBranch(5);
    const rows = visibleRows(tree, {
      expanded: new Set(["Afat"]),
      filter: "",
      selected: new Set(),
      budget: 3,
    });
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.kind === "overflow")).toBe(false);
    expect(rows[0]).toMatchObject({
      path: "Afat",
      hasChildren: true,
      expanded: false,
      budgetClosed: true,
    });
  });

  it("holds the budget on one folder of 199 folders, filtered or opened by hand", () => {
    // The shape that produced 399 rows: level 0 is 1 row, level 1 is 199,
    // together exactly 200, and each of the 199 then wanted a marker nobody
    // had paid for.
    const entries: { path: string; kind: "file" | "folder" }[] = [folder("Notes")];
    for (let i = 0; i < 199; i++) {
      entries.push(folder(`Notes/d${i}`), file(`Notes/d${i}/n.md`));
    }
    const tree = buildVaultTree(entries, "folder", isBranchByKind);
    const all = new Set(entries.filter((e) => e.kind === "folder").map((e) => e.path));
    for (const filter of ["", "n"]) {
      const rows = visibleRows(tree, { expanded: all, filter, selected: new Set(), budget: 200 });
      expect(rows.length).toBeLessThanOrEqual(200);
      // Nothing is left open with nothing under it.
      for (const r of rows) {
        if (r.kind === "overflow" || !r.expanded) continue;
        const next = rows[rows.indexOf(r) + 1];
        expect(next && next.depth > r.depth).toBe(true);
      }
    }
  });
});

/** Small deterministic generator, so a failure names a seed that replays. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEntries(rnd: () => number, maxDepth: number, maxBranch: number) {
  const entries: { path: string; kind: "file" | "folder" }[] = [];
  const letters = "nafx";
  const grow = (prefix: string, depth: number): void => {
    const n = Math.floor(rnd() * (maxBranch + 1));
    for (let i = 0; i < n; i++) {
      const name = `${letters[Math.floor(rnd() * letters.length)]}${i}`;
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (depth < maxDepth && rnd() < 0.5) {
        entries.push({ path, kind: "folder" });
        grow(path, depth + 1);
      } else {
        entries.push({ path: `${path}.md`, kind: "file" });
      }
    }
  };
  grow("", 0);
  return entries;
}

describe("the picker's row budget, over generated trees", () => {
  const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

  it("never exceeds the budget and never drops rows without a marker that counts them", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rnd = prng(seed);
      const entries = randomEntries(rnd, 1 + Math.floor(rnd() * 4), 1 + Math.floor(rnd() * 14));
      const tree = buildVaultTree(entries, "folder", isBranchByKind);
      const folders = entries.filter((e) => e.kind === "folder").map((e) => e.path);
      const expanded = new Set(folders.filter(() => rnd() < 0.7));
      const budget = [1, 2, 3, 5, 8, 20, 50][Math.floor(rnd() * 7)];
      const filter = ["", "", "n", "a1", "f"][Math.floor(rnd() * 5)];
      const onlyKind = rnd() < 0.3 ? ("folder" as const) : null;
      const where = `seed ${seed}, budget ${budget}, filter "${filter}", onlyKind ${onlyKind}`;

      const base = { expanded, filter, selected: new Set<string>(), onlyKind };
      const reference = visibleRows(tree, base);
      const rows = visibleRows(tree, { ...base, budget });

      // 1. The budget is a ceiling, overflow rows included.
      expect(rows.length, where).toBeLessThanOrEqual(budget);

      const drawn = rows.flatMap((r) => (r.kind === "overflow" ? [] : [r]));
      const drawnPaths = new Set(drawn.map((r) => r.path));
      const markers = rows.flatMap((r) => (r.kind === "overflow" ? [r] : []));

      // 2. A marker ends its level: the row after it, if any, is shallower.
      for (const m of markers) {
        const next = rows[rows.indexOf(m) + 1];
        expect(next === undefined || next.depth < m.depth, `${where}, marker after ${m.parent}`).toBe(true);
      }

      // 3. Every parent drawn open (and the root) shows each of its children
      //    or says how many are missing. Nothing disappears silently.
      const parents = [
        { path: "", expanded: true },
        ...drawn.filter((r) => r.expanded).map((r) => ({ path: r.path, expanded: true })),
      ];
      for (const p of parents) {
        const wanted = reference.filter((r) => parentOf(r.path) === p.path);
        const got = wanted.filter((r) => drawnPaths.has(r.path));
        const marker = markers.find((m) => m.parent === p.path);
        if (got.length < wanted.length) {
          expect(marker?.hidden, `${where}, parent "${p.path}"`).toBe(wanted.length - got.length);
        } else {
          expect(marker, `${where}, parent "${p.path}"`).toBeUndefined();
        }
      }

      // 4. A row drawn open has something under it.
      drawn.forEach((r) => {
        if (!r.expanded) return;
        const next = rows[rows.indexOf(r) + 1];
        expect(next && next.depth > r.depth, `${where}, open row ${r.path}`).toBe(true);
      });

      // 5. A row is flagged exactly when the budget, not the user, kept it closed.
      for (const r of drawn) {
        const ref = reference.find((x) => x.path === r.path);
        // Flagged exactly when the budget, not the user, kept it closed.
        expect(Boolean(r.budgetClosed), `${where}, flag on ${r.path}`).toBe(
          Boolean(ref?.expanded && !r.expanded)
        );
      }
    }
  });
});

describe("the picker's row budget, on a wide root", () => {
  /** 12 folders and 96 notes at the root; `Bd` has 150 folders, each with a note. */
  function wideRoot() {
    const entries: { path: string; kind: "file" | "folder" }[] = [];
    for (let i = 0; i < 12; i++) entries.push(folder(i === 1 ? "Bd" : `F${String(i).padStart(3, "0")}`));
    for (let i = 0; i < 96; i++) entries.push(file(`root${String(i).padStart(3, "0")}.md`));
    for (let i = 0; i < 150; i++) {
      entries.push(folder(`Bd/c${String(i).padStart(3, "0")}`), file(`Bd/c${String(i).padStart(3, "0")}/g.md`));
    }
    return buildVaultTree(entries, "folder", isBranchByKind);
  }

  it("shows a grandchild when the user opens a branch and then one of its children", () => {
    const tree = wideRoot();
    const rows = visibleRows(tree, {
      expanded: new Set(["Bd", "Bd/c000"]),
      filter: "",
      selected: new Set(),
      budget: 200,
    });
    const paths = rows.flatMap((r) => (r.kind === "overflow" ? [] : [r.path]));
    expect(paths).toContain("Bd/c000/g.md");
    expect(rows.length).toBeLessThanOrEqual(200);
    // Opening a branch shows its children directly beneath it.
    const bd = rows.findIndex((r) => r.kind !== "overflow" && r.path === "Bd");
    expect(rows[bd + 1]).toMatchObject({ path: "Bd/c000", depth: 1 });
    expect(rows.find((r) => r.kind !== "overflow" && r.path === "Bd/c000")).not.toHaveProperty(
      "budgetClosed"
    );
  });

  it("gives the root level its own marker when later roots cannot be drawn", () => {
    const tree = wideRoot();
    const rows = visibleRows(tree, {
      expanded: new Set(["Bd"]),
      filter: "",
      selected: new Set(),
      budget: 60,
    });
    expect(rows.length).toBeLessThanOrEqual(60);
    const drawnRoots = rows.filter((r) => r.kind !== "overflow" && r.depth === 0);
    const marker = rows.find((r) => r.kind === "overflow" && r.parent === "");
    expect(marker).toBeDefined();
    // 108 roots, the ones drawn plus the count the marker gives.
    expect(drawnRoots.length + (marker as { hidden: number }).hidden).toBe(108);
    expect(marker).toMatchObject({ depth: 0 });
    // The branch that was cut inside says so too.
    expect(rows.some((r) => r.kind === "overflow" && r.parent === "Bd")).toBe(true);
  });

  it("marks a root level that is wider than the budget on its own", () => {
    const tree = wideRoot();
    const rows = visibleRows(tree, { expanded: new Set(), filter: "", selected: new Set(), budget: 50 });
    const markers = rows.filter((r) => r.kind === "overflow");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ parent: "", depth: 0, hidden: 108 - 49 });
    expect(rows).toHaveLength(50);
  });
});
