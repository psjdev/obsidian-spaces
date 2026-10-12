// @vitest-environment jsdom
/**
 * The drag's two coordinate systems, through the real plugin.
 *
 * A compacted row carries the run's TIP as its `data-path`, because the tip is
 * the folder the row actually IS. It is drawn where the run's HEAD was,
 * because that is the level the chain occupied before it was folded up. Every
 * drag dependency that answers a question by asking the VAULT therefore
 * answers in the wrong system, and the one that costs data is the order
 * writeback:
 *
 *   `displayedOrder` reads through the patched seam, so it yields TIPS.
 *   `storedOrder` holds HEADS, because a stored order is keyed by the real
 *   child of the folder. `computeDrop` merges the two. The head is not in the
 *   displayed list so it falls out of the baseline, and `writeOrderFor`'s
 *   `compact(order, live)` then drops the tip too, because the tip is not a
 *   child of that folder. Both spellings of the chain are gone, and the
 *   arrangement the user made is deleted from `data.json` with no message.
 *
 * That is DS-4, and it fires for a drag that has NOTHING to do with the chain:
 * merely sharing a folder with one is enough.
 *
 * Layer: these drive the plugin's own `dragDeps()` through the real patched
 * seam and the real `writeOrderFor`, so the fixture's vault, snapshot and
 * stored order are the only stubs. The four dependency calls are made in the
 * order `DragOrdering`'s drop handler makes them, with `dragged`/`targetPath`/
 * `edge` supplied directly — the DOM gesture that produces those three is
 * `dragOrdering.test.ts`'s subject, not this file's.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { noticeLog } from "./helpers/obsidian-stub";
import { makePluginForSeam, type SeamHarness } from "./helpers/seamHarness";
import { computeDrop, type DropEdge } from "../src/order/dropIntent";
import type { DragOrderingDeps } from "../src/order/DragOrdering";

/**
 * `Parent` holds a two-folder chain and two ordinary notes.
 *
 * The chain is `Parent/Chain -> Parent/Chain/Link`, so the head is
 * `Parent/Chain`, the tip is `Parent/Chain/Link`, and `Parent/Chain` is the
 * run's one hidden segment. `Parent` itself has three visible children, so it
 * compacts nothing and keeps its own row — which is what makes it "a folder
 * that merely CONTAINS a chain".
 */
const SHAPE = {
  tree: {
    "": ["Other", "Parent"],
    Other: ["Other/new.md"],
    Parent: ["Parent/Chain", "Parent/alpha.md", "Parent/zeta.md"],
    "Parent/Chain": ["Parent/Chain/Link"],
    "Parent/Chain/Link": ["Parent/Chain/Link/note.md"],
  },
  visible: [
    "Other",
    "Other/new.md",
    "Parent",
    "Parent/Chain",
    "Parent/Chain/Link",
    "Parent/Chain/Link/note.md",
    "Parent/alpha.md",
    "Parent/zeta.md",
  ],
  members: ["Other/new.md", "Parent/Chain/Link/note.md", "Parent/alpha.md", "Parent/zeta.md"],
  // The arrangement the user made: the chain first, then the two notes. Keyed
  // by the HEAD, because a stored order names the folder's real children and
  // `Parent/Chain/Link` is not one of them.
  order: { Parent: ["Parent/Chain", "Parent/alpha.md", "Parent/zeta.md"] },
};

function harness(compactFolderChains: boolean): SeamHarness {
  const h = makePluginForSeam({ ...SHAPE, compactFolderChains });
  // `displayedPaths` calls the view's own `getSortedFolderItems`, so it sees
  // compaction only once the override is installed.
  h.patchSeam();
  return h;
}

function depsOf(h: SeamHarness): DragOrderingDeps {
  return h.plugin["dragDeps"]();
}

/** The drop handler's own sequence: read both lists, compute, write. */
async function drop(
  h: SeamHarness,
  o: { folder: string; dragged: string[]; targetPath: string; edge: DropEdge }
): Promise<void> {
  const deps = depsOf(h);
  const next = computeDrop({
    order: deps.storedOrder(o.folder),
    displayed: deps.displayedOrder(o.folder),
    dragged: o.dragged,
    targetPath: o.targetPath,
    edge: o.edge,
  });
  if (!next) return;
  await deps.writeOrder(o.folder, next);
}

