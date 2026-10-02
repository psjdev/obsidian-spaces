/**
 * A tree built from `/`-separated paths, flattened to the rows visible at a
 * given expansion and filter — and what the create panel's two pickers both
 * draw from.
 *
 * It began as the vault picker alone: curated mode shows files and folders and
 * takes any number of them; folder mode shows folders alone and takes one,
 * because a folder space has exactly one root. Files belong there because the
 * data model has always allowed file members — `MemberEntry.kind` is
 * `"file" | "folder"`, and right-click "Add to space" has been making them all
 * along. It was only the create panel that could not.
 *
 * Obsidian's tags use `/` the same way paths do (`area/health/active`), so the
 * tag picker wants every rule in here unchanged: expansion, carets, a filter
 * that keeps a node when a descendant matches, ancestors brought along with a
 * deep hit. What it does NOT want is the file picker's vocabulary, so the kind
 * is a type parameter rather than a fixed union, and the mode that hides files
 * is `onlyKind` rather than `foldersOnly`. Calling a leaf tag a `"file"` and a
 * parent tag a `"folder"` would have worked mechanically and left the type
 * saying something false about every row in the tag tree.
 *
 * `K` defaults to `NodeKind`, so the file picker's calls read exactly as they
 * did and cannot be handed a tag by accident.
 *
 * All of the pickers' decisions live here — what a filter reveals, which
 * ancestors it opens, what a mode hides — so they are testable in plain node
 * and the panel is left drawing rows. It imports nothing from `"obsidian"` and
 * knows nothing about the DOM.
 */

/** The file picker's vocabulary: what a row in the vault tree can be. */
export type NodeKind = "file" | "folder";

/**
 * The tag picker's vocabulary. One kind, because every tag is a tag whether or
 * not anything nests under it — the difference from the vault, where only one
 * of the two kinds can contain anything.
 */
export type TagKind = "tag";

interface VaultEntry<K extends string = NodeKind> {
  path: string;
  kind: K;
}

export interface VaultNode<K extends string = NodeKind> {
  /** Full path, the identity everything else keys on. A tag tree's is the tag. */
  path: string;
  /** Last segment — what the row shows. */
  name: string;
  kind: K;
  children: VaultNode<K>[];
}

export interface Row<K extends string = NodeKind> {
  path: string;
  name: string;
  kind: K;
  /** Nesting level, 0 at the top. The panel turns this into an indent. */
  depth: number;
  /** Only a node with children draws a caret. A file never has any. */
  hasChildren: boolean;
  /** Effective expansion, which a filter can force — see `visibleRows`. */
  expanded: boolean;
  /**
   * The row has children and was meant to be open, by the user or by a filter,
   * but the budget had too little left for them when the walk reached it.
   * Distinct from a row the user closed: that caret works. This one is drawn
   * without a caret, because the rows are spent in order, so opening it adds
   * demand and frees nothing; closing an open branch drawn earlier, or
   * narrowing the filter, is what makes room. The panel draws it as a leaf
   * that says why.
   */
  budgetClosed?: true;
  selected: boolean;
}

export interface ViewOptions<K extends string = NodeKind> {
  /** Paths the user has opened. Ignored for a branch a filter forces open. */
  expanded: ReadonlySet<string>;
  /** Free text; empty means no filtering. */
  filter: string;
  /** Chosen paths. Folder mode holds at most one; curated holds any number. */
  selected: ReadonlySet<string>;
  /**
   * Draw only rows of this kind, dropping a branch left with nothing under it.
   *
   * The file picker's folder mode passes `"folder"`: a file is not a candidate
   * for a root, so it is not shown. Absent or null draws every kind, which is
   * what curated mode and the whole of the tag tree want. Named for what it
   * does rather than for the one caller that needed it, so a second tree does
   * not inherit the word "folders" for rows that are not folders.
   */
  onlyKind?: K | null;
  /**
   * The most rows to return, overflow rows included. Absent means no limit.
   * Spent in the order the rows are drawn, so running out hides whatever comes
   * last. Rows cut from a level that was drawn are counted by an overflow row.
   * See `visibleRows`.
   */
  budget?: number;
}

