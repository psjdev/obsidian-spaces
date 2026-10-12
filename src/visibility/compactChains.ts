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
  /**
   * Every folder of a run that gets NO row: the head and each intermediate,
   * down to but excluding the tip. Keyed by path, valued by the run it belongs
   * to, so a caller holding a folder path asks one question.
   *
   * The sort seam needs this, and needs it as a membership test rather than as
   * a walk. Obsidian's `sort()` asks every folder it knows for its children
   * and then lets `vChildren.addChild` REASSIGN each answer's `parent`. A
   * hidden segment is still a real folder holding the next segment, so left to
   * answer honestly it adopts the tip a second time — while the tip's row is
   * drawn at the HEAD's level, under a different folder entirely. Measured in
   * a real Obsidian before this map existed: a row drawn at depth 1 under
   * `Nested` whose `parent` was `Nested/Chain/L1/L2`, a path with no row at
   * all.
   *
   * A one-folder "run" is not a run (`runFrom` refuses it), so this map is
   * never empty for a run that is in it: `segments.length - 1` is at least 1.
   */
  hiddenSegments: Map<string, Run>;
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
 * The run's unrendered folders: the head, and every intermediate above the
 * tip.
 *
 * Climbed from the TIP with `tree.parentOf` rather than built by joining the
 * head's path with `segments`. `segments` are NAMES, so joining them would
 * need a path separator, and this module has deliberately never known one —
 * it asks the tree for `parentOf` and `nameOf` instead. Climbing also cannot
 * drift from `runFrom`, which descended the same links.
 *
 * `segments.length - 1` steps, because `segments` names the head through the
 * tip inclusive and the tip is the one folder of a run that DOES render.
 */
function hiddenSegmentsOf(run: Run, tree: ChainTree): string[] {
  const out: string[] = [];
  let current = run.tip;
  for (let i = run.segments.length - 1; i > 0; i--) {
    const parent = tree.parentOf(current);
    // `parentOf` is nullable for a top-level path, and the compiler needs the
    // narrowing. It cannot fire for a run `runFrom` built: that walk descended
    // exactly these links, so the tip sits `segments.length - 1` levels below
    // the head and the climb stops AT the head, never above it. Breaking
    // rather than pushing a fabricated path is the conservative answer if a
    // future `ChainTree` ever makes it reachable — a short list blanks fewer
    // folders, which is the honest-tree direction.
    if (parent === null) break;
    out.push(parent);
    current = parent;
  }
  return out;
}

/**
 * Every run in the space, by head, by tip, and by hidden segment.
 *
 * Built ONCE per visibility snapshot and read by four consumers: the sort seam
 * substitutes by head and blanks by hidden segment, the explorer adapter
 * labels by tip, the drag translation maps between display and vault space by
 * both, and the re-sort memo keys on this object's identity. One producer and
 * a shared answer is what keeps those four from disagreeing about what is
 * compacted — and blanking is the consumer that most needs the agreement,
 * because a folder blanked by a run nothing else believes in would lose its
 * rows outright.
 *
 * NOT a consumer, though it is the obvious next guess: the seam's permits
 * predicate. It admits an out-of-input tip from `admittedThisCall`, a flat
 * per-call `Set` the substitution writes as it goes, and never reads this
 * object at all. Worth keeping straight, because this index deliberately
 * survives across sort calls and that record deliberately does not.
 */
export function buildChainIndex(folders: readonly string[], tree: ChainTree): ChainIndex {
  const runByHead = new Map<string, Run>();
  const runByTip = new Map<string, Run>();
  const hiddenSegments = new Map<string, Run>();
  for (const path of folders) {
    if (!isHead(path, tree)) continue;
    const run = runFrom(path, tree);
    if (!run) continue;
    runByHead.set(path, run);
    runByTip.set(run.tip, run);
    for (const hidden of hiddenSegmentsOf(run, tree)) hiddenSegments.set(hidden, run);
  }
  return { runByHead, runByTip, hiddenSegments };
}

/**
 * Whether two indexes describe the same runs: the same heads, each with the
 * same tip and the same segments in the same order, and the same set of hidden
 * segments. `runByTip` is derived from `runByHead`, so comparing heads covers
 * it.
 *
 * `hiddenSegments` is derived too, but from the runs AND the tree, so it is
 * compared rather than inferred. A tie here keeps the PREVIOUS index object,
 * and that object is what the sort seam blanks folders by: an index that
 * agreed about every head while disagreeing about one hidden segment would
 * leave that folder answering the sort honestly, which is the whole C2 defect
 * back again. The keys are enough — each maps to the run its head already
 * matched.
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
  if (a.hiddenSegments.size !== b.hiddenSegments.size) return false;
  for (const hidden of a.hiddenSegments.keys()) {
    if (!b.hiddenSegments.has(hidden)) return false;
  }
  return true;
}