describe("DS-4: a drag beside a chain must not delete the chain's saved position", () => {
  it("keeps the chain head in the stored order after an unrelated reorder", async () => {
    const h = harness(true);
    await drop(h, {
      folder: "Parent",
      dragged: ["Parent/zeta.md"],
      targetPath: "Parent/alpha.md",
      edge: "before",
    });
    // The pin. Before the translation layer this read `["Parent/zeta.md",
    // "Parent/alpha.md"]`: the head fell out of the baseline because the
    // displayed list named the tip, and the tip was then compacted away
    // because it is not a child of `Parent`. The user dragged one note and
    // lost the position of a folder they never touched.
    expect(depsOf(h).storedOrder("Parent")).toContain("Parent/Chain");
  });

  it("writes the order the user actually arranged, with the chain still first", async () => {
    const h = harness(true);
    await drop(h, {
      folder: "Parent",
      dragged: ["Parent/zeta.md"],
      targetPath: "Parent/alpha.md",
      edge: "before",
    });
    expect(depsOf(h).storedOrder("Parent")).toEqual([
      "Parent/Chain",
      "Parent/zeta.md",
      "Parent/alpha.md",
    ]);
  });

  it("loses nothing on a drop that moves a note to the end either", async () => {
    const h = harness(true);
    await drop(h, {
      folder: "Parent",
      dragged: ["Parent/alpha.md"],
      targetPath: "Parent/zeta.md",
      edge: "after",
    });
    expect(depsOf(h).storedOrder("Parent")).toEqual([
      "Parent/Chain",
      "Parent/zeta.md",
      "Parent/alpha.md",
    ]);
  });
});

describe("displayedOrder speaks the stored system", () => {
  it("names the chain's HEAD, not the tip the row carries", () => {
    const h = harness(true);
    // The displayed row for the chain is `Parent/Chain/Link` — that is what
    // the seam returns and what the row's `data-path` says. This dependency
    // deliberately answers with the head instead, so the list it hands
    // `computeDrop` is in the same system as `storedOrder`'s.
    expect(depsOf(h).displayedOrder("Parent")).toEqual([
      "Parent/Chain",
      "Parent/alpha.md",
      "Parent/zeta.md",
    ]);
  });

  it("leaves a folder with no chain in it untouched", () => {
    const h = harness(true);
    expect(depsOf(h).displayedOrder("Other")).toEqual(["Other/new.md"]);
  });
});

describe("describeRow answers in display space", () => {
  it("gives a compacted row the HEAD's parent, which is the folder on screen", () => {
    const h = harness(true);
    // The row is drawn under `Parent`. Its vault parent is `Parent/Chain`, a
    // path with no row at all, and answering that makes `sameParent` compare
    // the user's gesture against a folder they cannot see.
    expect(depsOf(h).describeRow("Parent/Chain/Link")).toEqual({
      parent: "Parent",
      isFolder: true,
    });
  });

  it("still calls a compacted row a folder", () => {
    const h = harness(true);
    expect(depsOf(h).describeRow("Parent/Chain/Link")?.isFolder).toBe(true);
  });

  it("leaves an ordinary row on its vault parent", () => {
    const h = harness(true);
    expect(depsOf(h).describeRow("Parent/alpha.md")).toEqual({
      parent: "Parent",
      isFolder: false,
    });
  });

  it("answers null for a path the vault does not have", () => {
    const h = harness(true);
    expect(depsOf(h).describeRow("Parent/gone.md")).toBeNull();
  });
});

/**
 * Compaction off is the identity, and that is what keeps every drag test in
 * the suite honest: with no index there is nothing to translate, so these
 * dependencies must answer exactly what they answered before the layer
 * existed.
 */
describe("with compaction off every answer is the vault's own", () => {
  it("displays the folder's real children", () => {
    const h = harness(false);
    expect(depsOf(h).displayedOrder("Parent")).toEqual([
      "Parent/Chain",
      "Parent/alpha.md",
      "Parent/zeta.md",
    ]);
  });

  it("gives the chain's deepest folder its real vault parent", () => {
    const h = harness(false);
    expect(depsOf(h).describeRow("Parent/Chain/Link")).toEqual({
      parent: "Parent/Chain",
      isFolder: true,
    });
  });

  it("writes the same order a drag would have written before compaction shipped", async () => {
    const h = harness(false);
    await drop(h, {
      folder: "Parent",
      dragged: ["Parent/zeta.md"],
      targetPath: "Parent/alpha.md",
      edge: "before",
    });
    expect(depsOf(h).storedOrder("Parent")).toEqual([
      "Parent/Chain",
      "Parent/zeta.md",
      "Parent/alpha.md",
    ]);
  });
});

