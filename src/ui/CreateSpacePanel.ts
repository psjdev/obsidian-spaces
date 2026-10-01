import { Notice, prepareFuzzySearch, renderResults, setIcon, type SearchResult } from "obsidian";
import { openIconPicker } from "./IconPickerPopover";
import { openColorPicker } from "./ColorPickerPopover";
import type { AnchoredPopover } from "./AnchoredPopover";
import { PALETTE, PALETTE_NAMES, type CreateSpaceOptions } from "../actions/spaceLifecycle";
import {
  emptyForm,
  MAX_SPACE_NAME_LENGTH,
  collapseMode,
  isFolderForm,
  modeHoldsChoice,
  setFolderMode,
  toggleItem,
  validateForm,
  setRoot,
  toCreateOptions,
  type CreateFormState,
  type VaultSource,
} from "./createSpaceForm";
import type { FormFault } from "./createSpaceForm";
import { alignmentGap } from "./ribbonAlign";
import { iconColorFor } from "./spaceIconColor";
import { ancestorsOf, buildVaultTree, visibleRows, type VaultNode } from "./vaultTree";
import {
  DEFAULT_PICKER_MODE,
  ITEMS_SIGIL,
  readModeSigil,
  TAG_SIGIL,
  type PickerMode,
} from "./pickerFilter";
import { coveringFolder } from "../definitions/membership";
import { countPicked, pickedSummary, readPickerBody } from "./pickerBody";
import { previewPaths } from "./memberPreview";
import { fuzzyTagCandidates, type TagHit, type TagSource } from "./tagCandidates";
import { countTagRows, tagCountLabel } from "./tagRowCounts";
import type { TagIndex } from "../visibility/TagIndex";
import type { MemberEntry } from "../types";

import {
  isStillCovering as isStillCoveringPure,
  resyncInertSiblings as resyncInertSiblingsPure,
} from "./panelCoverage";
import { SEL } from "../explorer/selectors";

/**
 * The title-to-field gap, in px: the panel's own design value, and how far a
 * ribbon icon may pull it.
 *
 * The tolerance is small deliberately: a theme that shifted the ribbon down
 * 34px stretched the visible gap from 32px to 58px. Six pixels is enough to
 * click into alignment when an icon is nearly there, and no more.
 */
/**
 * How many rows the item picker will draw at once.
 *
 * Measured on a 20,000-note vault: cost tracks the row count almost exactly,
 * about 12 rows per millisecond, and a single "a" matched 18,954 rows — over a
 * second of work for one keystroke, repeated on the next. `buildVaultTree` was
 * 25 ms of that, so the rows are the cost and nothing else is worth capping.
 *
 * 200 keeps a keystroke near 20 ms while still filling a tall pane several
 * times over. `visibleRows` still computes every match, so the count the
 * overflow row reports is exact rather than an estimate.
 */
const MAX_PICKER_ROWS = 200;

/**
 * How long the sigil stays in the filter box before the box takes it back, in
 * ms.
 *
 * Long enough to read as the box reacting, short enough that it cannot be
 * mistaken for a character that failed to delete. Nothing waits on it: the
 * query is sigil-free from the keystroke onwards, so this governs how the box
 * LOOKS and nothing else.
 */
const SIGIL_FLASH_MS = 120;

const DESIGN_TITLE_GAP = 22;
const TITLE_GAP_TOLERANCE = 6;

/**
 * Shared by the constructor and every `mount()` so a fresh open always starts
 * from the same rule — `deps.root`, when given, seeds a folder-space form via
 * the same `setRoot` the root row's own picker calls.
 */
function initialState(deps: Pick<CreateSpacePanelDeps, "defaultColor" | "root">): CreateFormState {
  const empty = emptyForm(deps.defaultColor);
  if (deps.root === undefined) return empty;
  // `isFolderForm`, not merely "a root was passed". `""` and `"/"` are the
  // missing-root state; ticking the mode for one of those opens the panel with
  // folder mode on, nothing chosen and BOTH buttons drawn unpressed — then
  // refuses Create naming a button that looks deselected.
  if (!isFolderForm(setRoot(empty, deps.root))) return empty;
  // Tick the box as well as setting the root: arriving from "Create space from
  // this folder" is a decision already made, and leaving the tick off opens
  // the panel showing the plain-space form with an invisible selection behind
  // it.
  return setFolderMode(setRoot(empty, deps.root), true);
}

export interface CreateSpacePanelDeps {
  /**
   * Every file and folder the picker can offer. Named `folders` from when it
   * was folders alone; the tree shows both now (see `VaultSource`).
   */
  folders: VaultSource;
  /**
   * Every tag the picker can offer, behind the `#` sigil in the filter box.
   * A source rather than an `App`, for the reason `TagSuggest` takes one: the
   * single private call that answers this stays in `nativeTagCounts.ts`, and
   * `knownTags()` returning null is the expected shape of a future Obsidian
   * that no longer answers it.
   */
  tags: TagSource;
  /**
   * The one tag index, reached rather than built, so each row in the `#` list
   * can say how many notes its tag currently brings in.
   *
   * A function rather than the index, for the reason `SettingsTab` documents:
   * the index is a SNAPSHOT that the coalescer's flush and every metadata
   * change replace, so a captured one would answer from the vault as it was
   * when this panel opened. Building one here instead would walk the vault
   * twice, once for this panel and once for the engine that already has one.
   */
  tagIndex: () => TagIndex;
  /**
   * The user's saved custom colors, and the way to persist a new one — the
   * theme button opens the same color popover the space strip uses, and that
   * popover can mint one. Threaded as deps so the panel stays ignorant of
   * `DefinitionStore`.
   */
  customColors: readonly string[];
  saveCustomColors(customs: string[]): Promise<void>;
  /**
   * The color the form starts on, and therefore the swatch the popover shows
   * selected when it opens. `main.ts` passes `DEFAULT_SPACE_COLOR`, which is
   * `PALETTE[0]` and so the FIRST swatch in the popover's grid: the popover
   * opens with its selection on the color the space actually has. Color is
   * opt-in, and the palette rotation remains `createSpace`'s fallback for a
   * caller that supplies none at all.
   *
   * Re-read on every `mount()`: captured once at construction, so a reused
   * instance would show a stale swatch after the first create.
   */
  defaultColor: string;
  /**
   * The Appearance toggle, so the icon preview predicts what the strip will
   * draw. A function rather than a value, because this panel is the one that
   * documents the reuse hazard above: a captured boolean would go stale on a
   * second open of the same instance.
   */
  useThemeIconColor: () => boolean;
  /**
   * Pre-fills the form as a folder space rooted here; `undefined` opens the
   * ordinary curated form. Read once per `mount()` alongside `defaultColor`,
   * so a reused instance does not seed a later, unrelated open with the first
   * open's root.
   */
  root?: string;
  onSubmit(name: string, opts: CreateSpaceOptions): Promise<void>;
  onClose(): void;
}

/**
 * Lucide `square-dashed` + the plus from Lucide `square-plus`, drawn as one
 * glyph: the "no icon chosen yet" placeholder in the create panel.
 *
 * The path data is read out of Obsidian 1.13.7's own icon set, so this is
 * pixel-wise a Lucide icon. The plus is `square-plus`'s inset 8-16 form, NOT
 * bare `plus` (which spans 5-19): a full-width plus inside the dashed border
 * leaves 2px of clearance and reads as a collision. Once Obsidian bundles a
 * `square-dashed-plus`, `paintIconButton` can drop to a `setIcon` call.
 */
const PLACEHOLDER_PATHS = [
  // square-dashed: four rounded corners, then the eight edge dashes
  "M5 3a2 2 0 0 0-2 2",
  "M19 3a2 2 0 0 1 2 2",
  "M21 19a2 2 0 0 1-2 2",
  "M5 21a2 2 0 0 1-2-2",
  "M9 3h1",
  "M9 21h1",
  "M14 3h1",
  "M14 21h1",
  "M3 9v1",
  "M21 9v1",
  "M3 14v1",
  "M21 14v1",
  // square-plus's plus
  "M8 12h8",
  "M12 8v8",
] as const;

/**
 * The Arc-style "Create a Space" overlay. One owned element,
 * mount/destroy, shaped like SwitcherView. Holds a single `CreateFormState`
 * and only ever replaces it through createSpaceForm.ts's functions — this
 * class renders and wires DOM events, and must not decide anything those
 * functions already decide (validation, defaults, ordering, dedup).
 */
