import {
  CLS_BOX_OPEN,
  CLS_CLAIMS_DROP,
  CLS_DROP_BOX,
  CLS_DROP_LINE,
  CLS_DROP_PARENT,
  CLS_GAP_DRAG,
  SEL,
} from "../explorer/selectors";
import { gapLayout, isLaidOut, type GapRow } from "./gapLayout";
import type { DropIndicatorStyle } from "../types";

/**
 * A row as the snapshot remembers it: what `gapLayout` needs, plus where the
 * row sits.
 *
 * `gapLayout` deliberately has no `top`, because it derives position from the
 * boundary it is given and the order of the list. The snapshot does need one,
 * since hit testing a pointer against an undisplaced row is the whole reason
 * it exists. Keeping them apart is what stops a field nobody reads travelling
 * into the pure module.
 */
interface RowSnapshot extends GapRow {
  /** Top of the row's strip in CONTAINER coordinates, so scrolling is moot. */
  top: number;
}

/** The part of a rect the drop rules read. Undisplaced, in viewport space. */
interface StripRect {
  top: number;
  bottom: number;
  height: number;
  left: number;
  width: number;
}
import { computeDrop, intentFor, movesIntoOwnSubtree, type DropEdge } from "./dropIntent";

/**
 * The drag half of ordering. Renders and dispatches; decides nothing —
 * every rule lives in `dropIntent.ts`, where it is tested. A reviewer finding a
 * decision in this file has found a real defect.
 *
 * It rides Obsidian's own HTML5 drag and NEVER `preventDefault`s a `dragstart`:
 * suppressing that breaks dragging a note into the editor to make a link, onto
 * a tab, and out to another application — the widest blast radius in this
 * feature, which is why the tests assert it directly. It also rides ON TOP of
 * Obsidian's own drag feedback rather than suppressing it: the tint says which
 * folder, our line says where within it. Clearing the native highlight at the
 * row EDGES only flashes it on and off as the pointer crosses bands within a
 * single row, so every `dragover` must propagate.
 *
 * **The phases are split, and deliberately.** `dragover` listens in the BUBBLE
 * phase so Obsidian's row handler — on the row, so it runs first — sees a
 * pristine event and establishes its own hover before we touch anything; in
 * capture our `preventDefault` lands first and the tint never appears at the
 * edges. `drop` stays in CAPTURE for the opposite reason: it must preempt
 * Obsidian's drop handler, which would otherwise move the file a second time
 * and fail on its own collision.
 *
 * **`dragover`, `drop` and `dragend` listen on the DOCUMENT, not the explorer
 * container.** Obsidian's drag ghost — the floating "Move into <folder>" chip —
 * is `position: fixed` with no `pointer-events: none` (read from its live
 * stylesheet), follows the cursor and is attached to `body`, so a
 * container-scoped `dragover` never fires while the pointer is over it and the
 * insertion line freezes where it was last drawn. On the document the events
 * always arrive; the row is resolved by hit-testing the pointer, and a
 * `pointerInside` guard keeps a document-wide listener off drags in the editor
 * or the tab bar.
 *
 * **The insertion line is created once at `bind` and never inserted or removed
 * during a drag** — only moved and shown. Appending it mid-drag is a childList
 * mutation inside the drag target's own subtree, which provokes
 * `dragenter`/`dragleave` churn and flickers the native highlight; it is also
 * observed by `ExplorerAdapter`'s MutationObserver, so every pointer move
 * schedules an apply pass for nothing.
 */
export interface DragOrderingDeps {
  /** The folder a row lives in, and whether the row is itself a folder. */
  describeRow(path: string): { parent: string; isFolder: boolean } | null;
  /** The folder's children in the order currently on screen. */
  displayedOrder(folderPath: string): string[];
  /** The stored order for that folder in the ACTIVE space, if any. */
  storedOrder(folderPath: string): string[] | undefined;
  /** Persist a new order. Rejects on failure; the caller reports it. */
  writeOrder(folderPath: string, order: string[]): Promise<void>;
  /**
   * Move paths into another folder and give them a position there. Must move
   * FIRST and order only on success — ordering a file into a folder it never
   * reached must never happen.
   */
  moveInto(paths: string[], targetFolder: string, edge: DropEdge, targetPath: string): Promise<void>;
  enabled(): boolean;
  /**
   * Which indicator to draw, read per frame rather than captured. The setting
   * can change while a pane is bound, and a captured value would need the
   * explorer reloaded to take effect.
   */
  indicatorStyle(): DropIndicatorStyle;
  /**
   * Called once per dragstart that `enabled()` refuses. The controller
   * says nothing itself — whether a blocked drag is worth explaining depends
   * on WHY it is blocked, and only the caller knows that.
   */
  onBlockedDrag?(): void;
  /**
   * Called once per drop declined because the collected selection may continue
   * past the explorer's render window (see `collectDragged`). Same division of
   * labour as `onBlockedDrag`: the controller declines, the caller explains,
   * because only the caller can raise a Notice. Optional, and the decline
   * stands whether or not it is supplied.
   */
  onSelectionOutsideWindow?(): void;
}

