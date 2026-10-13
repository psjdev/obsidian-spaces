/**
 * Which rows of a long, uniform list are worth building.
 *
 * Pure: numbers in, two indices out. No DOM, no `"obsidian"`, nothing
 * measured here. That is the point of the module rather than a detail of it.
 * jsdom implements no layout, so every `clientHeight`, `scrollTop` and
 * `getBoundingClientRect` it answers is zero; a window calculation written
 * against elements could not be tested at all, and a test named for what it
 * windowed would be observing nothing. The panel measures its scroller and
 * hands the numbers here, so the DECISION is testable and only the
 * MEASUREMENT needs a real browser.
 *
 * Why it exists at all: the create panel's Properties body draws a row per
 * property value, and one key in a 5,000-note vault holds 4,035 distinct
 * values. Measured in a real Obsidian, a row costs 0.31 ms of which 0.27 ms
 * is the browser's own style recalc and layout, strictly linear in the row
 * count, with no fixed cost worth attacking. The scroll viewport is 344 px
 * and a row's pitch is 25 px, so about 14 rows of the 206 that were built are
 * ever on screen: 93% of the work was never seen. Building the 14 is the only
 * change that fits the draw inside one frame.
 *
 * The list this serves is a flat one of uniform rows, which is why a single
 * `rowHeight` is enough and why the rows left out can be replaced by one
 * spacer of `first * rowHeight` above and one of `(count - last) * rowHeight`
 * below. A list of varying row heights would need a different module; this one
 * would be wrong for it rather than approximate.
 */

/** What the decision is made from. Every field is a number, deliberately. */
export interface RowWindowInput {
  /** How far the scroller is scrolled, in px. Clamped here, never read back. */
  readonly scrollTop: number;
  /** The scroller's visible height in px. Zero means "not laid out": see below. */
  readonly viewportHeight: number;
  /** One row's pitch in px, its height plus the margin under it. */
  readonly rowHeight: number;
  /** How many rows the list would have if all of them were built. */
  readonly count: number;
  /**
   * Extra rows to build beyond each edge of the viewport, so a small scroll
   * reveals rows that already exist instead of a gap waiting for a repaint.
   * Priced, not guessed: each one costs about 0.31 ms, so 3 either side adds
   * roughly 2 ms to a draw that has about 10 ms of room inside a frame.
   */
  readonly overscan?: number;
}

/** A half-open range of row indices: `first` is drawn, `last` is not. */
export interface RowWindow {
  readonly first: number;
  readonly last: number;
}

/** The default `overscan`, in rows. See the field's docstring for the price. */
export const DEFAULT_OVERSCAN = 3;

/** Whether a number is usable as a measurement. NaN and Infinity are not. */
function positive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/**
 * The rows to build for a scroller in this state.
 *
 * **An unknown viewport renders EVERYTHING.** A `viewportHeight` or
 * `rowHeight` of zero, negative, NaN or Infinity means nobody has measured a
 * laid-out scroller: before the first layout, in a hidden pane, and in every
 * jsdom test. Drawing nothing there would leave an empty list on screen and
 * would quietly empty the existing suite, so the whole list is the answer and
 * windowing is something that switches ON once a measurement exists.
 *
 * `scrollTop` is clamped into the scrollable range rather than trusted. A draw
 * that shortens the list (the filter box narrowing it) runs BEFORE the browser
 * clamps its own `scrollTop`, so an unclamped read would window past the end
 * of the new list and paint nothing where the browser is about to show the
 * tail of it.
 */
export function visibleRange(input: RowWindowInput): RowWindow {
  const { scrollTop, viewportHeight, rowHeight, count } = input;
  if (!Number.isFinite(count) || count <= 0) return { first: 0, last: 0 };
  if (!positive(viewportHeight) || !positive(rowHeight)) return { first: 0, last: count };
  const overscan =
    input.overscan === undefined || !Number.isFinite(input.overscan) || input.overscan < 0
      ? DEFAULT_OVERSCAN
      : Math.floor(input.overscan);
  const top = Math.min(
    Math.max(Number.isFinite(scrollTop) ? scrollTop : 0, 0),
    Math.max(count * rowHeight - viewportHeight, 0)
  );
  const first = Math.max(Math.floor(top / rowHeight) - overscan, 0);
  const last = Math.min(Math.ceil((top + viewportHeight) / rowHeight) + overscan, count);
  return { first, last: Math.max(last, first) };
}

/**
 * The same window, moved if it has to be, so that row `index` is built.
 *
 * For the one thing windowing takes away: a control that is not built cannot
 * be focused. After a redraw the panel puts focus back on the control that
 * held it, and that control may be the one row the plain window leaves out.
 * The window is moved to it rather than stretched to reach it, so restoring
 * focus across a redraw can never cost more rows than an ordinary draw.
 *
 * An index outside the list, or a list that is being drawn whole, gives the
 * plain window back unchanged.
 */
export function windowCovering(index: number, input: RowWindowInput): RowWindow {
  const plain = visibleRange(input);
  if (!Number.isInteger(index) || index < 0 || index >= input.count) return plain;
  if (index >= plain.first && index < plain.last) return plain;
  const { rowHeight, viewportHeight } = input;
  if (!positive(rowHeight) || !positive(viewportHeight)) return plain;
  // Just inside the near edge, which is where `scrollIntoView({ block:
  // "nearest" })` will put it when focus lands: the same rule, so the window
  // the panel paints and the place the browser scrolls to agree.
  const scrollTop =
    index < plain.first ? index * rowHeight : (index + 1) * rowHeight - viewportHeight;
  return visibleRange({ ...input, scrollTop });
}

/**
 * The height of the spacer that stands in for `rows` rows left unbuilt.
 *
 * Zero rows gives zero, and the caller leaves the spacer out entirely: an
 * empty div is a child a `role="list"` would have to account for.
 */
export function spacerHeight(rows: number, rowHeight: number): number {
  if (!Number.isFinite(rows) || rows <= 0 || !positive(rowHeight)) return 0;
  return rows * rowHeight;
}