export class CreateSpacePanel {
  private el: HTMLElement | null = null;
  /**
   * Every sibling of `el` under `mount()`'s `parent` that we set `inert` on —
   * recorded so `destroy()` clears exactly these. Inerting only
   * `.nav-files-container` leaves the switcher strip and the native
   * `.nav-header` tabbable behind an opaque overlay, where Shift+Tab or Enter
   * could switch spaces or create a note from behind the panel. Every sibling
   * the panel covers must be inert, with a re-sync obligation on switcher
   * re-mount.
   */
  private inertSiblings: HTMLElement[] = [];
  /**
   * `.nav-files-container` as found under `mount()`'s `parent` at the most
   * recent successful mount, which `isStillCovering()` compares against the
   * container `bindExplorer()` finds NOW — otherwise a `changeLayout()`
   * rebuild leaves the freshly-built tree, never scanned into
   * `inertSiblings`, live and tabbable behind the overlay. Cleared in
   * `destroy()`.
   */
  private mountedContainer: HTMLElement | null = null;
  /**
   * The document the Escape listener is attached to. Kept separately
   * from `el` because it must still be reachable to
   * unbind in `destroy()` even after `el` itself has been torn down.
   */
  private doc: Document | null = null;
  private state: CreateFormState;
  private nameInput: HTMLInputElement | null = null;

  /**
   * The name row, kept so `alignToRibbon()` can measure where it landed.
   * Cleared in `destroy()` beside `nameInput`/`createBtn`.
   */
  private nameRow: HTMLElement | null = null;

  /** The folder tree's container, redrawn in place by `renderItemTree()`. */
  private treeEl: HTMLElement | null = null;

  /**
   * The row pinned under the window's list, kept so `renderSummary()` can
   * redraw its words in place: picking must not rebuild the window under the
   * pointer that just clicked in it.
   */
  private summaryEl: HTMLElement | null = null;

  /** The filter box, kept so the sigil shortcut can retitle its placeholder. */
  private filterEl: HTMLInputElement | null = null;

  /**
   * The sigil now showing in the filter box but NOT part of the query, or
   * null when nothing is flashing.
   *
   * The box has to show the character for a moment, because a keystroke that
   * disappears at the instant it is pressed reads as a dropped key rather than
   * as the window snapping over. It must not be in the query while it shows.
   *
   * Held as state rather than stripped by the timer alone, and that is what
   * makes typing at speed safe: every character after it lands in the box
   * normally and in the order the keyboard produced it, `itemFilter` is taken
   * through `queryFrom` so the list never sees the sigil, and the flash ends
   * by removing exactly the one character it put there.
   */
  private sigilFlash: string | null = null;

  /**
   * Cancels the pending flash, or null. A closure rather than a bare handle so
   * the `clearTimeout` runs against whatever set it, and so teardown has one
   * thing to call.
   */
  private sigilFlashOff: (() => void) | null = null;

  /**
   * The Items and Tags buttons, kept so a mode reached by the sigil can press
   * the right one without redrawing the pair.
   */
  private pickerModeEls = new Map<PickerMode, HTMLElement>();

  /**
   * Which body the explorer window is showing.
   *
   * Held here rather than read back out of the filter text: the buttons are
   * the thing that holds the mode now, and the sigil presses a button rather
   * than leaving a mark in the box. Folder mode overrules it, which is
   * `readPickerBody`'s job rather than this field's.
   */
  private pickerMode: PickerMode = DEFAULT_PICKER_MODE;

  /**
   * The vault as a tree, kept while the picker stays open.
   *
   * Reading and rebuilding it is about 40 ms on a 20,000-note vault, and it
   * used to run on every keystroke, caret and row click. Rebuilt whenever the
   * panel re-renders — opening the picker, switching mode — so a filtering
   * session sees one snapshot and a newly created file appears the next time
   * the picker is opened rather than mid-keystroke. That is the trade: a few
   * seconds of staleness for a keystroke that does not stall.
   */
  private vaultTree: VaultNode[] | null = null;

  /**
   * The picker's own state, deliberately NOT in `CreateFormState`: how the
   * user is looking for something is not part of the space being made. A
   * cancelled panel should forget it, and `toCreateOptions` never see it.
   */
  private itemsOpen = false;

  /**
   * What the last failed Create pointed at, or `null`. Panel state: it is
   * about this attempt, not about the space being made.
   */
  private fault: FormFault | null = null;

  private itemFilter = "";

  private expandedFolders = new Set<string>();

  /**
   * Re-aligns when the window changes size, because the panel's top edge moves
   * with the workspace layout above it. Raw `addEventListener` with an
   * explicit removal in `destroy()`: this class is not a `Component`, so it
   * has no `registerDomEvent`, and the target (`defaultView`) outlives it.
   */
  private readonly onViewResize = (): void => this.alignToRibbon();
  private createBtn: HTMLButtonElement | null = null;
  /** Guards against double-submit while `onSubmit`'s promise is in flight. */
  private submitting = false;
  


  /**
   * The icon picker, while it is open. This panel re-renders by replacing
   * every node, so `destroy()` must be able to take down a popover whose
   * anchor button no longer exists: without the retained handle it leaks its
   * suggester once the anchor is gone.
   */
  private pickerPopover: AnchoredPopover | null = null;

  /**
   * The custom colors as they stand now — seeded from `deps` and updated
   * whenever this panel mints one, because `deps.customColors` is a snapshot
   * taken at construction and never written back to.
   */
  private customColors: readonly string[];