export class DragOrdering {
  private container: HTMLElement | null = null;
  private doc: Document | null = null;
  private indicator: HTMLElement | null = null;
  /**
   * Every strip this drag has ever displaced, and by how much.
   *
   * Never pruned while the drag runs, only emptied by `clearShifts`. An
   * earlier version replaced this wholesale on every frame, which meant a row
   * that carried a transform and then left the render window was untracked
   * from that moment and never put back by anything.
   */
  private shiftOf = new Map<HTMLElement, number>();
  /**
   * Where each strip sits when nothing has displaced it, in CONTAINER
   * coordinates so scrolling does not invalidate it.
   *
   * Every decision reads this instead of the live DOM. A transform changes
   * what `getBoundingClientRect` returns and what the browser hit-tests, so
   * measuring live meant each frame resolved the drop from rows the previous
   * frame had moved. Observed in a running vault: hovering 3px into a folder's
   * first child drew the box on that child, and the next frame resolved the
   * PARENT FOLDER at root level with the pointer untouched, so the drop would
   * have landed in the vault root. It also opened a hole under the pointer,
   * which made the indicator flicker on and off at the `dragover` rate.
   *
   * Subtracting the applied shift from a live measurement is NOT equivalent
   * and was rejected: the rows animate over 100ms, so a live rect read
   * mid-transition is only partway there and subtracting the full shift
   * overshoots by whatever is left of the animation.
   *
   * An entry is only ever recorded from a strip carrying no shift, which is
   * what keeps the stored value honest.
   */
  private geo = new Map<HTMLElement, RowSnapshot>();
  /** Where the box currently sits, so its fade replays only when it moves. */
  private openAt: number | null = null;
  /** Its height, so the pointer can be tested against the open gap. */
  private openHeight = 0;
  /**
   * The answer the open gap is holding, so a held frame can redraw it.
   *
   * Holding the gap has to freeze the DECISION, not the drawing. Rows appear
   * mid-drag whenever Obsidian expands a folder under the pointer, and they
   * arrive with no transform while their neighbours are displaced; a frame
   * that skips the write leaves the row above drawn on top of the first
   * newcomer.
   */
  private held:
    | { row: HTMLElement; path: string; edge: DropEdge; parent: string }
    | null = null;
  /** The folder row currently marked as the destination, if any. */
  private parentMark: HTMLElement | null = null;
  /**
   * Pending removal of the row transition after a gap slides shut.
   *
   * Held so a drag starting inside the closing animation can cancel it. The
   * timer's only job is to take the transition off once the rows have
   * arrived, and doing that to a gap that has since reopened would make the
   * next one jump.
   */
  private closing: ReturnType<typeof setTimeout> | null = null;
  /**
   * Watches for rows arriving while a gap is open, for the length of a drag.
   *
   * Obsidian expands a folder the pointer rests on, so the tree can gain rows
   * with no drag frame following. The newcomers have no transform while their
   * neighbours are displaced, and the row above is drawn on top of the first
   * of them. Redrawing on the next frame fixes it only if the pointer moves
   * again, and the whole point of an auto-expand is that it happens while you
   * hold still.
   *
   * Attributes are not observed, so the transforms this redraw writes cannot
   * feed it back into itself.
   */
  private arrivals: MutationObserver | null = null;
  private dragged: string[] = [];
  /**
   * Whether `dragged` may be only part of the user's selection, because
   * the rest of it is not rendered. Set once per `dragstart` and read on drop.
   */
  private draggedTruncated = false;
  /** The row the drag started on, so its teardown can be triggered (see onDrop). */
  private sourceEl: HTMLElement | null = null;
  private warned = false;

  constructor(private readonly deps: DragOrderingDeps) {}

  bind(container: HTMLElement): void {
    this.unbind();
    // `enabled()` is asked fresh on every `dragstart` instead (see
    // `onDragStart`): a sort override can turn on or off without a rebind ever
    // happening (`observeSortOrder` and `restoreSavedOrdering` do not call
    // `bind()` again), so a gate here would answer with whatever was true at
    // the last rebind. Listeners are therefore always attached; a blocked
    // `dragstart` never populates `this.dragged`, and both handlers bail on it.
    this.container = container;
    this.ensureIndicator(container);
    this.doc = container.ownerDocument;
    // dragstart originates on a row, so the container is the right scope.
    container.addEventListener("dragstart", this.onDragStart, true);
    // The rest go on the document: the drag ghost steals these from the
    // container whenever it is under the cursor (see the class comment).
    // Bubble for dragover, so Obsidian's row handler runs first and keeps its
    // highlight; capture for drop, so we preempt its move.
    this.doc.addEventListener("dragover", this.onDragOver, false);
    this.doc.addEventListener("drop", this.onDrop, true);
    this.doc.addEventListener("dragend", this.onDragEnd, true);
  }

  unbind(): void {
    const c = this.container;
    if (!c) return;
    // Before anything else, and before `this.container` is dropped below:
    // `clearShifts` needs it to take the gap class off, and a plugin disabled
    // mid-drag must not leave the pane displaced.
    this.cancelClosing();
    this.clearShifts();
    this.markDestination("");
    this.geo.clear();
    this.stopWatchingArrivals();
    this.cancelClosing();
    // The body is not ours and must not keep a class of ours after unload.
    this.setClaimingDrop(false);
    c.removeEventListener("dragstart", this.onDragStart, true);
    this.doc?.removeEventListener("dragover", this.onDragOver, false);
    this.doc?.removeEventListener("drop", this.onDrop, true);
    this.doc?.removeEventListener("dragend", this.onDragEnd, true);
    this.doc = null;
    // The element itself goes, not just its visibility.
    this.indicator?.remove();
    this.indicator = null;
    this.dragged = [];
    this.draggedTruncated = false;
    this.container = null;
  }

