import { AnchoredPopover } from "./AnchoredPopover";
import { appendSpaceIcon } from "./spaceRow";
import type { SpaceEntry } from "./spaceEntries";
import type { ActiveSelection } from "../types";

/**
 * Click the space header's icon to get the list of spaces and switch
 * from it.
 *
 * A second route to the same destination as the strip — the strip is a row
 * of glyphs you learn, this is a list you can read. It decides nothing: the
 * entries come from `spaceEntries.ts`, which is also what the strip renders,
 * so the two can never offer different spaces or a different order.
 *
 * Positioning and dismissal come from `AnchoredPopover`, like the pickers.
 * It opens BELOW the header without asking: `reposition()`
 * prefers above, and the header sits at the top of the pane where there is no
 * room, so it falls through to below the anchor.
 */
interface SpaceSwitcherDeps {
  anchor: HTMLElement;
  entries: readonly SpaceEntry[];
  /**
   * The Appearance toggle. A snapshot like `entries` beside it, since the
   * popover is built fresh on every click and cannot outlive a change.
   */
  useThemeIconColor: boolean;
  /** Rejects if the switch fails; the popover is already closed by then. */
  switchTo(key: ActiveSelection): Promise<void>;
}

/** Returns the popover so its opener can close it (see `AnchoredPopover`). */
export function openSpaceSwitcher(deps: SpaceSwitcherDeps): AnchoredPopover {
  const popover = new AnchoredPopover({
    anchor: deps.anchor,
    className: "spaces-spaces-popover",
    ariaLabel: "Switch space",
    build: (root, pop) => {
      const doc = root.ownerDocument;
      const list = doc.win.createDiv();
      list.className = "spaces-spaces-list";
      list.setAttribute("role", "listbox");

      const rows: HTMLElement[] = [];

      for (const entry of deps.entries) {
        const row = doc.win.createDiv();
        row.className = "spaces-spaces-row";
        row.setAttribute("role", "option");
        row.setAttribute("tabindex", "0");
        row.setAttribute("aria-selected", String(entry.active));
        if (entry.active) {
          row.classList.add("is-active");
          row.setAttribute("aria-current", "true");
        }

        appendSpaceIcon(row, entry, deps.useThemeIconColor);

        const name = doc.win.createDiv();
        name.className = "spaces-spaces-row-name";
        name.textContent = entry.label;
        row.appendChild(name);

        const pick = (): void => {
          // Closed FIRST, so a second click cannot land on a row that is still
          // there while the switch is in flight. The strip needs its
          // `pendingKey` guard because its buttons survive the click; these do
          // not.
          pop.close();
          void deps.switchTo(entry.key).catch((e: unknown) => {
            console.error("Spaces: switching space failed", e);
          });
        };
        row.addEventListener("click", pick);
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick();
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const i = rows.indexOf(row);
            // Wraps: a list you drive with arrows should not dead-end at
            // either edge.
            const next = (i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
            rows[next]?.focus();
          }
        });

        rows.push(row);
        list.appendChild(row);
      }

      root.appendChild(list);
      // The active row, so arrows start from where you are rather than the top.
      (rows.find((r) => r.classList.contains("is-active")) ?? rows[0])?.focus();
    },
  });

  popover.open();
  return popover;
}
