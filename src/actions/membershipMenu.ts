import type { SpaceDefinition } from "../types";
import type { TagIndex } from "../visibility/TagIndex";
import { inheritedFromFolder } from "../definitions/membership";
import { spaceAddTargets } from "./spaceAddTargets";
import { submenuFor, type SubmenuLike } from "./nativeMenuSubmenu";

/**
 * `inheritedFromFolder` now lives in `definitions/membership.ts` — a
 * domain predicate does not belong in a menu-rendering module, and importing
 * it from here is what made this file and `spaceAddTargets.ts` the one runtime
 * import cycle in `src/`. Re-exported so `main.ts` and `ui/memberList.ts`
 * keep compiling; the shim is meant to be deleted once those two import from
 * `definitions/membership` directly.
 */
export { inheritedFromFolder } from "../definitions/membership";

/**
 * Structural subsets of Obsidian's Menu/MenuItem, SpaceController and
 * VisibilitySnapshot -- just the members `decorate` actually calls. Kept
 * local (rather than importing the real classes) so this module never needs
 * the "obsidian" runtime and stays testable in plain node, the same way the
 * rest of the pure engine does. The real objects used in `membership.ts`
 * satisfy these structurally, so no adapter/wrapper is needed at the call
 * site.
 */
export interface MenuItemLike {
  setTitle(title: string): MenuItemLike;
  setIcon(icon: string): MenuItemLike;
  setDisabled(disabled: boolean): MenuItemLike;
  onClick(cb: () => void): MenuItemLike;
}

export interface MenuLike {
  addItem(cb: (item: MenuItemLike) => MenuItemLike): void;
}

export interface FileLike {
  path: string;
}

export interface VisibilityDecisionLike {
  visible: boolean;
  reason: string;
  canRemoveMembership: boolean;
}

interface SnapshotLike {
  decisionFor(path: string): VisibilityDecisionLike;
}

interface ControllerLike {
  activeSpace(): SpaceDefinition | null;
  currentSnapshot(): SnapshotLike | null;
}

export interface DecorateContext {
  controller: ControllerLike;
  /**
   * Every space, for *All*'s "Add to space" entry. In *All* there is
   * no active space and so no per-space snapshot, so membership is read from
   * the definitions plus the tag index (see `spaceAddTargets`).
   */
  spaces(): readonly SpaceDefinition[];
  /**
   * The tag index the tree was last drawn from, for expanding those spaces'
   * tag members. Required rather than optional: an absent one silently makes
   * every tag member match nothing, which is exactly the bug this closes —
   * "Add to space" offered for a note the space already holds through a tag.
   */
  tags(): TagIndex;
}

interface DecorateHandlers<T extends FileLike> {
  addAll: (files: T[]) => void;
  removeAll: (files: T[]) => void;
  /** Drops the reveal without touching membership. */
  dismissAll: (files: T[]) => void;
  /** Adds to a NAMED space, which is what *All* needs. */
  addToSpace: (spaceId: string, files: T[]) => void;
}

/**
 * Populates a file/files-menu with spaces's membership entries.
 *
 * Obsidian's own range selection (Shift+click in the file explorer) walks
 * its internal item list without consulting computed visibility, the same
 * way arrow-key navigation does -- so a selection that looks like
 * two adjacent visible rows can silently include `display:none` rows between
 * them. Unlike the arrow-key case, nothing else reveals those smuggled-in
 * paths (opening a file makes it visible via the visitor mechanism; a range
 * selection is not an open file). So `files` here may contain paths the
 * active space's snapshot does not consider visible, and every decision --
 * and the count shown in the menu -- must be computed after filtering them
 * out, never before.
 */
