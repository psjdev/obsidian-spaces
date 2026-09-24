import { Notice, setIcon } from "obsidian";
import { headerModel } from "./spaceHeader";
import { SEL } from "../explorer/selectors";
import { headerAnchor } from "./headerPlacement";
import { knownIconIds } from "./knownIcons";
import { iconColorFor } from "./spaceIconColor";
import { MAX_SPACE_NAME_LENGTH, normalizeSpaceName } from "./renameSpaceForm";
import { openSpaceSwitcher } from "./SpaceSwitcherPopover";
import type { AnchoredPopover } from "./AnchoredPopover";
import { spaceEntries } from "./spaceEntries";
import type { ActiveSelection } from "../types";
import type { DefinitionStore } from "../definitions/DefinitionStore";
import type { RuntimeStateStore } from "../runtime/RuntimeStateStore";

/**
 * The active space's icon and name at the top of the explorer pane.
 *
 * The counterpart to the switcher strip at the bottom — the strip is where
 * you go somewhere, this is where you are. It decides nothing: `spaceHeader.ts`
 * resolves a selection to an icon, a label, a colour and a renameable id, and
 * this renders what it returns.
 */
export class SpaceHeaderView {
  private el: HTMLElement | null = null;
  /** Kept so `render()` can re-attach after `showSpaceHeader` comes back on. */
  private parent: HTMLElement | null = null;
  /**
   * True between opening the inline editor and committing or cancelling it.
   * `render()` bails while it is set: rebuilding the row mid-edit would
   * destroy the input out from under the caret, and both re-render triggers
   * (a definitions change, an apply) fire during an ordinary rename.
   */
  private editing = false;
  /**
   * The dropdown, while it is open.
   *
   * Held for the same reason `SwitcherView` holds its pickers:
   * `AnchoredPopover` puts four listeners on `document` that only its own
   * `close()` removes, and `destroy()` — reached from `onunload` and from
   * every `mount()` — is the only thing guaranteed to run.
   */
  private popover: AnchoredPopover | null = null;

  constructor(
    private defs: DefinitionStore,
    private runtime: RuntimeStateStore,
    /** `renameSpace`, injected so this view imports no action module. */
    private rename: (id: string, name: string) => Promise<void>,
    /** Injected for the same reason: no controller import here. */
    private switchTo: (key: ActiveSelection) => Promise<void>,
    /**
     * Whether a path names a real folder right now, for the pin's
     * "(missing)". Injected for the same reason as the two above — this view
     * reads no vault of its own.
     */
    private folderExists: (path: string) => boolean
  ) {}

  /**
   * Builds the row and hands off to `render()`, which decides whether it is
   * attached at all — so a mount with the setting off costs one
   * detached element and touches the pane not at all.
   */
  mount(parent: HTMLElement): void {
    this.destroy();
    this.parent = parent;
    const el = parent.ownerDocument.win.createDiv();
    el.className = "spaces-space-header";
    this.el = el;
    this.render();
  }

  /**
   * Directly ABOVE the file tree and BELOW Obsidian's own `.nav-header`
   * — so the host's buttons and search stay where every other vault has them,
   * and the space name reads as a heading for the list it labels rather than a
   * banner over the whole pane.
   *
   * Positioned by finding the tree container rather than by index; see
   * `headerAnchor` for why, and for why a container it cannot place against
   * falls back to appending rather than throwing.
   */
  private attach(): void {
    const parent = this.parent;
    const el = this.el;
    if (!parent || !el) return;
    const anchor = headerAnchor(parent, parent.querySelector(SEL.container));
    if (anchor) parent.insertBefore(el, anchor);
    else parent.appendChild(el);
  }

  destroy(): void {
    // The dropdown is anchored to this row's icon and outlives it
    // otherwise, listeners and all.
    this.popover?.close();
    this.popover = null;
    this.el?.remove();
    this.el = null;
    this.parent = null;
    this.editing = false;
  }

