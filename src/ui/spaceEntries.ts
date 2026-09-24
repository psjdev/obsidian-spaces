/**
 * The one list of switchable destinations: *All*, then every space.
 *
 * Extracted when the dropdown became the THIRD reader of it. Before that
 * the list lived inline in `SwitcherView.render()` and, separately, as
 * `spaceHeader.ts`'s own notion of what *All* looks like — two copies of the
 * same knowledge. The dropdown makes the duplication a functional problem
 * rather than an untidy one: the strip and the dropdown must offer the same
 * spaces in the same order, and independent copies are how they stop doing so.
 *
 * Pure — no DOM, no `"obsidian"` import.
 */

import { renderableIcon } from "./iconPicker";
import type { ActiveSelection } from "../types";
import type { HeaderSpace } from "./spaceHeader";

/** *All*'s icon and label. Named here so nothing else has to know them. */
export const ALL_ICON = "layers";
export const ALL_LABEL = "All";

export interface SpaceEntry {
  /** What to pass to `SpaceController.switchTo`. */
  key: ActiveSelection;
  /** Already through the fallback, so a caller can `setIcon` it directly. */
  icon: string;
  label: string;
  /** Undefined for *All*, and for a space with no color of its own. */
  color: string | undefined;
  active: boolean;
}

/**
 * Definition order, *All* first.
 *
 * When `selection` names a space that no longer exists, NOTHING is marked
 * active — deliberately. The header resolves that case to *All* for display
 *, but a dropdown showing a tick against *All* would claim the user
 * is somewhere they are not; no tick is the honest rendering.
 */
export function spaceEntries(
  spaces: readonly HeaderSpace[],
  selection: ActiveSelection,
  knownIcons: ReadonlySet<string>
): SpaceEntry[] {
  return [
    {
      key: { kind: "all" },
      icon: ALL_ICON,
      label: ALL_LABEL,
      color: undefined,
      active: selection.kind === "all",
    },
    ...spaces.map((s) => ({
      key: { kind: "space", id: s.id } satisfies ActiveSelection,
      icon: renderableIcon(s.icon, knownIcons),
      label: s.name,
      color: s.color,
      active: selection.kind === "space" && selection.id === s.id,
    })),
  ];
}


/**
 * Splits the strip's entries into the one that is PINNED outside the
 * scrolling rail and the ones that scroll inside it.
 *
 * Layout only. `spaceEntries` above still yields *All* first and is untouched,
 * so the header and its dropdown see exactly the list they always did — this
 * is the strip deciding where to mount two of them, not a second notion of
 * what the list is.
 *
 * *All* is found by KIND rather than taken from index 0. It is first today,
 * and relying on that would couple this split to an ordering nothing here
 * enforces; a search cannot pin the wrong space if that ordering ever moves.
 * A list with no *All* in it therefore pins nothing and rails everything,
 * which is the same shape as the setting being off.
 */
export function splitPinnedEntry(
  entries: readonly SpaceEntry[],
  pinAll: boolean
): { pinned: SpaceEntry | null; railed: SpaceEntry[] } {
  if (!pinAll) return { pinned: null, railed: [...entries] };
  const pinned = entries.find((e) => e.key.kind === "all") ?? null;
  if (pinned === null) return { pinned: null, railed: [...entries] };
  return { pinned, railed: entries.filter((e) => e !== pinned) };
}