/**
 * The kind an invented intermediate takes when the caller names none: a vault
 * tree's, because only a folder can contain something.
 */
const DEFAULT_BRANCH_KIND = "folder";

/** Branch-ness by kind: the file tree's rule. An empty folder is still a folder. */
export const isBranchByKind = (node: VaultNode<string>): boolean =>
  node.kind === DEFAULT_BRANCH_KIND;

/** Branch-ness by shape: the tag tree's rule, there being no other kind to key on. */
export const isBranchByChildren = (node: VaultNode<string>): boolean => node.children.length > 0;

/**
 * Flat entries to a sorted tree.
 *
 * Built from path segments rather than by matching parents to children, so a
 * missing intermediate cannot orphan a subtree: `a/b/c` alone still yields
 * `a > b > c`. That is a defensive nicety for the vault, where Obsidian always
 * has the parent, and the ordinary case for tags, where `area/health/active`
 * can exist with nothing ever tagged `area` on its own.
 *
 * `branchKind` is what an invented intermediate becomes. The vault's is
 * `"folder"` and the tag tree's is `"tag"`, which is why it is a parameter: an
 * invented tag that claimed to be a folder would be a row whose type said one
 * thing and whose behaviour said another.
 *
 * Branches sort before leaves at each level, then alphabetically, and what
 * counts as a branch is the caller's `isBranch`. For the file tree it is the
 * node's KIND (`isBranchByKind`): a folder sorts first even when empty, which
 * is the order the file explorer itself uses and therefore the one a reader of
 * this picker already has in their head. For the tag tree it is whether the
 * node HAS CHILDREN (`isBranchByChildren`), because every tag is the same kind
 * and there is nothing else to key on. A parent tag is a container in the same
 * way a folder is, and putting the leaves after it keeps the branching
 * structure legible at a glance. The two cannot share a rule: under
 * has-children an empty folder would sort down among the files.
 */