  render(): void {
    const el = this.el;
    if (!el || this.editing) return;

    // DETACHED, not hidden: an element left in the pane is still a
    // sibling for the inert sweep and still a flex child taking part in
    // layout, and `[hidden]`'s `display: none` loses to this class's own
    // `display: flex` anyway.
    //
    // Emptying is housekeeping, not a fix: re-attaching runs the rebuild
    // below, so nothing stale can reach the screen either way — this just
    // declines to hold a dead subtree for as long as the setting is off.
    if (!this.defs.get().settings.showSpaceHeader) {
      el.remove();
      el.replaceChildren();
      this.popover?.closeIfAnchorDetached();
      return;
    }
    if (!el.isConnected) this.attach();

    el.replaceChildren();
    // The icon the dropdown anchors to was a child of the row, so it has
    // just left the document — and a removed node reports that to nobody.
    // Checked here, at the one place that destroys it, rather than from an
    // observer watching `body` for the life of every popover.
    this.popover?.closeIfAnchorDetached();
    const doc = el.ownerDocument;

    const model = headerModel(
      this.runtime.getSelection(),
      this.defs.get().spaces,
      knownIconIds(),
      this.folderExists
    );

    const icon = doc.win.createDiv();
    icon.className = "spaces-space-header-icon";
    setIcon(icon, model.icon);
    // The colour goes on the ICON ALONE, never the row. Tinting the row was
    // the first implementation and it rendered a `#123456` space's header
    // invisible on a dark theme — a space colour is chosen to read as a 16px
    // glyph, not as body text, and half the palette fails contrast as text on
    // one theme or the other. The name stays a themed colour, which is also
    // what Arc does: the icon carries identity, the name stays legible.
    // Removed rather than left stale, since `render()` reuses nothing but the
    // row and an unset property would inherit the previous space's colour.
    const painted = iconColorFor(model.color);
    if (painted) icon.style.color = painted;
    else icon.style.removeProperty("color");
    el.appendChild(icon);

    // The icon switches, the name renames. Wired HERE, above the
    // `spaceId === null` return below, because that return fires in *All* —
    // and *All* is exactly where a way to reach a space matters most. Putting
    // this after it would leave the dropdown silently dead in the one place
    // it is most wanted.
    icon.setAttribute("role", "button");
    icon.setAttribute("tabindex", "0");
    icon.setAttribute("aria-label", "Switch space");
    const openList = (): void => {
      // One at a time, without relying on the capture-phase `mousedown` that
      // normally dismisses the previous one — the keyboard route below fires
      // no pointer event.
      this.popover?.close();
      // Built at click time, not at render time, so the list reflects a space
      // created or renamed since this row was drawn.
      this.popover = openSpaceSwitcher({
        anchor: icon,
        entries: spaceEntries(
          this.defs.get().spaces,
          this.runtime.getSelection(),
          knownIconIds()
        ),
        switchTo: (key) => this.switchTo(key),
      });
    };
    icon.addEventListener("click", openList);
    icon.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openList();
      }
    });

    const label = doc.win.createDiv();
    label.className = "spaces-space-header-name";
    label.textContent = model.label;
    el.appendChild(label);

    // The pin, before the rename wiring below returns early for All.
    //
    // An ICON rather than the folder's name in text, so the space's own name
    // keeps the whole row minus a fixed 16px — a long name was the reason the
    // inline version was dropped. `aria-label` and NOTHING else: Obsidian
    // draws its own tooltip from that attribute, and a `title` beside it
    // stacks a second, OS-drawn one on top (measured in SwitcherView).
    //
    // Not focusable and not a control: it annotates the row, it does not act.
    if (this.defs.get().settings.showPinnedFolder && model.pinnedLabel !== null) {
      const pin = doc.win.createDiv();
      pin.className = "spaces-space-header-pin";
      setIcon(pin, "pin");
      pin.setAttribute("aria-label", model.pinnedLabel);
      el.appendChild(pin);
    }

    const spaceId = model.spaceId;
    // Null for All, and for a selection naming a space that is gone — neither
    // has a name to change. Without an id the label stays inert text
    // rather than a control that would fail on click.
    if (spaceId === null) return;

    label.setAttribute("role", "button");
    label.setAttribute("tabindex", "0");
    // The aria-label carries the affordance too; a `title` beside it would
    // stack a second tooltip on Obsidian's own.
    label.setAttribute("aria-label", `Rename ${model.label}`);
    const begin = (): void => this.beginEdit(el, label, spaceId, model.label);
    label.addEventListener("click", begin);
    label.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        begin();
      }
    });
  }

  /**
   * Swaps the label for an input, in the manner of Obsidian's own inline
   * rename in the file explorer: Enter and blur commit, Escape cancels.
   */
  private beginEdit(
    row: HTMLElement,
    label: HTMLElement,
    spaceId: string,
    current: string
  ): void {
    this.editing = true;

    const input = row.ownerDocument.win.createEl("input");
    input.type = "text";
    input.className = "spaces-space-header-input";
    input.setAttribute("aria-label", "Space name");
    // Caps typing and paste at the schema's limit, so the common route to an
    // invalid name never happens; `normalizeSpaceName` still has the last word.
    input.maxLength = MAX_SPACE_NAME_LENGTH;
    input.value = current;
    label.replaceWith(input);
    input.focus();
    input.select();

    // Enter removes the input, which fires `blur`, which would commit a second
    // time against an element already gone. One latch closes both routes.
    let settled = false;
    const finish = (commit: boolean): void => {
      if (settled) return;
      settled = true;
      this.editing = false;

      // Null is a cancel, never an error. Blur commits, so a click
      // elsewhere with an emptied field must not be able to destroy a name.
      const next = commit ? normalizeSpaceName(input.value) : null;
      if (next === null || next === current) {
        // Nothing to write, so nothing will call back — restore the label here
        // or the input stays on screen.
        this.render();
        return;
      }
      void this.rename(spaceId, next).catch((e: unknown) => {
        new Notice(`Spaces: could not rename the space (${String(e)})`);
        // The definitions never changed, so no subscriber will repaint this.
        this.render();
      });
      // A successful write reaches `render()` through the definitions
      // subscription, which is also what repaints the switcher — one store,
      // two readers, rather than this view pushing to the other.
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        // Stopped as well as prevented: Escape in the sidebar reaches
        // Obsidian's own handlers, and cancelling a rename should not also
        // close whatever is behind it.
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }
}
