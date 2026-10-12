// @vitest-environment jsdom
/**
 * The chain index is a PROMISE ABOUT THE SORT, and must not outlive it.
 *
 * Compaction is two independent mechanisms that have to agree. The sort seam
 * substitutes a run's TIP for its HEAD, so the chain draws as one row; the
 * adapter writes the joined label onto whatever row that substitution
 * produced. Only the first of those needs a patched, working seam.
 *
 * The states in which the label half would run and the sort half would not are
 * what this file enumerates, and there are more of them than the plan named:
 * the private method is absent from the build, `patch` is refused because
 * another plugin holds the same property, `bindExplorer`'s step 5 throws
 * before anything is patched, there is no explorer pane at all, one pane of
 * two is unpatched, and `requestResort` answers false because `sort()` threw.
 * In every one of them the chain is still drawn NESTED — no substitution
 * happened — and the joined path is stamped onto the head's row anyway, so the
 * user reads `Design/Decisions/2026` on a folder that is visibly `Design` with
 * `Decisions` nested underneath it. That is worse than doing nothing, which is
 * why "the index is null" is the required outcome rather than a nicety.
 *
 * ONE MORE STATE IS NOT HERE, and deliberately: a patched seam whose re-sort
 * SUCCEEDED, where `substituteCompacted` still failed open for one run because
 * this pane holds no tree item for its tip. Every question this gate can ask
 * answers "live", and that one chain is nested anyway. It is not a property of
 * the seam, so it is not settled by a gate: `applyCompactLabels` measures it
 * off the drawn tree instead (`drawnWhereTheHeadWas`, pinned in
 * `tests/compactRowLabel.test.ts`).
 *
 * A SECOND PANE is the same bug through a different door: `patch` is per view,
 * the index is one object, and the adapter labels every bound container. One
 * pane patched and one not means the unpatched one is labelled for a
 * substitution that never happened there.
 *
 * The honest nested tree is always the right fallback, and it is what the rest
 * of this transform already does: `substituteCompacted` leaves a run alone
 * when the pane cannot resolve its tip, and the seam returns its input
 * untouched whenever anything about the result is unrecognised.
 */
import { describe, expect, it } from "vitest";
import { makePluginForSeam, type SeamHarnessOptions } from "./helpers/seamHarness";

/** `Clients -> Meetings`, a two-folder run whose tip holds the only note. */
const TREE = {
  "": ["Clients"],
  Clients: ["Clients/Meetings"],
  "Clients/Meetings": ["Clients/Meetings/a.md"],
};
const VISIBLE = ["Clients", "Clients/Meetings", "Clients/Meetings/a.md"];
const TIP = "Clients/Meetings";

/** The chain fixture, with compaction on and the tip drawn as a real row. */
function harness(extra: Partial<SeamHarnessOptions> = {}) {
  return makePluginForSeam({
    compactFolderChains: true,
    tree: TREE,
    visible: VISIBLE,
    members: ["Clients/Meetings/a.md"],
    rows: [TIP],
    ...extra,
  });
}