  /**
   * Escape closes. Bound once as an instance field so `destroy()` can remove
   * the exact listener `mount()` added, and attached to `mount()`'s document
   * rather than to `el`: every `render()` can destroy the element holding
   * focus, and a keydown at a now-detached target would never reach a
   * listener that only lived on `el`.
   *
   * Narrowed to three conditions, or Escape in the editor pane discards the
   * whole form. Never act twice on a `defaultPrevented` event. When one of our
   * own popovers is open, Escape closes ONLY that (`AnchoredPopover` handles
   * its own). Otherwise act only if the target is inside the panel or is
   * `body`/`documentElement` — once focus genuinely has nowhere to go
   * `target` lands there, and dropping that case makes Escape unreachable.
   */
  private readonly onDocKeydown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // Escape-to-dismiss-a-picker must not close the whole form and throw away
    // the name already typed; `AnchoredPopover` closes itself.
    if (this.pickerPopover?.isOpen) return;
    const target = e.target;
    const inPanel = target instanceof Node && (this.el?.contains(target) ?? false);
    const isFallbackTarget = target === this.doc?.body || target === this.doc?.documentElement;
    if (!inPanel && !isFallbackTarget) return;
    e.preventDefault();
    this.close();
  };

  constructor(private readonly deps: CreateSpacePanelDeps) {
    this.state = initialState(deps);
    this.customColors = deps.customColors;
    this.resetPickerState();
  }

  /**
   * Puts the picker back to how a fresh open should find it.
   *
   * Shared by the constructor and `mount()` for the same reason `state` and
   * `submitting` are reset in both: a reused instance must not re-open showing
   * the last session's picker, filter text, expansion set or red mark over a
   * form that has just been emptied.
   */
  private resetPickerState(): void {
    this.vaultTree = null;
    this.fault = null;
    this.itemFilter = "";
    this.expandedFolders = new Set<string>();
    // Arriving from "Create space from this folder": the root is already set,
    // so open the branch containing it rather than showing a collapsed tree
    // with the selection hidden inside it...
    for (const ancestor of ancestorsOf(this.state.root)) this.expandedFolders.add(ancestor);
    // ...and with the picker open, or the selection would be hidden behind a
    // closed button on arrival.
    this.itemsOpen = isFolderForm(this.state);
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  /**
   * Whether the panel is still covering the SAME container it inerted, not
   * merely still parented under the same ancestor: parent identity stays true
   * across a `changeLayout()` rebuild, which destroys and recreates
   * `.nav-files-container` while `containerEl` (`parent`) persists.
   * `container` is whatever `bindExplorer()` finds under `parent` right now —
   * no second query here.
   *
   * The comparison lives in `panelCoverage.ts`, a plain-DOM module, so it is
   * directly testable — see `tests/panelCoverage.test.ts`.
   */
  isStillCovering(parent: HTMLElement, container: HTMLElement | null): boolean {
    return isStillCoveringPure(this.el, this.mountedContainer, parent, container);
  }

  /**
   * Called by `bindExplorer()` after `switcher.mount()`, only when the panel
   * is KEPT open across a layout-change. `SwitcherView` destroys and recreates
   * its own element on every `mount()`, so the switcher strip is always
   * rebuilt underneath the panel and `mount()`'s one-time inert loop never
   * sees the new node. Reconciles `inertSiblings` against `parent`'s CURRENT
   * children: drops and un-inerts any recorded sibling no longer parented
   * there, and inerts and records any current sibling not already recorded
   * and not already `inert` for some unrelated reason (never take ownership
   * of an `inert` we did not set). Mutated in place.
   */
  resyncInertSiblings(parent: HTMLElement): void {
    resyncInertSiblingsPure(this.el, this.inertSiblings, parent);
  }

  mount(parent: HTMLElement): void {
    this.destroy();
    // A fresh form and a cleared submit flag on every mount, not just at
    // construction: without this one successful create leaves `submitting ===
    // true` forever (nothing else clears it outside the failure branch) and
    // the next open shows a disabled "Creating…" button pre-filled with the
    // last submission.
    this.submitting = false;
    this.state = initialState(this.deps);
    this.resetPickerState();

    // The sibling relationship is load-bearing — it is the entire reason
    // ExplorerAdapter's health check cannot fire on account of this feature —
    // so it is asserted. A missing container, or a `parent` that IS (or is
    // nested inside) `.nav-files-container`, would make the panel a CHILD of
    // the tree instead of its sibling: a programming error in the caller, not
    // a state to degrade through.
    const container = parent.querySelector<HTMLElement>(SEL.container);
    if (!container || parent.closest(SEL.container)) {
      throw new Error(
        `Spaces: CreateSpacePanel.mount() expects the pane's containerEl ` +
          `(an ancestor of ${SEL.container}) as \`parent\` — got an element ` +
          `that is ${SEL.container} itself, nested inside it, or has no ` +
          `${SEL.container} descendant at all.`
      );
    }
    // Recorded so isStillCovering() can tell a later changeLayout() rebuild (a
    // NEW node here) apart from a no-op layout-change (the SAME node).
    this.mountedContainer = container;

    try {
      const el = parent.ownerDocument.win.createDiv();
      el.className = "spaces-create-panel";
      parent.appendChild(el);
      this.el = el;

      // Every OTHER child of `parent` must go inert — not just
      // `.nav-files-container` — so the switcher strip and the native
      // nav-header stop being tabbable behind the overlay too. Record exactly
      // which elements we touch, so `destroy()` never clears an `inert`
      // someone else set.
      for (const child of Array.from(parent.children)) {
        if (child === el || !child.instanceOf(HTMLElement) || child.inert) continue;
        child.inert = true;
        this.inertSiblings.push(child);
      }

      // On `parent`'s document, not on `el` — see the field comment on
      // `onDocKeydown`.
      //
      // The project requires every listener go through `registerDomEvent`;
      // this one cannot — `CreateSpacePanel` is not a `Component`. What
      // discharges the rule instead: this `addEventListener` is always paired
      // with exactly one `removeEventListener` in `destroy()`, on the same
      // `this.doc` reference, and `mount()` always calls `destroy()` first.
      this.doc = parent.ownerDocument;
      this.doc.addEventListener("keydown", this.onDocKeydown);
      this.doc.defaultView?.addEventListener("resize", this.onViewResize);
      this.render();
      this.nameInput?.focus();
    } catch (e) {
      // Inert must be unwound on every exit path, including a throw
      // during construction — never leave the tree stuck non-interactive.
      this.destroy();
      throw e;
    }
  }

  destroy(): void {
    // Unconditional and first: whatever else in this method could throw, the
    // host mutation comes off. Pop each element out of the record AS its
    // `inert` is cleared — clearing the record only after the whole loop
    // finishes would leave every later sibling `inert = true` with no
    // reference left to retry if an earlier iteration threw.
    while (this.inertSiblings.length > 0) {
      const sibling = this.inertSiblings.pop()!;
      sibling.inert = false;
    }
    this.mountedContainer = null;
    this.doc?.removeEventListener("keydown", this.onDocKeydown);
    this.doc?.defaultView?.removeEventListener("resize", this.onViewResize);
    this.doc = null;
    this.el?.remove();
    this.el = null;
    this.nameInput = null;
    this.nameRow = null;
    this.createBtn = null;
    // A handle left running would reach for a filter box that is no longer
    // in any document.
    this.cancelSigilFlash();
    // After `el.remove()`, not before: this call is unguarded, and a throw
    // here must not leave our own element still attached, contradicting this
    // method's own "teardown comes off first" ordering above. Nothing above
    // this line can throw, so everything this class owns is already torn down
    // by the time this can.
    this.closePicker();
  }

  /**
   * Idempotent: `renderInner()` and `destroy()` both call it unconditionally.
   * ONE field serves both pickers, so chaining icon into color cannot leave
   * two popovers open or drop the handle to the first.
   */
  private closePicker(): void {
    this.pickerPopover?.close();
    this.pickerPopover = null;
  }

  /**
   * The icon picker, opened from the button beside the name.
   *
   * Deliberately NOT chained into the color picker: auto-opening a second
   * popover the moment the first closed reads as jarring — the content
   * changing under the cursor is itself the jolt, however the box behaves.
   */
  private openIconPickerFor(anchor: HTMLElement): void {
    this.closePicker();
    this.pickerPopover = openIconPicker(
      anchor,
      this.state.icon,
      async (icon) => {
        // Form state only: no space exists yet, so persisting anything here
        // would be creating one behind the user's back.
        this.state = { ...this.state, icon };
        this.closePicker();
        this.renderInner();
      },
      // Below, for the theme button's reason and more so: this one sits in the
      // name row, so `above` would put the grid over the panel's title.
      "below"
    );
  }

  /**
   * The theme picker — the same color popover the space strip uses.
   *
   * Offered, never required: `validateForm` ignores color exactly as it
   * ignores the icon, so dismissing this keeps the rotating default.
   */
  private openThemePicker(anchor: HTMLElement): void {
    // Both openers close first, so `pickerPopover` is never overwritten while
    // it still holds a live popover. A mouse could not reach that state —
    // `AnchoredPopover`'s capture-phase mousedown dismisses the old one before
    // the click lands — but Enter on a focused button fires no mousedown, so
    // keyboard users could leave an orphan in `document.body` with its
    // document listeners still attached.
    this.closePicker();
    this.pickerPopover = openColorPicker({
      anchor,
      // Below: this button sits near the top of the pane, and above would put
      // the popover between it and the panel's title.
      placement: "below",
      current: this.state.color,
      customs: this.customColors,
      // Form state, like the icon: no space exists yet to write a color to.
      apply: async (color) => {
        this.state = { ...this.state, color };
        this.closePicker();
        this.renderInner();
      },
      // A custom color IS persisted: it belongs to the user's settings, not
      // to the space being created, so minting one and losing it when this
      // panel closes would be the surprising behaviour.
      saveCustoms: (customs) => {
        // Keep our own copy in step with what we just persisted: `deps` holds
        // the snapshot taken when the panel was constructed, so without this a
        // color minted here vanished from the grid the moment the picker was
        // reopened.
        this.customColors = [...customs];
        return this.deps.saveCustomColors(customs);
      },
    });
  }

  /**
   * Draws the icon button for the current state: the chosen icon, or — while
   * `state.icon` is `""` — a placeholder.
   *
   * The placeholder is our own SVG rather than a Lucide id: every real icon
   * reads as a choice already made. Drawn in `currentColor` so the stylesheet
   * owns the color (no hardcoded values — see `styles.css`).
   */
  private paintIconButton(btn: HTMLElement): void {
    const chosen = this.state.icon !== "";
    btn.classList.toggle("is-empty", !chosen);
    btn.setAttribute(
      "aria-label",
      chosen ? `Space icon: ${this.state.icon}. Choose a different one` : "Choose an icon"
    );
    if (chosen) {
      setIcon(btn, this.state.icon);
      // Only once an icon is chosen: the dashed placeholder is a prompt rather
      // than a preview, and coloring it would claim a choice not yet made.
      // Through `iconColorFor`, so the preview predicts the result. Painting
      // the neutral swatch here would show grey for a space that will render
      // in the theme's icon color everywhere else.
      const painted = iconColorFor(this.state.color, this.deps.useThemeIconColor());
      if (painted) btn.style.color = painted;
      else btn.style.removeProperty("color");
      return;
    }
    // Back to the stylesheet's muted grey. An inline color left over from a
    // previously chosen icon would out-specify `.is-empty` and leave the
    // placeholder wearing it.
    btn.style.removeProperty("color");
    const doc = btn.ownerDocument;
    const NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(NS, "svg");
    // Matches what `setIcon` emits, so the placeholder and a real icon are
    // styled and sized by the same rules.
    svg.setAttribute("class", "svg-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (const d of PLACEHOLDER_PATHS) {
      const path = doc.createElementNS(NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    btn.replaceChildren(svg);
  }

  /**
   * Escape / Cancel / a successful Create all converge here. Public
   * so a `layout-change` handler can close the panel
   * without reaching for `destroy()`, which skips `onClose()` and would
   * leave `main.ts`'s own reference stale.
   */
  close(): void {
    this.destroy();
    this.deps.onClose();
  }

  /**
   * Wrapped once here, so every call site is covered. `renderInner` opens
   * with `el.replaceChildren()`, so an unguarded throw partway through leaves
   * an empty absolutely-positioned box with `inert` never unwound and Escape
   * unreachable — a covered, unusable tree with no way out.
   */
  private render(): void {
    // Captured BEFORE `renderInner()` wipes the DOM
    // (`el.replaceChildren()`). On the very first render (from `mount()`)
    // `this.el` has no children, so this finds nothing and `restoreFocus` is a
    // no-op — `mount()`'s own `nameInput.focus()` supplies the initial focus.
    const focus = this.captureFocus();
    try {
      this.renderInner();
      this.restoreFocus(focus);
    } catch (e) {
      console.error(
        "Spaces: create-space panel failed to render; closing rather than leaving a stuck pane",
        e
      );
      // Guarded for the same reason handleSubmit's close() is: this catch
      // exists to return a working pane, and letting a throwing
      // deps.onClose() escape it defeats that. The pane is already released
      // by destroy() inside close().
      try {
        this.close();
      } catch (closeError) {
        console.error("Spaces: onClose threw while closing a failed render", closeError);
      }
    }
  }

  /**
   * Every state mutation re-renders (`el.replaceChildren()` + full rebuild),
   * which drops focus to `this.doc.body` and would break an otherwise fully
   * keyboard-operable form. Focus is identified by the `data-focus-key`
   * stamped on every focusable control in `renderInner()` below — stable
   * ACROSS a re-render because it is a value, never node identity, since
   * every node is replaced. Returns `null` when focus is not inside the panel.
   */
  private captureFocus(): { key: string; selStart: number | null; selEnd: number | null } | null {
    const active = this.doc?.activeElement;
    if (!(active instanceof HTMLElement) || !this.el?.contains(active)) return null;
    const key = active.dataset.focusKey;
    if (!key) return null;
    const isText = active.instanceOf(HTMLInputElement) && active.type === "text";
    return {
      key,
      selStart: isText ? active.selectionStart : null,
      selEnd: isText ? active.selectionEnd : null,
    };
  }

  /**
   * Counterpart to `captureFocus()`. Looks up the freshly-rendered control
   * carrying the same `data-focus-key` (not a saved node reference — the old
   * one is gone) and refocuses it, restoring caret position for a text input.
   * A `key` with no match after the render is left alone.
   */
  private restoreFocus(
    captured: { key: string; selStart: number | null; selEnd: number | null } | null
  ): void {
    if (!captured || !this.el) return;
    for (const el of Array.from(this.el.querySelectorAll<HTMLElement>("[data-focus-key]"))) {
      if (el.dataset.focusKey !== captured.key) continue;
      el.focus();
      if (el.instanceOf(HTMLInputElement) && captured.selStart !== null) {
        el.setSelectionRange(captured.selStart, captured.selEnd ?? captured.selStart);
      }
      return;
    }
  }

  private renderInner(): void {
    // A full re-render is the point at which the vault is read again: opening
    // the picker, switching mode, or any state change that rebuilds the panel.
    this.vaultTree = null;
    // The box the sigil is showing in is about to be discarded, and the one
    // that replaces it is seeded from `itemFilter`, which never held the
    // sigil.
    this.cancelSigilFlash();
    const el = this.el;
    if (!el) return;
    const doc = el.ownerDocument;
    // The picker is anchored to a button `replaceChildren()` is about to
    // discard. Closing first keeps it from floating over a panel that no
    // longer contains its anchor.
    this.closePicker();
    el.replaceChildren();

    const title = doc.win.createDiv();
    title.className = "spaces-create-title";
    title.textContent = "Create a space";
    el.appendChild(title);

    // --- Name ---
    const nameRow = doc.win.createDiv();
    nameRow.className = "spaces-create-row";

    // The icon lives beside the name rather than in a row of its own: it is
    // one value, and a full-width shelf of presets spent a whole row on the
    // least important field. `""` means unchosen (createSpaceForm.ts).
    const iconBtn = doc.win.createDiv();
    iconBtn.className = "spaces-create-iconbtn";
    iconBtn.setAttribute("role", "button");
    iconBtn.tabIndex = 0;
    // Stable across a re-render, like every other control here — node identity
    // is not, because each render replaces every node. See `captureFocus()`.
    iconBtn.dataset.focusKey = "icon";
    this.paintIconButton(iconBtn);
    const openPicker = (): void => this.openIconPickerFor(iconBtn);
    iconBtn.addEventListener("click", openPicker);
    iconBtn.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      // A div with role=button does not activate on Enter/Space by itself.
      ev.preventDefault();
      openPicker();
    });
    nameRow.appendChild(iconBtn);

    const nameInput = doc.win.createEl("input");
    nameInput.type = "text";
    // The filling half of the name row. The growth rule is a class rather
    // than an inline style so a theme can reach it, which is also what
    // `obsidianmd/no-static-styles-assignment` is asking for.
    nameInput.className = "text-input spaces-create-name";
    nameInput.placeholder = "Space name…";
    nameInput.value = this.state.name;
    // Mirrors validateSpace's own cap (schema.ts) so a pasted long name is
    // stopped visibly here rather than submitted and rejected by validation
    // with a Notice and an otherwise-unchanged form.
    nameInput.maxLength = MAX_SPACE_NAME_LENGTH;
    nameInput.dataset.focusKey = "name";
    nameInput.addEventListener("input", () => {
      // No decision here: validateForm (createSpaceForm.ts) is what decides
      // whether this is acceptable, not this handler.
      this.state = { ...this.state, name: nameInput.value };
      this.clearFault("name");
      this.refreshCreateButton();
    });
    nameRow.appendChild(nameInput);
    el.appendChild(nameRow);
    this.nameRow = nameRow;
    this.nameInput = nameInput;

    // --- Theme ---
    //
    // A button, not a swatch row: it names the one thing it changes — the
    // color the space's icon is drawn in — and defers the choosing to the
    // same popover the space strip uses. A real `<button>`, unclassed like
    // Cancel, so it inherits Obsidian's own chrome and Enter/Space activate it
    // natively rather than through a hand-rolled keydown handler.
    const themeBtn = doc.win.createEl("button");
    themeBtn.className = "spaces-create-theme";
    themeBtn.type = "button";
    themeBtn.dataset.focusKey = "theme";
    const themeIcon = doc.win.createSpan();
    themeIcon.className = "spaces-create-theme-icon";
    // Deliberately NOT tinted with the chosen color: the brush labels the
    // action, and the thing it colors is the space's own icon up in the name
    // row, which is where the choice shows (`paintIconButton`).
    setIcon(themeIcon, "brush");
    const themeLabel = doc.win.createSpan();
    themeLabel.textContent = "Choose icon color";
    themeBtn.appendChild(themeIcon);
    themeBtn.appendChild(themeLabel);
    // The color is named, not left as a swatch a screen reader cannot
    // describe; `paletteNameOf` already falls back to the value itself for a
    // custom color with no name.
    themeBtn.setAttribute(
      "aria-label",
      `Choose icon color. Currently ${paletteNameOf(this.state.color)}`
    );
    themeBtn.addEventListener("click", () => this.openThemePicker(themeBtn));
    el.appendChild(themeBtn);

    // --- Items ---
    //
    // Two buttons, not a checkbox with an unlabelled default: the kind of
    // space cannot be changed after creation, so both options are named and
    // neither is the one you get by not noticing. Switching is free —
    // `setFolderMode` discards nothing and each side remembers what it had.
    const modes = doc.win.createDiv();
    modes.className = "spaces-create-modes";
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "What goes in this space");

    const modeBtn = (folderMode: boolean, label: string, icon: string): HTMLButtonElement => {
      const btn = doc.win.createEl("button");
      btn.type = "button";
      btn.className = "spaces-create-mode";
      // Pressed means "this mode is in force", which outlives the picker: a
      // mode collapsed with a choice in it is still the mode being made, and
      // a mode collapsed with nothing in it is no longer on at all (see
      // `collapseMode`). Keying this off `itemsOpen` alone let a chosen
      // folder go on defining the space from behind an unpressed button.
      const active =
        this.state.folderMode === folderMode &&
        (this.itemsOpen || modeHoldsChoice(this.state, folderMode));
      if (active) btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", String(active));
      btn.dataset.focusKey = folderMode ? "mode-folder" : "mode-curate";
      const ic = doc.win.createSpan();
      ic.className = "spaces-create-theme-icon";
      setIcon(ic, icon);
      const text = doc.win.createSpan();
      text.textContent = label;
      btn.appendChild(ic);
      btn.appendChild(text);
      btn.addEventListener("click", () => {
        // Either button answers a root fault: one abandons the mode it was
        // about, the other re-opens the picker to satisfy it. Leaving the mark
        // on would keep a dead "choose a folder" against a control that is no
        // longer being asked for one.
        this.clearFault("root");
        if (this.itemsOpen && this.state.folderMode === folderMode) {
          this.itemsOpen = false;
          // Collapsing an empty mode abandons it, so the form does not go on
          // demanding a folder for a Pin to Folder the user has visibly
          // dropped. The root survives, so re-opening finds it.
          this.state = collapseMode(this.state, folderMode);
        } else {
          this.state = setFolderMode(this.state, folderMode);
          this.itemsOpen = true;
        }
        // The window is rebuilt for the mode being opened, and folder mode has
        // no tags at all, so it reopens on the vault rather than on whatever
        // the last curated session left it showing.
        this.pickerMode = DEFAULT_PICKER_MODE;
        this.render();
      });
      return btn;
    };

    modes.appendChild(modeBtn(false, "Curated", "list-plus"));
    modes.appendChild(modeBtn(true, "Folder pinned", "folder"));
    el.appendChild(modes);

    if (this.itemsOpen) {
      const view = doc.win.createDiv();
      view.className = "spaces-create-items";

      // Folder mode is offered neither button, for the reason it is offered no
      // sigil: a folder space is a window onto one root, and a tag is not one.
      this.pickerModeEls.clear();
      let bodies: HTMLElement | null = null;
      if (!this.state.folderMode) {
        bodies = doc.win.createDiv();
        bodies.className = "spaces-create-bodies";
        bodies.setAttribute("role", "group");
        bodies.setAttribute("aria-label", "What the window below shows");
        bodies.appendChild(this.bodyBtn(doc, "items", "Items", "folder-tree", ITEMS_SIGIL));
        bodies.appendChild(this.bodyBtn(doc, "tags", "Tags", "tag", TAG_SIGIL));
      }

      const windowEl = doc.win.createDiv();
      windowEl.className = "spaces-create-tree";
      // Focusable programmatically but NOT in the tab order: `showFault` marks
      // this box and then focuses it, and `focus()` is a silent no-op on an
      // element with no tabindex — so a keyboard user refused a Create got the
      // Notice, a red border they could not reach, and focus left on the
      // button.
      windowEl.tabIndex = -1;

      const filter = doc.win.createEl("input");
      filter.type = "text";
      filter.className = "text-input";
      filter.value = this.itemFilter;
      filter.dataset.focusKey = "item-filter";
      filter.addEventListener("input", () => {
        this.itemFilter = this.queryFrom(filter.value);
        this.renderItemTree();
      });
      filter.addEventListener("keydown", (e) => {
        if (this.state.folderMode) return;
        const mode = readModeSigil({
          box: filter.value,
          key: e.key,
          modified: e.ctrlKey || e.metaKey || e.altKey,
          composing: e.isComposing,
        });
        if (mode === null) return;
        // NOT prevented, which is the change: the character lands so it can be
        // seen, and `endSigilFlash` takes it back a moment later. It is still
        // consumed in the sense that matters — `queryFrom` keeps it out of
        // `itemFilter`, so the query typed behind it filters from its first
        // character and ends up in the box without it.
        this.startSigilFlash(e.key);
        this.setPickerMode(mode);
      });
      this.filterEl = filter;
      view.appendChild(filter);
      // Under the box they act on, between it and the list they switch. A
      // sibling of the window rather than a child: the filter is a sibling
      // too, so the buttons stay in the same column as the box, and the window
      // keeps exactly two children (the scrolling list and the pinned row).
      if (bodies) view.appendChild(bodies);

      // Rows live in their own child so redrawing them cannot disturb the box
      // around them. The role belongs HERE rather than on the box: ARIA
      // requires treeitems to be owned by the tree, and with an unroled div in
      // between assistive tech reported a tree of zero items and a pile of
      // orphaned rows. Which role it is depends on what is being drawn, so
      // `renderItemTree` sets it — a flat list of tags is not a tree.
      const rowsEl = doc.win.createDiv();
      rowsEl.className = "spaces-create-tree-rows";
      // The list scrolls, the window does not. That is what lets the summary
      // row below sit still: the list gives up the height instead of the
      // window taking more.
      const scroll = doc.win.createDiv();
      scroll.className = "spaces-create-tree-scroll";
      scroll.appendChild(rowsEl);
      windowEl.appendChild(scroll);
      this.treeEl = rowsEl;

      // Inside the window and pinned under its list: a choice made in one body
      // is still visible from the other, which is what the row above the
      // window used to do before it was taken out for crowding the pane.
      const summary = doc.win.createDiv();
      summary.className = "spaces-create-summary";
      // Announced when it changes, because the thing that changed it may have
      // been a click in a list the user is not reading.
      summary.setAttribute("role", "status");
      windowEl.appendChild(summary);
      this.summaryEl = summary;

      view.appendChild(windowEl);

      el.appendChild(view);
      this.renderPlaceholder();
      this.renderSummary();
      this.renderItemTree();
    } else {
      this.treeEl = null;
      this.summaryEl = null;
      this.filterEl = null;
      this.pickerModeEls.clear();
    }


    // --- Actions, pinned to the bottom ---
    const actions = doc.win.createDiv();
    actions.className = "spaces-create-actions";
    const createBtn = doc.win.createEl("button");
    createBtn.className = "mod-cta";
    createBtn.textContent = this.submitting ? "Creating…" : "Create space";
    // Only a submit in flight disables it: a greyed-out button with no reason
    // leaves the user guessing which control it is waiting on, so it always
    // submits and `handleSubmit` points at whatever is wrong.
    createBtn.disabled = this.submitting;
    createBtn.dataset.focusKey = "create";
    createBtn.addEventListener("click", () => void this.handleSubmit());
    actions.appendChild(createBtn);
    this.createBtn = createBtn;

    const cancelBtn = doc.win.createEl("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.dataset.focusKey = "cancel";
    cancelBtn.addEventListener("click", () => this.close());
    actions.appendChild(cancelBtn);

    el.appendChild(actions);

    // Last, so every row it measures is in place.
    this.alignToRibbon();
    // Re-apply after a rebuild: `render()` replaces the very nodes the mark
    // was on, and a fault is cleared by acting on the control, not by redraw.
    this.paintFault();
  }

  /**
   * Draws the item tree into its container, in place.
   *
   * Separate from `renderInner()` because filtering, expanding and picking
   * must not rebuild the whole panel: a full re-render would drop focus out of
   * the filter field on every keystroke.
   */
  /**
   * Tells the user how many matches were not drawn, or takes the message away
   * when everything fits.
   *
   * Appended to the scroll box rather than to the row container, because that
   * container is the `role="tree"` and a tree may own only `treeitem`s.
   */
  private renderOverflowNotice(hidden: number): void {
    const box = this.treeEl?.parentElement;
    if (!box) return;
    const existing = box.querySelector(".spaces-create-tree-more");
    if (hidden <= 0) {
      existing?.remove();
      return;
    }
    const el = existing ?? box.ownerDocument.win.createDiv();
    el.className = "spaces-create-tree-more";
    el.setAttribute("role", "status");
    el.textContent = `${hidden.toLocaleString()} more — keep typing to narrow`;
    if (!existing) box.appendChild(el);
  }

  /**
   * Draws whichever body the two buttons above the window ask for.
   *
   * Which one that is lives in `readPickerBody`, not here, so the rule can be
   * read and tested without a DOM rather than inferred from the panel that
   * happens to be this prototype's drawing.
   *
   * Folder mode never reaches the tag body: a folder space is a window onto
   * one root, and a tag is not one, so that mode draws neither button and the
   * sigils do nothing there.
   */
  private renderItemTree(): void {
    const host = this.treeEl;
    if (!host) return;
    if (readPickerBody(this.pickerMode, this.state.folderMode) === "tags") {
      this.renderTagBody(host, this.itemFilter);
      return;
    }
    const doc = host.ownerDocument;
    // Set every time rather than once at build: the box is the SAME element in
    // both modes, so coming back from the tag list has to undo what that left
    // behind. A `role="tree"` still carrying `aria-multiselectable` reads as a
    // multi-select tree, which this is not in folder mode.
    host.setAttribute("role", "tree");
    host.removeAttribute("aria-multiselectable");
    host.setAttribute("aria-label", this.state.folderMode ? "Choose a folder" : "Choose items");
    const src = this.deps.folders;
    const tree = (this.vaultTree ??= buildVaultTree(
      src
        .allPaths()
        .map((path) => ({ path, kind: src.kindOf(path) }))
        .filter((e): e is { path: string; kind: "file" | "folder" } => e.kind !== null)
    ));
    // Folder mode holds at most one path; curated holds any number. One set
    // covers both, so the tree needs no idea which mode it is in beyond
    // `foldersOnly`.
    const selected = this.state.folderMode
      ? new Set(this.state.root === "" ? [] : [this.state.root])
      : new Set(this.state.items.flatMap((i) => (i.kind === "tag" ? [] : [i.path])));

    const matched = visibleRows(tree, {
      expanded: this.expandedFolders,
      filter: this.itemFilter,
      selected,
      foldersOnly: this.state.folderMode,
    });
    const rows = matched.slice(0, MAX_PICKER_ROWS);
    this.renderOverflowNotice(matched.length - rows.length);

    host.replaceChildren();
    if (rows.length === 0) {
      const empty = doc.win.createDiv();
      empty.className = "spaces-create-tree-empty";
      // Distinguishes "your filter matched nothing" from "there is nothing
      // here" — identical as an empty box, different things to do about it.
      empty.textContent =
        this.itemFilter.trim() === "" ? "Nothing in this vault yet" : "No match";
      host.appendChild(empty);
      return;
    }

    for (const row of rows) {
      const el = doc.win.createDiv();
      el.className = "spaces-create-tree-row";
      el.setAttribute("role", "treeitem");
      el.tabIndex = 0;
      el.dataset.path = row.path;
      el.dataset.kind = row.kind;
      // The caret's slot is reserved even on a childless row, so names stay in
      // one column instead of jittering by level.
      el.style.paddingLeft = `${row.depth * 14}px`;
      el.classList.toggle("is-selected", row.selected);
      // Both states, not just the true one: a treeitem with no `aria-selected`
      // reads as "not selectable" rather than "not selected".
      el.setAttribute("aria-selected", String(row.selected));
      if (row.hasChildren) el.setAttribute("aria-expanded", String(row.expanded));
      // Everything under a selected folder is already in the space, at every
      // depth, so the tree says so rather than leaving the children looking
      // untouched. Picked wins over covered: a row chosen by hand is a member
      // in its own right and still removable, and reading it as inherited
      // would hide the entry it is. Folder mode takes one root and keeps no
      // member list, so nothing there can be covered.
      const coveredBy =
        this.state.folderMode || row.selected
          ? null
          : coveringFolder(this.state.items, row.path);
      el.classList.toggle("is-inherited", coveredBy !== null);
      if (coveredBy !== null) {
        // `aria-disabled` rather than the tint alone: covered is a third
        // state, and neither `aria-selected="false"` nor a background color
        // tells a screen reader it is one. Not `disabled`, which would take
        // the row out of the tab order and leave a keyboard user with no way
        // to reach the title that explains it.
        el.setAttribute("aria-disabled", "true");
        el.setAttribute(
          "title",
          `Already included by the selected folder ${coveredBy}. ` +
            "Deselect that folder to pick items under it one at a time."
        );
      }

      const caret = doc.win.createSpan();
      caret.className = "spaces-create-tree-caret";
      if (row.hasChildren) {
        setIcon(caret, row.expanded ? "chevron-down" : "chevron-right");
        // Hidden from assistive tech rather than labelled as a button: it
        // takes no focus, and the row's `aria-expanded` already carries the
        // state. Keyboard users expand with the arrow keys below.
        caret.setAttribute("aria-hidden", "true");
        caret.addEventListener("click", (e) => {
          // Expanding is browsing, not choosing — without this the caret would
          // also pick, and there would be no way to look inside a folder
          // without selecting it.
          e.stopPropagation();
          if (this.expandedFolders.has(row.path)) this.expandedFolders.delete(row.path);
          else this.expandedFolders.add(row.path);
          this.renderItemTree();
        });
      }
      el.appendChild(caret);

      const icon = doc.win.createSpan();
      icon.className = "spaces-create-tree-icon";
      setIcon(icon, row.kind === "folder" ? "folder" : "file");
      el.appendChild(icon);

      const label = doc.win.createSpan();
      label.className = "spaces-create-tree-name";
      label.textContent = row.name;
      el.appendChild(label);

      const setExpanded = (open: boolean): void => {
        if (!row.hasChildren) return;
        if (open) this.expandedFolders.add(row.path);
        else this.expandedFolders.delete(row.path);
        this.renderItemTree();
        const again = host.querySelector<HTMLElement>(`[data-path="${CSS.escape(row.path)}"]`);
        again?.focus();
      };

      const choose = (): void => {
        // A click on a covered row did nothing visible and stored a `file`
        // member the selected folder already covers — the state `memberRows`
        // calls `redundant`. Nothing is the honest answer, and the title says
        // which folder gave it.
        if (coveredBy !== null) return;
        if (this.state.folderMode) {
          // One root: picking replaces, and picking the same one again clears,
          // so a mis-click is undoable without leaving the picker.
          this.state = setRoot(this.state, this.state.root === row.path ? "" : row.path);
        } else {
          this.state = toggleItem(this.state, { path: row.path, kind: row.kind });
        }
        this.clearFault("root");
        this.renderSummary();
        this.renderItemTree();
        this.refreshCreateButton();
      };
      el.addEventListener("click", choose);
      el.addEventListener("keydown", (e) => {
        // Arrows browse, Enter and Space pick — the same split the caret and
        // the row body draw for the mouse, so expanding never selects.
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          if (!row.hasChildren) return;
          e.preventDefault();
          setExpanded(e.key === "ArrowRight");
          return;
        }
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        choose();
      });
      host.appendChild(el);
    }

    const selectedEl = host.querySelector(".is-selected");
    // Opened with a root already chosen (the right-click entry), the selection
    // can be below the fold of a scrolling box.
    if (selectedEl instanceof HTMLElement) selectedEl.scrollIntoView({ block: "nearest" });
  }

  /**
   * The tags this space currently holds, in the order they were chosen.
   *
   * Folder mode reports none. It keeps `items` so switching back costs nothing
   * (`setFolderMode`), but `toCreateOptions` submits the root alone, so
   * showing them would advertise members the space will not have.
   */
  private chosenTags(): string[] {
    if (this.state.folderMode) return [];
    return this.state.items.flatMap((i) => (i.kind === "tag" ? [i.tag] : []));
  }

  /**
   * One of the two buttons that choose what the window below them shows.
   *
   * They are new furniture in a pane that was kept bare on purpose, and that
   * is the point: a corner icon and a typed sigil both ask the user to already
   * know the other body is there. Two labelled buttons say it.
   *
   * `aria-pressed` rather than a radio group or a tablist: the pair beside
   * them, Curated and Folder pinned, is already a pressed-button pair in this
   * panel, and one idiom for two segmented pairs on one pane is what makes
   * them read as the same kind of control.
   *
   * The title names the shortcut, which is the only place the shortcut is
   * written down now that the placeholder is about filtering again.
   */
  private bodyBtn(
    doc: Document,
    mode: PickerMode,
    label: string,
    icon: string,
    sigil: string
  ): HTMLButtonElement {
    const btn = doc.win.createEl("button");
    btn.type = "button";
    btn.className = "spaces-create-body";
    btn.dataset.focusKey = mode === "tags" ? "body-tags" : "body-items";
    btn.title = `${label}. Type ${sigil} in an empty filter box.`;
    const ic = doc.win.createSpan();
    ic.className = "spaces-create-theme-icon";
    setIcon(ic, icon);
    const text = doc.win.createSpan();
    text.textContent = label;
    btn.appendChild(ic);
    btn.appendChild(text);
    btn.addEventListener("click", () => {
      this.setPickerMode(mode);
    });
    this.pickerModeEls.set(mode, btn);
    this.paintPickerModes();
    return btn;
  }

  /**
   * What a box showing a flashing sigil is actually asking for.
   *
   * Stripping the sigil here rather than from the box is the whole trick: the
   * list narrows by the real query from the first character typed after the
   * sigil, while the box goes on showing the sigil until the flash ends.
   */
  private queryFrom(value: string): string {
    const sigil = this.sigilFlash;
    if (sigil === null || !value.startsWith(sigil)) return value;
    return value.slice(sigil.length);
  }

  /** Starts the sigil showing, and arms the one thing that takes it back. */
  private startSigilFlash(sigil: string): void {
    this.cancelSigilFlash();
    this.sigilFlash = sigil;
    const handle = window.setTimeout(() => this.endSigilFlash(), SIGIL_FLASH_MS);
    this.sigilFlashOff = () => window.clearTimeout(handle);
  }

  /**
   * Takes the sigil out of the box, and nothing else.
   *
   * Exactly one character, matched against the one that was put there, and
   * only while the box still starts with it. Someone who backspaced it, or
   * selected the lot and typed over it, has already dealt with it; removing a
   * character anyway would eat the first letter of what they typed instead.
   *
   * The caret moves back by what was removed, so a flash that ends mid-word
   * leaves the user typing where they were rather than one place to the right.
   * `itemFilter` is untouched: it has been sigil-free since the keystroke
   * landed, so only the box changes and the list does not redraw.
   */
  private endSigilFlash(): void {
    const sigil = this.sigilFlash;
    this.cancelSigilFlash();
    const filter = this.filterEl;
    if (sigil === null || !filter || !filter.value.startsWith(sigil)) return;
    const caret = filter.selectionStart;
    filter.value = filter.value.slice(sigil.length);
    const at = caret === null ? filter.value.length : Math.max(0, caret - sigil.length);
    filter.setSelectionRange(at, at);
  }

  /** Drops a pending flash without touching the box. Idempotent. */
  private cancelSigilFlash(): void {
    this.sigilFlashOff?.();
    this.sigilFlashOff = null;
    this.sigilFlash = null;
  }

  /**
   * Switches the window over, from either door.
   *
   * The filter text is left exactly as it is. The box narrows whichever body
   * is on screen, so text in it is a query the user wrote and not a thing the
   * old body owned; clearing it would make the buttons destructive, and a
   * button that loses work is a button people stop pressing.
   *
   * Redrawn in place rather than through `render()`, so switching does not
   * rebuild the pane under the pointer or take focus off the filter box the
   * sigil was typed into.
   */
  private setPickerMode(mode: PickerMode): void {
    this.pickerMode = mode;
    this.paintPickerModes();
    this.renderPlaceholder();
    this.renderItemTree();
  }

  /** Marks the button whose body is on screen, for the eye and for ARIA. */
  private paintPickerModes(): void {
    for (const [mode, btn] of this.pickerModeEls) {
      const active = mode === this.pickerMode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    }
  }

  /**
   * What the filter box says it will filter.
   *
   * It names the body on screen rather than the sigil, which the buttons now
   * teach by being visible. Folder mode gets its own words, as it always has.
   */
  private renderPlaceholder(): void {
    const filter = this.filterEl;
    if (!filter) return;
    if (this.state.folderMode) {
      filter.placeholder = "Filter folders…";
      return;
    }
    filter.placeholder = this.pickerMode === "tags" ? "Filter tags…" : "Filter notes and folders…";
  }

  /**
   * The row pinned under the window's list: what this space holds so far.
   *
   * It is what makes the two bodies one picker. A tag chosen in Tags mode has
   * no row to mark in the tree, and a note chosen in the tree has none in the
   * tag list, so without this the window could only ever report half of what
   * was picked. Counting both in one line also keeps it to one line, which is
   * what the row of chips above the window failed at.
   *
   * Folder mode reports its root, by the same count. The mode holds one folder
   * or none, and `toCreateOptions` submits the root alone, so reporting the
   * curated items it is still carrying would advertise members the space will
   * not have.
   *
   * Redrawn in place rather than through `render()`, so picking does not
   * rebuild the window under the pointer that just clicked inside it.
   */
  private renderSummary(): void {
    const host = this.summaryEl;
    if (!host) return;
    const picked = this.pickedMembers();
    const counts = countPicked(picked);
    // The total is the whole row's lead figure, so it is resolved on every
    // draw. The index is reached lazily, once per draw and only if a tag was
    // picked: the accessor hands back the engine's current snapshot, and a
    // selection of notes and folders has no use for it. `previewPaths` reads
    // the vault listing only if a folder was picked.
    let index: ReturnType<typeof this.deps.tagIndex> | null = null;
    const notes = previewPaths(picked, this.deps.folders, (tag) => {
      index ??= this.deps.tagIndex();
      return index.pathsMatching(tag);
    }).notes;
    host.textContent = pickedSummary(counts, notes);
  }

  /**
   * What the summary row is reporting on: the curated members, or a folder
   * space's root alone.
   *
   * Expressed as members rather than as counts so the root is resolved by
   * exactly the rule a curated folder member is, and so both shapes reach
   * `previewPaths` as the one thing it takes.
   */
  private pickedMembers(): readonly MemberEntry[] {
    if (!this.state.folderMode) return this.state.items;
    return this.state.root === "" ? [] : [{ kind: "folder", path: this.state.root }];
  }

  /**
   * The tag body: a flat list drawn into the same box the tree uses.
   *
   * It holds the vault's tags, all of them, with the ones this space already
   * has marked — the same job the tree does for notes and folders, which is
   * what makes the two buttons above the window mean the same kind of thing.
   * An empty filter box is the whole list; text narrows it.
   *
   * Flat rather than nested even though tags nest, because `tagMatches` makes
   * a parent tag cover its children anyway — picking `project` already takes
   * `project/console`, so a hierarchy here would be a second way to express
   * something the member already means.
   *
   * `prepareFuzzySearch` and `renderResults` are the quick switcher's own
   * matching and highlighting, which is what makes this read as part of
   * Obsidian rather than as a list bolted into the panel. Both are public API,
   * so neither belongs in the private-API quarantine; the private call is
   * `deps.tags`, one layer down.
   *
   * WHAT is offered and in what order is `fuzzyTagCandidates`, which is pure
   * and tested. This function draws.
   *
   * Each row also reports how many notes its tag currently brings in, nested
   * tags included, which is what `pathsMatching` already answers and therefore
   * exactly what the member would resolve to. It is the row's confidence
   * signal: the picker offers a SELECTOR, so there is no list of notes to
   * click through here, and without the number a tag is a name and nothing
   * else. Counted after the cap, never before it (see `countTagRows`).
   */
  private renderTagBody(host: HTMLElement, query: string): void {
    const doc = host.ownerDocument;
    // A flat list of choices, not a tree, and several may be chosen at once.
    // Multi-select is also what makes ONE gesture enough: in a multi-select
    // listbox, activating a selected option deselects it, so a click means
    // "turn this on or off" here exactly as it does in the tree.
    host.setAttribute("role", "listbox");
    host.setAttribute("aria-multiselectable", "true");
    host.setAttribute("aria-label", "Choose tags");
    // The tree's count means nothing here; leaving it would report a stale
    // number against a list it was never about.
    this.renderOverflowNotice(0);
    host.replaceChildren();

    const message = (text: string): void => {
      const empty = doc.win.createDiv();
      empty.className = "spaces-create-tree-empty";
      empty.textContent = text;
      host.appendChild(empty);
    };

    const chosenTags = this.chosenTags();
    // Named explicitly rather than inferred: `prepareFuzzySearch` returns
    // `SearchResult | null`, and inference off a function-typed argument
    // widens to the constraint, which then loses the `matches` that
    // `renderResults` needs.
    const found = fuzzyTagCandidates<SearchResult>(this.deps.tags, query, prepareFuzzySearch);
    if (found === null) {
      // Null is the source saying it cannot list the vault's tags at all,
      // which is how `nativeKnownTags` reports a missing private `getTags` —
      // a return, not a throw, and the likelier of the two failures. The way
      // out is the field in Settings, so say that rather than leaving an
      // empty box to be read as "this vault has no tags".
      message("Tags cannot be listed here. Add a tag from Settings, Contents.");
      return;
    }
    if (found.length === 0) {
      message(query.trim() === "" ? "No tags in this vault yet" : "No matching tag");
      return;
    }
    const hits: TagHit<SearchResult>[] = found;

    // Reached once per render, not once per row: the accessor hands back the
    // engine's current snapshot, and `pathsMatching` is a map lookup on it.
    const index = this.deps.tagIndex();
    const counted = countTagRows(hits, (tag) => index.pathsMatching(tag).length);

    const chosen = new Set(chosenTags);
    for (const hit of counted) {
      const el = doc.win.createDiv();
      // Both classes: the tree's row rules are the layout, and the tag class
      // carries only what differs.
      el.className = "spaces-create-tree-row spaces-create-tag-row";
      el.setAttribute("role", "option");
      el.tabIndex = 0;
      el.dataset.tag = hit.tag;
      const selected = chosen.has(hit.tag);
      el.classList.toggle("is-selected", selected);
      el.setAttribute("aria-selected", String(selected));
      // The row toggles, so a selected one is offering to come off. Said in a
      // tooltip rather than in a second control: a real remove button inside a
      // clickable row gives two targets for one action.
      if (selected) el.title = `Remove ${TAG_SIGIL}${hit.tag}`;

      const label = doc.win.createSpan();
      label.className = "spaces-create-tree-name";
      const sigil = doc.win.createSpan();
      sigil.className = "spaces-create-tag-sigil";
      // A Lucide tag, not a `#`: the same mark the window's corner carries, so
      // one shape means "tag" everywhere in this panel.
      setIcon(sigil, "tag");
      label.appendChild(sigil);
      const name = doc.win.createSpan();
      // The icon is a sibling rather than part of the highlighted text: the
      // match positions are against the STORED tag, and anything prefixed to
      // it would put every one of them out by that much.
      if (hit.match) renderResults(name, hit.tag, hit.match);
      else name.textContent = hit.tag;
      label.appendChild(name);
      el.appendChild(label);

      // Trailing the name and set in the muted type the rest of the picker
      // uses for anything that is not a name: a hint the eye picks up while it
      // is already deciding, rather than a second thing to read.
      const count = doc.win.createSpan();
      count.className = "spaces-create-tag-count";
      count.textContent = tagCountLabel(hit.count);
      el.appendChild(count);

      const choose = (): void => {
        this.state = toggleItem(this.state, { kind: "tag", tag: hit.tag });
        this.clearFault("root");
        this.renderSummary();
        this.renderItemTree();
        this.refreshCreateButton();
      };
      el.addEventListener("click", choose);
      el.addEventListener("keydown", (e) => {
        // No arrow handling: there is nothing to expand, so the only keys
        // that mean anything here are the two that pick.
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        choose();
      });
      host.appendChild(el);
    }
  }

  /**
   * Lines the name field up with a left-ribbon icon, by measuring both.
   *
   * A SNAP, not a subordination: `DESIGN_TITLE_GAP` is the layout, and an icon
   * within `TITLE_GAP_TOLERANCE` of it gets taken because the alignment is
   * then free. Anything further away is ignored — a theme can decline to line
   * up with us, it cannot drag us out of shape (see `ribbonAlign.ts`).
   *
   * Measured rather than hardcoded: a fixed number is wrong the moment a theme
   * changes the ribbon's pitch or phase, and Obsidian publishes neither, so
   * CSS `calc()` cannot express it either.
   */
  private alignToRibbon(): void {
    const el = this.el;
    const doc = this.doc;
    const row = this.nameRow;
    if (!el || !doc || !row) return;

    const centres = Array.from(doc.querySelectorAll(SEL.ribbonIcon), (icon) => {
      const r = icon.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const rect = row.getBoundingClientRect();
    const current = Number.parseFloat(
      el.style.getPropertyValue("--spaces-title-gap") || `${DESIGN_TITLE_GAP}`
    );

    const gap = alignmentGap({
      ribbonCentres: centres,
      rowTop: rect.top,
      rowHeight: rect.height,
      currentGap: Number.isFinite(current) ? current : DESIGN_TITLE_GAP,
      designGap: DESIGN_TITLE_GAP,
      tolerance: TITLE_GAP_TOLERANCE,
    });
    // No icon worth moving for: fall back to the design value rather than
    // leaving whatever a previous layout happened to set, so the panel looks
    // the same whether or not a ribbon is there to snap to.
    el.style.setProperty("--spaces-title-gap", `${gap ?? DESIGN_TITLE_GAP}px`);
  }

  /**
   * Points at whatever stopped a Create, instead of a button that will not
   * click.
   *
   * Two halves, because a color alone is not a reason: the control is marked
   * so the eye lands on it, and the reason goes to a `Notice`. The panel keeps
   * no message row of its own — it had to be cleared by hand, which is how a
   * stale "choose a folder" once sat there after its mode was switched off.
   *
   * A fault on the root OPENS the picker first: a red border on a box that is
   * not on screen tells the user nothing. Focus follows the mark, so keyboard
   * users are taken where the color points sighted ones.
   */
  private showFault(fault: FormFault): void {
    if (fault.field === "root" && !this.itemsOpen) {
      this.itemsOpen = true;
      this.render();
    }
    this.fault = fault;
    this.paintFault();
    new Notice(`Spaces: ${fault.message}`);
    const el = this.el;
    const target = el?.querySelector<HTMLElement>(
      fault.field === "name" ? '[data-focus-key="name"]' : ".spaces-create-tree"
    );
    target?.focus();
    if (target && fault.field === "root") target.scrollIntoView({ block: "nearest" });
  }

  /**
   * Applies or removes the invalid marking — the mark only; the words are the
   * Notice's job. Separate from `showFault` because a re-render rebuilds the
   * nodes it marked and the fault has to survive that: it is cleared by
   * EDITING the control, not by redrawing it.
   */
  private paintFault(): void {
    const el = this.el;
    if (!el) return;
    const name = el.querySelector('[data-focus-key="name"]');
    const tree = el.querySelector(".spaces-create-tree");
    for (const [node, field] of [
      [name, "name"],
      [tree, "root"],
    ] as const) {
      if (!(node instanceof HTMLElement)) continue;
      const bad = this.fault?.field === field;
      node.classList.toggle("is-invalid", bad);
      if (bad) node.setAttribute("aria-invalid", "true");
      else node.removeAttribute("aria-invalid");
    }
  }

  /** Clears the mark once the user has acted on the control it named. */
  private clearFault(field: "name" | "root"): void {
    if (this.fault?.field !== field) return;
    this.fault = null;
    this.paintFault();
  }

  /**
   * Keeps the Create button's disabled state in step without a full re-render
   * (which would drop focus out of the input whose `input` event called this).
   * Only an in-flight submit disables it — validation does not, since a
   * refused Create explains itself instead.
   */
  private refreshCreateButton(): void {
    if (this.createBtn) this.createBtn.disabled = this.submitting;
  }

  private async handleSubmit(): Promise<void> {
    if (this.submitting) return;
    const fault = validateForm(this.state);
    if (fault) {
      this.showFault(fault);
      return;
    }
    this.submitting = true;
    this.render();
    let created = false;
    try {
      await this.deps.onSubmit(this.state.name, toCreateOptions(this.state));
      created = true;
    } catch (e) {
      // Stays open with its values intact — losing a typed name and
      // chosen folders to a failed write is worse than the failure.
      new Notice(`Spaces: could not create the space (${String(e)})`);
      this.submitting = false;
      this.render();
    }
    // Escape is not blocked while a create is in flight, so the panel may
    // already be gone by the time `onSubmit` resolves. Closing it a second
    // time would run `deps.onClose()` again — and `main.ts` nulls its panel
    // handle there, so a user who re-opened in the meantime would have the
    // reference to their NEW panel cleared.
    if (created && this.isOpen) {
      // Outside the try/catch above on purpose: `onSubmit` resolving means the
      // space already exists, so a throw past this point must never be
      // reported as "could not create the space".
      try {
        // Switching is the caller's job inside onSubmit; closing is ours.
        this.close();
      } catch (e) {
        console.error("Spaces: onClose threw after a successful create", e);
      }
    }
  }
}

/**
 * Resolves a swatch value back to its human name via PALETTE_NAMES
 * (spaceLifecycle.ts), by index against PALETTE — the one source of truth for
 * both. Falls back to the raw value for a color outside `PALETTE` (a custom
 * one the user minted).
 */
function paletteNameOf(color: string): string {
  const i = PALETTE.indexOf(color);
  return i >= 0 ? PALETTE_NAMES[i] : color;
}
