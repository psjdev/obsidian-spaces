/**
 * The display/vault translation, on its own.
 *
 * Layer 1: no plugin, no vault, no DOM, no `obsidian`. The index is built by
 * the real `buildChainIndex` over a hand-stated tree rather than assembled by
 * hand, so a change to `ChainIndex`'s shape reddens here instead of quietly
 * leaving these fixtures describing an index the production code no longer
 * builds.
 *
 * The identity cases carry most of the weight. Every drag test in the suite
 * runs with no index at all, and they were all written before this layer
 * existed; if identity is not exact, the cost does not show up here but in
 * them.
 */
import { describe, expect, it, vi } from "vitest";
import { buildChainIndex, type ChainIndex, type ChainTree } from "../src/visibility/compactChains";
import {
  displayParentOf,
  displayToStored,
  isCompactedRow,
  storedToDisplay,
} from "../src/visibility/compactCoords";

/**
 * A tree stated as "folder -> its visible children". A path absent from the
 * map is a note, and every folder is scaffold unless `members` names it.
 */
function indexFor(tree: Record<string, string[]>, members: readonly string[] = []): ChainIndex {
  const isFolder = (p: string): boolean => Object.prototype.hasOwnProperty.call(tree, p);
  const chainTree: ChainTree = {
    visibleChildrenOf: (p) => tree[p] ?? [],
    isFolder,
    isScaffold: (p) => isFolder(p) && !members.includes(p),
    parentOf: (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : null),
    nameOf: (p) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p),
  };
  // The vault root is left out for the same reason `rebuildChainIndex` never
  // sees it: it is not a visible path in a snapshot, and a root with one
  // visible child would otherwise index as a run whose head has no row.
  return buildChainIndex(
    Object.keys(tree).filter((p) => p !== ""),
    chainTree
  );
}

/** `Parent` contains the run `Parent/Chain -> Parent/Chain/Link`, plus two notes. */
const NESTED = {
  tree: {
    Parent: ["Parent/Chain", "Parent/alpha.md", "Parent/zeta.md"],
    "Parent/Chain": ["Parent/Chain/Link"],
    "Parent/Chain/Link": ["Parent/Chain/Link/note.md"],
  },
  members: ["Parent/Chain/Link/note.md", "Parent/alpha.md", "Parent/zeta.md"],
};

/** Three folders deep, so there is a middle segment that is neither head nor tip. */
const DEEP = {
  tree: {
    Parent: ["Parent/A", "Parent/other.md"],
    "Parent/A": ["Parent/A/B"],
    "Parent/A/B": ["Parent/A/B/C"],
    "Parent/A/B/C": ["Parent/A/B/C/note.md"],
  },
  members: ["Parent/A/B/C/note.md", "Parent/other.md"],
};

function nested(): ChainIndex {
  return indexFor(NESTED.tree, NESTED.members);
}

