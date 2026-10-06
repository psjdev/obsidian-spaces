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
 * A drag as anything outside the file tree has to see it: the paths, whether
 * that list can be trusted to be the WHOLE selection, and whether it came from
 * a selection at all.
 *
 * The three travel together deliberately. `collectDragged` produces all of
 * them, and `DragOrdering` already refuses its own drop on `truncated`, but a
 * consumer handed only `paths` has no way to tell a complete selection from a
 * clipped one, and a clipped one looks exactly like a small complete one.
 * Carrying the paths alone across this seam is what let a 240-note selection be
 * half moved and reported as a 48-note success.
 *
 * `fromSelection` is the later and blunter of the two guards, added once
 * `truncated` was found to be structurally blind on one edge. Read it, not the
 * length of `paths`, wherever the cost of acting on half a gesture is
 * irreversible.
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
  /**
   * True when `paths` came from the explorer's MULTI-SELECTION rather than from
   * the one row the pointer was on.
   *
   * This is the discriminator `truncated` cannot be trusted to be, and it
   * exists because `truncated` has a blind spot nothing downstream can see
   * around. `DragOrdering.selectionMayBeClipped` reads `rendered[0]` to ask
   * whether the selection runs off the TOP of the render window, but Obsidian's
   * virtualiser keeps the ancestor chain of everything it renders, so inside an
   * expanded folder `rendered[0]` is the FOLDER'S OWN ROW and never a selected
   * note. That half of the test can never fire. Measured rather than reasoned:
   * `e2e/drop-on-space.mjs` records it and scrolls the other way so its check
   * can drive the bottom edge instead.
   *
   * So `truncated` is a half-guard, and a consumer that cannot afford to
   * perform half a gesture must refuse on THIS. `collectDragged` cannot get it
   * wrong the way the geometry can: it is true on exactly one of that function's
   * return paths, the one where the dragged row was itself part of a selection,
   * and that is also the only path on which a short list is possible at all. A
   * single-row drag carries one path and carries all of it.
   *
   * Counting `paths` is NOT the same test and must never be substituted for it.
   * A selection clipped down to its one visible row presents as
   * `paths.length === 1`, indistinguishable from a single-row drag by count and
   * entirely distinguishable by this flag.
   */
  readonly fromSelection: boolean;
}

export class CurrentDrag {
  private current: string[] = [];
  private clipped = false;
  private selected = false;

  /** Copied, so the caller cannot edit the record through the array it passed. */
  begin(paths: readonly string[], truncated: boolean, fromSelection: boolean): void {
    this.current = [...paths];
    this.clipped = truncated;
    this.selected = fromSelection;
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
    this.selected = false;
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
    return { paths: this.current, truncated: this.clipped, fromSelection: this.selected };
  }
}