  /** Wraps every handler: a broken drag must never leave a stray line. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.clearIndicator();
      if (!this.warned) {
        this.warned = true;
        console.error("Spaces: reordering drag failed; leaving the drag to Obsidian", e);
      }
    }
  }

  /**
   * The row under the pointer.
   *
   * NOT `target.closest(SEL.rowWrapper)`: the vertical gap between two rows
   * belongs to their parent's `.tree-item-children`, so from there `closest`
   * walks up to the ENCLOSING FOLDER's wrapper, whose rect spans its entire
   * subtree (measured: 133px tall against a 25px row). Offset arithmetic
   * against that is meaningless — "before" resolves to the folder's top edge,
   * so the line jumps to the folder heading above and alternates with the
   * correct position, reading as a flickering, thickening line.
   *
   * So: prefer the row box the pointer is genuinely inside, and otherwise hit
   * test `clientY` against the rendered rows. That removes the dead zones too —
   * the left-hand indent strip belongs to the children container, not any row.
   */
  /**
   * Is the pointer over the tree at all? Required because the listeners are on
   * the document: without it, a drag in the editor at a y that happened to line
   * up with a tree row would resolve a row and draw a line.
   */
  private pointerInside(clientX: number, clientY: number): boolean {
    const c = this.container;
    if (!c) return false;
    const r = c.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  /**
   * Is the event's target the tree itself, rather than something drawn
   * ON TOP of it?
   *
   * `pointerInside` is geometry alone, and geometry cannot tell the tree apart
   * from a surface covering the tree's rect. spaces draws one itself — the
   * create panel is `position: absolute; inset: 0` and a SIBLING of
   * `.nav-files-container` inside the explorer pane — and a capture-phase
   * `stopPropagation` on the document cuts every handler below it.
   *
   * The middle case is the whole reason this is not `container.contains()`:
   *
   *  - inside the container: the tree. Ours.
   *  - outside the explorer PANE altogether: Obsidian's drag ghost, which is
   *    `position: fixed` with no `pointer-events: none`, lives in `body`, and
   *    is usually the node under the pointer. A real tree drop, and the reason
   *    these listeners are on the document at all. Ours.
   *  - inside the pane but outside the tree: something the pane stacked over
   *    the tree. NOT ours; it owns its own drops.
   */
  private targetIsOurs(target: EventTarget | null): boolean {
    const c = this.container;
    if (!c) return false;
    const node = target instanceof Node ? target : null;
    // No target to reason about (a synthetic event); fall back to geometry.
    if (!node) return true;
    if (c.contains(node)) return true;
    const pane = c.closest(SEL.fileExplorerPane);
    return pane === null || !pane.contains(node);
  }

  private rowAt(target: EventTarget | null, clientY: number): { el: HTMLElement; path: string } | null {
    const c = this.container;
    if (!c) return null;

    const node = target instanceof HTMLElement ? target : null;
    const direct = node?.closest(SEL.titleWithPath);
    if (direct instanceof HTMLElement) {
      const path = direct.getAttribute("data-path");
      const el = direct.closest(SEL.rowWrapper);
      if (path && el instanceof HTMLElement) return { el, path };
    }

    // Hit test, then nearest-row fallback, bounded by the render window (~49
    // rows). The fallback is not defensive padding: rows are separated by a real
    // 2px gap (`.tree-item-self` has `margin-bottom: 2px`), so without it those
    // pixels are dead zones where the line vanishes mid-drag. A pointer in the
    // gap goes to the nearer row; only one further than half a row from
    // everything resolves to nothing.
    let best: { el: HTMLElement; path: string } | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const titled of Array.from(c.querySelectorAll(SEL.titleWithPath))) {
      if (!titled.instanceOf(HTMLElement)) continue;
      // The SNAPSHOT, never the live rect. A displaced row paints somewhere
      // its drop meaning did not move to, and hit-testing where it paints is
      // what let the gap open a hole under the pointer and flicker.
      const r = this.stableRect(titled);
      if (!r || r.height <= 0) continue;
      const path = titled.getAttribute("data-path");
      const el = titled.closest(SEL.rowWrapper);
      if (!path || !(el instanceof HTMLElement)) continue;
      if (clientY >= r.top && clientY < r.bottom) return { el, path };
      const dist = clientY < r.top ? r.top - clientY : clientY - r.bottom;
      if (dist < bestDist) {
        bestDist = dist;
        best = { el, path };
        // Half a row is the threshold: past that the pointer is genuinely
        // nearer some other row, or outside the tree altogether.
        if (bestDist > r.height / 2) best = null;
      }
    }
    return best;
  }

  private readonly onDragStart = (e: Event): void =>
    this.guard(() => {
      // Checked per gesture rather than once at bind time — see `bind()`. A
      // blocked attempt is reported once and left inert: `dragover`/`drop` stay
      // silent because `this.dragged` is never populated below.
      if (!this.deps.enabled()) {
        this.deps.onBlockedDrag?.();
        return;
      }
      // Deliberately no preventDefault and no stopPropagation: Obsidian owns
      // the drag, we only observe what is being dragged.
      // The first snapshot of the drag. `rowAt` answers from it, so without
      // this the gesture never resolves a row and never registers at all.
      // A fresh drag measures the tree as it is now, never as a previous drag
      // left it.
      this.geo.clear();
      this.syncGeometry();
      const row = this.rowAt(e.target, (e as MouseEvent).clientY ?? 0);
      if (!row) {
        this.dragged = [];
        return;
      }
      this.sourceEl = row.el;
      // ALSO on the row itself, not only on the document where `bind` put it.
      // The explorer renders in blocks and drops them as the pane scrolls, so
      // autoscrolling far enough during a drag destroys the row the drag
      // started on. Measured in a running vault with a 240-child folder open:
      // a 3000px scroll mid-drag replaced 48 of the 49 rendered rows and left
      // `document.contains(sourceRow)` false. The browser still sends
      // `dragend` to that node, but an event dispatched at a detached node
      // reaches no listener on the document, so the teardown never ran and the
      // tree kept every row translated down until the next drag.
      //
      // A node runs its OWN listeners whether or not it is still in the
      // document, which is the whole point of putting one here. `once` so a
      // row cannot accumulate one per drag, and removed again below for the
      // ordinary case where the document listener got there first.
      row.el.addEventListener("dragend", this.onDragEnd, { once: true });
      const collected = this.collectDragged(row);
      this.dragged = collected.paths;
      this.draggedTruncated = collected.truncated;
    });

  /**
   * Multi-selection is OPPORTUNISTIC. The explorer tracks its selection in a
   * private field this file may not touch, and `SEL.selectedRow` matches a
   * class Obsidian also uses elsewhere (the name is deliberately not repeated
   * here, so `grep` for it keeps answering "selectors.ts only" — the same
   * hygiene the quarantined private-API names require), so it is not
   * authoritative: selected siblings are collected only when the dragged row
   * itself carries the class, and otherwise the drag is the one row. That
   * fallback is the correct single-row behaviour, so no guess here can produce
   * a wrong result, only a less capable one.
   *
   * **And the DOM does not necessarily hold all of it.** The explorer detaches
   * rows when they scroll out of view: a 400-row tree rendered SIX of one
   * folder's 153 children behind a virtual spacer. Because spaces claims the
   * drop and performs the move itself, rows it never saw were simply not moved,
   * silently. Collecting more is not available — the real selection lives in a
   * private field the quarantine forbids, with no public API — so this reports
   * whether the set might be SHORT and `onDrop` declines rather than
   * half-moving: declining leaves the gesture with Obsidian, so the whole
   * selection still moves and only spaces's ordering precision is lost.
   *
   * The tell is geometric and needs nothing private: a selection that reaches
   * the first or last RENDERED row may continue past it — unless the scroller
   * is already at that end of its range.
   */
  private collectDragged(
    row: { el: HTMLElement; path: string }
  ): { paths: string[]; truncated: boolean } {
    const whole = (paths: string[]): { paths: string[]; truncated: boolean } => ({
      paths,
      truncated: false,
    });
    const c = this.container;
    if (!c) return whole([row.path]);
    const self = row.el.querySelector(SEL.titleWithPath);
    if (!(self instanceof HTMLElement) || !self.matches(SEL.selectedRow)) {
      return whole([row.path]);
    }
    // DOM order, which after Slice A's sort is also the visual order. Rendered
    // rows are read WHOLE rather than filtered by the query, because the
    // unselected ones are what say whether the selection is bounded.
    const rendered = Array.from(c.querySelectorAll(SEL.titleWithPath));
    const paths: string[] = [];
    for (const el of rendered) {
      if (!el.matches(SEL.selectedRow)) continue;
      const p = el.getAttribute("data-path");
      if (p) paths.push(p);
    }
    if (paths.length === 0) return whole([row.path]);
    return { paths, truncated: this.selectionMayBeClipped(rendered) };
  }

