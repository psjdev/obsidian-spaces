/**
 * The create panel's mount and sibling-inerting rules: the two container and
 * sibling identity rules `CreateSpacePanel` applies when it covers a file
 * explorer container, extracted so they can be tested directly against real
 * DOM nodes.
 *
 * Both are plain DOM logic — neither touches anything Obsidian-specific —
 * but `CreateSpacePanel.ts` imports `AbstractInputSuggest`/`Notice`/
 * `setIcon` from `"obsidian"`, an API-types-only package with no runtime
 * module (`"main": ""` in its `package.json`), so importing that file from
 * a Vitest test throws at import time. These two functions are the ONLY
 * rules in this feature that needed two correctness revisions each (fix
 * round 2's container-identity fix, and the final whole-branch review's
 * sibling-inert re-sync fix) and had zero test coverage either time —
 * `container === mountedContainer` could be weakened to `container !==
 * null` and the suite would stay green. `CreateSpacePanel` calls these as
 * thin wrappers over its own instance fields; see `isStillCovering()` and
 * `resyncInertSiblings()` there.
 */

/**
 * Is the panel (`el`) still covering the SAME container (`mountedContainer`,
 * recorded at the most recent successful mount) as the one now found under
 * `parent`? Parent identity alone is not enough: `changeLayout()` can
 * destroy and recreate `.nav-files-container` while `parent` (the leaf's
 * `containerEl`) persists, so a parent-only check stays true across a
 * rebuild the panel needed to close for — the exact hazard this container
 * check exists to close (see `CreateSpacePanel.isStillCovering`'s own
 * comment for the full history).
 */
export function isStillCovering(
  el: HTMLElement | null,
  mountedContainer: HTMLElement | null,
  parent: HTMLElement,
  container: HTMLElement | null
): boolean {
  return (
    el !== null &&
    el.isConnected &&
    el.parentElement === parent &&
    mountedContainer !== null &&
    container === mountedContainer
  );
}

/**
 * Reconciles `inertSiblings` (mutated in place) against `parent`'s CURRENT
 * children, for the case where the panel is being KEPT open across a
 * layout-change. `SwitcherView` destroys and recreates its own element on
 * EVERY `mount()` call, regardless of whether anything else changed, so a
 * one-time inert-at-mount never sees that fresh node — this is what
 * catches it, called after every `switcher.mount()` while the panel stays
 * open.
 *
 * - Drops (and un-inerts) any recorded sibling no longer parented under
 *   `parent` — it was replaced or removed, and leaving it in the record
 *   would strand `inert` on a detached node forever while the live
 *   replacement in its place is never recorded as ours to un-inert later.
 * - Inerts and records any current child of `parent` that is `el`'s
 *   sibling, is not already recorded, AND — the same rule `mount()`'s own
 *   loop uses — is not already `inert` for some unrelated reason. Never
 *   take ownership of an `inert` this panel did not set.
 */
export function resyncInertSiblings(
  el: HTMLElement | null,
  inertSiblings: HTMLElement[],
  parent: HTMLElement
): void {
  if (!el) return;
  for (let i = inertSiblings.length - 1; i >= 0; i--) {
    const recorded = inertSiblings[i];
    if (recorded.parentElement === parent) continue;
    recorded.inert = false;
    inertSiblings.splice(i, 1);
  }
  for (const child of Array.from(parent.children)) {
    if (child === el || !child.instanceOf(HTMLElement)) continue;
    if (inertSiblings.includes(child) || child.inert) continue;
    child.inert = true;
    inertSiblings.push(child);
  }
}
