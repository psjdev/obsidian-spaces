import { describe, expect, it } from "vitest";
import {
  isOverridden,
  isOverrideActionable,
  sameSelection,
  shouldExplainBlockedDrag,
  shouldRecordSortOverride,
  sortGestureFrom,
  sortMenuRowState,
  withOverride,
  type SortOverrides,
} from "../src/order/sortOverride";
import type { OrderingSettings } from "../src/order/orderingScope";

const none: SortOverrides = { all: false, bySpaceId: {} };

describe("isOverridden", () => {
  it("is false when nothing is overridden", () => {
    expect(isOverridden({ kind: "all" }, none)).toBe(false);
    expect(isOverridden({ kind: "space", id: "work" }, none)).toBe(false);
  });

  it("keys All separately from the spaces", () => {
    // A space may legitimately be called "all"; it must not collide with All.
    const o: SortOverrides = { all: true, bySpaceId: { all: false } };
    expect(isOverridden({ kind: "all" }, o)).toBe(true);
    expect(isOverridden({ kind: "space", id: "all" }, o)).toBe(false);
  });

  it("reports only the space that is overridden", () => {
    const o: SortOverrides = { all: false, bySpaceId: { work: true } };
    expect(isOverridden({ kind: "space", id: "work" }, o)).toBe(true);
    expect(isOverridden({ kind: "space", id: "lab" }, o)).toBe(false);
  });
});

describe("sameSelection", () => {
  it("returns true for two identical All selections", () => {
    expect(sameSelection({ kind: "all" }, { kind: "all" })).toBe(true);
  });

  it("returns true for two selections of the same space", () => {
    expect(sameSelection({ kind: "space", id: "work" }, { kind: "space", id: "work" })).toBe(true);
  });

  it("returns false when one is All and the other is a space", () => {
    expect(sameSelection({ kind: "all" }, { kind: "space", id: "work" })).toBe(false);
    expect(sameSelection({ kind: "space", id: "work" }, { kind: "all" })).toBe(false);
  });

  it("returns false for different spaces", () => {
    expect(sameSelection({ kind: "space", id: "work" }, { kind: "space", id: "lab" })).toBe(false);
  });

  it("is safe against literal ordering (robust against spread/destructuring)", () => {
    // The point: structurally comparing the same selections in different
    // orders must not silently fail. JSON.stringify would; structural
    // comparison is order-agnostic.
    const a = { kind: "space" as const, id: "work" };
    const b = { id: "work", kind: "space" as const };
    expect(sameSelection(a, b)).toBe(true);
  });
});

describe("withOverride", () => {
  it("sets a space without touching the others", () => {
    const o = withOverride({ all: false, bySpaceId: { lab: true } }, { kind: "space", id: "work" }, true);
    expect(o).toEqual({ all: false, bySpaceId: { lab: true, work: true } });
  });

  it("sets All without touching a space of the same name", () => {
    const o = withOverride({ all: false, bySpaceId: { all: true } }, { kind: "all" }, true);
    expect(o).toEqual({ all: true, bySpaceId: { all: true } });
  });

  it("clears by deleting the key rather than storing false", () => {
    // Storing `false` would accumulate a key per space ever overridden, which
    // is the same dead-weight problem the member list had to solve.
    const o = withOverride({ all: false, bySpaceId: { work: true } }, { kind: "space", id: "work" }, false);
    expect(o.bySpaceId).toEqual({});
  });

  it("does not mutate the input", () => {
    const before: SortOverrides = { all: false, bySpaceId: { work: true } };
    withOverride(before, { kind: "space", id: "lab" }, true);
    expect(before).toEqual({ all: false, bySpaceId: { work: true } });
  });
});

describe("sortGestureFrom", () => {
  it("seeds on the first observation, so a bind is not a gesture", () => {
    // Otherwise binding the explorer would override every space on load.
    expect(sortGestureFrom(null, "alphabetical")).toBe("seed");
  });

  it("reports a gesture when the order actually changed", () => {
    expect(sortGestureFrom("alphabetical", "alphabeticalReverse")).toBe("gesture");
  });

  it("reports nothing when unchanged — our own re-sorts land here", () => {
    expect(sortGestureFrom("alphabetical", "alphabetical")).toBe("none");
  });

  it("treats an unreadable order as nothing, never a gesture", () => {
    // The seam collapses failures to a null read; inventing a gesture from one
    // would override a space because a private property moved.
    expect(sortGestureFrom("alphabetical", null)).toBe("none");
    expect(sortGestureFrom(null, null)).toBe("none");
  });
});

