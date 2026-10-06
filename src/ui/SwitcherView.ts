import { Menu, Platform, setIcon } from "obsidian";
import type { AnchoredPopover } from "./AnchoredPopover";
import { openIconPicker } from "./IconPickerPopover";
import { openColorPicker } from "./ColorPickerPopover";
import { openRenamePopover } from "./RenamePopover";
import { knownIconIds } from "./knownIcons";
import { spaceEntries, splitPinnedEntry, type SpaceEntry } from "./spaceEntries";
import { railScrollOffset, railWheelDelta } from "./railScroll";
import {
  edgeScrollStep,
  gapCenterAt,
  insertionIndexAt,
  isNoOpMove,
  moveTo,
  type ItemBox,
} from "./spaceReorder";
import { axisFor, pointerAlong, spanOf, type Axis, type Span } from "./stripAxis";
import { applyDock, applyUnlockState, clearDock } from "./stripDock";
import { BOLDED_CLASS, BOXED_CLASS, activeStyleClass } from "./activeStyle";
import {
  DESIGN_PAD_TOP,
  DESIGN_RAIL_GAP,
  stripAlignment,
  type AlignBox,
} from "./stripAlign";
import { nearestPlacement, passedThreshold, type PaneRect, type Point } from "./stripDrag";
import { CLS_SPACE_DRAGGING, CLS_SPACE_DROP_LINE, SEL } from "../explorer/selectors";
import { renameSpace, setSpaceIcon, setSpaceColor } from "../actions/spaceLifecycle";
import { setStripPlacement } from "../actions/stripPlacement";
import { iconColorFor } from "./spaceIconColor";
import type { DefinitionStore } from "../definitions/DefinitionStore";
import type { RuntimeStateStore } from "../runtime/RuntimeStateStore";
import type { SpaceController } from "../controller/SpaceController";
import type { ActiveSelection, SpaceDefinition, StripPlacement } from "../types";
import { dropTargetFor } from "./spaceDrop";
import type { DraggedFiles } from "../order/currentDrag";

/** The four candidate placements a drag can land on, in a fixed order. */
const PLACEMENTS: readonly StripPlacement[] = ["top", "bottom", "left", "right"];

/** The two properties `styles.css` reads the vertical alignment from. */
const PROP_PAD_TOP = "--spaces-strip-pad-top";
const PROP_RAIL_GAP = "--spaces-strip-rail-gap";

/** The space header, when it is shown -- the strip's preferred anchor row. */
const CLS_SPACE_HEADER = ".spaces-space-header";

/**
 * `render()` rebuilds every child of the strip, so focus has to be recorded
 * before the rebuild and put back after it. These are the names it is recorded
 * under, written to `data-switcher-key` on each control.
 *
 * The prefix in `focusKeyFor` is what keeps these distinct from any space:
 * every space's key is `space:<id>`, so none of the three bare names below can
 * ever be one, whatever a space is called.
 */
const ADD_FOCUS_KEY = "add";
const GRIP_FOCUS_KEY = "grip";

/** The `data-switcher-key` for one strip entry. */
function focusKeyFor(key: ActiveSelection): string {
  return key.kind === "all" ? "all" : `space:${key.id}`;
}

/** A measured centre, or null for a node that is absent or not yet laid out. */
function centreOf(node: Element | null): number | null {
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return r.height > 0 ? r.top + r.height / 2 : null;
}

function boxOf(node: Element | null): AlignBox | null {
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return { top: r.top, height: r.height };
}

/**
 * The value currently in effect, read back from the property this wrote last
 * time. Falls back to the stylesheet's own number, which is what applies
 * while the property is unset.
 */
function readPx(el: HTMLElement, name: string, fallback: number): number {
  const raw = Number.parseFloat(el.style.getPropertyValue(name));
  return Number.isFinite(raw) ? raw : fallback;
}

function writePx(el: HTMLElement, name: string, value: number | null): void {
  if (value === null) el.style.removeProperty(name);
  else el.style.setProperty(name, `${value}px`);
}

/**
 * An in-flight pointer drag of the grip.
 *
 * The listeners are stored so `endGripDrag()` can remove the exact functions it
 * added -- an inline arrow at `addEventListener` cannot be un-added later.
 */
interface DragState {
  pointerId: number;
  origin: Point;
  /** False until `passedThreshold`: a click that never starts one does nothing. */
  started: boolean;
  /** The last `nearestPlacement` computed, or null before a first move. */
  target: StripPlacement | null;
  grip: HTMLElement;
  overlay: HTMLElement | null;
  zones: Partial<Record<StripPlacement, HTMLElement>>;
  onMove: (e: PointerEvent) => void;
  onUp: (e: PointerEvent) => void;
  onCancel: (e: PointerEvent) => void;
  onLostCapture: (e: PointerEvent) => void;
  onKeydown: (e: KeyboardEvent) => void;
}

export class SwitcherView {
  private el: HTMLElement | null = null;
  /** The pane this strip is currently docked in, so a remount can clean it. */
  private host: HTMLElement | null = null;
  /** Watches the pane for the layout changes no render hears about. */
  private paneResize: ResizeObserver | null = null;
  /** Where the strip sits, mirroring the persisted setting. */
  private placement: StripPlacement = "bottom";
  /**
   * Whether the strip shows its grab handle. Locked (the default, and what
   * everyone sees) has no handle and no chrome at all; unlocked is the mode
   * that offers something to take hold of. The drag itself is a later task.
   */
  private unlocked = false;
  /** A pointer drag of the grip in progress, or null when idle. */
  private drag: DragState | null = null;
  /**
   * The ID of the space being dragged, or null when no space drag is running.
   *
   * An ID rather than the index it used to be. The index was captured at
   * `dragstart` and spent at `drop`, and `render()` can run between the two:
   * it is called from five sites in `main.ts`, one of them inside
   * `onSnapshotApplied`, which runs on every file open and every coalesced
   * vault flush. If the definitions changed in that window -- realistically
   * `onExternalSettingsChange` applying a `data.json` written on another
   * device -- the index named a different space and the drop moved that one
   * instead.
   *
   * `draggedIndex()` re-derives the position from this at the moment it is
   * needed, and answers null when the space is no longer there.
   */
  private dragFromId: string | null = null;
  /** Last pointer reading, projected onto the strip's axis, re-read every auto-scroll frame. */
  private dragPointerAlong = 0;
  private dragRaf = 0;
  /**
   * The one icon wearing `is-drop-target`, or null. Held as a field so
   * `markDropTarget` can take the mark off the previous icon without
   * querying the rail, and so a fast drag can never leave two icons lit.
   */
  private dropTargetEl: HTMLElement | null = null;
  /**
   * Whether this drag has already been told why it was refused.
   *
   * `dragover` is the only moment a refused drag can be spoken from (see
   * `fileDrop.onRefused`), and it fires once per few pixels of pointer travel,
   * so without this one notice becomes dozens. Reset in `clearDropTarget`,
   * which `main.ts` calls from `DragOrdering`'s drag-done callback. That
   * callback fires at the end of each drag the explorer published AND at the
   * start of the next one, which is what keeps this flag from surviving into a
   * drag it was not raised for -- the first reading of it, "the one callback
   * that learns every drag has ended however it ended", was not true, and a
   * `dragend` lost to a replaced source row left this stuck on while a stale
   * record was still offering its paths.
   */
  private refusalSpoken = false;
  /**
   * The one popover this view has open, or null.
   *
   * Held because `AnchoredPopover` adds four listeners to `document` that only
   * its own `close()` removes — nothing in Obsidian's component tree owns
   * them. `destroy()` is on `onunload`'s path (and on `mount()`'s, which runs
   * again on every rebind), so this field is what makes the popovers reachable
   * at teardown at all.
   */
  private popover: AnchoredPopover | null = null;

