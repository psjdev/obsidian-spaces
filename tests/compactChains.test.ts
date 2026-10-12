/**
 * The compaction rule, as a question about a tree rather than about the DOM.
 *
 * A run is folders that only lead onward. The tip is where that stops being
 * true, and the tip is what the caller substitutes, because a compacted row IS
 * the deepest folder wearing a longer label.
 */
import { describe, expect, it } from "vitest";
import { buildChainIndex, runFrom, sameChainIndex, type ChainTree } from "../src/visibility/compactChains";

/**
 * A tree written as a path-to-children map. Any path not listed is a note.
 *
 * `isFolder` and `isScaffold` are answered INDEPENDENTLY, not one in terms of
 * the other. A fixture that defined `isScaffold` as `isFolder && !member` made
 * every `isFolder` guard in the module unreachable, so a mutation deleting one
 * stayed green.
 */
function treeOf(
  children: Record<string, string[]>,
  opts: { members?: string[]; notFolders?: string[] } = {}
): ChainTree {
  const members = new Set(opts.members ?? []);
  const notFolders = new Set(opts.notFolders ?? []);
  const listed = (p: string): boolean => Object.prototype.hasOwnProperty.call(children, p);
  return {
    visibleChildrenOf: (p) => children[p] ?? [],
    isFolder: (p) => listed(p) && !notFolders.has(p),
    isScaffold: (p) => listed(p) && !members.has(p),
    parentOf: (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : null),
    nameOf: (p) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p),
  };
}

describe("runFrom", () => {
  it("collapses a chain of three folders to its deepest", () => {
    const t = treeOf({
      Work: ["Work/Clients"],
      "Work/Clients": ["Work/Clients/Northwind"],
      "Work/Clients/Northwind": ["Work/Clients/Northwind/notes.md"],
    });
    expect(runFrom("Work", t)).toEqual({
      tip: "Work/Clients/Northwind",
      segments: ["Work", "Clients", "Northwind"],
    });
  });

  it("stops where a chain branches, because the branch is the information", () => {
    const t = treeOf({
      Work: ["Work/Clients"],
      "Work/Clients": ["Work/Clients/Northwind", "Work/Clients/Contoso"],
      "Work/Clients/Northwind": ["Work/Clients/Northwind/a.md"],
      "Work/Clients/Contoso": ["Work/Clients/Contoso/b.md"],
    });
    expect(runFrom("Work", t)).toEqual({ tip: "Work/Clients", segments: ["Work", "Clients"] });
  });

  it("stops before a folder the user added as a member", () => {
    // The user picked `Clients`, so it keeps its own row and may be acted on.
    const t = treeOf(
      {
        Work: ["Work/Clients"],
        "Work/Clients": ["Work/Clients/a.md"],
      },
      { members: ["Work/Clients"] }
    );
    expect(runFrom("Work", t)).toBeNull();
  });

  it("does not compact a folder whose only visible child is a note", () => {
    const t = treeOf({ Work: ["Work/a.md"] });
    expect(runFrom("Work", t)).toBeNull();
  });

  it("does not compact a folder that is itself a member", () => {
    const t = treeOf(
      { Work: ["Work/Clients"], "Work/Clients": ["Work/Clients/a.md"] },
      { members: ["Work"] }
    );
    expect(runFrom("Work", t)).toBeNull();
  });

  it("returns null for something that is not a folder, even when it is scaffold", () => {
    // Pins the `isFolder(start)` half of the first guard. Without it this
    // walks the children the fixture gives and returns a two-segment run.
    const t = treeOf({ X: ["X/y"], "X/y": ["X/y/z.md"] }, { notFolders: ["X"] });
    expect(runFrom("X", t)).toBeNull();
  });

  it("does not extend into a child that is not a folder, even when it is scaffold", () => {
    // Pins the `isFolder(only)` half. Without it the run reaches `X/y` and
    // comes back two segments long.
    const t = treeOf({ X: ["X/y"], "X/y": ["X/y/z.md"] }, { notFolders: ["X/y"] });
    expect(runFrom("X", t)).toBeNull();
  });
});