  /**
   * Could the selection continue past the rendered window?
   *
   * Only if it touches an end of that window AND the scroller has more tree in
   * that direction. One pixel of slack at each end, because a scroll offset can
   * be fractional on a HiDPI display.
   *
   * Known blind spot, recorded rather than papered over: a selected row inside
   * a folder the user has since COLLAPSED is not rendered and is not adjacent
   * to the window's edges either, so this cannot see it. Nothing in the public
   * DOM can.
   */
  private selectionMayBeClipped(rendered: readonly Element[]): boolean {
    const c = this.container;
    const first = rendered[0];
    const last = rendered[rendered.length - 1];
    if (!c || !first || !last) return false;
    const atTop = c.scrollTop <= 1;
    const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 1;
    return (
      (!atTop && first.matches(SEL.selectedRow)) ||
      (!atBottom && last.matches(SEL.selectedRow))
    );
  }

  private readonly onDragOver = (e: Event): void =>
    this.guard(() => {
      if (this.dragged.length === 0) return;
      // Before anything is decided: a row the explorer rendered into view
      // since the last frame has to be measured while it still carries no
      // transform of ours.
      this.syncGeometry();
      const clientY = (e as MouseEvent).clientY ?? 0;
      if (!this.pointerInside((e as MouseEvent).clientX ?? 0, clientY)) {
        // The pointer left the tree — over the editor, a tab, or off-window.
        // The line must go with it, which a container-scoped listener could
        // never notice.
        this.clearIndicator();
        return;
      }
      // The pointer is over the tree's box, but something else may be
      // drawn there. See `targetIsOurs`.
      if (!this.targetIsOurs(e.target)) {
        this.clearIndicator();
        return;
      }
      // No line for a drop that cannot happen: this drop is going to be
      // declined, and promising a position and then refusing it is the
      // silent-partial-move defect wearing a hint.
      if (this.draggedTruncated) {
        this.clearIndicator();
        return;
      }
      // The open gap is STICKY. Once it opens, the row that was there has
      // slid away and the pointer is inside the space it left, but the
      // decision still works from that row's ORIGINAL slot, whose midpoint is
      // now inside the gap. Without this the answer flips while the pointer
      // has not left the box it is pointing at: the box jumps to the far side
      // of a row, or disappears when that side happens to be a no-op, and the
      // row animates back through wherever the box just went.
      //
      // Leaving the gap is what changes the answer, which is also what the
      // eye expects of a hole it is pointing into.
      if (this.pointerInOpenGap(clientY) && this.held?.row.isConnected) {
        // Re-asserted, not assumed. The box being on screen while spaces is
        // not claiming the drop is the state where Obsidian paints its own
        // answer underneath ours, and a frame that holds the gap skips the
        // code further down that would otherwise set this.
        this.setClaimingDrop(true);
        this.markDestination(this.held.parent);
        // REDRAWN with the same answer rather than skipped. `syncGeometry`
        // ran at the top of this handler, so a row that arrived since the
        // last frame is now measurable and this is what gives it the same
        // displacement as its neighbours. Measured in a running vault with a
        // folder expanded under a held gap: without this the folder's title
        // stayed 24.9px lower than its first child and overlapped it by 23px,
        // and the next frame did not clear it either.
        this.showIndicator(this.held.row, this.held.edge);
        return;
      }
      const row = this.rowAt(e.target, clientY);
      if (!row) {
        this.clearIndicator();
        return;
      }
      const info = this.deps.describeRow(row.path);
      if (!info) {
        this.clearIndicator();
        return;
      }
      // Geometry from the row's own box, for the same reason `rowAt` exists:
      // the wrapper's rect includes a folder's whole subtree.
      const rect = this.rowBox(row.el);
      const intent = intentFor({
        offsetY: clientY - rect.top,
        height: rect.height,
        isFolder: info.isFolder,
      });

      if (intent.kind !== "between") {
        // Let Obsidian have it — this is drop-into-folder, and not stopping
        // propagation is exactly what keeps that working.
        this.clearIndicator();
        return;
      }

      // No line for a drop that cannot happen: the user must never be offered a
      // target inside the folder being dragged.
      if (this.illegalTarget(this.dragged, info.parent)) {
        this.clearIndicator();
        return;
      }

      // And no line where a drop would change nothing. `computeDrop` already
      // declines these — "the target is itself being dragged" and "the sequence
      // is unchanged" — but consulted only on DROP, so the line promised a move
      // the drop then silently refused. The case that surfaced it: dragging an
      // expanded folder over its own row put a line between the folder and its
      // first child, which reads as INSIDE the folder while actually being its
      // own trailing edge in its parent.
      //
      // Same-parent only, because that is the only case `computeDrop` describes;
      // a cross-folder drop always changes something by definition.
      if (this.isNoOpReorder(this.dragged, info.parent, row.path, intent.edge)) {
        this.clearIndicator();
        return;
      }

      // Obsidian's row handler has already run and, for a FOLDER, has tinted
      // it and captioned the drag "Move into <folder>" whichever part of the
      // row the pointer is in. This frame is a "between", so that caption
      // describes a drop that will not happen: spaces claims this one and
      // reorders. The stylesheet hides both while this is set.
      this.setClaimingDrop(true);

      // Neither preventDefault nor stopPropagation. Obsidian's own handler has
      // already run (bubble phase) and calls preventDefault itself — measured:
      // with spaces's listeners detached entirely, a dragover over the tree
      // still comes back `defaultPrevented`. So the drop is permitted without us
      // touching the event, and the tint and its label survive.
      this.held = { row: row.el, path: row.path, edge: intent.edge, parent: info.parent };
      this.markDestination(info.parent);
      this.watchForArrivals();
      this.showIndicator(row.el, intent.edge);
    });