describe("the chain index is gated on the sort seam being live", () => {
  /**
   * The CONTROL, and it is a pin rather than evidence: it passes before this
   * gate existed and after it. Its job is to prove the four cases below fail
   * for the reason claimed — the seam, not a broken fixture — by showing the
   * same fixture producing an index and a labelled row when nothing is wrong.
   */
  it("builds the index and labels the tip when every pane is patched", () => {
    const h = harness();
    expect(h.plugin["chainIndexNow"]).not.toBe(null);
    expect(h.labelledPaths()).toEqual([TIP]);
  });

  it("holds no index when the build does not expose the seam at all", () => {
    const h = harness({ seam: "absent" });
    expect(h.plugin["sortProbe"]).toBe("unknown");
    // The LABEL first, because it is the half the user reads: the joined path
    // stamped onto a row that is still visibly the head, with the rest of the
    // chain nested under it.
    expect(h.labelledPaths()).toEqual([]);
    expect(h.plugin["chainIndexNow"]).toBe(null);
  });

  it("holds no index when another plugin holds the seam and `patch` declines", () => {
    const h = harness({ seam: "refused" });
    // The distinction that makes this a separate case: the build is fine, the
    // probe says so, and the patch still did not go on.
    expect(h.plugin["sortProbe"]).toBe("ok");
    expect(h.plugin["sortedViews"].length).toBe(0);
    expect(h.plugin["chainIndexNow"]).toBe(null);
    expect(h.labelledPaths()).toEqual([]);
  });

  it("holds no index when the patch step threw before anything was patched", () => {
    const h = harness({ explorerViewsThrows: true });
    // `bindExplorer` wraps step 5 in its own try/catch, so the plugin carries
    // on with nothing patched. The gate must survive the same throw rather
    // than take the apply down with it.
    expect(() => h.plugin["ensureOrderingPatched"]()).toThrow();
    expect(h.plugin["chainIndexNow"]).toBe(null);
    expect(h.labelledPaths()).toEqual([]);
  });

  it("drops the index when the forced re-sort could not be asked for", () => {
    const h = harness({ seam: "sort-throws" });
    // Patched, and the index was built: this state is only knowable AFTER the
    // re-sort is attempted, which is what makes it the fourth case and not a
    // restatement of the third.
    expect(h.plugin["sortedViews"].length).toBe(1);
    expect(h.plugin["chainIndexNow"]).toBe(null);
    expect(h.labelledPaths()).toEqual([]);
  });

  it("holds no index when one of two panes is unpatched", () => {
    const h = harness({ secondPane: "absent" });
    // `sortProbe` takes the BEST answer across panes, so it still says the
    // build is capable -- which is true, and is exactly why it cannot be the
    // gate on its own.
    expect(h.plugin["sortProbe"]).toBe("ok");
    expect(h.plugin["sortedViews"].length).toBe(1);
    expect(h.plugin["chainIndexNow"]).toBe(null);
    expect(h.labelledPaths()).toEqual([]);
  });

  it("holds no index when there is no explorer pane at all", () => {
    // The Files tab is closed. There is no pane to patch, so nothing will
    // re-sort anything -- but the adapter can still be holding a container
    // from a moment ago, and a live index would have it labelling that.
    const h = harness();
    expect(h.plugin["chainIndexNow"]).not.toBe(null);

    (h.plugin as unknown as { explorerViews: () => object[] }).explorerViews = () => [];
    // Releases the view it held: `ensureOrderingPatched` unpatches whatever is
    // no longer served before it decides anything else.
    h.plugin["ensureOrderingPatched"]();
    h.plugin["onSnapshotApplied"](h.plugin["controller"].currentSnapshot());

    expect(h.plugin["chainIndexNow"]).toBe(null);
    expect(h.labelledPaths()).toEqual([]);
  });

  it("builds the index when BOTH panes are patched", () => {
    // The other half of the two-pane case: a split explorer is not itself a
    // reason to stop compacting, so the gate must be "every pane", not "one
    // pane".
    const h = harness({ secondPane: "ok" });
    expect(h.plugin["sortedViews"].length).toBe(2);
    expect(h.plugin["chainIndexNow"]).not.toBe(null);
    expect(h.labelledPaths()).toEqual([TIP]);
  });

  it("labels nothing on a RESUME whose re-sort was refused", () => {
    // Resuming from `spaces:pause-filtering` does not go through
    // `onSnapshotApplied`: it rebuilds the index, re-sorts and re-seeds the
    // adapter itself. So it has to run those three in the same order, or the
    // one state that is only knowable after the re-sort lands on the adapter
    // before the verdict does.
    const h = harness({ seam: "sort-throws" });
    h.plugin["setFilteringPaused"](true);
    h.plugin["setFilteringPaused"](false);

    expect(h.plugin["chainIndexNow"]).toBe(null);
    expect(h.labelledPaths()).toEqual([]);
  });

  it("recovers on the next apply once the seam is patched again", () => {
    // The gate must not be a one-way door. A pane arrives deferred, or a
    // layout change lands between the patch and the apply; the very next
    // snapshot has to compact again rather than wait for the setting to be
    // toggled.
    const h = harness({ explorerViewsThrows: true });
    expect(h.plugin["chainIndexNow"]).toBe(null);

    (h.plugin as unknown as { explorerViews: () => object[] }).explorerViews = () => [h.view];
    h.plugin["ensureOrderingPatched"]();
    h.plugin["onSnapshotApplied"](h.plugin["controller"].currentSnapshot());

    expect(h.plugin["chainIndexNow"]).not.toBe(null);
    expect(h.labelledPaths()).toEqual([TIP]);
  });

  it("drops the ADAPTER's copy too, at the one place the verdict is reached", () => {
    // `applyFilterAndOrdering` has four call sites and only two of them
    // re-seed the adapter afterwards. `recordSortOverride` and
    // `restoreSavedOrdering` just call it and render the switcher, so a
    // refusal reached from either used to leave the plugin's index null --
    // the seam stops substituting -- while the adapter's own copy stayed
    // live and went on stamping the joined path on every observer pass.
    // That is the outcome the drop exists to prevent, not a milder one.
    const h = harness();
    expect(h.plugin["chainIndexNow"]).not.toBe(null);
    expect(h.labelledPaths()).toEqual([TIP]);

    (h.view as { sort: () => void }).sort = () => {
      throw new Error("Spaces test: this pane's sort() throws");
    };
    // What a real gesture leaves behind: whatever changed dropped the memo,
    // so the next call actually attempts the re-sort.
    h.plugin["lastResort"] = null;
    // The ONLY line `recordSortOverride` reaches before rendering.
    h.plugin["applyFilterAndOrdering"]();

    expect(h.plugin["chainIndexNow"]).toBe(null);
    expect(h.plugin["adapter"]["chainIndex"]).toBe(null);
    // The adapter draws on its own schedule, so the proof is a pass it runs
    // with nobody re-seeding it.
    h.plugin["adapter"].applyNow();
    expect(h.labelledPaths()).toEqual([]);
  });

  it("re-sorts the panes that already substituted when a LIVE index is dropped", () => {
    // The index is live for the whole `requestResort` loop, so a pane that
    // sorted before a later pane threw has ALREADY rendered the
    // substitution. Nulling the index afterwards does not move it back: the
    // next apply rebuilds a live index, that pane re-sorts compacted, the
    // other throws, and the index is nulled again -- leaving the tip
    // folder's bare name at the head's position with no label, for good. A
    // second pass with the index gone renders it honestly.
    const h = harness({ seam: "sort-throws", secondPane: "ok" });
    const views = h.plugin["sortedViews"] as unknown as { sort: () => void }[];
    expect(views.length).toBe(2);
    let sorts = 0;
    views[1].sort = (): void => {
      sorts += 1;
    };

    // Both panes are patched, so the gate builds a live index again.
    h.plugin["onSnapshotApplied"](h.plugin["controller"].currentSnapshot());

    expect(h.plugin["chainIndexNow"]).toBe(null);
    expect(sorts).toBe(2);
  });

  it("does not re-sort a second time when the refusal dropped nothing", () => {
    // Compaction off means there was no index to drop, so a refused re-sort
    // is just a refused re-sort. Sorting every pane again would be work for
    // a substitution that never happened.
    const h = makePluginForSeam({
      compactFolderChains: false,
      tree: TREE,
      visible: VISIBLE,
      members: ["Clients/Meetings/a.md"],
      rows: [TIP],
      seam: "sort-throws",
      secondPane: "ok",
    });
    const views = h.plugin["sortedViews"] as unknown as { sort: () => void }[];
    expect(views.length).toBe(2);
    let sorts = 0;
    views[1].sort = (): void => {
      sorts += 1;
    };

    h.plugin["onSnapshotApplied"](h.plugin["controller"].currentSnapshot());

    expect(h.plugin["chainIndexNow"]).toBe(null);
    expect(sorts).toBe(1);
  });

  it("asks the workspace nothing at all while filtering is paused", () => {
    // The gate is LAST of `rebuildChainIndex`'s guards, below the pause, and
    // this is what pins that placement: the gate walks the workspace's
    // leaves, and a pause cannot use the answer. Counted the way
    // `tests/productCommands.test.ts` counts leaf lookups around
    // `ensureOrderingPatched`, which is the same discipline.
    const h = harness();
    const snap = h.plugin["controller"].currentSnapshot();
    const p = h.plugin as unknown as { explorerViews: () => object[] };
    const real = p.explorerViews;
    let lookups = 0;
    p.explorerViews = (): object[] => {
      lookups += 1;
      return real();
    };

    h.plugin["filteringPaused"] = true;
    h.plugin["rebuildChainIndex"](snap);
    expect(h.plugin["chainIndexNow"]).toBe(null);
    expect(lookups).toBe(0);

    // The control, and it is what makes the count above mean "the pause
    // returned first" rather than "the gate never looks".
    h.plugin["filteringPaused"] = false;
    h.plugin["rebuildChainIndex"](snap);
    expect(h.plugin["chainIndexNow"]).not.toBe(null);
    expect(lookups).toBe(1);
  });
});