describe("shouldExplainBlockedDrag (once per GESTURE)", () => {
  it("explains a blocked drag while overridden and ordering is otherwise enabled", () => {
    expect(shouldExplainBlockedDrag(true, true)).toBe(true);
  });

  it("explains EVERY attempt, not just the first", () => {
    // The predicate is stateless on purpose: an
    // `alreadyExplained` flag that answered false forever after the first blocked
    // drag would treat the Notice as education. It is also the only
    // feedback that the gesture registered at all, and a drag that silently
    // does nothing is indistinguishable from a bug. This test is the guard
    // against reintroducing any memory here.
    expect(shouldExplainBlockedDrag(true, true)).toBe(true);
    expect(shouldExplainBlockedDrag(true, true)).toBe(true);
    expect(shouldExplainBlockedDrag(true, true)).toBe(true);
  });

  it("stays silent when not overridden — ordering disabled but no override in play", () => {
    // A drag blocked by `allowReordering`/`allowReorderingAll` alone (no
    // override in play) has nothing to do with the override, and restoring
    // saved ordering would not help.
    expect(shouldExplainBlockedDrag(false, true)).toBe(false);
  });

  it("stays silent in the trap state — overridden AND ordering disabled", () => {
    // Override *All*, then turn
    // `allowReorderingAll` off: `overridden` stays true (nothing clears it)
    // while `orderingEnabled` (== `orderingEnabledFor`) is now false. Firing
    // here would tell the user to restore saved ordering when doing so changes
    // nothing visible. This is NOT the same case as "stays silent when not
    // overridden" above: there, `overridden` itself is false. Here it is true
    // and only the second input catches it.
    expect(shouldExplainBlockedDrag(true, false)).toBe(false);
  });

  it("stays silent when neither condition holds", () => {
    expect(shouldExplainBlockedDrag(false, false)).toBe(false);
  });
});

describe("isOverrideActionable", () => {
  const settingsOn: OrderingSettings = { allowReordering: true, allowReorderingAll: true };
  const settingsAllowReorderingOff: OrderingSettings = {
    allowReordering: false,
    allowReorderingAll: true,
  };
  const settingsAllowReorderingAllOff: OrderingSettings = {
    allowReordering: true,
    allowReorderingAll: false,
  };

  it("is true when overridden and ordering is otherwise enabled", () => {
    const overrides: SortOverrides = { all: false, bySpaceId: { work: true } };
    expect(isOverrideActionable({ kind: "space", id: "work" }, overrides, settingsOn)).toBe(true);
  });

  it("is false when overridden but allowReordering is off", () => {
    const overrides: SortOverrides = { all: false, bySpaceId: { work: true } };
    expect(
      isOverrideActionable({ kind: "space", id: "work" }, overrides, settingsAllowReorderingOff)
    ).toBe(false);
  });

  it("is false when All is overridden but allowReorderingAll is off — the trap state", () => {
    const overrides: SortOverrides = { all: true, bySpaceId: {} };
    expect(isOverrideActionable({ kind: "all" }, overrides, settingsAllowReorderingAllOff)).toBe(
      false
    );
  });

  it("is false when not overridden, regardless of the settings", () => {
    const overrides: SortOverrides = { all: false, bySpaceId: {} };
    expect(isOverrideActionable({ kind: "space", id: "work" }, overrides, settingsOn)).toBe(false);
  });
});

describe("shouldRecordSortOverride (the deferred-write gate)", () => {
  it("records a gesture when not already overridden and ordering is enabled", () => {
    expect(shouldRecordSortOverride(false, true)).toBe(true);
  });

  it("does not record when already overridden — the write would be a no-op", () => {
    expect(shouldRecordSortOverride(true, true)).toBe(false);
  });

  it("does not record when ordering is disabled", () => {
    // Recording anyway would sit latent in runtime state and hijack the saved
    // order the moment the setting is turned back on.
    expect(shouldRecordSortOverride(false, false)).toBe(false);
  });

  it("does not record when neither condition holds", () => {
    expect(shouldRecordSortOverride(true, false)).toBe(false);
  });
});

