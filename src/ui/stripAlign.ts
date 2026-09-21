/**
 * Where the vertical strip's two fixed parts sit, so they line up with the
 * rows of the pane beside them.
 *
 * Only the strip's START can align. The strip's icons step 32px and the file
 * tree's rows step ~34px, but that is not a defect to correct: the strip lists
 * SPACES and the tree lists one space's CONTENTS, so they are not parallel
 * lists and forcing a common pitch would only make the strip look stretched.
 * Two anchors are therefore enough:
 *
 * - the pinned *All* control, centred on Obsidian's toolbar row
 * - the rail's first icon, centred on the first pane row below that toolbar --
 *   the space header when it is shown, the first tree row when it is not
 *
 * **Unlike `ribbonAlign.ts`, the thing being aligned to is the authority
 * here.** That module snaps to the left ribbon only when the ribbon is already
 * within a few pixels of the panel's design gap, because the ribbon is a
 * foreign element and the panel's own spacing is the design. These anchors are
 * rows of the very pane this strip is mounted in, and lining up with them IS
 * the feature -- so a theme that makes the toolbar 60px tall is followed
 * rather than declined. The clamps below exist only so a measurement taken
 * before layout settles cannot push the strip somewhere absurd.
 *
 * Pure on purpose: the caller measures, this decides.
 */

/** A measured box, projected onto the only axis that matters here. */
export interface AlignBox {
  /** Viewport-relative top. */
  top: number;
  /** Measured height. Zero means "not laid out yet", never "flat". */
  height: number;
}

export interface StripAlignInput {
  /** Centre of Obsidian's toolbar row, or null when no toolbar is on screen. */
  toolbarCentre: number | null;
  /**
   * Centre of the first pane row below the toolbar: the space header when
   * shown, else the first tree row. Null when the header is off and the tree
   * is empty, leaving nothing to anchor to.
   */
  anchorCentre: number | null;
  /** The pinned *All* control, or null when nothing is pinned. */
  pinned: AlignBox | null;
  /** The rail's first icon, or null when the rail is empty. */
  firstIcon: AlignBox | null;
  /** The padding-top in effect, which `pinned` was measured under. */
  currentPadTop: number;
  /** The pinned-to-rail gap in effect, which `firstIcon` was measured under. */
  currentRailGap: number;
  /**
   * How far the rail has been scrolled, added back to `firstIcon` so the
   * alignment describes the rail's ORIGIN rather than wherever scrolling has
   * currently put its first child.
   *
   * Without this the solve reads a scrolled-away icon as an icon that needs
   * more gap above it, and pushes the rail down by the scroll distance to
   * "correct" it. Measured live with 80 spaces: a 150px scroll turned a 6px
   * gap into 156px, and the hole above the rail survived scrolling back.
   */
  railScroll: number;
}

export interface StripAlignOutput {
  /** The strip's `padding-top`, or null to leave the stylesheet's own value. */
  padTop: number | null;
  /**
   * The total distance from the pinned control's bottom to the rail's top, or
   * null to leave the stylesheet's own value. The divider lives inside this
   * gap and is centred in it, which is why this is a total rather than a
   * margin: one number keeps the divider centred at any gap.
   */
  railGap: number | null;
}

/**
 * The stylesheet's own gap: 4px flex gap, the divider's 4px margins either
 * side, and the divider's own 1px. Exported so the caller can seed
 * `currentRailGap` with the same number the CSS falls back to.
 */
export const DESIGN_RAIL_GAP = 17;

/** The stylesheet's own `padding-top` for the strip. */
export const DESIGN_PAD_TOP = 6;

/** The divider is 1px and sits inside the gap, so the gap cannot close past it. */
export const MIN_RAIL_GAP = 1;

/**
 * How far either offset may travel before the measurement behind it is more
 * likely wrong than the layout is unusual. A pane is rarely taller than this,
 * and a correction this large would put the strip's controls somewhere no
 * theme intended.
 */
const MAX_OFFSET = 400;

function usable(box: AlignBox | null): box is AlignBox {
  return (
    box !== null && Number.isFinite(box.top) && Number.isFinite(box.height) && box.height > 0
  );
}

/**
 * Solved rather than searched: both parts move one-for-one with the offset
 * above them, so the offset that lands a centre on `target` is simply the
 * current offset plus the distance to it.
 */
function solve(current: number, boxCentre: number, target: number, min: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return null;
  const next = Math.round(current + (target - boxCentre));
  if (Math.abs(next - current) > MAX_OFFSET) return null;
  return Math.max(min, next);
}

export function stripAlignment(input: StripAlignInput): StripAlignOutput {
  const { toolbarCentre, anchorCentre, pinned, firstIcon, currentPadTop, currentRailGap } = input;
  const { railScroll } = input;

  const padTop =
    toolbarCentre !== null && usable(pinned)
      ? solve(currentPadTop, pinned.top + pinned.height / 2, toolbarCentre, 0)
      : null;

  // Everything below the padding moves with it, so the rail is solved against
  // where its first icon WILL be -- and against the CLAMPED padding, not the
  // one that was asked for, or a clamp would be silently undone here.
  const padDelta = padTop === null ? 0 : padTop - currentPadTop;

  const railGap =
    anchorCentre !== null && usable(firstIcon) && Number.isFinite(railScroll)
      ? solve(
          currentRailGap,
          firstIcon.top + railScroll + padDelta + firstIcon.height / 2,
          anchorCentre,
          MIN_RAIL_GAP
        )
      : null;

  return { padTop, railGap };
}
