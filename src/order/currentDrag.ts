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
 * `DragOrdering` already refuses its own drop on `truncated`, but a consumer
 * handed only `paths` has no way to tell a complete selection from a clipped
 * one, and a clipped one looks exactly like a small complete one. Carrying the
 * paths alone across this seam is what let a 240-note selection be half moved
 * and reported as a 48-note success.
 *
 * A third field, `fromSelection`, lived here while the strip could MOVE files
 * on disk: it was the blunter guard that refused the irreversible path outright
 * rather than trusting `truncated`'s geometry. The move was removed by an
 * owner's decision and nothing else ever read the flag, so it went with its one
 * consumer rather than being kept against a path that no longer exists. The
 * blindness it guarded against is unfixed and is recorded where it lives, at
 * `DragOrdering.selectionMayBeClipped`; anything that puts an irreversible act
 * back behind this record needs that guard back with it.
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
   * shape of. On the strip that half is a member list holding a fraction of
   * what was selected, written by a gesture whose notice counts only what it
   * wrote.
   *
   * It is a HALF-GUARD and must not be mistaken for a complete one. It is
   * geometric, and `DragOrdering.selectionMayBeClipped` records at its own
   * definition the edge on which it cannot fire at all.
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
    // REASSIGNED rather than emptied in place.
    //
    // Stated carefully, because the first version of this note overclaimed and
    // the overclaim is the only thing that made it sound load-bearing. The
    // strip's drop handler reads the record once and passes it on, and
    // `filesDroppedOnSpace` resolves every path to a file SYNCHRONOUSLY before
    // its first `await`, so no consumer today is holding this array across a
    // suspension. The drag the strip sees is also one `DragOrdering` declined,
    // never one it claimed, so the synthetic `dragend` that would fire DURING a
    // drop is not in this picture either.
    //
    // What remains is a cheap invariant worth keeping rather than a defect
    // narrowly averted: `paths()` hands out the live array, so anything that
    // does start holding it across an await -- and an `await` added to
    // `filesDroppedOnSpace` above its resolution loop is all it would take --
    // keeps a list that still says what it said. `length = 0` in place would
    // empty it under them. The guarantee is pinned in `currentDrag.test.ts`.
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