  /**
   * Would this drop move one of the dragged paths inside itself?
   *
   * Dragging a folder over its own row opens it, and the rows inside are then
   * ordinary between-row targets — so without this the drop was claimed and
   * `Archive` was moved to `Archive/Archive`, which the filesystem rejects
   * with EINVAL.
   *
   * The dragged paths are passed WHOLE, not filtered to folders: such a filter
   * guards nothing. For a target to be under a dragged path that path must have
   * descendants, which only a folder has, and `targetFolder` always comes from
   * a row's `parent`, which is always a folder path — so a dragged file matches
   * neither branch of the rule.
   */
  private illegalTarget(dragged: string[], targetFolder: string): boolean {
    return movesIntoOwnSubtree(dragged, targetFolder);
  }

  /**
   * Would this same-parent drop leave the order exactly as it is?
   *
   * Asks `computeDrop` the same question the drop handler asks, so the line and
   * the drop can never disagree about whether a position does anything.
   * Returns false for a cross-folder drop, which always changes something.
   */
  private isNoOpReorder(
    dragged: string[],
    targetFolder: string,
    targetPath: string,
    edge: DropEdge
  ): boolean {
    const sameParent = dragged.every(
      (p) => this.deps.describeRow(p)?.parent === targetFolder
    );
    if (!sameParent) return false;
    return (
      computeDrop({
        order: this.deps.storedOrder(targetFolder),
        displayed: this.deps.displayedOrder(targetFolder),
        dragged,
        targetPath,
        edge,
      }) === null
    );
  }

  private readonly onDragEnd = (): void =>
    this.guard(() => {
      // The one path that animates. A drop re-renders the tree into its new
      // arrangement immediately, so closing a gap against that would animate
      // rows out of positions they no longer hold.
      this.clearIndicator(true);
      this.dragged = [];
      this.draggedTruncated = false;
      // Taken off explicitly as well as by `once`: this handler is reached
      // from the document listener too, and that path leaves the row's own
      // listener armed for a drag that is already over.
      this.sourceEl?.removeEventListener("dragend", this.onDragEnd);
      this.sourceEl = null;
      this.geo.clear();
    });

  private readonly onDrop = (e: Event): void =>
    this.guard(() => {
      // The drop resolves its target the same way the indicator did, from the
      // same snapshot, so what lands is what was shown.
      this.syncGeometry();
      const dragged = this.dragged;
      const truncated = this.draggedTruncated;
      this.dragged = [];
      this.draggedTruncated = false;
      if (dragged.length === 0) return;
      const clientY = (e as MouseEvent).clientY ?? 0;
      // What the indicator was pointing at when the button came up, captured
      // before `clearIndicator` discards it.
      //
      // The drop has to honour this rather than resolve the pointer again.
      // Holding the gap freezes the display on an answer the pointer would no
      // longer produce, and re-deciding here made the indicator a lie: proven
      // in a running vault, where it read `left=29px destination=Travel`
      // while the file landed at the vault root.
      const shown = this.held?.row.isConnected ? this.held : null;
      this.clearIndicator();
      // A document-wide listener must not touch a drop anywhere but the tree.
      if (!this.pointerInside((e as MouseEvent).clientX ?? 0, clientY)) return;
      // Nor one that landed on a surface stacked over the tree, whose
      // own drop handler the `stopPropagation` below would otherwise cut.
      if (!this.targetIsOurs(e.target)) return;
      const row = shown ? { el: shown.row, path: shown.path } : this.rowAt(e.target, clientY);
      if (!row) return;

      const info = this.deps.describeRow(row.path);
      if (!info) return;
      // A shown answer was already decided to be a "between" when it was
      // drawn, so asking again would only reintroduce the disagreement. The
      // pointer is consulted only when nothing was on screen to honour.
      let intent: ReturnType<typeof intentFor>;
      if (shown) {
        intent = { kind: "between", edge: shown.edge };
      } else {
        const rect = this.rowBox(row.el);
        intent = intentFor({
          offsetY: clientY - rect.top,
          height: rect.height,
          isFolder: info.isFolder,
        });
      }
      // Not our drop: Obsidian's own handler moves the file into the folder.
      if (intent.kind !== "between") return;

      // An impossible move is not ours to claim. Returning without
      // preventDefault leaves the gesture with the core explorer, which owns
      // moves — better than swallowing it silently or raising an EINVAL Notice.
      if (this.illegalTarget(dragged, info.parent)) return;

      // And neither is a drop whose selection we can only see part of.
      // Declining without `preventDefault` hands the gesture to Obsidian, which
      // DOES know the whole selection: all of it moves, and only the position
      // within the destination folder is lost. Checked here rather than earlier
      // so it fires only for a drop spaces would otherwise have claimed.
      if (truncated) {
        this.reportUnclaimableSelection();
        return;
      }

      // On DROP, stopping propagation is required: Obsidian's own handler
      // would also move the file into the hovered folder, so leaving it to run
      // means two moves for one drop and a spurious collision failure.
      e.preventDefault();
      e.stopPropagation();
      // ...but that same handler is where Obsidian tears its drag state down,
      // so suppressing it leaves `is-grabbing` on the body (a stuck grab
      // cursor), the drop target still tinted, the source row still marked and
      // the ghost still attached until the next drag. Measured: dispatching a
      // plain `dragend` clears all four, and the browser's own dragend
      // afterwards is harmless because the teardown is idempotent.
      this.endNativeDrag();

      const targetFolder = info.parent;
      const sameParent = dragged.every(
        (p) => this.deps.describeRow(p)?.parent === targetFolder
      );

      if (!sameParent) {
        // A cross-folder drop is a filesystem move AND a position in the
        // new parent. The move has to land first.
        void this.deps
          .moveInto(dragged, targetFolder, intent.edge, row.path)
          .catch((err) => this.reportFailure(err));
        return;
      }

      const next = computeDrop({
        order: this.deps.storedOrder(targetFolder),
        displayed: this.deps.displayedOrder(targetFolder),
        dragged,
        targetPath: row.path,
        edge: intent.edge,
      });
      // A drop that changes nothing must not touch data.json.
      if (!next) return;
      void this.deps.writeOrder(targetFolder, next).catch((err) => this.reportFailure(err));
    });

