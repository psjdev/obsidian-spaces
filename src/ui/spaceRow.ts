import { setIcon } from "obsidian";
import type { SpaceEntry } from "./spaceEntries";

/**
 * The icon half of a space row, wherever one is drawn.
 *
 * Extracted because there is now more than one list of spaces outside the
 * strip -- the header's popover and the quick switcher -- and the rule below
 * is the kind that drifts silently once it is written twice.
 */

/**
 * Appends the entry's icon, in the entry's colour.
 *
 * **The colour goes on the ICON, never the text.** Measured: a `#123456`
 * space is invisible as body text on a dark theme. A name stays in the
 * theme's own foreground colour so it is always readable, and the colour
 * does its identifying work on the glyph beside it.
 *
 * Returns the icon element so a caller can class or measure it.
 */
export function appendSpaceIcon(row: HTMLElement, entry: SpaceEntry): HTMLElement {
  const icon = row.ownerDocument.win.createDiv();
  icon.className = "spaces-spaces-row-icon";
  setIcon(icon, entry.icon);
  if (entry.color) icon.style.color = entry.color;
  row.appendChild(icon);
  return icon;
}
