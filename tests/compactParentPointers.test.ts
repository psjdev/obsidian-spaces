// @vitest-environment jsdom
/**
 * A compacted run must not corrupt Obsidian's own item graph (C2).
 *
 * Compaction draws a run as ONE row at the head's level, carrying the TIP's
 * path. Obsidian's `sort()` then walks every folder it knows, calls the
 * patched `getSortedFolderItems` for each, and lets `vChildren.addChild`
 * REASSIGN each returned child's `parent`. For a run that put the tip in two
 * answers — once for the head's parent, where the row is drawn, and once for
 * the run's own unrendered intermediate, where it is not — the later write
 * wins.
 *
 * Measured in a real Obsidian before this fix, for the run
 * `Nested/Chain/L1/L2/L3`: the row drew at depth 1 under `Nested` while its
 * `parent` pointed at `Nested/Chain/L1/L2`, a folder with no row at all.
 * Rendering survives that, which is why the whole suite stayed green;
 * keyboard navigation walks `parent`, and does not.
 *
 * These tests go through `sortWholeTree`, which reproduces that walk and
 * nothing else about `sort()`. Asserting on the seam's return value alone
 * cannot see the defect: both answers are individually reasonable, and only
 * the sequence of them is wrong.
 */
import { describe, expect, it } from "vitest";
import { makePluginForSeam, folderItem } from "./helpers/seamHarness";

/**
 * A run whose head is NOT top-level. `Nested` holds the run's head and a note
 * beside it, so `Nested` has two visible children and is therefore a rendered
 * folder of its own rather than part of the run.
 */
const NESTED = {
  tree: {
    "": ["Nested"],
    Nested: ["Nested/Chain", "Nested/note.md"],
    "Nested/Chain": ["Nested/Chain/L1"],
    "Nested/Chain/L1": ["Nested/Chain/L1/L2"],
    "Nested/Chain/L1/L2": ["Nested/Chain/L1/L2/L3"],
    "Nested/Chain/L1/L2/L3": ["Nested/Chain/L1/L2/L3/a.md"],
  },
  visible: [
    "Nested",
    "Nested/note.md",
    "Nested/Chain",
    "Nested/Chain/L1",
    "Nested/Chain/L1/L2",
    "Nested/Chain/L1/L2/L3",
    "Nested/Chain/L1/L2/L3/a.md",
  ],
  members: ["Nested/note.md", "Nested/Chain/L1/L2/L3/a.md"],
};

const TIP = "Nested/Chain/L1/L2/L3";

describe("a nested run's tip keeps the parent its row is drawn under", () => {
  it("points the tip at the head's parent, not at an unrendered intermediate", () => {
    const h = makePluginForSeam({ ...NESTED, compactFolderChains: true });
    h.sortWholeTree();
    // The measured failure was "Nested/Chain/L1/L2" here.
    expect(h.parentPointerOf(TIP)).toBe("Nested");
  });

  it("still draws the run as one row under Nested", () => {
    const h = makePluginForSeam({ ...NESTED, compactFolderChains: true });
    // The parent-pointer fix must not be a filtering fix: the row the user
    // sees is unchanged, which is why this defect was invisible to the rest of
    // the suite.
    const out = h.filterAndOrderFolder("Nested", [
      folderItem("Nested/Chain"),
      folderItem("Nested/note.md"),
    ]);
    expect(out.map((i) => i.file?.path)).toEqual([TIP, "Nested/note.md"]);
  });

  it("leaves the tip's own children parented to the tip", () => {
    const h = makePluginForSeam({ ...NESTED, compactFolderChains: true });
    h.sortWholeTree();
    // The tip is the one folder of the run that DOES render, so blanking it
    // would empty the compacted row instead of fixing its parent.
    expect(h.parentPointerOf(`${TIP}/a.md`)).toBe(TIP);
  });
});

