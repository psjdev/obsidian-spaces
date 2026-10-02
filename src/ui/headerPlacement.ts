/**
 * Where the space header goes in the explorer pane. Plain DOM, no
 * `"obsidian"` import, extracted for the same reason as `panelMount.ts` —
 * `SpaceHeaderView` imports `Notice`/`setIcon`, so nothing in that file can be
 * reached from a plain Vitest run.
 *
 * Small, but it has a branch that only fires when the pane is not the shape we
 * expect, which is precisely the branch no manual check will ever exercise.
 */

/**
 * The node to insert the header BEFORE, or null to append instead.
 *
 * Null in two cases, both of which mean "we cannot place it correctly, so
 * place it harmlessly":
 *
 * - **No tree container.** `changeLayout()` destroys and recreates
 *   `.nav-files-container`, so a rebind can run while it is absent.
 * - **The container is not a direct child of `parent`.** `insertBefore` throws
 *   `NotFoundError` for a reference node that is not a child, which during a
 *   rebind would abort the mount and leave the pane with no header at all.
 *   A wrongly-positioned header is a cosmetic bug; a throw here is a missing
 *   feature.
 *
 * Deliberately NOT an index into `parent.children`: the pane's child list is
 * not ours to count. Other plugins add to it, and an index that held at mount
 * would not hold at the next rebind.
 */
export function headerAnchor(parent: Element, container: Element | null): Element | null {
  if (!container) return null;
  return container.parentElement === parent ? container : null;
}
