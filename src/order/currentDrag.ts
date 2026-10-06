/**
 * What the live drag is carrying, for anything that is not the file tree.
 *
 * `DragOrdering` already works out which paths a drag holds, including the
 * explorer's multi-selection, but it keeps that in a private field and clears
 * it at the TOP of its own drop handler, before the guards that decline a drop
 * outside the tree. That handler runs in the capture phase on the document, so
 * by the time a bubble-phase listener on the strip runs, the field is empty.
 * This record exists to survive that: it is cleared on `dragend`, which fires
 * AFTER `drop`.
 *
 * That holds only for a drop `DragOrdering` DECLINES, which is the only kind the
 * strip ever sees. A drop it CLAIMS calls `endNativeDrag()`, which dispatches a
 * synthetic `dragend` during the drop, so the record is already empty by the
 * bubble phase. `endNativeDrag()` sitting below the decline guards is what makes
 * this work, so anyone moving it above them breaks the strip's drops.
 *
 * An instance rather than module state, and reached through callbacks rather
 * than imported, so neither `DragOrdering` nor `SwitcherView` has to know the
 * other exists. `main.ts` owns the one instance.
 */

/**
 * A drag as anything outside the file tree has to see it: the paths, and
 * whether that list can be trusted to be the WHOLE selection.
 *
 * The two travel together deliberately. `collectDragged` produces both, and
 * `DragOrdering` already refuses its own drop on the second, but a consumer
 * handed only `paths` has no way to tell a complete selection from a clipped
 * one, and a clipped one looks exactly like a small complete one. Carrying the
 * paths alone across this seam is what let a 240-note selection be half moved
 * and reported as a 48-note success: see `truncated` below.
 */
export interface DraggedFiles {
  readonly paths: readonly string[];
  /**
   * True when the selection may continue past the explorer's RENDER WINDOW,
   * so `paths` may be a fraction of what the user actually selected.
   *
   * The explorer detaches rows that scroll out of view and tracks its
   * selection in a private field this plugin may not touch, so a selection
   * reaching the first or last rendered row while the pane is scrolled can
   * have more rows behind it that no public DOM read can see.
   * `DragOrdering.selectionMayBeClipped` is the geometric tell.
   *
   * Every consumer must REFUSE on this rather than act on what it can see.
   * `dropIntent.ts` states the governing stance above `movesIntoOwnSubtree`: a
   * multi-selection is one gesture, and performing the possible half leaves
   * the user with a partial result they did not ask for and cannot see the
   * shape of. On the strip that half is a `renameFile` per path, and Obsidian
   * has no undo for a file move.
   */
  readonly truncated: boolean;
}

export class CurrentDrag {
  private current: string[] = [];
  private clipped = false;

  /** Copied, so the caller cannot edit the record through the array it passed. */
  begin(paths: readonly string[], truncated: boolean): void {
    this.current = [...paths];
    this.clipped = truncated;
  }

  end(): void {
    // REASSIGNED rather than emptied in place, and that is load-bearing: the
    // strip's drop handler reads the array out of this record and holds it
    // across the awaits of the write that follows. Emptying in place would
    // clear the list that drop is still working from the moment `dragend`
    // arrives, which on a claimed drop is DURING the drop.
    this.current = [];
    this.clipped = false;
  }

  paths(): readonly string[] {
    return this.current;
  }

  /**
   * The whole record. Read by anything that has to DECIDE something, because
   * deciding on `paths` alone is deciding without knowing whether the list is
   * complete.
   */
  dragged(): DraggedFiles {
    return { paths: this.current, truncated: this.clipped };
  }
}
