/**
 * Which folders only lead onward.
 *
 * A note added to a curated space brings its ancestor folders along as
 * scaffold, which is right for one note and noise for ten. The noise comes from
 * CHAINS, not from folders: a folder holding several of the space's notes is
 * carrying information, and a folder that exists only to lead to one other
 * folder is not.
 *
 * Pure. No DOM, no `"obsidian"` import, no knowledge of the sort seam. The
 * caller supplies the tree as five questions, so this module cannot care
 * whether the answers come from a vault, a snapshot or a test fixture.
 */

/** The tree, asked rather than walked, so this module stays pure. */
export interface ChainTree {
  /** Children VISIBLE in the active space. Order is irrelevant here. */
  visibleChildrenOf(folderPath: string): readonly string[];
  isFolder(path: string): boolean;
  /** Scaffold in the active space: an ancestor of something visible, not picked. */
  isScaffold(path: string): boolean;
  parentOf(path: string): string | null;
  /** The last segment, as the explorer displays it. */
  nameOf(path: string): string;
}

export interface Run {
  /** The deepest folder. What the caller substitutes, and what owns behaviour. */
  tip: string;
  /** Folder names from head to tip, in order. */
  segments: string[];
}

export interface ChainIndex {
  runByHead: Map<string, Run>;
  runByTip: Map<string, Run>;
}

/**
 * The run starting at `start`, or null when `start` does not compact.
 *
 * Extension stops at the TIP, which is the folder where the rule fails: it has
 * several visible children, or one child that is a note, or one child that is a
 * folder the user added as a member. The tip carries no further condition,
 * which is why it is the loop's exit rather than one of its tests.
 *
 * A member folder is never absorbed. The user picked it, so it keeps its own
 * row and stays something they can act on.
 */
export function runFrom(start: string, tree: ChainTree): Run | null {
  if (!tree.isFolder(start) || !tree.isScaffold(start)) return null;
  const segments = [tree.nameOf(start)];
  let current = start;
  for (;;) {
    const kids = tree.visibleChildrenOf(current);
    if (kids.length !== 1) break;
    const only = kids[0];
    if (!tree.isFolder(only) || !tree.isScaffold(only)) break;
    current = only;
    segments.push(tree.nameOf(only));
  }
  // One folder is not a run. Compacting it would change nothing and would still
  // cost the caller an out-of-input substitution to justify.
  return segments.length < 2 ? null : { tip: current, segments };
}

/**
 * Whether a folder could START a run, rather than sit inside one.
 *
 * A folder whose parent is a scaffold folder with exactly this one visible
 * child is already inside its parent's run, and indexing it again would
 * substitute it at a level that never renders.
 */
function isHead(path: string, tree: ChainTree): boolean {
  const parent = tree.parentOf(path);
  if (parent === null) return true;
  if (!tree.isFolder(parent) || !tree.isScaffold(parent)) return true;
  const kids = tree.visibleChildrenOf(parent);
  return !(kids.length === 1 && kids[0] === path);
}

/**
 * Every run in the space, by head and by tip.
 *
 * Built ONCE per visibility snapshot and read by three consumers: the sort
 * seam substitutes by head, the seam's permits predicate admits by tip, and
 * the explorer adapter labels by tip. One producer and a shared answer is what
 * keeps those three from disagreeing about what is compacted.
 */
export function buildChainIndex(folders: readonly string[], tree: ChainTree): ChainIndex {
  const runByHead = new Map<string, Run>();
  const runByTip = new Map<string, Run>();
  for (const path of folders) {
    if (!isHead(path, tree)) continue;
    const run = runFrom(path, tree);
    if (!run) continue;
    runByHead.set(path, run);
    runByTip.set(run.tip, run);
  }
  return { runByHead, runByTip };
}

/**
 * Whether two indexes describe the same runs: the same heads, each with the
 * same tip and the same segments in the same order. `runByTip` is derived from
 * `runByHead`, so comparing heads covers both.
 *
 * Exists so the plugin can keep the PREVIOUS index object when a rebuild
 * produced nothing new. The re-sort memo compares the index by identity, and a
 * fresh object per snapshot would defeat it on every `file-open`. Runs are one
 * per compacted chain, so a direct comparison is cheap.
 *
 * `null` means "no index" (compaction off, paused, or no snapshot) and equals
 * only itself.
 */
export function sameChainIndex(a: ChainIndex | null, b: ChainIndex | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.runByHead.size !== b.runByHead.size) return false;
  for (const [head, runA] of a.runByHead) {
    const runB = b.runByHead.get(head);
    if (!runB || runA.tip !== runB.tip) return false;
    if (runA.segments.length !== runB.segments.length) return false;
    for (let i = 0; i < runA.segments.length; i++) {
      if (runA.segments[i] !== runB.segments[i]) return false;
    }
  }
  return true;
}