/** Vault parents by string, which is what the real lookup resolves to. */
function parentOf(path: string): string | null {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

describe("buildChainIndex gives these fixtures the runs they claim", () => {
  // Not ceremony: every assertion below is about a tip or a head, and a
  // fixture that compacted nothing would make all of them pass as identity.
  it("compacts the nested fixture into one run", () => {
    const ix = nested();
    expect([...ix.runByHead.keys()]).toEqual(["Parent/Chain"]);
    expect([...ix.runByTip.keys()]).toEqual(["Parent/Chain/Link"]);
  });

  it("compacts the deep fixture into one three-folder run", () => {
    const ix = indexFor(DEEP.tree, DEEP.members);
    expect(ix.runByHead.get("Parent/A")?.tip).toBe("Parent/A/B/C");
    expect([...ix.hiddenSegments.keys()].sort()).toEqual(["Parent/A", "Parent/A/B"]);
  });
});

describe("displayToStored: the row's path to the path storage keys", () => {
  it("maps a run's tip to its head", () => {
    expect(displayToStored(nested(), "Parent/Chain/Link")).toBe("Parent/Chain");
  });

  it("maps the tip of a longer run to the head, not to the segment above it", () => {
    const ix = indexFor(DEEP.tree, DEEP.members);
    expect(displayToStored(ix, "Parent/A/B/C")).toBe("Parent/A");
  });

  it("leaves the head alone, because the head is already the stored path", () => {
    expect(displayToStored(nested(), "Parent/Chain")).toBe("Parent/Chain");
  });

  it("leaves a hidden middle segment alone", () => {
    const ix = indexFor(DEEP.tree, DEEP.members);
    expect(displayToStored(ix, "Parent/A/B")).toBe("Parent/A/B");
  });

  it("leaves a path that is in no run at all alone", () => {
    expect(displayToStored(nested(), "Parent/alpha.md")).toBe("Parent/alpha.md");
    expect(displayToStored(nested(), "Parent")).toBe("Parent");
  });

  it("leaves a path the index has never heard of alone", () => {
    expect(displayToStored(nested(), "Elsewhere/thing.md")).toBe("Elsewhere/thing.md");
  });
});

describe("storedToDisplay: the stored path to the row that stands for it", () => {
  it("maps a run's head to its tip", () => {
    expect(storedToDisplay(nested(), "Parent/Chain")).toBe("Parent/Chain/Link");
  });

  it("leaves the tip alone", () => {
    expect(storedToDisplay(nested(), "Parent/Chain/Link")).toBe("Parent/Chain/Link");
  });

  it("leaves everything else alone", () => {
    expect(storedToDisplay(nested(), "Parent/alpha.md")).toBe("Parent/alpha.md");
    expect(storedToDisplay(nested(), "Parent")).toBe("Parent");
  });

  it("round-trips a head through the tip and back", () => {
    const ix = nested();
    expect(displayToStored(ix, storedToDisplay(ix, "Parent/Chain"))).toBe("Parent/Chain");
  });
});

describe("isCompactedRow", () => {
  it("is true for a tip, which is the only path a compacted row carries", () => {
    expect(isCompactedRow(nested(), "Parent/Chain/Link")).toBe(true);
  });

  it("is false for the head, which has no row of its own", () => {
    expect(isCompactedRow(nested(), "Parent/Chain")).toBe(false);
  });

  it("is false for an ordinary folder and for a note", () => {
    expect(isCompactedRow(nested(), "Parent")).toBe(false);
    expect(isCompactedRow(nested(), "Parent/alpha.md")).toBe(false);
  });
});

describe("displayParentOf: where the row is DRAWN, not where the folder lives", () => {
  it("gives a compacted row the head's vault parent", () => {
    expect(displayParentOf(nested(), "Parent/Chain/Link", parentOf)).toBe("Parent");
  });

  it("asks the vault about the HEAD, never about the tip", () => {
    // The whole point of taking the lookup as a parameter: which path this
    // layer resolves is the behaviour, and it is observable here without a
    // vault.
    const lookup = vi.fn(parentOf);
    displayParentOf(nested(), "Parent/Chain/Link", lookup);
    expect(lookup).toHaveBeenCalledWith("Parent/Chain");
    expect(lookup).not.toHaveBeenCalledWith("Parent/Chain/Link");
  });

  it("gives an ordinary path its own vault parent", () => {
    expect(displayParentOf(nested(), "Parent/alpha.md", parentOf)).toBe("Parent");
    expect(displayParentOf(nested(), "Parent", parentOf)).toBe("");
  });

  it("falls back to the row's own parent when the head no longer resolves", () => {
    // A rename between the snapshot and the gesture. The honest tree is the
    // safe answer, matching the fail-open the substitution already takes when
    // a pane cannot resolve a run's tip.
    const gone = (p: string): string | null => (p === "Parent/Chain" ? null : parentOf(p));
    expect(displayParentOf(nested(), "Parent/Chain/Link", gone)).toBe("Parent/Chain");
  });

  it("passes a null answer through for a path the vault does not have", () => {
    expect(displayParentOf(nested(), "Gone/thing.md", () => null)).toBeNull();
  });
});

/**
 * No index means compaction is off, the space is paused, or there is no
 * snapshot — and in all three the tree on screen IS the vault, so every
 * function here must be the identity.
 */
describe("a null index is the identity, everywhere", () => {
  it("translates nothing in either direction", () => {
    expect(displayToStored(null, "Parent/Chain/Link")).toBe("Parent/Chain/Link");
    expect(storedToDisplay(null, "Parent/Chain")).toBe("Parent/Chain");
  });

  it("calls no row compacted", () => {
    expect(isCompactedRow(null, "Parent/Chain/Link")).toBe(false);
  });

  it("hands back exactly what the vault lookup says", () => {
    expect(displayParentOf(null, "Parent/Chain/Link", parentOf)).toBe("Parent/Chain");
  });

  it("asks the vault about the row's own path and nothing else", () => {
    const lookup = vi.fn(parentOf);
    displayParentOf(null, "Parent/Chain/Link", lookup);
    expect(lookup.mock.calls).toEqual([["Parent/Chain/Link"]]);
  });
});

/**
 * An index with no runs is the state a space is in whenever compaction is on
 * but nothing in the tree compacts. It is a different object from null and
 * must behave the same.
 */
describe("an index with no runs is the identity too", () => {
  const empty = indexFor({ Parent: ["Parent/a.md", "Parent/b.md"] }, ["Parent/a.md", "Parent/b.md"]);

  it("has no runs to begin with", () => {
    expect(empty.runByHead.size).toBe(0);
  });

  it("translates nothing and calls nothing compacted", () => {
    expect(displayToStored(empty, "Parent/a.md")).toBe("Parent/a.md");
    expect(storedToDisplay(empty, "Parent/a.md")).toBe("Parent/a.md");
    expect(isCompactedRow(empty, "Parent/a.md")).toBe(false);
    expect(displayParentOf(empty, "Parent/a.md", parentOf)).toBe("Parent");
  });
});

describe("two runs in one index do not borrow each other's heads", () => {
  const ix = indexFor(
    {
      Parent: ["Parent/One", "Parent/Two"],
      "Parent/One": ["Parent/One/A"],
      "Parent/One/A": ["Parent/One/A/one.md"],
      "Parent/Two": ["Parent/Two/B"],
      "Parent/Two/B": ["Parent/Two/B/two.md"],
    },
    ["Parent/One/A/one.md", "Parent/Two/B/two.md"]
  );

  it("maps each tip to its own head", () => {
    expect(displayToStored(ix, "Parent/One/A")).toBe("Parent/One");
    expect(displayToStored(ix, "Parent/Two/B")).toBe("Parent/Two");
  });

  it("maps each head to its own tip", () => {
    expect(storedToDisplay(ix, "Parent/One")).toBe("Parent/One/A");
    expect(storedToDisplay(ix, "Parent/Two")).toBe("Parent/Two/B");
  });
});