export function buildVaultTree<K extends string = NodeKind>(
  entries: readonly VaultEntry<K>[],
  // The cast is the price of leaving the vault's call sites unparameterised.
  // It is only ever reached when the caller named no kind, and the only
  // container kind a caller of the default `K` has is `"folder"`.
  branchKind: K = DEFAULT_BRANCH_KIND as K,
  isBranch: (node: VaultNode<K>) => boolean = isBranchByKind
): VaultNode<K>[] {
  const roots: VaultNode<K>[] = [];
  const byPath = new Map<string, VaultNode<K>>();

  for (const entry of entries) {
    const segments = entry.path.split("/").filter((s) => s !== "");
    let prefix = "";
    let siblings = roots;
    segments.forEach((segment, i) => {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      const leaf = i === segments.length - 1;
      let node = byPath.get(prefix);
      if (!node) {
        node = { path: prefix, name: segment, kind: leaf ? entry.kind : branchKind, children: [] };
        byPath.set(prefix, node);
        siblings.push(node);
      } else if (leaf) {
        // A path can arrive after one of its own descendants invented it as a
        // bridge. The entry's own kind is the authoritative one.
        node.kind = entry.kind;
      }
      siblings = node.children;
    });
  }

  const sort = (nodes: VaultNode<K>[]): void => {
    nodes.sort((a, b) => {
      const aBranch = isBranch(a);
      if (aBranch !== isBranch(b)) return aBranch ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) sort(n.children);
  };
  sort(roots);
  return roots;
}

/** A row standing in for children the budget could not draw. */
export interface OverflowRow {
  kind: "overflow";
  /** The parent whose children were cut, or "" for the root level. */
  parent: string;
  /** How many of that parent's children are not drawn. */
  hidden: number;
  depth: number;
}
export type PickerRow<K extends string = NodeKind> = Row<K> | OverflowRow;

/**
 * The rows to render, in order, within a budget.
 *
 * The tree is walked depth-first and each row is emitted as it is reached, so
 * opening a branch shows its children directly beneath it, ahead of rows that
 * sort after it. The cost is that a big branch drawn early can use the budget
 * that later siblings needed, and a branch that sorts late can be reached with
 * nothing left. When a parent is drawn open and only some of its children fit,
 * the list ends with an overflow row at the children's depth that counts
 * exactly how many were cut; the root level is cut and counted the same way.
 * A parent that wants to be open and gets no room is the other case, covered
 * below: it carries a flag instead of a count. Typing in the filter is what
 * brings cut rows back.
 *
 * `rows.length <= budget` always holds, overflow rows included. An overflow
 * row costs a slot like any other, so a level that is cut spends `take + 1`:
 * its marker's slot is held back while a sibling is still to come, and the
 * last sibling needs no marker and holds none. A budget of 0 returns no rows.
 *
 * A parent that wants to be open is drawn open only when at least one child
 * fits, together with a marker if it has more than one, because an open row
 * with nothing beneath it would tell a screen reader the branch is empty. The
 * rest of its children, if they do not all fit, are counted by the marker.
 * Otherwise it is returned closed (`expanded: false`) and flagged
 * `budgetClosed`, even if the user or the filter asked for it open. In
 * depth-first order that happens to a parent reached with almost nothing
 * left, near the end of the budget. Its children are not counted by any
 * marker: the flag and the panel's title stand in for it. It is not offered as
 * a caret, because opening it adds demand and frees nothing. What makes room
 * depends on the state. With a filter, expansion is forced and `expanded` is
 * ignored, so only narrowing the filter helps. Without one, closing an open
 * branch drawn earlier helps if there is one, and typing a filter always does.
 * The panel's wording is the one that is true in both states.
 *
 * The root level has no parent row to close, so a cut there keeps its marker,
 * paid for like any other.
 *
 * Without a filter this is a plain walk: a node's children appear only if the
 * node is in `expanded`.
 *
 * With one, two rules apply together. A node is KEPT if it matches or has a
 * descendant that matches, so a deep hit brings its ancestors with it rather
 * than appearing rootless, and a kept node is force-expanded, because the
 * point of typing is to be shown the thing, and honouring a stale collapsed
 * state would hide the only row that matched. A node that matches itself
 * keeps its whole subtree, so typing a parent's name is a way to browse
 * into it rather than a way to hide its children.
 *
 * The match is against a node's own NAME, which is its last segment. In the
 * tag tree that is what makes typing `atlas` find `project/atlas`. A query
 * containing `/` is asking about nesting, so it is matched against the node's
 * whole path instead, and `project/at` finds `project/atlas`. A query of only
 * `/` therefore matches every nested node and no top-level one; the top-level
 * parents of those nodes are still kept as ancestors.
 *
 * `onlyKind` applies FIRST, before any of that. A folder whose only matching
 * descendant was a file must disappear along with it, rather than linger as a
 * branch that opens onto nothing.
 */
export function visibleRows<K extends string = NodeKind>(
  tree: readonly VaultNode<K>[],
  opts: ViewOptions<K> & { budget: number }
): PickerRow<K>[];
// Without a budget nothing is ever cut, so no overflow row can appear. Saying
// so in the type spares every caller that passes none from narrowing a row
// kind that cannot occur.
export function visibleRows<K extends string = NodeKind>(
  tree: readonly VaultNode<K>[],
  opts: ViewOptions<K> & { budget?: undefined }
): Row<K>[];
export function visibleRows<K extends string = NodeKind>(
  tree: readonly VaultNode<K>[],
  opts: ViewOptions<K>
): PickerRow<K>[] {
  const query = opts.filter.trim().toLowerCase();
  const only = opts.onlyKind ?? null;
  const budget = opts.budget ?? Number.POSITIVE_INFINITY;

  const included = (node: VaultNode<K>): boolean => only === null || node.kind === only;
  // The match is against a node's own NAME, which is its last segment, so
  // typing `atlas` finds `project/atlas`. A query carrying a separator is
  // asking about nesting, so it is matched against the whole path instead:
  // `project/at` found nothing before this, while the same query worked in
  // Settings, where the chip field has always matched the full path.
  // The two rules are believed to produce the same rows: without a separator, a
  // substring of a path lies wholly inside one segment, which is either this
  // node's own name or an ancestor's, and an ancestor's match already shows the
  // whole subtree. The gate is here to say what the code means, not to change
  // what it does, so do not "simplify" it away as an oversight.
  const deep = query.includes("/");
  const matches = (node: VaultNode<K>): boolean =>
    (deep ? node.path : node.name).toLowerCase().includes(query);

  /** Whether this node survives the filter, itself or through a descendant. */
  const keep = (node: VaultNode<K>): boolean =>
    included(node) && (query === "" || matches(node) || node.children.some(keep));

  // Inside a matched ancestor everything is shown; that is what makes a
  // parent's name a way in rather than a filter that empties it.
  const shownChildren = (nodes: readonly VaultNode<K>[], insideMatch: boolean): VaultNode<K>[] =>
    nodes.filter((node) => {
      if (!included(node)) return false;
      if (query === "" || insideMatch) return true;
      return matches(node) || node.children.some(keep);
    });

  // One depth-first walk, spending `left` as rows are emitted. Siblings are
  // emitted in order and each open one is walked into before the next sibling.
  const rows: PickerRow<K>[] = [];
  let left = budget;

  /**
   * Emit one parent's children, cutting the list when the budget runs out and
   * ending it with a marker that counts what was cut. The marker's slot is
   * kept back for as long as another sibling remains, so cutting never needs a
   * slot nobody reserved. The last sibling needs no marker and so reserves
   * none. The root level has no parent row to close, so it is cut like any
   * other level and keeps its marker.
   */
  const emitLevel = (
    nodes: readonly VaultNode<K>[],
    depth: number,
    parent: string,
    insideMatch: boolean
  ): void => {
    for (let i = 0; i < nodes.length; i++) {
      const reserve = i < nodes.length - 1 ? 1 : 0;
      if (left - reserve < 1) {
        // Nothing else fits. `left` is at least 1 here except when the budget
        // was spent before this level began, which only the root can see.
        if (left >= 1) {
          rows.push({ kind: "overflow", parent, hidden: nodes.length - i, depth });
          left -= 1;
        }
        return;
      }
      const node = nodes[i];
      const kids = node.children.filter(included);
      const hasChildren = kids.length > 0;
      const selfMatches = query !== "" && matches(node);
      const wantsOpen = hasChildren && (query !== "" || opts.expanded.has(node.path));
      // Only a parent that wants to be open needs its children worked out; a
      // filter makes that a walk over their subtrees.
      const shown = wantsOpen ? shownChildren(kids, insideMatch || selfMatches) : [];
      left -= 1 + reserve;
      // A parent is opened only if one child fits, plus a marker when there
      // are several to follow; a share of one slot for several would be an
      // open row with nothing under it, which tells a screen reader the branch
      // is empty. Otherwise it is returned closed and flagged `budgetClosed`,
      // so the panel does not offer a caret. A row the user closed is not
      // flagged: its caret works.
      const fits = shown.length > 0 && left >= (shown.length > 1 ? 2 : 1);
      const expanded = wantsOpen && fits;
      const budgetClosed = wantsOpen && shown.length > 0 && !fits;
      rows.push({
        path: node.path,
        name: node.name,
        kind: node.kind,
        depth,
        hasChildren,
        expanded,
        ...(budgetClosed ? { budgetClosed: true as const } : {}),
        selected: opts.selected.has(node.path),
      });
      if (expanded) emitLevel(shown, depth + 1, node.path, insideMatch || selfMatches);
      left += reserve;
    }
  };
  emitLevel(shownChildren(tree, false), 0, "", false);
  return rows;
}