  constructor(
    private defs: DefinitionStore,
    private runtime: RuntimeStateStore,
    private controller: SpaceController,
    private onCreateClicked: () => void,
    /** Shown only while that space renders with Obsidian's sort. */
    private isSortOverridden: (key: ActiveSelection) => boolean,
    private onRestoreOrdering: (key: ActiveSelection) => void,
    /**
     * Everything the strip needs to answer a drag that did not start on it.
     *
     * One object rather than three loose parameters because they are a single
     * seam: the same record has to reach the `dragover` that lights the icon,
     * the `drop` that acts, and the explanation for the one refusal that is
     * voiced. Handing the paths alone to one of them and not the others is how
     * a clipped selection came to be half moved and reported as complete.
     */
    private fileDrop: {
      /** The live drag's paths AND whether that list may be short. */
      dragged: () => DraggedFiles;
      /**
       * Whether that path names a real folder in the vault right now.
       *
       * Asked rather than assumed because a folder space keeps its root string
       * after the folder is deleted -- the definition is kept so the space can
       * offer to repair itself -- and `spaceDropFor` is pure, has no `app`, and
       * so cannot find out on its own. Without it the icon lit for such a space
       * and every rename behind the drop then threw.
       */
      rootExists: (path: string) => boolean;
      /** Act on a drop this seam has already approved. */
      onDropped: (spaceId: string, drag: DraggedFiles) => void;
      /**
       * Say why a drop was refused, at most once per drag.
       *
       * Called from `dragover`, not `drop`, because a refused drag never
       * produces a `drop` to speak from: refusing means not calling
       * `preventDefault()`, and without that the browser fires no `drop` at
       * all. `dragover` is therefore the only moment the strip has, and it is
       * also the moment the user is still deciding.
       *
       * `spaceName` comes from the refusal rather than being looked up here,
       * so the words name the same space the decision was made about. Both
       * spoken refusals tell the user to do something else instead, and advice
       * that does not say WHICH space it is about is not advice when four icons
       * sit side by side.
       */
      onRefused: (reason: string, spaceName: string | null) => void;
    }
  ) {}

  /** The axis the strip's icons run along, for the current placement. */
  private get axis(): Axis {
    return axisFor(this.placement);
  }

  mount(parent: HTMLElement): void {
    this.destroy();
    this.host = parent;
    const el = parent.ownerDocument.win.createDiv();
    el.className = "spaces-switcher";
    parent.appendChild(el);
    this.el = el;
    applyDock(parent, this.placement);
    this.render();
    // Zoom, a theme swap and a font change all move the pane's rows without
    // going anywhere near a render, so alignment needs a second trigger.
    //
    // Observing the PANE cannot feed itself: the properties this writes
    // resize only the strip, which is absolutely positioned in a vertical
    // placement and so contributes nothing to the pane's own layout. That is
    // worth stating rather than assuming -- an observer on this pane whose
    // callback mutated inside it is exactly what once pegged the renderer.
    // `defaultView`, not Obsidian's `win`: the same cross-window handle the
    // drag's rAF loop uses, and the one the DOM lib types constructors on.
    const view = parent.ownerDocument.defaultView;
    if (view) {
      this.paneResize = new view.ResizeObserver(() => this.alignToPane());
      this.paneResize.observe(parent);
    }
  }

  destroy(): void {
    // A grip drag in flight holds pointer capture on an element this call is
    // about to remove; tearing that down first keeps the capture, the
    // preview and the temporary listeners from outliving the node.
    this.cancelDrag();
    // A drag in flight owns a requestAnimationFrame loop that re-arms
    // itself while `dragFromId` is set. Dropping the element without clearing
    // both would leave that loop running forever against a detached rail.
    this.dragFromId = null;
    this.dropTargetEl = null;
    this.stopDragScrolling?.();
    this.stopDragScrolling = null;
    // A picker anchored to one of these icons outlives the element it points
    // at otherwise, listeners and all.
    this.popover?.close();
    this.popover = null;
    // Outlives the element it measures otherwise, and a remount makes a new one.
    this.paneResize?.disconnect();
    this.paneResize = null;
    this.el?.remove();
    this.el = null;
    // A remount can land in a different pane. `mount()` calls `destroy()`
    // first, so this is what stops the pane we are leaving from going on
    // reserving side padding for a strip that has gone.
    clearDock(this.host);
    this.host = null;
  }

  /** Re-paints for a new placement. Cheap: one class swap, no re-render. */
  applyPlacement(placement: StripPlacement): void {
    this.placement = placement;
    if (this.host) applyDock(this.host, placement);
    // After the dock class, never before: alignment measures the strip in
    // the placement it is arriving at, not the one it is leaving.
    this.alignToPane();
  }

  isUnlocked(): boolean {
    return this.unlocked;
  }

  /** The pair of commands' shared setter. Re-renders so the grip appears or disappears immediately. */
  setUnlocked(on: boolean): void {
    // Locking is one of the ways a drag ends without committing -- calls
    // `cancelDrag()` directly rather than through `setStripPlacement`,
    // because this path must never touch a placement, only the lock.
    if (!on) this.cancelDrag();
    if (this.unlocked === on) return;
    this.unlocked = on;
    this.render();
  }

  /** The pane the strip is mounted in, in viewport coordinates -- null only while unmounted. */
  private paneRect(): PaneRect | null {
    return this.host?.getBoundingClientRect() ?? null;
  }

  /**
   * The strip's own cross-axis size, reused as the thickness of every
   * candidate preview band. Exact for the placement the strip is already in;
   * approximate for the other three, whose icons could measure differently
   * on the other axis -- but close enough to read as "the strip would go
   * here", which is all a preview needs to do.
   */
  private stripThickness(): number {
    const rect = this.el?.getBoundingClientRect();
    const measured = rect ? (this.axis === "y" ? rect.width : rect.height) : 0;
    return measured || 40;
  }