describe("a run's hidden segments answer the sort with nothing", () => {
  it("returns an empty list for every path from the head down to the tip", () => {
    const h = makePluginForSeam({ ...NESTED, compactFolderChains: true });
    // Head, and the two intermediates. None of them has a row, so none of
    // them has children to place — and an empty array is a subset of any
    // input, so `isAllowed` cannot reject it and send the seam back to the
    // raw, unfiltered items.
    expect(h.filterAndOrderFolder("Nested/Chain", [folderItem("Nested/Chain/L1")])).toEqual([]);
    expect(
      h.filterAndOrderFolder("Nested/Chain/L1", [folderItem("Nested/Chain/L1/L2")])
    ).toEqual([]);
    expect(h.filterAndOrderFolder("Nested/Chain/L1/L2", [folderItem(TIP)])).toEqual([]);
  });

  it("gets the empty list past the seam's subset guard, through the real patch", () => {
    const h = makePluginForSeam({ ...NESTED, compactFolderChains: true });
    h.sortWholeTree();
    // `sortWholeTree` goes through `patch()`'s override, so `isAllowed` is on
    // the stack. A rejection there makes `patch` hand back the RAW items, and
    // `Nested/Chain` would then adopt `Nested/Chain/L1` after all. Nothing
    // adopting it is the proof that the empty array was accepted — an empty
    // array is a subset of every input, which is why this exit cannot be
    // refused.
    expect(h.parentPointerOf("Nested/Chain/L1")).toBe(null);
    expect(h.parentPointerOf("Nested/Chain/L1/L2")).toBe(null);
  });

  it("does not blank the tip, which is the folder the row actually is", () => {
    const h = makePluginForSeam({ ...NESTED, compactFolderChains: true });
    const out = h.filterAndOrderFolder(TIP, [folderItem(`${TIP}/a.md`)]);
    expect(out.map((i) => i.file?.path)).toEqual([`${TIP}/a.md`]);
  });

  it("does not blank a folder that is merely inside some other run's name", () => {
    const h = makePluginForSeam({ ...NESTED, compactFolderChains: true });
    const out = h.filterAndOrderFolder("Nested", [
      folderItem("Nested/Chain"),
      folderItem("Nested/note.md"),
    ]);
    expect(out).toHaveLength(2);
  });
});

/**
 * The top-level case, which the probe measured as ALREADY correct — the vault
 * root is sorted after the run's own folders, so its adoption of the tip is
 * the last one to run. It is here as a regression guard, not as a red test:
 * the fix must not reach the one shape that happened to work.
 */
describe("a top-level run is unchanged", () => {
  const TOP = {
    tree: {
      "": ["Clients", "Inbox"],
      Clients: ["Clients/Northwind"],
      "Clients/Northwind": ["Clients/Northwind/Meetings"],
      "Clients/Northwind/Meetings": ["Clients/Northwind/Meetings/a.md"],
      Inbox: ["Inbox/b.md"],
    },
    visible: [
      "Clients",
      "Clients/Northwind",
      "Clients/Northwind/Meetings",
      "Clients/Northwind/Meetings/a.md",
      "Inbox",
      "Inbox/b.md",
    ],
    members: ["Clients/Northwind/Meetings/a.md", "Inbox/b.md"],
  };

  it("keeps the tip parented to the vault root", () => {
    const h = makePluginForSeam({ ...TOP, compactFolderChains: true });
    h.sortWholeTree();
    expect(h.parentPointerOf("Clients/Northwind/Meetings")).toBe("");
  });

  it("still compacts the run into one top-level row", () => {
    const h = makePluginForSeam({ ...TOP, compactFolderChains: true });
    const out = h.filterAndOrderFolder("", [folderItem("Clients"), folderItem("Inbox")]);
    expect(out.map((i) => i.file?.path)).toEqual(["Clients/Northwind/Meetings", "Inbox"]);
  });
});

/**
 * With the setting off there is no index, so nothing may be blanked and no
 * pointer may move. This is the ablation that says the blanking is gated on
 * compaction rather than on folder shape.
 */
describe("compaction off leaves every parent pointer at its vault parent", () => {
  it("parents each item to the folder that really contains it", () => {
    const h = makePluginForSeam({ ...NESTED, compactFolderChains: false });
    h.sortWholeTree();
    expect(h.parentPointerOf("Nested")).toBe("");
    expect(h.parentPointerOf("Nested/Chain")).toBe("Nested");
    expect(h.parentPointerOf("Nested/Chain/L1")).toBe("Nested/Chain");
    expect(h.parentPointerOf("Nested/Chain/L1/L2")).toBe("Nested/Chain/L1");
    expect(h.parentPointerOf(TIP)).toBe("Nested/Chain/L1/L2");
    expect(h.parentPointerOf(`${TIP}/a.md`)).toBe(TIP);
  });

  it("sorts every folder of the chain to its real children", () => {
    const h = makePluginForSeam({ ...NESTED, compactFolderChains: false });
    expect(
      h.filterAndOrderFolder("Nested/Chain/L1/L2", [folderItem(TIP)]).map((i) => i.file?.path)
    ).toEqual([TIP]);
  });
});
