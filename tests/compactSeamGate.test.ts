// @vitest-environment jsdom
/**
 * The chain index is a PROMISE ABOUT THE SORT, and must not outlive it.
 *
 * Compaction is two independent mechanisms that have to agree. The sort seam
 * substitutes a run's TIP for its HEAD, so the chain draws as one row; the
 * adapter writes the joined label onto whatever row that substitution
 * produced. Only the first of those needs a patched, working seam.
 *
 * So there are four reachable states in which the label half runs and the sort
 * half does not: the private method is absent from the build, `patch` is
 * refused because another plugin holds the same property, `bindExplorer`'s
 * step 5 throws before anything is patched, and `requestResort` answers false
 * because `sort()` threw. In every one of them the chain is still drawn
 * NESTED — no substitution happened — and the joined path is stamped onto the
 * head's row anyway, so the user reads `Design/Decisions/2026` on a folder
 * that is visibly `Design` with `Decisions` nested underneath it. That is
 * worse than doing nothing, which is why "the index is null" is the required
 * outcome rather than a nicety.
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
});