describe("buildChainIndex", () => {
  const t = treeOf({
    Work: ["Work/Clients"],
    "Work/Clients": ["Work/Clients/Northwind"],
    "Work/Clients/Northwind": ["Work/Clients/Northwind/a.md"],
    Archive: ["Archive/old.md"],
  });

  it("indexes a run by its head and by its tip", () => {
    const ix = buildChainIndex(["Work", "Work/Clients", "Work/Clients/Northwind", "Archive"], t);
    expect(ix.runByHead.get("Work")?.tip).toBe("Work/Clients/Northwind");
    expect(ix.runByTip.get("Work/Clients/Northwind")?.segments).toEqual([
      "Work",
      "Clients",
      "Northwind",
    ]);
  });

  it("indexes a run once, under its head, never under a folder inside it", () => {
    // `Work/Clients` is mid-run. Indexing it as a head too would substitute it
    // for itself at a level that never renders.
    const ix = buildChainIndex(["Work", "Work/Clients", "Work/Clients/Northwind"], t);
    expect(ix.runByHead.has("Work/Clients")).toBe(false);
    expect(ix.runByHead.size).toBe(1);
  });

  it("indexes nothing for a folder that does not compact", () => {
    const ix = buildChainIndex(["Archive"], t);
    expect(ix.runByHead.size).toBe(0);
    expect(ix.runByTip.size).toBe(0);
    expect(ix.hiddenSegments.size).toBe(0);
  });

  it("indexes every folder of the run that gets no row, and not the tip", () => {
    // The head and each intermediate. The tip is the one folder of a run that
    // renders, so it must NOT be here: the sort seam blanks what this map
    // holds, and blanking the tip would empty the compacted row.
    const ix = buildChainIndex(["Work", "Work/Clients", "Work/Clients/Northwind", "Archive"], t);
    expect([...ix.hiddenSegments.keys()].sort()).toEqual(["Work", "Work/Clients"]);
    expect(ix.hiddenSegments.has("Work/Clients/Northwind")).toBe(false);
    expect(ix.hiddenSegments.get("Work/Clients")?.tip).toBe("Work/Clients/Northwind");
  });

  it("indexes the hidden segments of a run that does not start at the top level", () => {
    // The nested shape C2 was measured on: the head's parent is a visible
    // folder of its own, so the tip's row is drawn under it and every folder
    // between the two must stay silent.
    const b = treeOf({
      Nested: ["Nested/Chain", "Nested/note.md"],
      "Nested/Chain": ["Nested/Chain/L1"],
      "Nested/Chain/L1": ["Nested/Chain/L1/L2"],
      "Nested/Chain/L1/L2": ["Nested/Chain/L1/L2/a.md"],
    });
    const ix = buildChainIndex(
      ["Nested", "Nested/Chain", "Nested/Chain/L1", "Nested/Chain/L1/L2"],
      b
    );
    expect([...ix.hiddenSegments.keys()].sort()).toEqual(["Nested/Chain", "Nested/Chain/L1"]);
    expect(ix.hiddenSegments.has("Nested")).toBe(false);
  });

  it("indexes a run that starts under a branching parent", () => {
    // `Clients` has two visible children so it is no run itself, but the chain
    // below `Northwind` still is one and must not be lost along with it.
    const b = treeOf({
      Clients: ["Clients/Northwind", "Clients/Contoso"],
      "Clients/Northwind": ["Clients/Northwind/2026"],
      "Clients/Northwind/2026": ["Clients/Northwind/2026/a.md"],
      "Clients/Contoso": ["Clients/Contoso/b.md"],
    });
    const ix = buildChainIndex(
      ["Clients", "Clients/Northwind", "Clients/Northwind/2026", "Clients/Contoso"],
      b
    );
    expect(ix.runByHead.get("Clients/Northwind")?.tip).toBe("Clients/Northwind/2026");
    expect(ix.runByHead.has("Clients")).toBe(false);
  });

  it("indexes a run that starts under a member folder", () => {
    // The member keeps its own row, and the chain below it is still a chain.
    const b = treeOf(
      {
        Picked: ["Picked/A"],
        "Picked/A": ["Picked/A/B"],
        "Picked/A/B": ["Picked/A/B/a.md"],
      },
      { members: ["Picked"] }
    );
    const ix = buildChainIndex(["Picked", "Picked/A", "Picked/A/B"], b);
    expect(ix.runByHead.get("Picked/A")?.tip).toBe("Picked/A/B");
    expect(ix.runByHead.has("Picked")).toBe(false);
  });
});

