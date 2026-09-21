/**
 * Keeping the active switcher control in view. Pure — no DOM, no
 * `"obsidian"` import, just the arithmetic.
 *
 * The strip scrolls along its axis rather than wrapping, so a
 * space must never be unreachable because it does not fit. That holds for
 * reaching a space by scrolling to it, but not for the space you are already
 * in: switching by command, by the header's dropdown or by creating a
 * space would light up a control sitting outside the visible range, with
 * nothing bringing it back.
 *
 * Deliberately NOT `Element.scrollIntoView()`. That walks every scrollable
 * ancestor and can move elements spaces does not own, which spaces must not do —
 * the rail is ours, its ancestors are the host's. Arithmetic on one element is
 * both contained and testable.
 */

/** Breathing room either side, so a revealed control is not flush to the edge. */
export const PAD = 8;

/**
 * The scroll offset along the rail's axis the rail should have, given where
 * the active item sits.
 *
 * Returns the CURRENT offset unchanged whenever the item is already wholly
 * visible. That is the important case rather than an optimisation:
 * `SwitcherView.render()` runs on every switch and every definitions change,
 * so a function that always recentred would leave the rail drifting under the
 * user's hand.
 *
 * `itemOffset` is the item's start in the rail's own content coordinates —
 * measured from rects plus the live scroll offset, never `offsetLeft`/
 * `offsetTop`, which are relative to the nearest *positioned* ancestor and
 * are not guaranteed to be the rail.
 */
export function railScrollOffset(args: {
  scroll: number;
  clientSize: number;
  itemOffset: number;
  itemSize: number;
}): number {
  const { scroll, clientSize, itemOffset, itemSize } = args;
  // A collapsed sidebar reports a zero size. Any answer but "leave it alone"
  // would fabricate a scroll position for something nobody can see.
  if (!(clientSize > 0)) return scroll;
  if (!Number.isFinite(itemOffset) || !Number.isFinite(itemSize)) return scroll;
  if (!Number.isFinite(scroll)) return 0;

  // An item that cannot fit WITH its padding gets its start aligned, and that
  // branch has to come first for two reasons. It picks the half that matters —
  // the icon is at the start, so revealing the end would show the wrong half.
  // And it is the only stable answer: fall through to the two edge tests below
  // and an item nearly as large as the rail satisfies "starts too early" and
  // "ends too late" on alternate calls, so `render()` would flip the offset
  // between two values forever.
  if (itemSize + PAD * 2 > clientSize) return Math.max(0, itemOffset - PAD);
  if (itemOffset - PAD < scroll) return Math.max(0, itemOffset - PAD);
  const end = itemOffset + itemSize + PAD;
  if (end > scroll + clientSize) return Math.max(0, end - clientSize);
  return scroll;
}

/**
 * How far a wheel gesture should move the rail along its OWN axis, or 0 to
 * leave the event to the browser.
 *
 * Needed because Chromium does not redirect a wheel to a scroller that only
 * scrolls on the other axis. A vertical rail is fine: a mouse wheel reports
 * `deltaY` and the rail scrolls on Y, so the browser matches them up. A
 * HORIZONTAL rail scrolls on X, the wheel still reports `deltaY`, and nothing
 * connects the two — the rail overflows and can be scrolled programmatically,
 * but the wheel walks straight past it to an ancestor. Measured in Obsidian
 * 1.x: with 80 spaces a `deltaX` wheel moved the docked-bottom rail, a
 * `deltaY` wheel of the same size moved it by zero. Pinning the cross axis to
 * `overflow-y: hidden` does not change that, so this cannot be fixed in CSS.
 *
 * `along` is the wheel delta on the rail's axis and `across` the delta on the
 * other one, already projected by the caller — the same convention as the
 * reorder helpers, which keeps this free of axis branches.
 */
export function railWheelDelta(args: {
  along: number;
  across: number;
  scroll: number;
  scrollSize: number;
  clientSize: number;
}): number {
  const { along, across, scroll, scrollSize, clientSize } = args;
  if (!Number.isFinite(along) || !Number.isFinite(across)) return 0;
  // The gesture already points along the rail: a trackpad's sideways swipe on
  // a horizontal rail, or any ordinary wheel on a vertical one. The browser
  // scrolls those itself, and doing it again here would double the distance.
  if (along !== 0) return 0;
  if (!Number.isFinite(scroll) || !(scrollSize > clientSize)) return 0;

  // Clamped to what is actually left, so that a rail already at one end
  // returns 0 and the caller lets the wheel through to the pane behind it —
  // which is how the browser treats a scroller at its end, and the reason the
  // file tree still scrolls when the pointer happens to be over the strip.
  const max = scrollSize - clientSize;
  const next = Math.min(Math.max(scroll + across, 0), max);
  return next - scroll;
}
