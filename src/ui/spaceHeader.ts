/**
 * The header model, pure (no DOM, no `"obsidian"` import).
 *
 * What the header at the top of the explorer pane shows for a given selection.
 * `SpaceHeaderView` renders what this returns and decides nothing itself, so
 * the rules — All's presentation, the icon fallback, what happens when the
 * selection points at a space that no longer exists — are testable in plain
 * node rather than only in the running app.
 */

import { ALL_ICON, spaceEntries } from "./spaceEntries";
import { isVaultRoot } from "../visibility/folderSpace";

/**
 * Re-exported so the callers keep one name for it. The value now lives in
 * `spaceEntries.ts`, which is the single list the strip, the header and
 * The dropdown all read.
 */
export const ALL_HEADER_ICON = ALL_ICON;

/** Just the fields the header reads. Structural, so no store type leaks in. */
export interface HeaderSpace {
  id: string;
  name: string;
  icon: string;
  color?: string;
  /** A folder space's root. Absent on a curated space. */
  root?: string;
}

interface HeaderModel {
  icon: string;
  label: string;
  /** Undefined for All, and for a space that has no color of its own. */
  color: string | undefined;
  /**
   * The space this header can rename, or null when there is nothing to rename
   * — All, or a selection pointing at a space that is gone. `SpaceHeaderView`
   * makes the label clickable only when this is non-null.
   */
  spaceId: string | null;
  /**
   * What the header's pin says on hover, or null when there is no pin to draw
   * — All, a curated space, or a folder space whose root was never chosen.
   *
   * A composed SENTENCE rather than a name/path/flag triple, because writing
   * it is a decision and this module is where the header's decisions live.
   * `SpaceHeaderView` renders it into an `aria-label` and nothing else:
   * Obsidian draws its own tooltip from that attribute, and a `title` beside
   * it stacks a second, OS-drawn one on top (measured — see `SwitcherView`).
   *
   * The FULL path, not the folder's own name. The pin is a fixed-width icon,
   * so nothing competes with it for the row and there is no reason to abridge
   * the single fact it carries. An earlier design put this text inline, where
   * the basename was all that fit.
   */
  pinnedLabel: string | null;
}

/**
 * The pin's sentence for one space, or null when it has nothing to say.
 *
 * `exists` is the same predicate `spaceRowSummary` (memberList.ts) takes, so
 * the header and the settings list agree about what "missing" means rather
 * than each deciding. Saying nothing for an unchosen root is deliberate: an
 * unset root is stored as `""`/`"/"` rather than dropped, but neither names a
 * folder, so there is no folder to announce.
 */
function pinnedLabelFor(
  space: HeaderSpace | undefined,
  exists: (path: string) => boolean
): string | null {
  const root = space?.root;
  if (typeof root !== "string" || isVaultRoot(root)) return null;
  return exists(root) ? `Pinned to ${root}` : `Pinned to ${root} (missing)`;
}

export function headerModel(
  selection: { kind: "all" } | { kind: "space"; id: string },
  spaces: readonly HeaderSpace[],
  knownIcons: ReadonlySet<string>,
  exists: (path: string) => boolean
): HeaderModel {
  const entries = spaceEntries(spaces, selection, knownIcons);
  // `entries[0]` is always All, so this is the fallback as well as the
  // All case. A selection naming a space that is gone marks nothing active —
  // reachable while a delete is in flight, and from a hand-edited data.json —
  // and resolving it to All shows the truth. Keeping the stale name would
  // label the pane after something that no longer exists, and would offer a
  // rename with no target.
  const active = entries.find((e) => e.active) ?? entries[0];
  // Read off the RESOLVED active entry, not off `selection`: a selection
  // naming a space that is gone falls back to All above, and All has no pin.
  const activeId = active.key.kind === "space" ? active.key.id : null;
  return {
    icon: active.icon,
    label: active.label,
    color: active.color,
    spaceId: activeId,
    pinnedLabel:
      activeId === null ? null : pinnedLabelFor(spaces.find((s) => s.id === activeId), exists),
  };
}
