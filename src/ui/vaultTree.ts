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

interface Row<K extends string = NodeKind> {
  path: string;
  name: string;
  kind: K;
  /** Nesting level, 0 at the top. The panel turns this into an indent. */
  depth: number;
  /** Only a node with children draws a caret. A file never has any. */
  hasChildren: boolean;
  /** Effective expansion, which a filter can force — see `visibleRows`. */
  expanded: boolean;
  selected: boolean;
}

interface ViewOptions<K extends string = NodeKind> {
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

/**
 * The rows to render, in order.
 *
 * Without a filter this is a plain walk: a node's children appear only if the
 * node is in `expanded`.
 *
 * With one, two rules apply together. A node is KEPT if it matches or has a
 * descendant that matches — so a deep hit brings its ancestors with it rather
 * than appearing rootless — and a kept node is force-expanded, because the
 * point of typing is to be shown the thing, and honouring a stale collapsed
 * state would hide the only row that matched. A node that matches on its own
 * name keeps its whole subtree, so typing a parent's name is a way to browse
 * into it rather than a way to hide its children.
 *
 * The match is against a node's own NAME, which is its last segment. In the
 * tag tree that is what makes typing `atlas` find `project/atlas`.
 *
 * `onlyKind` applies FIRST, before any of that. A folder whose only matching
 * descendant was a file must disappear along with it, rather than linger as a
 * branch that opens onto nothing.
 */
export function visibleRows<K extends string = NodeKind>(
  tree: readonly VaultNode<K>[],
  opts: ViewOptions<K>
): Row<K>[] {
  const query = opts.filter.trim().toLowerCase();
  const rows: Row<K>[] = [];
  const only = opts.onlyKind ?? null;

  const included = (node: VaultNode<K>): boolean => only === null || node.kind === only;
  const matches = (node: VaultNode<K>): boolean => node.name.toLowerCase().includes(query);

  /** Whether this node survives the filter, itself or through a descendant. */
  const keep = (node: VaultNode<K>): boolean =>
    included(node) && (query === "" || matches(node) || node.children.some(keep));

  const walk = (nodes: readonly VaultNode<K>[], depth: number, insideMatch: boolean): void => {
    for (const node of nodes) {
      if (!included(node)) continue;
      const selfMatches = query !== "" && matches(node);
      // Inside a matched ancestor everything is shown; that is what makes a
      // parent's name a way in rather than a filter that empties it.
      const shown = query === "" || insideMatch || selfMatches || node.children.some(keep);
      if (!shown) continue;

      const children = node.children.filter(included);
      const hasChildren = children.length > 0;
      const expanded = hasChildren && (query !== "" || opts.expanded.has(node.path));
      rows.push({
        path: node.path,
        name: node.name,
        kind: node.kind,
        depth,
        hasChildren,
        expanded,
        selected: opts.selected.has(node.path),
      });
      if (expanded) walk(children, depth + 1, insideMatch || selfMatches);
    }
  };

  walk(tree, 0, false);
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