/**
 * The SECOND place the two systems are merged.
 *
 * `moveAndOrder` runs the cross-folder drop: rename first, then give the
 * landed files a position in the destination. It built its own `displayed`
 * list from `displayedPaths` while taking `order` from `dragDeps().storedOrder`
 * — the same mismatch as DS-4, at a different call site, with the same
 * consequence for a destination folder that contains a chain.
 *
 * The fixture does not re-home the renamed node, so the moved file is absent
 * from the destination's live children and `writeOrderFor` compacts it back
 * out. That is a limit of the fixture and not what is asserted: the claim here
 * is only that the chain head the user arranged is still in the file
 * afterwards.
 */
describe("a cross-folder drop into a folder that contains a chain", () => {
  function withRenames(h: SeamHarness): void {
    (h.plugin as unknown as { app: { fileManager: unknown } }).app.fileManager = {
      renameFile: async (): Promise<void> => undefined,
    };
  }

  it("keeps the chain head's stored position", async () => {
    const h = harness(true);
    withRenames(h);
    await h.plugin["moveAndOrder"](["Other/new.md"], "Parent", "before", "Parent/alpha.md");
    expect(depsOf(h).storedOrder("Parent")).toContain("Parent/Chain");
  });
});

/**
 * The translation the DRAG CONTROLLER asks for, as dependencies.
 *
 * `DragOrdering` decides nothing about compaction and knows nothing about a
 * chain index -- every rule it applies comes from `dropIntent.ts` and every
 * fact it uses comes from its dependencies. So the three questions it needs
 * are wired here, and these pin the wiring: a `DragOrdering` built without
 * them falls back to the identity, which is the correct answer only when
 * compaction is off. `tests/compactDragGestures.test.ts` holds the other half,
 * the gestures those answers produce.
 */
describe("the drag dependencies carry the translation", () => {
  it("spells a compacted row the way storage spells it", () => {
    const h = harness(true);
    expect(depsOf(h).storedPathFor?.("Parent/Chain/Link")).toBe("Parent/Chain");
  });

  it("leaves an ordinary path alone", () => {
    const h = harness(true);
    expect(depsOf(h).storedPathFor?.("Parent/alpha.md")).toBe("Parent/alpha.md");
  });

  it("spells a stored chain the way its ROW is spelled", () => {
    const h = harness(true);
    expect(depsOf(h).displayPathFor?.("Parent/Chain")).toBe("Parent/Chain/Link");
  });

  it("leaves an ordinary path alone in that direction too", () => {
    const h = harness(true);
    expect(depsOf(h).displayPathFor?.("Parent")).toBe("Parent");
  });

  it("calls the run's tip a compacted row", () => {
    const h = harness(true);
    expect(depsOf(h).isCompactedRow?.("Parent/Chain/Link")).toBe(true);
  });

  it("does not call the run's head one, because the head has no row", () => {
    const h = harness(true);
    expect(depsOf(h).isCompactedRow?.("Parent/Chain")).toBe(false);
  });

  it("does not call an ordinary folder one", () => {
    const h = harness(true);
    expect(depsOf(h).isCompactedRow?.("Parent")).toBe(false);
  });

  it("answers the identity on every question with compaction off", () => {
    const h = harness(false);
    const deps = depsOf(h);
    expect(deps.storedPathFor?.("Parent/Chain/Link")).toBe("Parent/Chain/Link");
    expect(deps.displayPathFor?.("Parent/Chain")).toBe("Parent/Chain");
    expect(deps.isCompactedRow?.("Parent/Chain/Link")).toBe(false);
  });
});

/**
 * The refusal has a voice.
 *
 * `DragOrdering` refuses the drop on its own; this hook is the only thing that
 * tells the user it happened, and a gesture that does nothing and says nothing
 * reads as a broken plugin. Same division of labour as `onBlockedDrag` and
 * `onSelectionOutsideWindow`: the controller declines, the plugin explains,
 * because only the plugin can raise a Notice.
 */
describe("refusing to move a compacted row", () => {
  beforeEach(() => {
    noticeLog.length = 0;
  });

  it("tells the user what the folder is and what to turn off", () => {
    const h = harness(true);
    depsOf(h).onCompactedRowRefused?.();
    expect(noticeLog).toHaveLength(1);
    expect(String(noticeLog[0]?.message)).toBe(
      "Spaces: that folder is part of a compacted chain. " +
        "Turn off compact folder chains to move it."
    );
  });

  it("keeps the user-facing copy free of em dashes", () => {
    const h = harness(true);
    depsOf(h).onCompactedRowRefused?.();
    // The length check is not decoration: without it `String(undefined)`
    // satisfies the assertion and the test passes while nothing is said.
    expect(noticeLog).toHaveLength(1);
    expect(String(noticeLog[0]?.message)).not.toContain("\u2014");
  });
});