  /**
   * Ask Obsidian to end its own drag. Called after we claim a drop, because
   * claiming it means its drop handler — which does this teardown — never runs.
   */
  private endNativeDrag(): void {
    const el = this.sourceEl;
    this.sourceEl = null;
    // The DOCUMENT when the source row has gone, rather than nothing at all.
    //
    // Moving a row re-renders the tree and replaces the row that was dragged,
    // which nesting folders in each other does every time. Skipping the send
    // left Obsidian in a drag that never ended: the folder stayed
    // highlighted, its floating chip stayed on screen, and the cursor stayed
    // a grabbing hand. An event dispatched at a detached node reaches no
    // listener on the document, so it has to be sent somewhere still
    // attached.
    const target: EventTarget | null = el?.isConnected ? el : this.doc;
    if (!target) return;
    // Constructed from the document's own window, and feature-detected: jsdom
    // has `Event` but not always `DragEvent`, and Obsidian's teardown does not
    // read the dataTransfer, so a plain Event is enough where it is missing.
    const view = this.doc?.defaultView as unknown as
      | { DragEvent?: typeof Event; Event?: typeof Event }
      | undefined;
    const Ctor = view?.DragEvent ?? view?.Event;
    if (!Ctor) return;
    target.dispatchEvent(new Ctor("dragend", { bubbles: true }));
  }

  /**
   * A drop declined because the selection outruns the render window.
   *
   * The console line is unconditional so the decline is never invisible to a
   * support question; the Notice, if any, is the caller's — this file has no
   * `"obsidian"` import and is not going to grow one.
   */
  private reportUnclaimableSelection(): void {
    console.warn(
      "Spaces: part of this selection is scrolled out of the explorer's " +
        "render window, so the drop was left to Obsidian rather than " +
        "moving only the rows spaces can see"
    );
    this.deps.onSelectionOutsideWindow?.();
  }

  private reportFailure(err: unknown): void {
    // The stored order is the truth and the render follows it, so there
    // is nothing to roll back — the tree simply keeps the arrangement it had.
    console.error("Spaces: could not save the new order", err);
  }

  private ensureIndicator(container: HTMLElement): void {
    if (this.indicator) return;
    const el = container.ownerDocument.win.createDiv();
    el.className = CLS_DROP_LINE;
    // Created hidden, and it stays in the DOM for the life of the binding: see
    // the class comment on why inserting it mid-drag caused the flicker.
    el.hidden = true;
    container.appendChild(el);
    this.indicator = el;
  }