describe("sortMenuRowState", () => {
  const settings = { allowReordering: true, allowReorderingAll: true };
  const none: SortOverrides = { all: false, bySpaceId: {} };
  const ordersAll = { all: { "": ["b.md", "a.md"] } };
  const ordersSpace = { bySpaceId: { s1: { Projects: ["y.md", "x.md"] } } };

  it("shows the row TICKED when a saved order exists and is what renders", () => {
    // The state the corner case is about: Obsidian ticks "File name (A to Z)"
    // while the custom order is on screen. Exactly one item may be ticked, and
    // it has to be the one describing what the user is looking at.
    expect(sortMenuRowState({ kind: "all" }, none, settings, ordersAll)).toEqual({
      show: true,
      checked: true,
    });
  });

  it("shows the row UNTICKED while a native sort is overriding the saved order", () => {
    const overridden: SortOverrides = { all: true, bySpaceId: {} };
    expect(sortMenuRowState({ kind: "all" }, overridden, settings, ordersAll)).toEqual({
      show: true,
      checked: false,
    });
  });

  it("hides the row when nothing has ever been reordered here", () => {
    // Never reordered means there is no such mode, so the menu must be exactly
    // Obsidian's — and the caller then never patches the prototype at all.
    expect(sortMenuRowState({ kind: "all" }, none, settings, {})).toEqual({
      show: false,
      checked: false,
    });
  });

  it("hides the row when the stored map exists but holds no actual order", () => {
    expect(sortMenuRowState({ kind: "all" }, none, settings, { all: {} })).toEqual({
      show: false,
      checked: false,
    });
  });

  it("hides the row when a stored folder order is empty", () => {
    expect(sortMenuRowState({ kind: "all" }, none, settings, { all: { "": [] } })).toEqual({
      show: false,
      checked: false,
    });
  });

  it("shows the row UNTICKED when overridden with nothing ever reordered", () => {
    // The trap this closes. The override suppresses drag-to-reorder, so no
    // saved order can be created; with the row hidden on "no saved order"
    // there was then nothing in the menu that cleared the override, and the
    // two conditions held each other in place. Reproduced against 0.3.1: a
    // fresh folder space, one click on a sort mode, and the menu offers
    // Obsidian's six and nothing else.
    //
    // Unticked, not ticked: an Obsidian mode is what renders, and the row is
    // advertising a mode rather than claiming to be the one in effect.
    const overridden = withOverride(none, { kind: "space", id: "s1" }, true);
    expect(sortMenuRowState({ kind: "space", id: "s1" }, overridden, settings, {})).toEqual({
      show: true,
      checked: false,
    });
  });

  it("shows the row UNTICKED when overridden and the stored map is empty", () => {
    // `compact` can empty a folder's list without removing the key, so "has a
    // map" and "has an order" are different questions. Neither is an order,
    // and the override still needs its way out.
    const overridden = withOverride(none, { kind: "all" }, true);
    expect(sortMenuRowState({ kind: "all" }, overridden, settings, { all: { "": [] } })).toEqual({
      show: true,
      checked: false,
    });
  });

  it("stays hidden when ordering is off, even while overridden", () => {
    // The ordering gate dominates. Offering the row here would promise an
    // escape that changes nothing: the drag is blocked by the setting, not
    // by the override, so clearing the override would not unblock it.
    const off = { allowReordering: false, allowReorderingAll: false };
    const overridden = withOverride(none, { kind: "space", id: "s1" }, true);
    expect(sortMenuRowState({ kind: "space", id: "s1" }, overridden, off, {})).toEqual({
      show: false,
      checked: false,
    });
  });

  it("hides the row when ordering is switched off", () => {
    // Same rule as every other surface: an option that cannot change what
    // renders must not be offered.
    const off = { allowReordering: true, allowReorderingAll: false };
    expect(sortMenuRowState({ kind: "all" }, none, off, ordersAll)).toEqual({
      show: false,
      checked: false,
    });
  });

  it("reads the space's own map, not All's", () => {
    expect(sortMenuRowState({ kind: "space", id: "s1" }, none, settings, ordersSpace)).toEqual({
      show: true,
      checked: true,
    });
    expect(sortMenuRowState({ kind: "space", id: "s2" }, none, settings, ordersSpace)).toEqual({
      show: false,
      checked: false,
    });
  });

  it("does not let All's saved order show the row inside a space", () => {
    // All is keyed apart precisely so the two cannot bleed together.
    expect(sortMenuRowState({ kind: "space", id: "s1" }, none, settings, ordersAll)).toEqual({
      show: false,
      checked: false,
    });
  });

  it("tolerates orders being absent entirely", () => {
    expect(sortMenuRowState({ kind: "all" }, none, settings, undefined)).toEqual({
      show: false,
      checked: false,
    });
  });
});