describe("sameChainIndex", () => {
  const WORK = {
    Work: ["Work/Clients"],
    "Work/Clients": ["Work/Clients/Northwind"],
    "Work/Clients/Northwind": ["Work/Clients/Northwind/notes.md"],
  };
  const indexOf = (children: Record<string, string[]>) =>
    buildChainIndex(Object.keys(children), treeOf(children));

  it("treats two indexes built from the same tree as the same", () => {
    expect(sameChainIndex(indexOf(WORK), indexOf(WORK))).toBe(true);
  });

  it("treats an empty index as the same as an empty index", () => {
    expect(sameChainIndex(indexOf({}), indexOf({}))).toBe(true);
  });

  it("treats null as the same as null, and as different from any index", () => {
    expect(sameChainIndex(null, null)).toBe(true);
    expect(sameChainIndex(null, indexOf({}))).toBe(false);
    expect(sameChainIndex(indexOf({}), null)).toBe(false);
  });

  it("differs when the tip differs", () => {
    const shorter = {
      Work: ["Work/Clients"],
      "Work/Clients": ["Work/Clients/a.md", "Work/Clients/b.md"],
    };
    expect(sameChainIndex(indexOf(WORK), indexOf(shorter))).toBe(false);
  });

  it("differs when the segments differ but the tip does not", () => {
    const a = buildChainIndex(["Work"], treeOf(WORK));
    const b = buildChainIndex(["Work"], treeOf(WORK));
    b.runByHead.get("Work")!.segments = ["Work", "Renamed", "Northwind"];
    expect(sameChainIndex(a, b)).toBe(false);
  });

  it("differs when segments hold the same names in a different order", () => {
    const a = buildChainIndex(["Work"], treeOf(WORK));
    const b = buildChainIndex(["Work"], treeOf(WORK));
    a.runByHead.get("Work")!.segments = ["A", "B", "C"];
    b.runByHead.get("Work")!.segments = ["A", "C", "B"];
    expect(sameChainIndex(a, b)).toBe(false);
  });

  it("differs when one run is a strict prefix of the other with the same head and tip", () => {
    const a = buildChainIndex(["Work"], treeOf(WORK));
    const b = buildChainIndex(["Work"], treeOf(WORK));
    a.runByHead.get("Work")!.segments = ["Work", "Clients"];
    b.runByHead.get("Work")!.segments = ["Work", "Clients", "Northwind"];
    expect(sameChainIndex(a, b)).toBe(false);
    expect(sameChainIndex(b, a)).toBe(false);
  });

  it("differs when a head exists in one and not the other", () => {
    const more = { ...WORK, Other: ["Other/Sub"], "Other/Sub": ["Other/Sub/x.md"] };
    expect(sameChainIndex(indexOf(WORK), indexOf(more))).toBe(false);
    expect(sameChainIndex(indexOf(more), indexOf(WORK))).toBe(false);
  });

  it("differs when the same number of heads are different heads", () => {
    const a = indexOf({ A: ["A/B"], "A/B": ["A/B/x.md"] });
    const b = indexOf({ C: ["C/D"], "C/D": ["C/D/x.md"] });
    expect(sameChainIndex(a, b)).toBe(false);
  });

  it("differs when the hidden segments differ although every head matches", () => {
    // A tie keeps the PREVIOUS index object, and that object is what the sort
    // seam blanks folders by. Agreeing about the heads while disagreeing about
    // which folders are silent would keep an index that lets one of them
    // answer the sort, which is C2 again.
    const a = buildChainIndex(["Work"], treeOf(WORK));
    const b = buildChainIndex(["Work"], treeOf(WORK));
    b.hiddenSegments.delete("Work/Clients");
    expect(sameChainIndex(a, b)).toBe(false);
    expect(sameChainIndex(b, a)).toBe(false);
  });
});
