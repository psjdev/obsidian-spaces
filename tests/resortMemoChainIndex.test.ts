// @vitest-environment jsdom
/**
 * The resort memo must key on the chain index.
 *
 * Toggling `compactFolderChains` changes what the sort seam RETURNS without
 * changing the selection, the order map or the visible set. A memo keyed on
 * those three alone reports "nothing changed" and never re-sorts, so the
 * explorer keeps drawing the chain it drew before the toggle.
 */
import { describe, expect, it, vi } from "vitest";
import { makePluginForSeam } from "./helpers/seamHarness";
import { sameResortSignature } from "../src/main";

const TREE = {
  "": ["Clients"],
  Clients: ["Clients/Meetings"],
  "Clients/Meetings": ["Clients/Meetings/a.md"],
};
const VISIBLE = ["Clients", "Clients/Meetings", "Clients/Meetings/a.md"];

function seeded() {
  const h = makePluginForSeam({
    compactFolderChains: false,
    tree: TREE,
    visible: VISIBLE,
    members: ["Clients/Meetings/a.md"],
  });
  // Installs the override and registers the view in `sortedViews`.
  h.plugin["ensureOrderingPatched"]();
  const sort = vi.spyOn(h.view, "sort");
  return { h, sort };
}

function flipSetting(h: ReturnType<typeof makePluginForSeam>, on: boolean): void {
  const settings = h.plugin["defs"].get().settings as { compactFolderChains: boolean };
  settings.compactFolderChains = on;
  h.plugin["rebuildChainIndex"](h.plugin["controller"].currentSnapshot());
}

describe("applyFilterAndOrdering memo and the chain index", () => {
  it("re-sorts the view when only compactFolderChains changed", () => {
    const { h, sort } = seeded();
    h.plugin["applyFilterAndOrdering"]();
    expect(sort).toHaveBeenCalledTimes(1);

    // Same call again with nothing changed: the memo still works.
    h.plugin["applyFilterAndOrdering"]();
    expect(sort).toHaveBeenCalledTimes(1);

    flipSetting(h, true);
    h.plugin["applyFilterAndOrdering"]();
    expect(sort).toHaveBeenCalledTimes(2);
  });

  it("re-sorts when the setting is turned back off", () => {
    const { h, sort } = seeded();
    flipSetting(h, true);
    h.plugin["applyFilterAndOrdering"]();
    flipSetting(h, false);
    h.plugin["applyFilterAndOrdering"]();
    expect(sort).toHaveBeenCalledTimes(2);
  });

  it("gives a different signature once the index changes", () => {
    const { h } = seeded();
    const before = h.plugin["currentResortSignature"]();
    flipSetting(h, true);
    const after = h.plugin["currentResortSignature"]();
    expect(before.selection).toBe(after.selection);
    expect(before.order).toBe(after.order);
    expect(before.visible).toEqual(after.visible);
    expect(before.chainIndex).toBe(null);
    expect(after.chainIndex).not.toBe(null);
    expect(sameResortSignature(before, after)).toBe(false);
    expect(sameResortSignature(after, h.plugin["currentResortSignature"]())).toBe(true);
  });
});

describe("the chain index is only replaced when the runs change", () => {
  function compactOn() {
    const h = makePluginForSeam({
      compactFolderChains: true,
      tree: TREE,
      visible: VISIBLE,
      members: ["Clients/Meetings/a.md"],
    });
    h.plugin["ensureOrderingPatched"]();
    const sort = vi.spyOn(h.view, "sort");
    return { h, sort };
  }

  it("does not re-sort on a second snapshot that leaves the tree alone", () => {
    const { h, sort } = compactOn();
    const snap = h.plugin["controller"].currentSnapshot();
    h.plugin["onSnapshotApplied"](snap);
    expect(sort).toHaveBeenCalledTimes(1);
    const index = h.plugin["chainIndexNow"];
    expect(index).not.toBe(null);

    // A file-open: same tree, a fresh apply.
    h.plugin["onSnapshotApplied"](snap);
    h.plugin["onSnapshotApplied"](snap);
    expect(sort).toHaveBeenCalledTimes(1);
    expect(h.plugin["chainIndexNow"]).toBe(index);
  });

  it("re-sorts when the runs genuinely change", () => {
    const { h, sort } = compactOn();
    const snap = h.plugin["controller"].currentSnapshot()!;
    h.plugin["onSnapshotApplied"](snap);
    expect(sort).toHaveBeenCalledTimes(1);

    // Meetings drops out of the space, so Clients no longer leads onward.
    const narrowed = {
      decisionFor: snap.decisionFor,
      visiblePaths: () => new Set(VISIBLE.filter((p) => p !== "Clients/Meetings")),
    };
    h.plugin["controller"] = { currentSnapshot: () => narrowed } as never;
    h.plugin["onSnapshotApplied"](narrowed);
    expect(sort).toHaveBeenCalledTimes(2);
  });
});