  /** The screen rectangle a candidate placement's preview band would cover. */
  private zoneRect(
    placement: StripPlacement,
    pane: PaneRect,
    thickness: number
  ): { left: number; top: number; width: number; height: number } {
    const width = pane.right - pane.left;
    const height = pane.bottom - pane.top;
    switch (placement) {
      case "top":
        return { left: pane.left, top: pane.top, width, height: thickness };
      case "bottom":
        return { left: pane.left, top: pane.bottom - thickness, width, height: thickness };
      case "left":
        return { left: pane.left, top: pane.top, width: thickness, height };
      case "right":
        return { left: pane.right - thickness, top: pane.top, width: thickness, height };
    }
  }

  /**
   * Paints the four candidate bands once a drag has passed the threshold.
   *
   * Not painted at `pointerdown`: a click that never moves must show nothing
   * at all, so nothing is built until `passedThreshold` says this is really
   * a drag.
   */
  private paintPreview(drag: DragState): void {
    const pane = this.paneRect();
    if (!pane) return;
    const doc = drag.grip.ownerDocument;
    const overlay = doc.win.createDiv({ cls: "spaces-strip-drop-overlay" });
    const thickness = this.stripThickness();
    for (const placement of PLACEMENTS) {
      const zone = overlay.createDiv({ cls: "spaces-strip-drop-zone" });
      const rect = this.zoneRect(placement, pane, thickness);
      // Dynamic per drag frame, computed from the pane's live rect -- not
      // the static assignment `obsidianmd/no-static-styles-assignment` bars.
      zone.style.left = `${rect.left}px`;
      zone.style.top = `${rect.top}px`;
      zone.style.width = `${rect.width}px`;
      zone.style.height = `${rect.height}px`;
      drag.zones[placement] = zone;
    }
    doc.body.appendChild(overlay);
    drag.overlay = overlay;
  }

  /** Moves the highlight to the nearest candidate; the other three stay dim. */
  private markActive(drag: DragState, target: StripPlacement): void {
    drag.target = target;
    for (const placement of PLACEMENTS) {
      drag.zones[placement]?.classList.toggle("is-active", placement === target);
    }
  }

  private pointOf(e: PointerEvent): Point {
    return { x: e.clientX, y: e.clientY };
  }

  private insidePane(point: Point, pane: PaneRect): boolean {
    return (
      point.x >= pane.left && point.x <= pane.right && point.y >= pane.top && point.y <= pane.bottom
    );
  }