export function decorate<T extends FileLike>(
  menu: MenuLike,
  ctx: DecorateContext,
  files: T[],
  handlers: DecorateHandlers<T>
): void {
  const space = ctx.controller.activeSpace();
  // *All* has no active space, so the per-space entries below have no
  // subject — but it does have somewhere to send things, so this stays an
  // explicit fork rather than a bare early return.
  if (!space) {
    addToSpaceEntries(menu, ctx, files, handlers);
    return;
  }
  const snap = ctx.controller.currentSnapshot();
  if (!snap) return;

  const visible = files.filter((f) => snap.decisionFor(f.path).visible);
  if (visible.length === 0) return; // entire selection is invisible to this space

  const decisions = visible.map((f) => snap.decisionFor(f.path));
  const allExact = decisions.every((d) => d.canRemoveMembership);
  const anyInherited = decisions.some((d) => d.reason === "inherited-member");

  if (allExact) {
    menu.addItem((i) =>
      i
        .setTitle(`Remove from ${space.name}`)
        .setIcon("minus-circle")
        .onClick(() => handlers.removeAll(visible))
    );
    return;
  }

  if (anyInherited) {
    // Disabled, not hidden -- omitting it would read as a bug.
    // Name the folder responsible for the inheritance so the disabled entry
    // explains itself; MenuItem has no tooltip API, so it goes in the title.
    const folder =
      visible.length === 1 ? inheritedFromFolder(space, visible[0].path) : null;
    const label = folder
      ? `Remove from ${space.name} (inherited from ${folder})`
      : `Remove from ${space.name} (inherited)`;
    menu.addItem((i) => i.setTitle(label).setIcon("minus-circle").setDisabled(true));
  }

  menu.addItem((i) =>
    i
      .setTitle(
        visible.length === 1 ? `Add to ${space.name}` : `Add ${visible.length} to ${space.name}`
      )
      .setIcon("plus-circle")
      .onClick(() => handlers.addAll(visible))
  );

  // A visitor is shown only because it is open, so it gets a way to
  // stop being shown that is distinct from membership -- nothing is added to
  // or removed from the space. Computed from the already-filtered `visible`
  // array, so a hidden row smuggled into the selection by Obsidian's range
  // select cannot be dismissed.
  const visitors = visible.filter(
    (f) => snap.decisionFor(f.path).reason === "visitor"
  );
  if (visitors.length > 0) {
    menu.addItem((i) =>
      i
        .setTitle("Stop showing here")
        .setIcon("eye-off")
        .onClick(() => handlers.dismissAll(visitors))
    );
  }
}

/**
 * *All*'s "Add to space".
 *
 * A nested menu when this build can nest one, and flat `Add to <space>`
 * entries when it cannot. The two carry the same information, and the choice
 * is made by `submenuFor` (the private-API quarantine) — so an Obsidian
 * release that drops the nesting API costs the nesting and nothing else. The
 * method's name deliberately does not appear here: `grep -rn` for it is the
 * check that the quarantine holds, and a comment would make that grep lie.
 *
 * Disabled targets are rendered, not skipped: a space that already holds
 * everything selected says so. The rule, and the same choice the
 * inherited-remove entry above makes.
 */
function addToSpaceEntries<T extends FileLike>(
  menu: MenuLike,
  ctx: DecorateContext,
  files: T[],
  handlers: DecorateHandlers<T>
): void {
  const spaces = ctx.spaces();
  if (files.length === 0) return;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const targets = spaceAddTargets(
    spaces,
    files.map((f) => f.path),
    ctx.tags()
  );
  // No targets AFTER filtering means no entry, rather than one that opens onto
  // nothing. Checking `spaces.length` alone is not enough: `spaceAddTargets`
  // drops every folder space, so a vault whose spaces are all folder spaces
  // has `spaces.length > 0` but `targets` empty.
  if (targets.length === 0) return;

  const build = (item: MenuItemLike, t: (typeof targets)[number]): MenuItemLike => {
    item.setTitle(t.label).setIcon(t.icon).setDisabled(t.disabled);
    if (!t.disabled) {
      // Only the paths this space does not already hold: clicking must do
      // exactly what the label says.
      const addable = t.addablePaths
        .map((p) => byPath.get(p))
        .filter((f): f is T => f !== undefined);
      item.onClick(() => handlers.addToSpace(t.id, addable));
    }
    return item;
  };

  // Held in an object rather than a `let`: assigning inside the callback does
  // not update TypeScript's narrowing of a local, which then reads as `never`
  // at the check below.
  const held: { sub: SubmenuLike | null } = { sub: null };
  menu.addItem((parent) => {
    parent.setTitle("Add to space").setIcon("plus-circle");
    held.sub = submenuFor(parent);
    return parent;
  });

  const submenu = held.sub;
  if (submenu) {
    for (const t of targets) submenu.addItem((item) => build(item, t));
    return;
  }

  // Fall back to flat entries. The parent added above is left as a label so
  // the group still reads as one thing rather than a loose run of items.
  for (const t of targets) {
    menu.addItem((item) => build(item, { ...t, label: `Add to ${t.label}` }));
  }
}
