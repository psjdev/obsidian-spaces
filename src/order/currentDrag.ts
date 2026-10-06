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
 * An instance rather than module state, and reached through callbacks rather
 * than imported, so neither `DragOrdering` nor `SwitcherView` has to know the
 * other exists. `main.ts` owns the one instance.
 */
export class CurrentDrag {
  private current: string[] = [];

  /** Copied, so the caller cannot edit the record through the array it passed. */
  begin(paths: readonly string[]): void {
    this.current = [...paths];
  }

  end(): void {
    this.current = [];
  }

  paths(): readonly string[] {
    return this.current;
  }
}
