/**
 * Display space and vault space, and the one translation between them.
 *
 * A compacted run draws ONE row for a chain of folders. That row's
 * `data-path` is the run's TIP, because the tip is the folder the row
 * actually IS: opening it, dropping into it and naming it all mean the tip.
 * But the row is DRAWN where the run's HEAD was — at the head's depth, under
 * the head's parent — because that is the level the chain occupied before it
 * was folded up.
 *
 * So a compacted row has two coordinates, and every consumer that resolves a
 * row's position by asking the vault is in the wrong one. The expensive case
 * is the order writeback: `displayedOrder` reads through the patched sort seam
 * and yields TIPS, a stored order holds HEADS because it is keyed by the real
 * children of a folder, and `computeDrop` merges the two lists. The head is
 * not in the displayed list so it falls out of the baseline, and
 * `writeOrderFor`'s `compact(order, live)` then drops the tip too, because the
 * tip is not a child of that folder. One drag of an unrelated note deletes the
 * chain's saved position from `data.json`, with nothing on screen to say so.
 *
 * Pure. No plugin, no DOM, no `"obsidian"` import, and no vault:
 * `displayParentOf` takes the parent lookup as a parameter rather than
 * reaching for one. The whole module is therefore exercisable from a
 * hand-built `ChainIndex`.
 *
 * **A null index is the identity on every function here**, and that is load
 * bearing rather than defensive. `rebuildChainIndex` nulls the index whenever
 * compaction is off, the space is paused, or there is no snapshot — which is
 * the state every drag in this codebase was specified and tested in before
 * compaction existed. Identity there is what lets these calls sit
 * unconditionally on the drag's hot path without a single one of those tests
 * needing to know they are there.
 */
import type { ChainIndex } from "./compactChains";

/**
 * The head of the run whose tip is `tip`, or null when no run has that tip.
 *
 * A scan rather than a lookup. `runByTip` answers "is this path a tip", but it
 * values the `Run`, and a `Run` carries the tip and the segment NAMES — never
 * the head's path, because `compactChains.ts` deliberately knows no path
 * separator and so cannot build one. The head is the KEY in `runByHead`, which
 * is a map in the wrong direction for this question.
 *
 * Widening `ChainIndex` with a fourth map for one consumer would put a second
 * derived structure into `sameChainIndex`'s comparison, which is the thing
 * that decides whether the whole index object is reused and therefore whether
 * the explorer re-sorts. The scan is one entry per compacted chain in the
 * active space, and it is only reached for a path already known to be a tip:
 * at most once per compacted row, not once per row.
 */
function headOfTip(ix: ChainIndex, tip: string): string | null {
  for (const [head, run] of ix.runByHead) {
    if (run.tip === tip) return head;
  }
  return null;
}

/** Whether this path is a run's tip, and so the path a compacted ROW carries. */
export function isCompactedRow(ix: ChainIndex | null, path: string): boolean {
  return ix !== null && ix.runByTip.has(path);
}

/**
 * The path STORAGE would key this row by: a run's tip becomes its head,
 * everything else is itself.
 *
 * The direction a stored order needs. An order is a list of a folder's own
 * children, and the head is the child; the tip is several levels down and
 * `compact(order, live)` would strike it out on the next write.
 *
 * Falls back to the path itself if the index knows the tip but no head claims
 * it. `buildChainIndex` fills `runByTip` only from `runByHead`, so that cannot
 * happen for an index it built — the fallback is what keeps a hand-built or
 * future index from turning an unanswerable question into `undefined` on the
 * drag path.
 */
export function displayToStored(ix: ChainIndex | null, path: string): string {
  if (ix === null || !ix.runByTip.has(path)) return path;
  return headOfTip(ix, path) ?? path;
}

/**
 * The path the ROW for this stored entry carries: a run's head becomes its
 * tip, everything else is itself.
 *
 * The inverse of `displayToStored`, for the consumer going the other way — a
 * stored path that has to be matched against a row on screen, where the row
 * for a compacted chain is spelled with the tip.
 */
export function storedToDisplay(ix: ChainIndex | null, path: string): string {
  return ix?.runByHead.get(path)?.tip ?? path;
}

/**
 * The folder this row is drawn INSIDE, which for a compacted row is the
 * head's parent and not the tip's.
 *
 * `vaultParentOf` is the caller's own lookup, returning the parent's path, `""`
 * for a top-level path, or null for a path the vault does not have. Passed in
 * rather than imported so this module needs no vault; the caller is also the
 * only one that knows how its vault spells the root.
 *
 * The head's answer wins, and the row's OWN parent is the fallback when the
 * head does not resolve. A head can disappear between the snapshot that built
 * the index and the gesture that reads it — a rename or a delete is enough —
 * and the honest tree is the safe answer there. It is the same fail-open
 * `substituteCompacted` takes when a pane cannot resolve a run's tip: when the
 * two halves of compaction disagree, fall back to the folders as they really
 * are.
 */
export function displayParentOf(
  ix: ChainIndex | null,
  path: string,
  vaultParentOf: (path: string) => string | null
): string | null {
  const stored = displayToStored(ix, path);
  if (stored === path) return vaultParentOf(path);
  return vaultParentOf(stored) ?? vaultParentOf(path);
}