  /**
   * Starts tracking the grab handle.
   *
   * Primary pointer, left button only: a right-click must reach the grip's
   * own `contextmenu` handler below and start nothing here. A second pointer
   * arriving while the first is already down is ignored outright -- it does
   * not steal the gesture or restart it.
   */
  private onGripPointerDown(e: PointerEvent, grip: HTMLElement): void {
    if (!e.isPrimary || e.button !== 0) return;
    if (this.drag) return;
    const pointerId = e.pointerId;
    // An optimisation, not a prerequisite: the listeners below are on the
    // grip and the document, so the drag still works without capture -- it
    // only stops tracking once the pointer leaves the element. Guarded
    // because a pointer that is no longer active by the time this runs makes
    // `setPointerCapture` throw `NotFoundError`, and losing capture must not
    // cost the gesture (nor leave an uncaught exception in the console). This
    // also means a synthetic `PointerEvent` with an id that was never a real
    // active pointer cannot drive capture in a test -- the rest of the
    // gesture still runs.
    try {
      grip.setPointerCapture(pointerId);
    } catch {
      // Deliberately empty: see above.
    }
    const onMove = (ev: PointerEvent): void => this.onGripPointerMove(ev);
    const onUp = (ev: PointerEvent): void => this.onGripPointerUp(ev);
    const onCancel = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) this.cancelDrag();
    };
    const onLostCapture = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) this.cancelDrag();
    };
    const onKeydown = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") this.cancelDrag();
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onCancel);
    grip.addEventListener("lostpointercapture", onLostCapture);
    grip.ownerDocument.addEventListener("keydown", onKeydown);
    this.drag = {
      pointerId,
      origin: this.pointOf(e),
      started: false,
      target: null,
      grip,
      overlay: null,
      zones: {},
      onMove,
      onUp,
      onCancel,
      onLostCapture,
      onKeydown,
    };
  }

  /** Below the threshold this is still a click; past it, paints and tracks the preview. */
  private onGripPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const point = this.pointOf(e);
    if (!drag.started) {
      if (!passedThreshold(drag.origin, point)) return;
      drag.started = true;
      this.paintPreview(drag);
    }
    const pane = this.paneRect();
    if (!pane) return;
    this.markActive(drag, nearestPlacement(point, pane));
  }

  /**
   * A release that never passed the threshold is a click, and a click on the
   * grip does nothing. A release past the threshold commits, but only when
   * it lands inside the pane the drag started in -- outside it, it cancels
   * the same as Escape does.
   */
  private onGripPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.started || !drag.target) {
      this.endGripDrag();
      return;
    }
    const pane = this.paneRect();
    const point = this.pointOf(e);
    if (!pane || !this.insidePane(point, pane)) {
      this.cancelDrag();
      return;
    }
    const target = drag.target;
    // Torn down BEFORE the write: `setStripPlacement`'s own `onCancelDrag`
    // argument calls back into `cancelDrag()`, which must find no drag left
    // to cancel, or a slow write could look like a second interaction.
    this.endGripDrag();
    void setStripPlacement(this.defs, target, () => this.cancelDrag());
  }

  /** Right-click the grip: lock, without starting a drag. */
  private onGripContextMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const menu = new Menu();
    // Only lock is offered: when the strip is locked there is no grip to
    // right-click, so the inverse can never be reached from here.
    menu.addItem((mi) =>
      mi
        .setIcon("lock")
        .setTitle("Lock the space strip")
        .onClick(() => this.setUnlocked(false))
    );
    menu.showAtMouseEvent(e);
  }

  /**
   * The only early exit from a drag. Idle-safe, so every caller -- Escape,
   * a lost capture, a release outside the pane, `setUnlocked(false)`, a
   * re-render, `destroy()`, or a placement written from Settings or a
   * command while a drag is in flight -- can reach for it without first
   * checking whether one is even running. Never persists anything: that is
   * `setStripPlacement`'s job alone, reached only from a commit.
   */
  cancelDrag(): void {
    this.endGripDrag();
  }

  /**
   * The one teardown, run by both the cancel path and the commit path.
   * Removes the preview, detaches the temporary listeners, releases capture
   * and clears `this.drag` -- guarded so a second call, however it arrives,
   * neither commits nor cleans up twice.
   *
   * Named distinctly from the reorder feature's own `endDrag(rail, line)`
   * below: the two are unrelated gestures (this one moves the whole strip,
   * that one reorders icons within it) that happen to share a name for the
   * same idea.
   */
  private endGripDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    drag.grip.removeEventListener("pointermove", drag.onMove);
    drag.grip.removeEventListener("pointerup", drag.onUp);
    drag.grip.removeEventListener("pointercancel", drag.onCancel);
    drag.grip.removeEventListener("lostpointercapture", drag.onLostCapture);
    drag.grip.ownerDocument.removeEventListener("keydown", drag.onKeydown);
    if (drag.grip.hasPointerCapture(drag.pointerId)) {
      drag.grip.releasePointerCapture(drag.pointerId);
    }
    drag.overlay?.remove();
  }

  /**
   * One popover at a time. The capture-phase `mousedown` in `AnchoredPopover`
   * already dismisses the open one on the click that opens the next, so this
   * mostly restates an existing guarantee — but it holds it without depending
   * on a pointer event, which the keyboard routes into these menus do not
   * produce.
   */
  private show(popover: AnchoredPopover): void {
    this.popover?.close();
    this.popover = popover;
  }

  render(): void {
    const el = this.el;
    if (!el) return;
    // Rebuilds every child below, including the grip a drag in flight is
    // holding pointer capture on. Tearing the drag down first is what keeps
    // that capture, and the preview it painted, from being left dangling on
    // a node this call is about to detach.
    this.cancelDrag();
    // Read BEFORE the line below destroys the element holding it. Everything
    // in the strip that can take focus carries a `data-switcher-key`, so what
    // is recorded is an identity rather than a position in a list this render
    // may be about to change the length of.
    const refocus = this.focusedKey();
    el.replaceChildren();
    // That line just destroyed every icon a picker could be anchored to, and
    // destroying a node fires nothing. This is the moment to notice: deleting
    // a custom color chip re-renders the strip from the definitions
    // subscription, which would otherwise leave the color picker floating
    // over an anchor that is no longer in the document.
    this.popover?.closeIfAnchorDetached();

    // One list, read by the strip, the header and the header's
    // dropdown. Inline copies of it drifted the moment a third reader existed.
    const entries = spaceEntries(
      this.defs.get().spaces,
      this.runtime.getSelection(),
      knownIconIds()
    );

    // Layout only. `pinned` is mounted OUTSIDE the rail, so the other
    // icons scroll past it instead of taking it with them.
    const { pinned, railed } = splitPinnedEntry(entries, this.defs.get().settings.pinAllSpace);

    if (pinned) {
      el.appendChild(this.buildItem(pinned));
      // Rendered only while something is pinned. A permanent rule that
      // sometimes separates nothing is worse than no rule — and without one,
      // icons scrolling under the pinned control look like they are vanishing
      // at an invisible edge.
      const divider = el.ownerDocument.win.createDiv();
      divider.className = "spaces-switcher-divider";
      el.appendChild(divider);
    }

    // The icons scroll, the + does not. A `margin-left: auto` child of
    // an `overflow-x: auto` flex row scrolls away with the icons, which is
    // precisely when a create control is most wanted.
    const rail = el.ownerDocument.win.createDiv();
    rail.className = "spaces-switcher-rail";
    el.appendChild(rail);

    for (const entry of railed) {
      rail.appendChild(this.buildItem(entry));
    }
    // Space reordering is HTML5 drag, which a touch pointer never starts. Building
    // the insertion line and three listeners for a gesture that cannot happen
    // is not merely wasted — the line is a child of the rail that `spaceEls()`
    // has to keep excluding, and `destroy()` has to keep unwinding. Gated on
    // `Platform`, Obsidian's own answer, rather than on a media query: the
    // question is what the device can DO, not how wide it is.
    if (!Platform.isMobile) this.wireReorder(rail);
    // Not gated on `Platform`: a wheel is a mouse, and a tablet with a mouse
    // attached is still a device this has to work on. One listener either way.
    this.wireWheel(rail);

    const add = el.ownerDocument.win.createDiv();
    add.className = "clickable-icon spaces-switcher-add";
    add.setAttribute("role", "button");
    add.setAttribute("tabindex", "0");
    add.setAttribute("aria-label", "Create a space");
    add.dataset.switcherKey = ADD_FOCUS_KEY;
    setIcon(add, "plus");
    add.addEventListener("click", () => this.onCreateClicked());
    add.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.onCreateClicked();
      }
    });
    el.appendChild(add);

    // Inserted first regardless of what has already been appended above:
    // `applyUnlockState` puts the grip at `el.firstChild`, so it reads as
    // pinned to the leading edge ahead of a pinned *All* control too.
    const grip = applyUnlockState(el, this.unlocked);
    if (grip) {
      grip.dataset.switcherKey = GRIP_FOCUS_KEY;
      setIcon(grip, this.axis === "y" ? "grip-horizontal" : "grip-vertical");
      // Rebuilt every render, so these are re-wired every time rather than
      // once: `applyUnlockState` returns a fresh element whenever the strip
      // was locked a moment ago, and the listeners of a discarded grip are
      // discarded with it.
      grip.addEventListener("pointerdown", (e) => this.onGripPointerDown(e, grip));
      grip.addEventListener("contextmenu", (e) => this.onGripContextMenu(e));
    }

    this.revealActive(rail);
    // Both classes are set every render, not just the chosen one: the element
    // survives a render, so a switch from Boxed to Bolded that only added
    // would leave the strip wearing both and drawing both looks at once.
    const styleClass = activeStyleClass(this.defs.get().settings.activeSpaceStyle);
    el.classList.toggle(BOXED_CLASS, styleClass === BOXED_CLASS);
    el.classList.toggle(BOLDED_CLASS, styleClass === BOLDED_CLASS);
    // Last: every box it measures was created above.
    this.alignToPane();
    // After alignment, because focusing a control inside the scrolling rail
    // scrolls it into view and the padding written above changes where that
    // is.
    this.restoreFocus(refocus);
  }

  /**
   * The key of the strip control holding focus, or null when focus is
   * elsewhere.
   *
   * Null is the ordinary answer: `document.activeElement` is the body when
   * nothing is focused, and the strip does not contain the body.
   */
  private focusedKey(): string | null {
    const el = this.el;
    const active = el?.ownerDocument.activeElement;
    if (!el || !active || !el.contains(active) || !active.instanceOf(HTMLElement)) {
      return null;
    }
    // A control inside the strip with no key of its own falls back to the add
    // button rather than to nothing: focus was demonstrably in the strip, and
    // dropping it to `<body>` is the failure this method exists to prevent.
    return active.dataset.switcherKey ?? ADD_FOCUS_KEY;
  }

  /**
   * Put focus back on the control `focusedKey()` named, after the rebuild
   * that destroyed it.
   *
   * Does nothing for a null key, which is what keeps a render from STEALING
   * focus: the strip re-renders on every definitions change, including ones
   * the user caused from the settings tab or from another window, and pulling
   * the caret out of whatever they were typing in would be worse than the bug
   * this fixes.
   *
   * A space that has gone — deleted from the settings tab, or by a `data.json`
   * arriving from another device — falls back to the add button. It is the one
   * control the strip always has, and it is what the user is now nearest to
   * doing.
   */
  private restoreFocus(key: string | null): void {
    const el = this.el;
    if (!el || key === null) return;
    const match = el.querySelector<HTMLElement>(
      `[data-switcher-key="${CSS.escape(key)}"]`
    );
    const add = el.querySelector<HTMLElement>(
      `[data-switcher-key="${ADD_FOCUS_KEY}"]`
    );
    (match ?? add)?.focus();
  }

  /**
   * Line the strip's two fixed parts up with the rows of the pane beside it.
   * Measures; `stripAlign.ts` decides.
   *
   * Cheap enough to run on every render: four `getBoundingClientRect` calls
   * and two property writes, against a strip that has just been rebuilt.
   */
  private alignToPane(): void {
    const el = this.el;
    const pane = this.host;
    if (!el || !pane) return;

    // Three ways to have no opinion, all of which keep the stylesheet's own
    // spacing:
    //
    // - a horizontal strip already reads correctly
    // - with nothing pinned there is no fixed control to sit beside the
    //   toolbar; every icon scrolls, so no position would stay aligned
    // - while UNLOCKED the grip is inserted ahead of the pinned control and
    //   pushes everything past where alignment can reach. Both offsets would
    //   clamp to their floors and sit the divider flush against its
    //   neighbours, which looks worse than simply not aligning. Alignment
    //   describes the resting state; the editing mode keeps the design
    //   spacing and gets it back on lock.
    if (this.axis !== "y" || this.unlocked || !this.defs.get().settings.pinAllSpace) {
      writePx(el, PROP_PAD_TOP, null);
      writePx(el, PROP_RAIL_GAP, null);
      return;
    }

    const header = pane.querySelector(CLS_SPACE_HEADER);
    const rail = el.querySelector<HTMLElement>(".spaces-switcher-rail");
    const out = stripAlignment({
      toolbarCentre: centreOf(pane.querySelector(SEL.navHeader)),
      // The header when it is shown, the first tree row when it is not:
      // whichever row the pane actually puts below the toolbar.
      anchorCentre: centreOf(header ?? pane.querySelector(`${SEL.container} ${SEL.treeRow}`)),
      // The pinned control is the strip's own child; the rail's icons are not.
      pinned: boxOf(el.querySelector(":scope > .spaces-switcher-item")),
      firstIcon: boxOf(el.querySelector(".spaces-switcher-rail > .spaces-switcher-item")),
      currentPadTop: readPx(el, PROP_PAD_TOP, DESIGN_PAD_TOP),
      currentRailGap: readPx(el, PROP_RAIL_GAP, DESIGN_RAIL_GAP),
      // The rail scrolls once the spaces outrun the pane, and the icon's rect
      // scrolls with it. Alignment is about the rail's origin, not its
      // current scroll position.
      railScroll: rail?.scrollTop ?? 0,
    });

    // Computed from live rects, not static values, so this is not a
    // `no-static-styles-assignment` violation -- the same reason the drag
    // preview sets its coordinates inline.
    writePx(el, PROP_PAD_TOP, out.padTop);
    writePx(el, PROP_RAIL_GAP, out.railGap);
  }

  /**
   * Scroll the rail with the wheel when the rail runs horizontally.
   *
   * A mouse wheel reports `deltaY`, and Chromium will not hand that to a
   * scroller that only scrolls on X, so a docked-top or docked-bottom rail
   * overflowed with no way to reach the icons past the edge. `railWheelDelta`
   * holds the rule; this projects the event and applies the answer.
   *
   * Attached to the rail, which is rebuilt on every render, so the listener
   * dies with the element it was added to and nothing has to unwind it. The
   * axis is read per event rather than per wiring because `this.axis` tracks
   * the live placement, which can change without rebuilding the rail.
   */
  private wireWheel(rail: HTMLElement): void {
    rail.addEventListener(
      "wheel",
      (e) => {
        const vertical = this.axis === "y";
        // A vertical rail already agrees with the wheel; leaving it to the
        // browser keeps its scroll smoothing and its end-of-scroll handoff.
        if (vertical) return;
        const delta = railWheelDelta({
          along: e.deltaX,
          across: e.deltaY,
          scroll: rail.scrollLeft,
          scrollSize: rail.scrollWidth,
          clientSize: rail.clientWidth,
        });
        // Zero means "not ours": the rail does not overflow, or it is already
        // at the end the wheel points at. Returning without cancelling lets
        // the event reach the pane, so the file tree still scrolls.
        if (delta === 0) return;
        e.preventDefault();
        rail.scrollLeft += delta;
      },
      // Not passive: the whole point is to cancel the default so the wheel
      // does not scroll an ancestor at the same time.
      { passive: false }
    );
  }

  /**
   * Drag a space icon to reorder it.
   *
   * Every rule lives in `spaceReorder.ts`; this measures, renders and writes.
   *
   * Rebuilt with the rail on each render, and a render CAN land mid-drag:
   * `main.ts` calls it on every file open and every coalesced vault flush, not
   * only after a write of its own. Rebuilding is still safe for the listeners
   * themselves, which are discarded with the rail they were on while the drag
   * state lives on the view -- but it is exactly why that state holds the
   * dragged space by ID and re-derives its index per use. See `dragFromId`.
   */
  private wireReorder(rail: HTMLElement): void {
    const line = rail.ownerDocument.win.createDiv();
    line.className = CLS_SPACE_DROP_LINE;
    line.hidden = true;
    rail.appendChild(line);

    /** The draggable icons, in `spaces` order, with the line excluded. */
    const spaceEls = (): HTMLElement[] =>
      Array.from(rail.querySelectorAll<HTMLElement>("[data-space-id]"));

    /** The rail's current scroll offset along its own axis. */
    const railScrollAlong = (): number =>
      this.axis === "x" ? rail.scrollLeft : rail.scrollTop;

    /** Boxes in the rail's CONTENT coordinates, so they survive scrolling. */
    const boxesOf = (els: readonly HTMLElement[], railSpan: Span): ItemBox[] =>
      els.map((e) => {
        const span = spanOf(e.getBoundingClientRect(), this.axis);
        return { start: span.start - railSpan.start + railScrollAlong(), size: span.size };
      });

    const update = (): void => {
      // Null for "no drag in flight" and for "the space being dragged is no
      // longer in the definitions". Both mean there is no line to draw, and
      // the second has to HIDE one that is already showing rather than leave
      // it pointing at a position that no longer means anything.
      const from = this.draggedIndex();
      if (from === null) {
        line.hidden = true;
        return;
      }
      const vertical = this.axis === "y";
      const railSpan = spanOf(rail.getBoundingClientRect(), this.axis);
      const boxes = boxesOf(spaceEls(), railSpan);
      const contentPointer = this.dragPointerAlong - railSpan.start + railScrollAlong();
      const index = insertionIndexAt(contentPointer, boxes);
      // A drop that changes nothing draws no line.
      if (isNoOpMove(from, index)) {
        line.hidden = true;
        return;
      }
      // Only the coordinate along the axis is dynamic. The thickness/length
      // swap and the cross-axis anchor for a vertical rail are static, so
      // they live in CSS (`.spaces-dock-left/right .spaces-space-drop-line`)
      // rather than as an inline assignment here.
      const pos = Math.round(gapCenterAt(index, boxes)) - 1;
      if (vertical) line.style.top = `${pos}px`;
      else line.style.left = `${pos}px`;
      line.hidden = false;
    };

    const stopScrolling = (): void => {
      if (this.dragRaf) rail.ownerDocument.defaultView?.cancelAnimationFrame(this.dragRaf);
      this.dragRaf = 0;
    };

    const tick = (): void => {
      this.dragRaf = 0;
      const reordering = this.dragFromId !== null;
      // A file drag scrolls the rail too, so an icon off the end is reachable
      // without letting go. It draws no line: there is no gap to point at.
      if (!reordering && this.fileDrop.dragged().paths.length === 0) return;
      const vertical = this.axis === "y";
      const railSpan = spanOf(rail.getBoundingClientRect(), this.axis);
      const step = edgeScrollStep(this.dragPointerAlong, railSpan);
      if (step !== 0) {
        if (vertical) rail.scrollTop += step;
        else rail.scrollLeft += step;
      }
      // Recomputed every frame, not only on pointer movement: the pointer can
      // be perfectly still while the rail moves under it, and the gap it points
      // at changes anyway.
      if (reordering) update();
      if (step !== 0) startScrolling();
    };

    const startScrolling = (): void => {
      if (this.dragRaf) return;
      const view = rail.ownerDocument.defaultView;
      if (view) this.dragRaf = view.requestAnimationFrame(tick);
    };

    rail.addEventListener("dragover", (e) => {
      if (this.dragFromId === null) {
        // A drag that did not start on the strip. The only one we act on is a
        // file drag over an icon that would do something; everything else
        // falls through untouched, so the event reaches whatever is beneath.
        const drag = this.fileDrop.dragged();
        // Nothing published means the drag did not start in the file tree: a
        // tab being torn off, a selection dragged out of the editor, a file
        // from the desktop. Every one of those crosses this rail and reaches
        // this listener, several times a second.
        //
        // Checked FIRST, before the auto-scroll is armed. `startScrolling`
        // used to run for all of them, scheduling a frame whose `tick` opened
        // by asking this same question and returning -- one wasted rAF per
        // dragover event, for drags that have nothing to do with spaces.
        if (drag.paths.length === 0) return;
        const over = this.spaceElAt(e.target);
        const target = dropTargetFor(null, this.spaceFor(over), drag, this.fileDrop.rootExists);
        if (target !== null && target.kind === "refuse") {
          // Aimed at a space, and refused for a reason the user cannot see.
          // The icon stays dark -- lighting one that then refuses is the
          // failure this seam exists to prevent -- so the words are the only
          // feedback there is. No scroll either: there is nothing further
          // along the rail that this drag could reach and act on.
          this.markDropTarget(null);
          if (!this.refusalSpoken) {
            this.refusalSpoken = true;
            this.fileDrop.onRefused(target.reason, target.spaceName ?? null);
          }
          return;
        }
        this.markDropTarget(target === null ? null : over);
        // Refreshed on EVERY file-drag dragover, lit icon or not. The scroll
        // tick reads this value every frame, and a pointer over the gap
        // between two icons is still a real position. Left stale, the tick
        // would keep scrolling against wherever the pointer last lit an icon.
        this.dragPointerAlong = pointerAlong(e, this.axis);
        startScrolling();
        if (target === null) return;
        // Same reason the reorder branch cancels: nothing permits a drop in
        // our own strip, and without this the `drop` event never fires.
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = target.kind === "move" ? "move" : "copy";
        }
        return;
      }
      // Calling `preventDefault()` here must not happen for the FILE TREE,
      // where Obsidian's own handler already permits the drop. Nothing
      // permits a drop in our own strip, though, and without cancelling here
      // the `drop` event never fires at all. Scoped to a space drag we
      // started: `dragFromId` is null for every other drag crossing this
      // element, including a note dragged out of the explorer.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      this.dragPointerAlong = pointerAlong(e, this.axis);
      update();
      startScrolling();
    });

    rail.addEventListener("drop", (e) => {
      if (this.dragFromId === null) {
        // Stopped here rather than left to end when `onDragDone` clears the
        // paths a frame later, so this does not depend on another
        // component's timing.
        stopScrolling();
        const over = this.spaceElAt(e.target);
        // Re-asked HERE against the definitions as they are at the drop, the
        // same discipline the reorder uses for its index: a space deleted
        // while the drag was in flight resolves to null and refuses.
        // The record is read here, during the drop, because DragOrdering
        // declines a drop on the strip and so it is still live; a claimed drop
        // would already have cleared it.
        const drag = this.fileDrop.dragged();
        const target = dropTargetFor(null, this.spaceFor(over), drag, this.fileDrop.rootExists);
        this.markDropTarget(null);
        // A refusal cannot reach here -- `dragover` never called
        // `preventDefault()` for one, so the browser fired no `drop` -- but it
        // is checked rather than assumed, because the cost of being wrong is an
        // irreversible move and the cost of checking is one comparison.
        if (target === null || target.kind === "refuse") return;
        e.preventDefault();
        this.fileDrop.onDropped(target.spaceId, drag);
        return;
      }
      e.preventDefault();
      const railSpan = spanOf(rail.getBoundingClientRect(), this.axis);
      const boxes = boxesOf(spaceEls(), railSpan);
      const pointer = pointerAlong(e, this.axis) - railSpan.start + railScrollAlong();
      const index = insertionIndexAt(pointer, boxes);
      // Re-derived HERE, against the definitions as they are at the drop
      // rather than as they were at the dragstart. Null means the space was
      // deleted while the drag was in flight: there is no position to compute
      // and nothing the user could have meant, so nothing is written.
      const from = this.draggedIndex();
      this.endDrag(rail, line);
      if (from === null) return;
      if (isNoOpMove(from, index)) return;
      void this.defs
        .mutate((d) => {
          d.spaces = moveTo(d.spaces, from, index);
        })
        .catch((err) => {
          console.error("Spaces: reordering spaces failed", err);
        });
    });

    // Fires whether the drag ended in a drop, outside the strip, or on Escape,
    // so it is the only teardown guaranteed to run for a REORDER, whose source
    // is an icon in this rail. A file drag's source is a tree row the rail never
    // hears `dragend` from; that one is torn down through `clearDropTarget`,
    // called from the plugin's drag-done callback.
    rail.addEventListener("dragend", () => this.endDrag(rail, line));

    rail.addEventListener("dragleave", (e) => {
      // Only when the pointer actually left the rail, not when it crossed
      // between two icons inside it.
      // Through `asNode`, not `instanceof Node`: a node from a popout window
      // fails the global check, which would clear the mark on every crossing.
      const into = this.asNode(e.relatedTarget);
      if (into && rail.contains(into)) return;
      this.markDropTarget(null);
      // The pointer has left, so `dragPointerAlong` is now stale. Without
      // this the tick keeps scrolling against it, re-arming every frame even
      // at the scroll limit, for as long as the drag lives over the tree.
      stopScrolling();
    });
    this.stopDragScrolling = stopScrolling;
  }

  /**
   * Where the dragged space sits in `spaces` right now, or null when no drag
   * is running or the space is no longer in the definitions.
   *
   * Asked per use rather than cached, because the whole point is that the
   * answer can change between the dragstart that set `dragFromId` and the drop
   * that spends it.
   */
  private draggedIndex(): number | null {
    const id = this.dragFromId;
    if (id === null) return null;
    const at = this.defs.get().spaces.findIndex((sp) => sp.id === id);
    return at < 0 ? null : at;
  }

  /**
   * An event target as a `Node`, or null. Uses Obsidian's cross-window
   * `instanceOf`: the global `Node` is a different constructor in a popout
   * window, so `instanceof` would refuse every node there. The typeof test
   * is for targets that are not nodes at all (a `Window`), which lack it.
   */
  private asNode(target: EventTarget | null): Node | null {
    const node = target as Node | null;
    return node && typeof node.instanceOf === "function" && node.instanceOf(Node) ? node : null;
  }

  /** The icon under the pointer, or null when the pointer is between them. */
  private spaceElAt(target: EventTarget | null): HTMLElement | null {
    const node = this.asNode(target);
    if (!node) return null;
    const el = node.instanceOf(HTMLElement) ? node : node.parentElement;
    const item = el?.closest<HTMLElement>(".spaces-switcher-item") ?? null;
    // *All* and the `+` carry no `spaceId`, which is what makes them decline.
    return item?.dataset.spaceId === undefined ? null : item;
  }

  private spaceFor(el: HTMLElement | null): SpaceDefinition | null {
    const id = el?.dataset.spaceId;
    if (id === undefined) return null;
    return this.defs.get().spaces.find((s) => s.id === id) ?? null;
  }

  /** At most one icon wears the mark, so a fast drag cannot leave two lit. */
  private markDropTarget(el: HTMLElement | null): void {
    if (this.dropTargetEl === el) return;
    this.dropTargetEl?.classList.remove("is-drop-target");
    el?.classList.add("is-drop-target");
    this.dropTargetEl = el;
  }

  /**
   * Takes the drop mark off, for a drag that ended without the pointer ever
   * leaving the icon -- Escape, or a drop refused elsewhere. `dragend` fires on
   * the drag SOURCE, a row in the file tree, so the rail never hears it.
   *
   * `dragleave` is not a substitute. The HTML spec does fire one before
   * `dragend` when a drag is cancelled, so it covers the Escape case, but it
   * says nothing about a drop the browser delivered elsewhere and it is
   * `relatedTarget`-dependent (see the listener). `main.ts` calls this from
   * `DragOrdering`'s drag-done callback, which fires at the end of each drag
   * the explorer published and again at the start of the next one. The older
   * wording here, "the one callback that learns every drag has ended, however
   * it ended", claimed more than that callback could deliver: a `dragend` sent
   * to a source row the tree had already replaced reached nothing at all.
   */
  clearDropTarget(): void {
    this.markDropTarget(null);
    // The next drag gets its own explanation. Reset here rather than at a
    // drag's start, because the strip has no start to hook: a file drag begins
    // on a tree row this view never hears from.
    this.refusalSpoken = false;
    // Stopped here so the guarantee is local: the loop would also end once the
    // published paths go empty, but that rests on the caller's call order.
    this.stopDragScrolling?.();
  }

  /** Set by `wireReorder`; torn down with the view. */
  private stopDragScrolling: (() => void) | null = null;

  private endDrag(rail: HTMLElement, line: HTMLElement): void {
    this.dragFromId = null;
    this.markDropTarget(null);
    line.hidden = true;
    this.stopDragScrolling?.();
    rail
      .querySelectorAll(`.${CLS_SPACE_DRAGGING}`)
      .forEach((e) => e.classList.remove(CLS_SPACE_DRAGGING));
  }

  /**
   * One control, whether it ends up in the rail or pinned beside it.
   *
   * Shared deliberately. A second hand-rolled copy of the *All* item is exactly
   * how the strip and the dropdown drifted apart before `spaceEntries.ts`
   * existed, and a pinned control that quietly lost `is-active`, its
   * `aria-label` or its pending state would be that mistake again in miniature.
   * The rule that *All* has no context menu survives for free: the gate is
   * on `entry.key.kind`, not on where the element is mounted.
   */
  private buildItem(entry: SpaceEntry): HTMLElement {
    const el = this.el as HTMLElement;
    const item = el.ownerDocument.win.createDiv();
    // `clickable-icon` is Obsidian's own. It carries the color, radius and
    // hover a theme restyles, so without it a theme has no selector that
    // reaches this control. Ours carries size, position and state.
    item.className = "clickable-icon spaces-switcher-item";
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    // Name in the label, never color alone (spec section 9.6).
    // `aria-label` and NOTHING ELSE. Obsidian renders its own tooltip
    // from this attribute — its nav buttons and ribbon actions carry an
    // aria-label and no `title` at all — so adding `title` too produced a
    // second, OS-drawn tooltip stacked on the first.
    item.setAttribute("aria-label", entry.label);
    // What `render()` refocuses by. Stable across a rebuild and across a
    // change in how many icons there are, which an index would not be. Set on
    // EVERY item, including *All* and including a mobile build, because this
    // is about the keyboard rather than about dragging — `data-space-id`
    // beside it is the drag's own marker and is neither.
    item.dataset.switcherKey = focusKeyFor(entry.key);
    // `iconColorFor` answers this for every surface that draws a space icon.
    // A real color is the user's data and goes inline, where it wins over a
    // theme's rule. The neutral swatch means no color was chosen, so nothing
    // is written and `--icon-color` applies.
    const painted = iconColorFor(
      entry.color,
      this.defs.get().settings.useThemeIconColor
    );
    if (painted) item.style.color = painted;

    if (entry.active) {
      item.classList.add("is-active");
      item.setAttribute("aria-current", "true");
    }

    // The fallback is already applied by `spaceEntries`, so an id this
    // build cannot draw arrives here as `box` rather than rendering a BLANK
    // button with no clue why.
    setIcon(item, entry.icon);

    // No in-flight dedupe flag is needed here: `SpaceController.switchTo`'s
    // "already active" check runs INSIDE the queue, against the selection as
    // it is when the work actually starts, so two fire-and-forget clicks on
    // the same new target still only enqueue one real recompute — the second
    // resolves to "already there" and returns without doing anything. A local
    // flag would only restate a guarantee the controller already makes for
    // every caller, not only this one.
    const activate = async (): Promise<void> => {
      item.classList.add("is-pending");
      try {
        await this.controller.switchTo(entry.key);
      } catch (e) {
        console.error("Spaces: switching space failed", e);
      } finally {
        this.render();
      }
    };
    item.addEventListener("click", () => void activate());
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void activate();
      }
    });

    // Right-click a space to change its icon. Only a space — All has no
    // icon of its own to change, and offering the menu there would imply it
    // did. The rows come from `iconMenuItems`, which owns the rule that
    // exactly one is checked; this loop renders them and nothing more.
    //
    // No teardown needed: `render()` rebuilds these elements wholesale, so
    // the listener dies with the node it is on.
    if (entry.key.kind === "space") {
      const spaceId = entry.key.id;

      // Only a SPACE is draggable. *All* is not in the `spaces` array
      // and has no position to move; the `+` is a control, not a space.
      //
      // And only on a pointer that can drag. `draggable` is worse than
      // inert on touch — a long press on it hands the gesture to the browser's
      // own drag/selection machinery instead of opening the context menu this
      // item wants, so an attribute that does nothing useful would take away
      // something that works. The reorder itself stays desktop-only; a touch
      // equivalent is a feature, not a fix.
      if (!Platform.isMobile) {
        item.dataset.spaceId = spaceId;
        item.draggable = true;
      }
      item.addEventListener("dragstart", (e) => {
        // The ID, not the position it currently has. See `dragFromId`.
        this.dragFromId = spaceId;
        this.dragPointerAlong = pointerAlong(e, this.axis);
        item.classList.add(CLS_SPACE_DRAGGING);
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          // Some browsers fire no `drop` at all unless the drag carries data.
          // The payload is never read back -- `dragFromId` is the source of
          // truth, and trusting a string from the event would let any outside
          // drag claiming this type reorder the strip.
          e.dataTransfer.setData("text/plain", spaceId);
        }
      });
      const currentIcon = entry.icon;
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = new Menu();
        // First, because renaming is the commonest of the three. Its
        // own popover rather than the header's inline editor — this menu is
        // offered on EVERY icon, but the header shows only the active space,
        // so routing through it would rename the wrong one.
        menu.addItem((mi) =>
          mi
            .setIcon("pencil")
            .setTitle("Rename space…")
            .onClick(() => {
              this.show(
                openRenamePopover({
                  anchor: item,
                  current: entry.label,
                  apply: (name) => renameSpace(this.defs, spaceId, name),
                })
              );
            })
        );
        menu.addItem((mi) =>
          mi
            .setIcon("image")
            .setTitle("Change space icon…")
            .onClick(() => {
              // Anchored to the switcher item itself, so the popover opens
              // where the space lives rather than in the middle of the app.
              this.show(
                openIconPicker(item, currentIcon, (icon) =>
                  setSpaceIcon(this.defs, spaceId, icon)
                )
              );
            })
        );
        menu.addItem((mi) =>
          mi
            .setIcon("palette")
            .setTitle("Change space color…")
            .onClick(() => {
              this.show(
                openColorPicker({
                  anchor: item,
                  current: entry.color ?? "",
                  customs: this.defs.get().settings.customColors,
                  apply: (color) => setSpaceColor(this.defs, spaceId, color),
                  saveCustoms: (customs) =>
                    this.defs.mutate((d) => {
                      d.settings.customColors = customs;
                    }),
                })
              );
            })
        );
        // Only while this space is actually overridden. A permanently
        // present row that usually does nothing teaches nothing.
        if (this.isSortOverridden(entry.key)) {
          menu.addItem((mi) =>
            mi
              .setIcon("rotate-ccw")
              .setTitle("Restore saved ordering")
              .onClick(() => this.onRestoreOrdering(entry.key))
          );
        }
        menu.showAtMouseEvent(e);
      });
    }

    return item;
  }

  /**
   * Brings the active control into view when the rail overflows.
   *
   * Without this, the promise that "a space is never unreachable because it
   * does not fit" held only for reaching a space by scrolling to it, and not
   * for the space you are already IN: switching by command, by the header's
   * dropdown, or by creating a space lit up a control outside the visible
   * range with nothing bringing it back.
   *
   * `railScrollOffset` returns the current offset unchanged when the control
   * is already wholly visible, so this is a no-op on the common path — which
   * matters, because `render()` runs on every switch and every definitions
   * change.
   */
  private revealActive(rail: HTMLElement): void {
    // Scoped to the RAIL, which is also why pinning needed no change
    // here. With *All* pinned and active, the element is not in the rail, this
    // finds nothing and returns — correct, because a pinned control is always
    // visible and there is nothing to scroll it into. Do not "fix" this by
    // widening the query to the whole strip: it would then measure a control
    // outside the scroller against the scroller's own box.
    const active = rail.querySelector<HTMLElement>(".spaces-switcher-item.is-active");
    if (!active) return;
    // Content coordinates from rects plus the live scroll offset, never
    // `offsetLeft`/`offsetTop`: those are relative to the nearest POSITIONED
    // ancestor, which nothing guarantees is the rail.
    const vertical = this.axis === "y";
    const railRect = rail.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    const next = railScrollOffset({
      scroll: vertical ? rail.scrollTop : rail.scrollLeft,
      clientSize: vertical ? rail.clientHeight : rail.clientWidth,
      itemOffset: vertical
        ? itemRect.top - railRect.top + rail.scrollTop
        : itemRect.left - railRect.left + rail.scrollLeft,
      itemSize: vertical ? itemRect.height : itemRect.width,
    });
    // Assigning an unchanged value would still be a write; skipping it keeps
    // this provably inert when nothing needs to move.
    if (vertical) {
      if (next !== rail.scrollTop) rail.scrollTop = next;
    } else if (next !== rail.scrollLeft) {
      rail.scrollLeft = next;
    }
  }
}
