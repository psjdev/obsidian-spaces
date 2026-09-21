/**
 * The ONLY place selector strings appear. Verified against Obsidian 1.13.7
 * in Spike A against Obsidian 1.13.7.
 */
export const SEL = {
  container: ".nav-files-container",
  /** Carries data-path. NOT the element we mutate. */
  titleWithPath: "[data-path]",
  /** The row container: parentElement of a title. This is what we class. */
  rowWrapper: ".tree-item",
  /**
   * The explorer's own action buttons (new note, new folder, sort,
   * collapse). A click on ANY of them arms a creation intent — deliberately
   * not matched by label, which would couple us to Obsidian's UI copy and
   * break under localisation. Arming is harmless: only a create in the
   * computed destination consumes it, so a click on "collapse all" arms an
   * intent that simply expires.
   */
  navActionButton: ".nav-action-button",
  /** Scopes the above to the FILE explorer; other panes have action buttons too. */
  fileExplorerPane: '.workspace-leaf-content[data-type="file-explorer"]',
  /**
   * The left ribbon's icons, read ONLY to measure where they sit — the create
   * panel lines its name field up with one (`ribbonAlign.ts`). Never clicked,
   * classed or mutated; this is a ruler, not a handle.
   *
   * Two selectors because the ribbon's action elements changed class between
   * Obsidian versions and both spellings are still in the wild. Matching
   * neither is a supported outcome: the ribbon can be hidden from settings and
   * does not exist on mobile, and the alignment simply does not apply then.
   */
  ribbonIcon: ".workspace-ribbon .clickable-icon, .side-dock-ribbon-action",
  /**
   * Obsidian's own multi-select state, carried by the `[data-path]`
   * element of every row in an explorer selection.
   *
   * The one Obsidian-owned class spaces matches that is not structural.
   * `DragOrdering` must read this constant rather than hard-code the class
   * itself — the single genuine escape from this file. It is read OPPORTUNISTICALLY and is never
   * authoritative: the class appears in several unrelated places in Obsidian's
   * UI, so `collectDragged` uses it only to WIDEN a drag the user started on a
   * row already carrying it. If it ever means something else there, the
   * fallback is the correct single-row drag.
   */
  selectedRow: ".is-selected",
  /**
   * The sort button specifically, among the buttons above. Unlike the
   * creation-intent arming above, this one must discriminate — matching
   * "Change sort order" would couple us to Obsidian's UI copy and break
   * under localisation, so the icon class is used instead (measured against
   * 1.13.7: the six explorer buttons are `lucide-edit`, `lucide-folder-plus`,
   * `lucide-sort-asc`, `lucide-gallery-vertical`, `lucide-chevrons-down-up`
   * and `lucide-search`).
   *
   * If Obsidian ever renames it, the row silently stops appearing while the
   * sort-override feature's other surfaces keep working — the intended
   * failure.
   */
  sortButtonIcon: "svg.lucide-sort-asc",
  /**
   * The explorer's "New folder" nav action, identified the same way and for
   * the same reason as `sortButtonIcon` above: by its icon, not its
   * `aria-label`, which is translated and would break in every non-English
   * install.
   *
   * Used to redirect the button into a folder space's pinned folder. If
   * Obsidian renames the icon the redirect silently stops and Obsidian's own
   * behaviour returns — the intended failure, same as the sort row.
   */
  newFolderButtonIcon: "svg.lucide-folder-plus",
  /**
   * Obsidian's toolbar row above the file tree, and the first row of the
   * tree itself. Both are read ONLY to measure where they sit: the vertical
   * strip lines its pinned control and its rail up with them
   * (`stripAlign.ts`). Rulers, not handles -- never clicked, classed or
   * mutated.
   *
   * Matching neither is a supported outcome, the same way the ribbon's is:
   * a theme can hide the toolbar, and a space with no visible rows has no
   * first row. The alignment simply does not apply, and the stylesheet's own
   * spacing stands.
   */
  navHeader: ".nav-header",
  treeRow: ".tree-item-self",
} as const;

/**
 * `styles.css` ALSO depends on this DOM shape and cannot import from here.
 *
 * The owned classes land on `.tree-item`, whose children are the row itself
 * (`.tree-item-self`, the `[data-path]` element) and the subtree
 * (`.tree-item-children`). The de-emphasis rules target only the row, not the
 * subtree, so they are written as `.spaces-scaffold > .tree-item-self`. If
 * `titleWithPath` or `rowWrapper` ever changes, those two rules in styles.css
 * change with it.
 */

export const CLS = {
  scaffold: "spaces-scaffold",
  visitor: "spaces-visitor",
} as const;

/**
 * Marks the first row of the elsewhere group, so CSS can draw a boundary
 * above it.
 *
 * A class on a row rather than a new element: the tree is Obsidian's, and
 * every cue this plugin adds is a class or style on a row it already owns.
 *
 * A top-level export rather than a member of `CLS`: `ExplorerAdapter` writes
 * this one from an ORDER the caller computed, not from `decisionFor` like
 * `CLS.scaffold`/`CLS.visitor`. Still belongs in `ALL_OWNED_CLASSES` below,
 * applied and cleared per row like those two, unlike the transient
 * `CLS_SWITCHING`/`CLS_DROP_LINE`.
 *
 * Keep `as const`: widening this to plain `string` widens
 * `ALL_OWNED_CLASSES` to `string[]`, which in turn infers `ExplorerAdapter`'s
 * `want` object as `Record<string, boolean>` — silently losing the compile
 * error when a class is added here with no matching `want` entry.
 */
export const CLS_ELSEWHERE = "spaces-elsewhere" as const;

export const ALL_OWNED_CLASSES = [CLS.scaffold, CLS.visitor, CLS_ELSEWHERE];

/**
 * Goes on `document.body`, not on any explorer element, and
 * that is the whole point: measured across a space switch, EVERY reference
 * into the explorate DOM goes stale — `changeLayout()` replaces the
 * `.nav-files-container`, the view's `containerEl`, and the left split itself.
 * `document.body` is the only node in the sequence that is never replaced.
 *
 * Not in `CLS` above because those are row classes the adapter applies and
 * clears per row; this one is a transient document-level state.
 */
export const CLS_SWITCHING = "spaces-switching";

/**
 * The insertion line. Owned, created by `DragOrdering`, positioned
 * absolutely inside `.nav-files-container` — which is already
 * `position: relative` (measured), so no host style is needed to anchor it.
 *
 * Not in `CLS` above for the same reason as `CLS_SWITCHING`: those are row
 * classes the adapter applies and clears per row, and this is a transient
 * element of our own.
 */
export const CLS_DROP_LINE = "spaces-drop-line";

/**
 * The insertion line for reordering SPACES, vertical, drawn inside
 * `.spaces-switcher-rail`.
 *
 * A second class rather than reusing `CLS_DROP_LINE`: that one is horizontal
 * and sized to a tree row, this one is vertical and sized to an icon, and the
 * two live in different scrollers. Sharing a class would mean one rule set
 * fighting over both orientations.
 */
export const CLS_SPACE_DROP_LINE = "spaces-space-drop-line";

/** On the space icon being dragged, mirroring Obsidian's own row state. */
export const CLS_SPACE_DRAGGING = "is-being-dragged";