  /**
   * A row's own clickable box — `.tree-item-self` — falling back to the wrapper.
   *
   * **VERTICAL geometry only, and that restriction is load-bearing.** A FOLDER's
   * wrapper contains its entire subtree, so its box runs from the folder row to
   * the bottom of its last descendant; hit-testing and `boundaryY` both depend
   * on this being the row strip and nothing more. It is equally wrong to measure
   * HORIZONTALLY, in the opposite direction — see `showIndicator`, which is why that
   * one caller does not use this.
   */
  private rowBox(row: HTMLElement): StripRect {
    const box = row.querySelector(SEL.titleWithPath);
    const strip = box instanceof HTMLElement ? box : row;
    // Undisplaced, for the same reason `rowAt` is. Falling back to the live
    // rect covers only the case where the strip has no snapshot entry yet,
    // and such a strip carries no transform either, so the two agree.
    const stable = strip.instanceOf(HTMLElement) ? this.stableRect(strip) : null;
    if (stable) return stable;
    const r = strip.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, width: r.width };
  }

  /**
   * The y of the boundary between two rows, in container space.
   *
   * ONE boundary must have ONE position. Rows are separated by a real gap —
   * `.tree-item-self` carries `margin-bottom: 2px` — so "after A" (A's bottom)
   * and "before B" (B's top) are two values 2px apart for what the user sees as
   * a single line. The line is itself 2px tall, so crossing that boundary
   * alternated between two adjacent, non-overlapping bands: a 4px flicker that
   * reads as the line thickening, with subpixel offsets rendering one at half
   * intensity — the "thin" state in the report.
   *
   * Taking the midpoint of the gap collapses both into the same pixel, derived
   * from the neighbouring row's geometry rather than a hardcoded 2px, so a theme
   * with different spacing needs no constant kept in sync.
   */
  private boundaryY(row: HTMLElement, edge: DropEdge): number {
    const rect = this.rowBox(row);
    const neighbour =
      edge === "after" ? row.nextElementSibling : row.previousElementSibling;
    const nRect =
      neighbour instanceof HTMLElement && neighbour.matches(SEL.rowWrapper)
        ? this.rowBox(neighbour)
        : null;
    if (!nRect || nRect.height <= 0) return edge === "after" ? rect.bottom : rect.top;

    // The sibling must actually be ADJACENT before its rect is trusted: in a
    // windowed container a `.tree-item` sibling can still be in the DOM while
    // scrolled far out of view, and averaging against it threw the line hundreds
    // of pixels away (measured mid-drag: a boundary at clientY -167 against a
    // correct value near 1220). A real inter-row gap is ~2px, so anything beyond
    // one row's height is not a neighbour worth averaging with.
    const gap = edge === "after" ? nRect.top - rect.bottom : rect.top - nRect.bottom;
    if (!(gap >= 0) || gap > rect.height) {
      return edge === "after" ? rect.bottom : rect.top;
    }

    return edge === "after"
      ? (rect.bottom + nRect.top) / 2
      : (nRect.bottom + rect.top) / 2;
  }

  /**
   * The rows on screen, in document order, measured for `gapLayout`.
   *
   * The unit of movement is the row's own strip (`[data-path]`), NOT the
   * `.tree-item` wrapper. A folder's wrapper contains its whole subtree, so
   * transforming wrappers would move a folder's children twice: once with the
   * folder and once on their own. Strips are never nested inside each other.
   *
   * Horizontal geometry still comes from the wrapper, which is what carries
   * the indent. `showIndicator` has always split its measurements this way.
   */
  /**
   * Bring `geo` up to date, then answer from it alone.
   *
   * Called at the top of every handler that decides anything, so a row that
   * the explorer rendered into view a moment ago is measured before it is
   * asked about. A strip that already carries a shift is skipped rather than
   * re-measured, because its live rect is displaced and would poison the
   * entry the rest of the drag depends on.
   */
  private syncGeometry(): void {
    const c = this.container;
    if (!c) return;
    const cRect = c.getBoundingClientRect();
    for (const strip of Array.from(c.querySelectorAll(SEL.titleWithPath))) {
      if (!strip.instanceOf(HTMLElement)) continue;
      if ((this.shiftOf.get(strip) ?? 0) !== 0) continue;
      const wrapper = strip.closest(SEL.rowWrapper);
      if (!wrapper || !wrapper.instanceOf(HTMLElement)) continue;
      const sRect = strip.getBoundingClientRect();
      const wRect = wrapper.getBoundingClientRect();
      this.geo.set(strip, {
        top: sRect.top - cRect.top + c.scrollTop,
        // Rounded like the other three. A real row is not a whole number of
        // pixels tall, and the box takes both its height and every row's
        // shift from this, so leaving it fractional put the box's bottom edge
        // and every displaced row on a subpixel while its top sat on a whole
        // one. Rounding keeps the box and the gap exactly the same size.
        height: Math.round(sRect.height),
        left: Math.round(wRect.left - cRect.left + c.scrollLeft),
        width: Math.round(wRect.width),
      });
    }
  }

  /**
   * A strip's undisplaced box in VIEWPORT coordinates, for comparing against a
   * pointer's `clientY`. Derived from the container-relative snapshot, so it
   * is correct at any scroll position and during any animation.
   */
  private stableRect(strip: HTMLElement): StripRect | null {
    const c = this.container;
    const g = this.geo.get(strip);
    if (!c || !g) return null;
    const cRect = c.getBoundingClientRect();
    const top = g.top + cRect.top - c.scrollTop;
    return { top, bottom: top + g.height, height: g.height, left: g.left, width: g.width };
  }

  private visibleRows(c: HTMLElement): { el: HTMLElement; row: GapRow }[] {
    const out: { el: HTMLElement; row: GapRow }[] = [];
    for (const strip of Array.from(c.querySelectorAll(SEL.titleWithPath))) {
      if (!strip.instanceOf(HTMLElement)) continue;
      const row = this.geo.get(strip);
      if (!row) continue;
      // `gapLayout` owns the rule; this only applies it.
      if (!isLaidOut(row)) continue;
      out.push({ el: strip, row });
    }
    return out;
  }

  private showIndicator(row: HTMLElement, edge: DropEdge): void {
    const c = this.container;
    if (!c) return;
    this.ensureIndicator(c);
    const el = this.indicator;
    if (!el) return;
    const cRect = c.getBoundingClientRect();
    // The container is the scroller and is already `position: relative`
    // (measured), so an absolute child is positioned against its padding box
    // and scrolls with the content, hence the scroll terms. Rounded to a whole
    // pixel: a 2px line at a fractional offset straddles two device rows and
    // renders at half intensity, the dim "thin" state in the report.
    const boundaryTop = Math.round(this.boundaryY(row, edge) - cRect.top + c.scrollTop);

    if (this.deps.indicatorStyle() === "line") {
      // The setting can change mid-drag, so a gap left open by a previous
      // frame has to close rather than sitting there under a line.
      this.clearShifts();
      el.className = CLS_DROP_LINE;
      // The WRAPPER, not `rowBox`'s `.tree-item-self`, and only for the
      // horizontal span. `top` comes from `boundaryY` above.
      //
      // Measured against 1.13.7: Obsidian indents a row by indenting the
      // `.tree-item` WRAPPER while stretching `.tree-item-self` back to the
      // pane's edge (`margin-inline-start: 0`, the indent applied as
      // `padding-inline-start`) so hover and selection backgrounds run full
      // width. At depth 0 both boxes read l=12 w=305; at depth 1 the wrapper
      // reads l=29 w=288 while the self is still l=12 w=305, so taking the
      // self produced a pane-wide line at every depth. The wrapper is also
      // what Obsidian's own drop highlight paints
      // (`.nav-folder.is-being-dragged-over`), so matching it makes our line
      // agree with the bubble the user is aiming at.
      const rowRect = row.getBoundingClientRect();
      el.style.top = boundaryTop + "px";
      el.style.left = Math.round(rowRect.left - cRect.left + c.scrollLeft) + "px";
      el.style.width = Math.round(rowRect.width) + "px";
      // The line takes its 2px from the stylesheet. A height left over from a
      // box drawn a frame ago would out-specify it. Removed rather than set to
      // an empty string, which `no-static-styles-assignment` reads as a static
      // write and which the rest of this codebase already avoids the same way.
      el.style.removeProperty("height");
      el.hidden = false;
      return;
    }

    const rows = this.visibleRows(c);
    const strip = row.querySelector(SEL.titleWithPath);
    const targetIndex = rows.findIndex((r) => r.el === strip);
    const layout = gapLayout({
      rows: rows.map((r) => r.row),
      targetIndex,
      edge,
      boundaryTop,
    });
    // No layout means no honest way to draw the gap, so draw nothing at all
    // rather than a box describing a position the drop will not use.
    if (!layout) {
      this.clearIndicator();
      return;
    }

    // The slide is for OPENING the gap, never for moving it.
    //
    // Opening it, the rows part and the box fades in over them, which is the
    // motion this feature is for. Moving it is a swap: the row on the far
    // side of the new boundary travels back through the space the box is
    // about to occupy, and no animation of a swap avoids a frame where both
    // are in the same place. That frame is what was reported as the box
    // appearing on top of a row, and it is only reachable once a gap is
    // already open, which is why dragging over a folder first was needed to
    // provoke it.
    //
    // Taking the class off BEFORE the transforms are written is what makes
    // the move instant: with no transition in effect the rows are simply
    // already there when the box arrives.
    const opening = this.openAt === null;
    this.cancelClosing();
    c.classList.toggle(CLS_GAP_DRAG, opening);

    // Written in full every time, not as a diff against the last frame. A row
    // that `infinityScroll` rendered into view a moment ago carries no
    // transform, and rewriting the whole set is what puts one on it.
    // Idempotent beats clever when the DOM is not ours.
    for (let i = 0; i < rows.length; i++) {
      const shift = layout.shift[i];
      const el = rows[i].el;
      if (shift) el.style.transform = `translateY(${shift}px)`;
      else el.style.removeProperty("transform");
      // Recorded even when it is zero, so `clearShifts` knows about every row
      // this drag has touched. Rows that leave the render window keep their
      // entry and are put back at the end rather than stranded.
      this.shiftOf.set(el, shift);
    }

    // The fade covers the rows sliding apart, so it belongs to opening the gap
    // and not to moving it. A move lands in space the rows have already left,
    // so the box simply appears there at full strength.
    this.openAt = layout.box.top;
    this.openHeight = layout.box.height;
    if (opening) el.classList.remove(CLS_BOX_OPEN);
    el.className = CLS_DROP_BOX;
    el.style.top = layout.box.top + "px";
    el.style.left = layout.box.left + "px";
    el.style.width = layout.box.width + "px";
    el.style.height = layout.box.height + "px";
    el.hidden = false;
    if (opening) {
      // Reading a layout property between the two writes is what makes the
      // browser treat them as separate states rather than collapsing them and
      // skipping the transition entirely.
      void el.offsetWidth;
    }
    el.classList.add(CLS_BOX_OPEN);
  }

  /**
   * Marks, on the body, whether spaces owns the drop this frame.
   *
   * The stylesheet reads it to neutralise Obsidian's into-the-folder tint and
   * its "Move into <folder>" caption for exactly the frames where spaces is
   * drawing its own insertion point instead. Obsidian's own state is left
   * untouched, so the moment spaces stops claiming, its feedback comes back
   * by itself.
   */
  /**
   * Light up the folder a drop is going to land inside.
   *
   * The vault root is not a folder anyone can see, so an empty parent marks
   * nothing. Re-marking the row that is already marked is a no-op, which
   * matters because this runs on every frame of a held gap.
   */
  private markDestination(parent: string): void {
    const c = this.container;
    if (!c) return;
    const strip = parent
      ? c.querySelector(`${SEL.titleWithPath}[data-path="${CSS.escape(parent)}"]`)
      : null;
    const next = strip instanceof HTMLElement ? strip : null;
    if (next === this.parentMark) return;
    this.parentMark?.classList.remove(CLS_DROP_PARENT);
    next?.classList.add(CLS_DROP_PARENT);
    this.parentMark = next;
  }

  /**
   * Redraw the held answer when the tree gains or loses rows.
   *
   * Only while a gap is open, and disconnected the moment it closes. The
   * redraw writes the same answer, so a pointer that has not moved sees no
   * change beyond the newcomers falling into line.
   */
  private watchForArrivals(): void {
    const c = this.container;
    if (!c || this.arrivals) return;
    this.arrivals = new MutationObserver(() => {
      if (!this.held?.row.isConnected) return;
      this.guard(() => {
        this.syncGeometry();
        if (this.held) this.showIndicator(this.held.row, this.held.edge);
      });
    });
    this.arrivals.observe(c, { childList: true, subtree: true });
  }

  private stopWatchingArrivals(): void {
    this.arrivals?.disconnect();
    this.arrivals = null;
  }

  /** Abandons a pending close, so a new gap is not stripped of its transition. */
  private cancelClosing(): void {
    if (this.closing === null) return;
    clearTimeout(this.closing);
    this.closing = null;
  }

  /**
   * Is the pointer inside the gap that is already open?
   *
   * Box style only. The line opens no gap, so there is nothing to be inside
   * and its behaviour is unchanged.
   */
  private pointerInOpenGap(clientY: number): boolean {
    const c = this.container;
    if (!c || this.openAt === null || this.openHeight <= 0) return false;
    if (this.deps.indicatorStyle() !== "box") return false;
    const top = this.openAt + c.getBoundingClientRect().top - c.scrollTop;
    return clientY >= top && clientY < top + this.openHeight;
  }

  private setClaimingDrop(on: boolean): void {
    const body = this.doc?.body;
    if (!body) return;
    body.classList.toggle(CLS_CLAIMS_DROP, on);
  }

  /**
   * Puts every displaced row back.
   *
   * Separate from hiding the indicator because the two failures are not
   * equally bad. An indicator left showing is a stale hint that the next frame
   * corrects. A transform left behind is a tree sitting permanently out of
   * position, which survives the drag and reads as corruption.
   */
  private clearShifts(animate = false): void {
    // Every strip the drag ever touched, not merely the ones visible now. A
    // row displaced on one frame and gone from the render window on the next
    // still has to be put back, or it returns from a scroll still translated.
    // Instant unless asked otherwise, and the ORDER is what decides it:
    // taking the transition off before the transforms means the rows are
    // already home by the time anything could animate.
    const c = this.container;
    // Nothing displaced, nothing to slide. A drop tears down instantly and
    // then asks Obsidian to end its own drag, which comes back here as a
    // `dragend`; without this that second pass would switch the transition
    // back on for an animation of no rows.
    const worthAnimating = animate && this.shiftOf.size > 0;
    if (worthAnimating && c) {
      // Put BACK, not assumed to be there. The transition is taken off the
      // moment the gap stops opening and starts moving, so by the time any
      // real drag ends it is long gone and a close would jump.
      c.classList.add(CLS_GAP_DRAG);
      // Reading a layout property here is what makes the browser treat the
      // transforms below as a change FROM the current positions rather than
      // collapsing both into one state and skipping the animation.
      void c.offsetWidth;
    } else {
      c?.classList.remove(CLS_GAP_DRAG);
    }
    for (const el of this.shiftOf.keys()) el.style.removeProperty("transform");
    this.shiftOf.clear();
    // The SNAPSHOT SURVIVES. `clearIndicator` runs on every frame that draws
    // nothing, and `onDrop` calls it before resolving its target, so clearing
    // the geometry here left the drop with nothing to resolve against and it
    // silently declined every time. The snapshot belongs to the drag; it is
    // emptied when one starts and when one ends.
    if (worthAnimating && c) {
      // The rows are travelling back. The transition comes off when they
      // arrive, a little after the 100ms the stylesheet asks for.
      this.cancelClosing();
      this.closing = setTimeout(() => {
        this.closing = null;
        this.container?.classList.remove(CLS_GAP_DRAG);
      }, 140);
    }
  }

  /** Hides, never removes: removal during a drag is what caused the flicker. */
  private clearIndicator(animate = false): void {
    if (this.indicator) {
      this.indicator.hidden = true;
      this.indicator.classList.remove(CLS_BOX_OPEN);
    }
    this.openAt = null;
    this.openHeight = 0;
    this.held = null;
    this.markDestination("");
    this.stopWatchingArrivals();
    // Obsidian's feedback is correct again the moment spaces stops claiming.
    this.setClaimingDrop(false);
    this.clearShifts(animate);
  }
}
