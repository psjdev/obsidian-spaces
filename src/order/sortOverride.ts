/**
 * The override rules, pure — no DOM, no `"obsidian"` import.
 *
 * An override says "render this space with Obsidian's own sort instead of its
 * saved order". It never touches a saved order; the patch only ever reads
 * one, and nothing here writes one.
 *
 * Imports `orderingEnabledFor` from `./orderingScope` — also pure — because
 * the override gate and the ordering-enabled gate must never disagree about
 * whether the override is actually visible right now.
 */

import type { ActiveSelection, SpaceOrders } from "../types";
import { orderingEnabledFor, type OrderingSettings } from "./orderingScope";

/** Structural comparison of two selections, safe against literal ordering. */
export function sameSelection(a: ActiveSelection, b: ActiveSelection): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === "all" || (a.kind === "space" && b.kind === "space" && a.id === b.id))
  );
}

export interface SortOverrides {
  /** All is keyed apart from the spaces so no space id can collide. */
  all: boolean;
  bySpaceId: Record<string, boolean>;
}

export function isOverridden(sel: ActiveSelection, o: SortOverrides): boolean {
  return sel.kind === "all" ? o.all : o.bySpaceId[sel.id] === true;
}

/**
 * Clearing DELETES the key rather than storing `false`: keeping it would let
 * the map grow an entry for every space ever overridden — the same
 * dead-weight problem an unpruned member list has — and runtime state has no
 * UI to tidy it.
 */
export function withOverride(
  o: SortOverrides,
  sel: ActiveSelection,
  on: boolean
): SortOverrides {
  if (sel.kind === "all") return { all: on, bySpaceId: { ...o.bySpaceId } };
  const bySpaceId = { ...o.bySpaceId };
  if (on) bySpaceId[sel.id] = true;
  else delete bySpaceId[sel.id];
  return { all: o.all, bySpaceId };
}

/**
 * What an observation of Obsidian's sort order means.
 *
 * `"seed"` is the first observation after a bind and must NOT count as a
 * gesture, or loading the explorer would override every space.
 * `"none"` covers our own `requestResort`, which never changes the order, and
 * an unreadable value — the seam collapses failures to null, and inventing a
 * gesture from one would override a space because a private property moved.
 */
export function sortGestureFrom(
  seen: string | null,
  current: string | null
): "seed" | "gesture" | "none" {
  if (current === null) return "none";
  if (seen === null) return "seed";
  return seen === current ? "none" : "gesture";
}

/**
 * The blocked-drag rule, pure: whether the override is the reason THIS
 * drag went nowhere, and worth a Notice about it.
 *
 * Feedback belongs on the gesture, not a one-time-per-space flag: a drag
 * that silently does nothing twice reads as a broken plugin, so every
 * blocked drag on an overridden space explains itself again.
 *
 * `overridden` alone is not enough: override *All*, then turn
 * `allowReorderingAll` off, and `overridden` stays true while THAT gate is
 * what's actually blocking the drag — telling the user to restore saved
 * ordering would change nothing. `orderingEnabled` is that gate's own
 * answer, passed in raw so this stays a tested predicate.
 */
export function shouldExplainBlockedDrag(
  overridden: boolean,
  orderingEnabled: boolean
): boolean {
  // The allowReordering/allowReorderingAll gate is blocking regardless of the
  // override, so the override is not the actual reason — and restoring
  // saved ordering could not fix it either.
  if (!orderingEnabled) return false;
  return overridden;
}

/**
 * The same composition `shouldExplainBlockedDrag` uses (override AND the
 * ordering-enabled gate), for the two surfaces that offer an ACTION rather
 * than a Notice — the switcher's "Restore saved ordering" row and the
 * `restore-saved-ordering` command. Gating on `isOverridden` alone would
 * offer an action that does nothing whenever the ordering-enabled gate is
 * also blocking.
 */
export function isOverrideActionable(
  sel: ActiveSelection,
  overrides: SortOverrides,
  settings: OrderingSettings
): boolean {
  return isOverridden(sel, overrides) && orderingEnabledFor(sel, settings);
}

/**
 * The deferred-write gate for `observeSortOrder`'s recording step. Two
 * independent reasons not to record a gesture as an override:
 *
 *  - **already overridden** — recording again is a no-op.
 *  - **ordering disabled** — recording anyway would sit latent in runtime
 *    state until reordering is re-enabled, then silently hijack the saved
 *    order the user never asked to leave. The OBSERVATION that feeds
 *    `sortGestureFrom` still runs unconditionally; only this write is gated.
 */
export function shouldRecordSortOverride(
  overridden: boolean,
  orderingEnabled: boolean
): boolean {
  if (overridden) return false;
  return orderingEnabled;
}


/**
 * Whether Obsidian's own sort menu should carry spaces's ordering as a
 * SEVENTH MODE, and whether that mode is the one currently in effect.
 *
 * The corner case: Obsidian ticks "File name (A to Z)" whenever `sortOrder`
 * says so, even while a saved order is what actually renders. Modelling the
 * saved order as a mode fixes it — exactly one item is ticked, and it
 * always names what is on screen.
 *
 * `show` is deliberately narrow, because it also decides whether the caller
 * patches `Menu.prototype` at all:
 *
 *  - **Ordering must be allowed here** — the same
 *    `allowReordering`/`allowReorderingAll` gate every other surface uses.
 *  - **A saved order must actually exist** for this selection. With nothing
 *    ever reordered, there is no such mode, and the menu stays Obsidian's.
 */
export function sortMenuRowState(
  sel: ActiveSelection,
  overrides: SortOverrides,
  settings: OrderingSettings,
  orders: SpaceOrders | undefined
): { show: boolean; checked: boolean } {
  const hidden = { show: false, checked: false };
  // This gate dominates both conditions below. With ordering off the drag is
  // blocked by the setting, not by the override, so the row would promise an
  // escape that changes nothing.
  if (!orderingEnabledFor(sel, settings)) return hidden;
  const overridden = isOverridden(sel, overrides);
  const map = sel.kind === "all" ? orders?.all : orders?.bySpaceId?.[sel.id];
  // An empty map, or one holding only empty arrays, is not a saved order. Both
  // shapes occur: `compact` can empty a folder's list without removing the key.
  const saved = !!map && Object.values(map).some((list) => list.length > 0);
  // An override shows the row even with nothing ever reordered, which a saved
  // order alone would not. Otherwise the two conditions hold each other in
  // place: the override suppresses drag-to-reorder, so no saved order can be
  // created, so the row stays hidden, and the row is the discoverable way to
  // clear the override. `Restore saved ordering` escapes it but nothing on
  // screen says so. Reproduced on 0.3.1 with a fresh folder space and one
  // click on a sort mode.
  //
  // Shown UNTICKED in that case, which keeps the invariant this whole mode
  // exists for: exactly one item is ticked and it names what is on screen.
  // Obsidian's sort is what renders, one of its six carries the tick, and
  // this row advertises a mode rather than claiming to be in effect.
  if (!saved && !overridden) return hidden;
  return { show: true, checked: !overridden };
}
