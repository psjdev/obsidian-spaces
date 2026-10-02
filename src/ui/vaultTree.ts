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
   * but the budget had nothing left for them. Distinct from a row the user
   * closed: that caret works, and this one would not, because allocation is
   * breadth-first and opening a deeper parent frees nothing above it. The
   * panel draws it as a leaf that says why.
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
   * Spent breadth-first, so running out hides the deepest rows rather than
   * whatever sorted last. See `visibleRows`.
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
 * The budget is allocated BREADTH-FIRST and the survivors are emitted
 * depth-first. That separation is the whole point. Allocating depth-first,
 * which is what slicing a flat pre-order list does, spends the budget on one
 * expanded branch's children and silently deletes the roots that sort after
 * it: expanding `topic` on a real vault removed four unrelated root tags from
 * the tree, with nothing on screen to say so and a notice that said "keep
 * typing to narrow", which does not bring a root back.
 *
 * Allocating breadth-first gives the invariant instead: a row at depth N is
 * only ever dropped once every row at depth N-1 has been drawn. A branch that
 * cannot fit its children says so where its children would be.
 *
 * The budget stays at the measured 200. Its size was never the defect.
 *
 * An overflow row costs a slot of the budget like any other row, so a parent
 * that is cut hands over one slot less than its share and spends it on the
 * marker, and the total never exceeds the budget. A parent that cannot be
 * given a child AND its marker, or whose level the budget never reached, is
 * returned closed (`expanded: false`) and flagged `budgetClosed`, even if the
 * user or the filter asked for it open. Drawing it open with nothing beneath
 * would tell a screen reader the branch is empty. It is not offered as a
 * caret either: allocation is breadth-first, so opening a deeper parent adds
 * demand and frees nothing, and the click would do nothing. What makes room
 * depends on the state. With a filter, expansion is forced and `expanded` is
 * ignored, so only narrowing the filter helps. Without one, closing other open
 * branches helps and there is no filter to narrow. The panel says whichever of
 * the two is true.
 *
 * The root level has no parent row to close, so it is cut like any other level
 * and keeps its marker; that marker is paid for, spending `(left - 1) + 1`.
 *
 * Without a filter this is a plain walk: a node's children appear only if the
 * node is in `expanded`.
 *
 * With one, two rules apply together. A node is KEPT if it matches or has a
 * descendant that matches, so a deep hit brings its ancestors with it rather
 * than appearing rootless, and a kept node is force-expanded, because the
 * point of typing is to be shown the thing, and honouring a stale collapsed
 * state would hide the only row that matched. A node that matches on its own
 * name keeps its whole subtree, so typing a parent's name is a way to browse
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
  const deep = query.includes("/");
  const matches = (node: VaultNode<K>): boolean =>
    (deep ? node.path : node.name).toLowerCase().includes(query);

  /** Whether this node survives the filter, itself or through a descendant. */
  const keep = (node: VaultNode<K>): boolean =>
    included(node) && (query === "" || matches(node) || node.children.some(keep));

  /** One parent's drawable children, with the context the emit phase needs. */
  interface Level {
    parent: string;
    depth: number;
    nodes: VaultNode<K>[];
    insideMatch: boolean;
  }

  // Inside a matched ancestor everything is shown; that is what makes a
  // parent's name a way in rather than a filter that empties it.
  const shownChildren = (nodes: readonly VaultNode<K>[], insideMatch: boolean): VaultNode<K>[] =>
    nodes.filter((node) => {
      if (!included(node)) return false;
      if (query === "" || insideMatch) return true;
      return matches(node) || node.children.some(keep);
    });

  // Phase 1: hand out the budget level by level, shallowest first.
  const survivors = new Set<VaultNode<K>>();
  const cut = new Map<string, number>();
  // Parents whose children were actually admitted or accounted for. A survivor
  // that wants to be open but is not in here is drawn closed: see `visibleRows`.
  const opened = new Set<string>();
  let left = budget;
  let level: Level[] = [
    { parent: "", depth: 0, nodes: shownChildren(tree, false), insideMatch: false },
  ];

  while (level.length > 0 && left > 0) {
    const wanted = level.reduce((n, l) => n + l.nodes.length, 0);
    if (wanted <= left) {
      // The whole level fits, and nothing in it is cut, so it costs no marker.
      for (const l of level) {
        for (const n of l.nodes) survivors.add(n);
        opened.add(l.parent);
      }
      left -= wanted;
    } else {
      // Split what remains evenly, so no one parent starves its siblings.
      // Smallest first, so what a small parent does not use goes back to the
      // pool for the larger ones rather than being wasted. An overflow row
      // costs a slot too, which is why each cut parent reserves one.
      let pool = left;
      const open = level
        .filter((l) => l.nodes.length > 0)
        .sort((a, b) => a.nodes.length - b.nodes.length);
      open.forEach((l, i) => {
        const share = Math.floor(pool / (open.length - i));
        if (l.nodes.length <= share) {
          for (const n of l.nodes) survivors.add(n);
          opened.add(l.parent);
          pool -= l.nodes.length;
          return;
        }
        // A cut parent needs a child AND its marker, two slots. A share of
        // one buys only the marker, which would be a branch drawn open with
        // nothing in it. The root level has no parent row to close, so it
        // keeps its marker; any other parent is left closed, spending nothing.
        if (share < 2 && l.depth > 0) return;
        const take = Math.max(0, share - 1);
        for (let k = 0; k < take; k++) survivors.add(l.nodes[k]);
        opened.add(l.parent);
        cut.set(l.parent, l.nodes.length - take);
        pool -= take + 1;
      });
      level = [];
      break;
    }
    // Descend only into survivors that are expanded.
    const next: Level[] = [];
    for (const l of level) {
      for (const node of l.nodes) {
        if (!survivors.has(node)) continue;
        const kids = node.children.filter(included);
        if (kids.length === 0) continue;
        const expanded = query !== "" || opts.expanded.has(node.path);
        if (!expanded) continue;
        const selfMatches = query !== "" && matches(node);
        const inside = l.insideMatch || selfMatches;
        const shown = shownChildren(kids, inside);
        if (shown.length > 0) {
          next.push({ parent: node.path, depth: l.depth + 1, nodes: shown, insideMatch: inside });
        }
      }
    }
    level = next;
  }

  // Phase 2: emit the survivors in pre-order, which is what a tree looks like.
  const rows: PickerRow<K>[] = [];
  const emit = (
    nodes: readonly VaultNode<K>[],
    depth: number,
    parent: string,
    insideMatch: boolean
  ): void => {
    for (const node of nodes) {
      if (!survivors.has(node)) continue;
      const kids = node.children.filter(included);
      const hasChildren = kids.length > 0;
      // Closed when the budget never reached its children, however much the
      // user or the filter wanted it open: an open row with nothing beneath it
      // would tell a screen reader the branch is empty. It is also flagged, so
      // the panel does not offer a caret that could do nothing. A row the user
      // closed is not flagged; its caret works.
      const wantsOpen = hasChildren && (query !== "" || opts.expanded.has(node.path));
      const expanded = wantsOpen && opened.has(node.path);
      const budgetClosed = wantsOpen && !expanded;
      const selfMatches = query !== "" && matches(node);
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
      if (expanded) {
        emit(
          shownChildren(kids, insideMatch || selfMatches),
          depth + 1,
          node.path,
          insideMatch || selfMatches
        );
      }
    }
    const hidden = cut.get(parent);
    if (hidden !== undefined && hidden > 0) {
      rows.push({ kind: "overflow", parent, hidden, depth });
    }
  };
  emit(shownChildren(tree, false), 0, "", false);
  return rows;
}

/**
 * Every ancestor of `path`, so the panel can open a pre-filled selection into
 * view — the right-click "Create space from this folder" entry lands with a
 * root already chosen, and a tree that showed it collapsed would hide it.
 */
export function ancestorsOf(path: string): string[] {
  const segments = path.split("/").filter((s) => s !== "");
  const out: string[] = [];
  let prefix = "";
  // The last segment is the node itself, not an ancestor.
  for (const segment of segments.slice(0, -1)) {
    prefix = prefix === "" ? segment : `${prefix}/${segment}`;
    out.push(prefix);
  }
  return out;
}
