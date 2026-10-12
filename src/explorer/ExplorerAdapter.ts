import { ALL_OWNED_CLASSES, CLS, CLS_COMPACT_PREFIX, CLS_ELSEWHERE, SEL } from "./selectors";
import type { VisibilitySnapshot } from "../visibility/VisibilityEngine";
import {
  compactLabel,
  isAbbreviated,
  type CompactLabelPolicy,
  type LabelPart,
} from "../ui/compactLabel";
import type { ChainIndex, Run } from "../visibility/compactChains";

/**
 * The attribute a compacted-and-shortened row carries the full path in.
 *
 * Measured against Obsidian 1.13.7 in the running app: a `[data-path]` row has
 * exactly `class`, `data-path`, `draggable` and an inline `style`, so this is
 * ours alone on these rows -- and hovering a row given one produced
 * Obsidian's own `.tooltip` element reading the attribute's text, the same
 * mechanism its `.nav-action-button` icons use. Nothing else was needed: no
 * `title`, no `data-tooltip-position`.
 */
const ARIA_LABEL = "aria-label";

/**
 * How long the pane must stop moving before the labels are measured again.
 *
 * A sidebar drag fires the observer on nearly every pointer move, and each
 * re-measurement forces a synchronous layout over a window of rows. Settling
 * first means one measurement per drag instead of one per frame, and the user
 * cannot read a label mid-drag anyway.
 */
const RESIZE_SETTLE_MS = 120;

/**
 * How much wider than its box a row's content may measure and still count as
 * fitting.
 *
 * ONE pixel, because both numbers compared below are integers rounded from a
 * fractional layout, and two roundings of nearly equal quantities can land a
 * pixel apart. A row whose text fits exactly can therefore report one pixel
 * more content than box, and without this slack a label that fits would be
 * shortened on a rounding.
 */
const OVERFLOW_SLACK = 1;

/**
 * "Does this row's label fail to fit the pane it is drawn in?"
 *
 * A SEAM, and the reason it is one is jsdom. No test environment this suite
 * runs in performs layout: every element reports `scrollWidth` and
 * `clientWidth` as 0, so the real probe below answers "it fits" for every row
 * a test can build, and a test depending on real layout could only ever
 * assert one branch. Tests substitute this function instead, and the real one
 * is measured in a running Obsidian by `e2e/deep-compact.mjs`.
 */
export type OverflowProbe = (title: HTMLElement) => boolean;

/**
 * What one label pass is told beyond the index and the policy.
 *
 * Both are optional and both default to production: an ordinary caller writes
 * `applyCompactLabels(titles, index, policy)` and gets the real probe and the
 * kept decision.
 */
export interface LabelPassOptions {
  /**
   * Decide every row again, including the ones already drawn short.
   *
   * Set by a settled pane resize, which is the event the adapter hears that
   * can turn a row which did not fit into one that does. See
   * `applyCompactLabels` for why an ordinary pass must NOT do this.
   */
  remeasure?: boolean;
  /** The measuring step. Defaults to `rowOverflows`. */
  overflows?: OverflowProbe;
  /**
   * The caller's record of which rows currently carry a prefix element of
   * ours. Rows are added as they are drawn and removed as they are restored.
   *
   * Teardown's reach problem, and the only thing that solves it. Obsidian
   * renders a window of roughly 49 rows and DETACHES the rest, keeping each
   * row's element on its own tree item so it can be re-attached on scroll. A
   * detached row is in no container and in no document, so no query of any
   * scope can find it. `onunload` makes that likelier rather than rarer: it
   * runs `teardownOrdering()` before `adapter.unbind()`, and `unpatch` forces
   * a `sort()` that re-renders the whole unfiltered vault, so in a vault big
   * enough to window at all the compacted rows have moved before the sweep
   * looks. A stale CLASS on such a row stops mattering when the stylesheet
   * unloads; a stale prefix ELEMENT is still in the user's explorer after the
   * plugin is gone.
   *
   * Optional so a test can drive this function without one. `ExplorerAdapter`
   * always passes its own.
   */
  drawn?: Set<HTMLElement>;
}

/**
 * The rows this module has written an `aria-label` onto.
 *
 * The one record of whose attribute it is, and it has to be a record rather
 * than an inference. `aria-label` is a plain DOM attribute that Obsidian and
 * any other plugin may set for their own reasons; a row having our prefix on
 * it says the ROW is ours, not that the ATTRIBUTE is (a compacted row drawn in
 * full never gets one from here). Removing one we did not set strips a real
 * accessible name for no gain, so both removal sites ask this first.
 *
 * A WeakSet: it is keyed on elements, holds nothing alive, and needs no
 * teardown of its own. It is module state rather than adapter state for the
 * reason `applyCompactLabels` is a free function -- the question is about a
 * row, not about an adapter, and a second adapter asking about the same row
 * must get the same answer.
 */
const ourTooltips = new WeakSet<HTMLElement>();

/**
 * The production probe: TWO comparisons, because the overflow this feature
 * exists for is not visible on one of them alone.
 *
 * Measured in a real vault at a 246px pane, with
 * `Research/2026/Q4/Projects/Atlas/Design/Decisions` compacted onto one row:
 * the row's own content was 263px of a 222px box, AND Obsidian's
 * `.tree-item-inner` -- the tip, the one segment naming the row -- was laid
 * out at a client width of ZERO. The row is a flex container, so a prefix
 * wide enough squeezes the tip to nothing without the row itself reporting any
 * overflow at all. Asking only the row would miss exactly the case that
 * matters most, since the squeezed element is the part the reader needs.
 */
export function rowOverflows(title: HTMLElement): boolean {
  if (title.scrollWidth > title.clientWidth + OVERFLOW_SLACK) return true;
  const textEl = title.querySelector<HTMLElement>(`:scope > ${SEL.rowText}`);
  if (!textEl) return false;
  return textEl.scrollWidth > textEl.clientWidth + OVERFLOW_SLACK;
}

/**
 * The only module that WRITES to Obsidian's explorer tree.
 *
 * It is not the only module that KNOWS that DOM — `DragOrdering` reads and
 * hit-tests the same tree, and `main.ts` reads it through the sort seam. What
 * is exclusive is the writing: owned classes go on rows from here and nowhere
 * else. Selector strings stay centralised in `selectors.ts` for every reader.
 *
 * Two measured facts drive the design:
 *  - data-path is on .tree-item-self, but the row container is its parent
 *    .tree-item. Classing the wrong one leaves folder children visible.
 *  - The tree is WINDOWED: rows detach when scrolled out of view and
 *    reattach later, so application must run on row insertion too.
 *
 * SEVERAL containers, not one. There is one active selection per app
 * instance, and it applies to every file-explorer leaf in the main window.
 * Obsidian permits more than one — drag the Files tab into a split — and one
 * binding leaves the second pane rendered unclassed. One snapshot still,
 * because there is one selection; N containers to write it into.
 */
export class ExplorerAdapter {
  private containers: HTMLElement[] = [];
  private observers: MutationObserver[] = [];
  /** One per bound container, disconnected in `unbind()` with the rest. */
  private resizeObservers: ResizeObserver[] = [];
  /** The settle timer armed by `onPaneResize`, cleared in `unbind()`. */
  private resizeTimer = 0;
  private snapshot: VisibilitySnapshot | null = null;
  /**
   * `apply()` takes only a snapshot, and a snapshot carries no order — there
   * is no way to ask it "which row is first". The caller
   * (`main.ts`) computed the elsewhere group's order to build the hoisted
   * tree in the first place, so it hands the one path to mark here rather
   * than this class inventing its own idea of ordering. Held exactly like
   * `snapshot` — set by `apply()`, read by every `applyNow()` pass including
   * the ones the MutationObserver drives, since the marked row can arrive in
   * the DOM after the queued re-sort completes, well after this `apply()`
   * call returned.
   */
  private elsewhereFirst: string | null = null;
  private chainIndex: ChainIndex | null = null;
  /**
   * Seeded to the shipped default rather than to "never shorten".
   *
   * It is only ever read with a non-null `chainIndex`, which cannot exist
   * before `setChainIndex` has supplied both — so this value is unreachable in
   * practice. It matches `DEFAULT_DEFINITIONS` anyway, so the failure mode if
   * that ever stops being true is the shipped behaviour rather than a silently
   * disabled setting.
   */
  private labelPolicy: CompactLabelPolicy = { abbreviateWhenOverflowing: true };
  /**
   * Set by a settled pane resize, consumed by the next label pass.
   *
   * A row already drawn short is normally left alone: deciding again means
   * drawing the full label to measure it, and a pass that rewrote the prefix
   * every time would be seen by this class's own MutationObserver and schedule
   * the next pass forever. A pane resize is the event this class hears that
   * can turn a row which did not fit into one that does, so it is the one that
   * asks for the decision to be retaken.
   */
  private remeasure = false;

  /**
   * Every row this adapter currently has a prefix element on.
   *
   * See `LabelPassOptions.drawn` for why a record is the only thing that can
   * reach a row Obsidian has detached. Held per adapter rather than per module
   * because it is a list of what to UNDO, and undoing is this instance's job.
   *
   * It does not grow without bound: an entry goes in when a prefix is drawn
   * and comes out when it is removed, so the size is the number of compacted
   * tips the explorer is currently holding elements for, and `bindAll` calls
   * `unbind()` first, which empties it on every layout change. The elements it
   * keeps alive between those points are the same ones Obsidian is keeping
   * alive on its own tree items.
   */
  private readonly drawn = new Set<HTMLElement>();

  /**
   * The measuring step, substitutable for the reason `OverflowProbe`
   * documents: no test environment lays anything out.
   *
   * A defaulted constructor argument rather than a setter, so production
   * constructs this class exactly as it always did and no branch exists that
   * only a test can take.
   */
  constructor(private readonly overflows: OverflowProbe = rowOverflows) {}

  /**
   * Set with the snapshot, because the runs are a function of it.
   *
   * The policy is a REQUIRED second argument, not a separate setter with a
   * default, so a caller cannot hand over an index and forget it — which
   * would silently draw every row with the shipped behaviour whatever the
   * user had chosen, and pass the whole suite.
   */
  setChainIndex(index: ChainIndex | null, policy: CompactLabelPolicy): void {
    // A CHANGE here re-opens the question a kept decision closed.
    //
    // `applyCompactLabels` recognises a row already drawn short by the text in
    // its prefix, and that text is `../<parent>/` for EVERY run ending at this
    // tip -- the last two segments are fixed by the path. So a run whose HEAD
    // moved (a sibling appears under the head, and the run now starts a folder
    // lower) draws the same short label and would never be measured again,
    // even though its full label is now shorter and might fit. The index is
    // the honest signal: `main.ts` keeps the previous OBJECT when the runs are
    // unchanged (`sameChainIndex`), so a different one means they really did
    // change, and this costs nothing on the `file-open` path that reaches here
    // most often. Compared by identity for the index and by VALUE for the
    // policy, because `compactLabelOptions()` builds a fresh object each call.
    if (
      index !== this.chainIndex ||
      policy.abbreviateWhenOverflowing !== this.labelPolicy.abbreviateWhenOverflowing
    ) {
      this.remeasure = true;
    }
    this.chainIndex = index;
    this.labelPolicy = policy;
  }

  private frame = 0;
  private healthy = true;
  private healthListener: ((healthy: boolean) => void) | null = null;

  /**
   * Fires only on a healthy/unhealthy transition (not on every apply pass),
   * including transitions triggered internally by the MutationObserver, not
   * just the applies the caller initiates directly. This lets a caller show
   * a single Notice per break without tracking apply-by-apply state itself.
   */
  onHealthChange(fn: (healthy: boolean) => void): void {
    this.healthListener = fn;
  }

  /** The single-container case, which is every case but a split explorer. */
  bind(container: HTMLElement): void {
    this.bindAll([container]);
  }

  /**
   * Bind every main-window file explorer's container at once.
   *
   * Wholesale, not incremental: `changeLayout()` replaces containers rather
   * than mutating the set, so a diffing rebind would be machinery serving a
   * case that does not arise — and `unbind()` first is what guarantees the
   * owned classes come off the OUTGOING nodes while they can still be reached
   *. Duplicates are dropped so a caller that queries the same node twice
   * cannot install two observers on it.
   */
  bindAll(containers: readonly HTMLElement[]): void {
    this.unbind();
    for (const container of containers) {
      if (this.containers.includes(container)) continue;
      this.containers.push(container);
      const observer = new MutationObserver(() => this.schedule());
      observer.observe(container, { childList: true, subtree: true });
      this.observers.push(observer);
      // Whether a compacted label fits is a fact about the PANE, and a
      // sidebar drag reaches nothing else that re-runs the label pass: it
      // produces no mutation of the tree, no snapshot and no setting write.
      // (`SwitcherView` watches the same pane with an observer of its own, for
      // its strip's alignment; neither knows about the other.) Without this, a
      // row shortened in a narrow pane stays shortened once the pane is
      // widened, and a row that fitted goes on overflowing a pane the user
      // just narrowed.
      //
      // CAN THIS FEED ITSELF? It observes the container the label pass writes
      // into, which `SwitcherView.ts:245` is careful to rule out for its own.
      // Here the answer is bounded rather than impossible, and the bound is
      // worth stating. A pass is SYNCHRONOUS -- draw full, measure, draw short
      // all happen in one task -- and a ResizeObserver reports the size at
      // delivery, which is the end of the frame. So the browser never sees the
      // intermediate layouts, only the pass's final one. A pass that changes
      // no label leaves that final layout identical and reports nothing. A
      // pass that DOES change one can flip a horizontal scrollbar, which is a
      // content-box change this observer would report; that costs one further
      // debounced pass, whose own final layout is then identical, so the chain
      // stops there. The residual is one extra pass per genuine relabel on a
      // pane whose scrollbar is on the edge, 120ms after it, and not a loop.
      //
      // `defaultView`, not Obsidian's `win`: the same cross-window handle
      // `SwitcherView` uses, and the one the DOM lib types constructors on. It
      // is null for a container no document owns, which is a tree with no
      // width to measure anyway.
      const view = container.ownerDocument.defaultView;
      if (!view) continue;
      const resize = new view.ResizeObserver(() => this.onPaneResize());
      resize.observe(container);
      this.resizeObservers.push(resize);
    }
  }

  /**
   * A settled resize, then one ordinary pass with the decision retaken.
   *
   * Debounced rather than coalesced into a frame like `schedule()`: a sidebar
   * drag fires the observer on nearly every pointer move, each pass re-reads
   * the layout of a window of rows, and a label nobody can read mid-drag is
   * worth nothing. One measurement per drag, taken where it stops.
   */
  private onPaneResize(): void {
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = 0;
      this.remeasure = true;
      this.applyNow();
    }, RESIZE_SETTLE_MS);
  }

  unbind(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
    // A ResizeObserver holds the element it watches and its callback holds
    // this adapter, so one left connected outlives the plugin's unload and
    // goes on labelling a torn-down tree every time the user drags the
    // sidebar. Disconnected here, beside the MutationObservers, because this
    // is where the rest of the teardown lives and a second place to remember
    // is a place to forget.
    for (const resize of this.resizeObservers) resize.disconnect();
    this.resizeObservers = [];
    if (this.resizeTimer) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = 0;
    }
    this.remeasure = false;
    if (this.frame) {
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.clearOwnedClasses();
    this.containers = [];
    this.snapshot = null;
    this.elsewhereFirst = null;
    const wasHealthy = this.healthy;
    this.healthy = true;
    if (!wasHealthy) this.healthListener?.(true);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  /**
   * There is deliberately no `currentSnapshot()` here.
   *
   * The snapshot this class holds is the DOM layer's working copy — what the
   * last `applyNow()` wrote, nulled by `unbind()`, which is a DOM-PRESENCE
   * event and says nothing about which space is active. `filterAndOrderFolder`
   * used to read it to decide which files exist in the tree, making a domain
   * decision depend on this layer's lifecycle; it reads
   * `SpaceController.currentSnapshot()` now, which is where the snapshot is
   * owned and which the other two consumers (`creation.ts`, `membershipMenu.ts`)
   * already read. Keeping a public reader here would invite that back.
   */

  /**
   * Take everything of ours back off, wherever it ended up.
   *
   * THREE REACHES, because no one of them finds every row. The tree is
   * WINDOWED and the containers are REPLACED, so "the rows I can see from the
   * container I hold" — which is all this used to be — is the smallest of the
   * three sets and the only one that is never enough.
   *
   *  - The bound CONTAINERS. Still first, and still necessary: a container may
   *    be detached from its document by the time this runs (`changeLayout()`
   *    replaces `.nav-files-container`, and `bindExplorer` unbinds when it
   *    finds none), and a detached container is not reachable from the
   *    document either.
   *  - The DOCUMENTS those containers and rows belong to, asked for our own
   *    classes rather than enumerated row by row. This is what reaches the
   *    LIVE tree when the adapter is holding an outgoing container —
   *    `bindExplorer` documents that exact window, where a cleanup scoped to
   *    what we hold "can never reach the live tree either". Asking for our
   *    classes also costs one query per class instead of a pass over every
   *    row in the vault's rendered window.
   *  - The RECORD of rows a prefix was drawn on, which is the only reach that
   *    finds a row Obsidian has DETACHED — see `LabelPassOptions.drawn`.
   *
   * Overlap between the three is free: every removal here is idempotent.
   */
  private clearOwnedClasses(): void {
    const roots: ParentNode[] = [...this.containers];
    const docs = new Set<Document>();
    for (const c of this.containers) docs.add(c.ownerDocument);
    // A remembered row's document, so a sweep still has a document to ask
    // when every container has already gone (`unbind()` empties the list, and
    // a popout explorer's rows do not belong to this one's document anyway).
    for (const title of this.drawn) docs.add(title.ownerDocument);
    for (const doc of docs) roots.push(doc);

    for (const root of roots) {
      for (const cls of ALL_OWNED_CLASSES) {
        root.querySelectorAll(`.${cls}`).forEach((el) => el.classList.remove(cls));
      }
      // `CLS.compacted` needs no query of its own, although it is not in
      // `ALL_OWNED_CLASSES`: `drawRow` only ever adds it to a row it also puts
      // a prefix on, and `restoreRow` below takes the two off together. A
      // query for it here would be a branch no test could reach.
      //
      // Found by OUR element rather than by walking every `[data-path]` row:
      // the prefix is the thing that has to come off, and it is the one node
      // in this tree that says so. `restoreRow` is the same function the
      // ordinary pass gives a row back with, so there is one definition of
      // "restored" rather than a second one that could drift.
      root.querySelectorAll<HTMLElement>(`.${CLS_COMPACT_PREFIX}`).forEach((prefix) => {
        const title = prefix.parentElement;
        if (title) restoreRow(title, this.drawn);
      });
    }

    // Copied first: `restoreRow` deletes from the set it is iterating.
    for (const title of [...this.drawn]) restoreRow(title, this.drawn);
    this.drawn.clear();
  }

  /** Coalesce bursts of mutations into a single pass. */
  private schedule(): void {
    if (this.frame) return;
    // Qualified with `window`, and cancelled on the same object in
    // `unbind()`: a bare call resolves against whichever global the bundle
    // was evaluated in, which is not the popout window an explorer can be
    // living in. `obsidianmd/prefer-window-timers` asks for exactly this.
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.applyNow();
    });
  }

  /**
   * Returns the number of rows whose classes actually changed.
   *
   * `elsewhereFirst` defaults to `null`: most callers, and every
   * space that is not a folder space, have no elsewhere group at all, and
   * `null` classes nothing rather than requiring every call site to pass it.
   */
  apply(snapshot: VisibilitySnapshot | null, elsewhereFirst: string | null = null): number {
    this.snapshot = snapshot;
    this.elsewhereFirst = elsewhereFirst;
    return this.applyNow();
  }

  applyNow(): number {
    if (this.containers.length === 0) return 0;

    if (this.snapshot === null) {
      this.clearOwnedClasses();
      return 0;
    }

    const titles: HTMLElement[] = [];
    for (const c of this.containers) {
      c.querySelectorAll<HTMLElement>(SEL.titleWithPath).forEach((t) => titles.push(t));
    }
    // Health check: ROWS but no path-bearing rows means the DOM contract
    // changed. Fail open rather than present a misleading tree.
    //
    // Gated on rows, not on `c.children.length`, and the difference is a real
    // bug this replaced. Measured against 1.13.7, `.nav-files-container` holds
    // one wrapper div whose first child is a virtual-scroll spacer with no
    // `data-path` — and both exist BEFORE any row is populated. On a slow
    // start-up the old condition was therefore satisfied by a perfectly normal
    // half-built tree, and told the user their file explorer was not
    // recognised. It could not distinguish "the contract changed" from "the
    // tree is not built yet".
    //
    // Rows are the honest signal because the danger this guards against is
    // rows being ON SCREEN that we cannot identify. With no rows at all,
    // nothing is being mis-presented and there is nothing to fail open from —
    // and if `.tree-item` itself were ever renamed we would find no rows,
    // apply no classes, and still show the user their own tree untouched.
    //
    // Aggregated across containers rather than judged per container.
    // The DOM contract is a property of the Obsidian build, so a real change
    // breaks every pane at once; one pane with rows and no titles while
    // another has titles is a half-built tree, which is exactly the false
    // alarm the rows gate above was written to avoid.
    let rowCount = 0;
    for (const c of this.containers) rowCount += c.querySelectorAll(SEL.rowWrapper).length;
    if (titles.length === 0 && rowCount > 0) {
      const wasHealthy = this.healthy;
      this.healthy = false;
      this.clearOwnedClasses();
      if (wasHealthy) this.healthListener?.(false);
      return 0;
    }
    const wasHealthy = this.healthy;
    this.healthy = true;
    if (!wasHealthy) this.healthListener?.(true);

    let changed = 0;
    for (const title of titles) {
      const path = title.getAttribute("data-path");
      const wrapper = title.parentElement;
      if (!path || !wrapper) continue;

      const d = this.snapshot.decisionFor(path);
      // Left inferred: `CLS_ELSEWHERE` is `as const`
      // (selectors.ts) exactly like `CLS.scaffold`/`CLS.visitor`, so this
      // stays a literal-keyed object type, and `want[cls]` below only
      // type-checks because `ALL_OWNED_CLASSES` is the same three literals.
      // Widening either side (a plain-`string` constant, or annotating this
      // as `Record<string, boolean>`) would make a class added to
      // `ALL_OWNED_CLASSES` with no matching entry here compile silently
      // instead of failing loudly (TS7053) — the failure mode we want.
      const want = {
        [CLS.scaffold]: d.visible && d.reason === "scaffold",
        [CLS.visitor]: d.visible && d.reason === "visitor",
        // Not derived from `d`: this is an ORDER fact the caller computed,
        // not a visibility reason `decisionFor` knows about.
        [CLS_ELSEWHERE]: path === this.elsewhereFirst,
      };

      for (const cls of ALL_OWNED_CLASSES) {
        const has = wrapper.classList.contains(cls);
        if (want[cls] && !has) {
          wrapper.classList.add(cls);
          changed++;
        } else if (!want[cls] && has) {
          wrapper.classList.remove(cls);
          changed++;
        }
      }
    }
    // The flag is consumed HERE rather than read in place, so a pass that
    // returned early above cannot swallow a resize: it stays set until a pass
    // actually reaches the labels.
    const remeasure = this.remeasure;
    this.remeasure = false;
    applyCompactLabels(titles, this.chainIndex, this.labelPolicy, {
      remeasure,
      overflows: this.overflows,
      drawn: this.drawn,
    });
    return changed;
  }
}

/**
 * Put the joined label on each compacted tip row, and take it off everything
 * else.
 *
 * Exported and free of adapter state so it can be asserted directly. The text
 * belongs to Obsidian, which also uses it for inline rename, so restoring it
 * exactly matters more than the labelling does.
 *
 * THREE PASSES, AND THAT IS THE POINT. Whether a compacted label fits is
 * something only the laid-out pane knows, so the row is drawn in full,
 * measured, and redrawn short if it did not fit. Done row by row that is
 * write-read-write-read down a window of about fifty rows, and every read
 * after a write forces the browser to lay the tree out again. So: every row is
 * drawn first, then every row is measured, then every row that overflowed is
 * redrawn. One layout instead of fifty.
 *
 * WHY A ROW ALREADY DRAWN SHORT IS LEFT ALONE. The first pass would have to
 * put the full label back to measure it, and the third would shorten it again
 * -- rewriting the prefix on every pass, forever. `ExplorerAdapter` watches
 * the very container this writes into with a MutationObserver, so those writes
 * would schedule the next pass, which would write again: the explorer would
 * redraw every frame for as long as the plugin was loaded. The decision is
 * therefore kept until something that could change it happens, which is a pane
 * resize, and `remeasure` is how the adapter says so.
 *
 * WHAT IS WRITTEN, AND WHAT IS NOT. `titles` are `[data-path]` elements, which
 * in Obsidian are `.tree-item-self` -- the ROW, whose children are the collapse
 * chevron and `.tree-item-inner`. NEITHER is written. `.tree-item-inner`
 * especially: Obsidian seeds its inline-rename editor from that element's
 * text, so a joined label written there offered `Clients/Meetings` for a
 * folder named `Meetings` and the commit failed with ENOENT against
 * `Clients/Clients/Meetings` -- a compacted folder could not be renamed at all.
 * `SEL.rowText` documents that in full.
 *
 * Instead ONE element of our own (`CLS_COMPACT_PREFIX`) carries the lead and
 * the separator, inserted as a sibling immediately before the text element.
 * The row reads `Clients/` + `Meetings` exactly as it did, and the inner still
 * holds only `Meetings`.
 *
 * FAILS OPEN PER ROW. A row with no text element is skipped entirely -- no
 * prefix, and not even classed. There is nothing to anchor the prefix to, and
 * a class with no label is a style on a row that reads as an ordinary folder.
 *
 * RESTORATION IS REMOVING ONE ELEMENT, plus the class, plus the tooltip
 * attribute when this pass put one there. Nothing else. No text is rewritten,
 * so nothing can be restored wrongly, nothing is stashed in a data attribute,
 * and the row comes back as the elements Obsidian built rather than as a
 * rebuild that resembles them.
 *
 * THE TOOLTIP. A row whose label was SHORTENED no longer shows the folders it
 * passed through, so the full joined path goes on the row as `aria-label`,
 * which Obsidian renders as its own tooltip on hover (verified in the running
 * app -- see `ARIA_LABEL`). It is set only while the label is abbreviated: a
 * row drawing its whole path has nothing a tooltip could add, and a stale one
 * would claim a shortening that is no longer happening.
 *
 * Taken off only on a row this pass PUT ONE ON, never blanket-removed and
 * never inferred from the row being compacted. `aria-label` is a plain DOM
 * attribute Obsidian and any other plugin may set for their own reasons, and
 * stripping one we did not write would quietly delete a real accessible name.
 * `ourTooltips` is the record both removal sites consult.
 */
export function applyCompactLabels(
  titles: readonly HTMLElement[],
  index: ChainIndex | null,
  policy: CompactLabelPolicy,
  pass: LabelPassOptions = {}
): void {
  const overflows = pass.overflows ?? rowOverflows;
  const drawn = pass.drawn;
  /** The rows drawn in full that still need a verdict. */
  const undecided: { title: HTMLElement; run: Run }[] = [];

  // PASS ONE: writes only.
  for (const title of titles) {
    const path = title.getAttribute("data-path");
    if (!path) continue;
    // `:scope >` is deliberate: a collapsed folder still holds its
    // `.tree-item-children` subtree in the DOM, and a plain descendant query
    // from the WRAPPER would find a child row's text element first. Searching
    // the row itself keeps that impossible either way, and the direct-child
    // form says so. The same reasoning applies to the prefix below.
    const textEl = title.querySelector<HTMLElement>(`:scope > ${SEL.rowText}`);
    if (!textEl) continue;
    const run = index?.runByTip.get(path);
    if (!run) {
      restoreRow(title, drawn);
      continue;
    }
    // Turned off means never measured. The answer could not change the label,
    // and reading a width forces a layout.
    if (!policy.abbreviateWhenOverflowing) {
      drawRow(title, textEl, run, false, drawn);
      continue;
    }
    // Already showing what a "yes" would draw. For a long run that is the
    // decision taken at the last measurement, kept for the reason above; for a
    // two-segment run, which `compactLabel` refuses to shorten at any width,
    // it is the only label there is, so measuring it is work with one possible
    // outcome.
    if (!pass.remeasure && textOf(run, true) === prefixTextOn(title)) {
      drawRow(title, textEl, run, true, drawn);
      continue;
    }
    drawRow(title, textEl, run, false, drawn);
    undecided.push({ title, run });
  }

  // PASS TWO: reads only. Nothing in this loop writes, so the layout the first
  // read forces is the only one, and every later read is served from it.
  const tooLong = undecided.filter((row) => overflows(row.title));

  // PASS THREE: writes only.
  for (const { title, run } of tooLong) {
    const textEl = title.querySelector<HTMLElement>(`:scope > ${SEL.rowText}`);
    if (textEl) drawRow(title, textEl, run, true, drawn);
  }
}

/** What this module would write into the prefix for a run, drawn either way. */
function textOf(run: Run, abbreviate: boolean): string {
  return partsFor(run, abbreviate)
    .map((p) => p.text)
    .join("");
}

/**
 * The parts that are actually DRAWN, which is the label minus its tip.
 *
 * The TIP part is dropped, and that is not an oversight. `compactLabel` still
 * returns it because it describes the whole label; the element it would be
 * drawn into already contains it, as the folder's real name, and writing that
 * element is the defect this shape exists to avoid. A run is two segments or
 * more (`runFrom`), so what is left is never empty.
 */
function partsFor(run: Run, abbreviate: boolean): readonly LabelPart[] {
  return compactLabel(run.segments, { abbreviate }).filter((p) => p.role !== "tip");
}

/** The text our prefix element currently carries, or null if there is none. */
function prefixTextOn(title: HTMLElement): string | null {
  const prefix = title.querySelector<HTMLElement>(`:scope > .${CLS_COMPACT_PREFIX}`);
  return prefix ? prefix.textContent : null;
}

/**
 * Draw one compacted row, long or short.
 *
 * Idempotent where it MATTERS: called again with the same run and the same
 * decision it adds and removes no nodes, which is what keeps the adapter's own
 * MutationObserver -- a `childList` observer -- from scheduling an endless
 * chain of passes.
 *
 * It is not inert. The `aria-label` and the row class below are written
 * unconditionally, so a second call does set an attribute to the value it
 * already holds. That is deliberate: both are cheap, and gating them would
 * make the drawn label the record of what the attribute should be, which is
 * the kind of stashed state this pass does not keep. It is safe only because
 * no observer in `src/` watches attributes; one added later would have to read
 * this.
 *
 * REMOVING the tooltip is the one thing it does not do unconditionally, and
 * that asymmetry is deliberate too (DS-6). Writing an attribute we own is
 * ours to repeat; removing one is only ours when we put it there. A compacted
 * row drawn in FULL carries no tooltip of ours, and being compacted says
 * nothing about who set the `aria-label` it may be carrying -- Obsidian sets
 * them on its own rows for its own reasons. `ourTooltips` is the record, for
 * the reason given there.
 */
function drawRow(
  title: HTMLElement,
  textEl: HTMLElement,
  run: Run,
  abbreviate: boolean,
  drawn?: Set<HTMLElement>
): void {
  const label = compactLabel(run.segments, { abbreviate });
  const parts = partsFor(run, abbreviate);
  const text = parts.map((p) => p.text).join("");
  let prefix = title.querySelector<HTMLElement>(`:scope > .${CLS_COMPACT_PREFIX}`);
  if (!prefix) {
    // Created on the row's own window: a popout explorer is not this one's
    // document.
    prefix = textEl.ownerDocument.win.createSpan({ cls: CLS_COMPACT_PREFIX });
    title.insertBefore(prefix, textEl);
  }
  // Compared on the concatenated text, not on the parts: it is what changes
  // when a run or a decision changes, and `textContent` already reads through
  // the spans. Rebuilding them every pass would churn the DOM on every
  // mutation the observer sees -- and REUSING the prefix rather than appending
  // a second one is what keeps a repeated pass idempotent.
  if (prefix.textContent !== text) {
    prefix.replaceChildren(
      ...parts.map((p) =>
        textEl.ownerDocument.win.createSpan({ cls: `spaces-compact-${p.role}`, text: p.text })
      )
    );
  }
  // Asked of the PARTS, not recomputed from the decision, so one rule decides
  // both what is drawn and whether anything was left out. A later variant that
  // elides differently gets the tooltip without touching this line.
  if (isAbbreviated(label)) {
    // The whole label, which is what the row would have read. Joined from the
    // run's own segments rather than from `run.tip`: a run that starts below
    // the vault root has a tip path with ancestors the label never claimed,
    // and the tooltip must say what was hidden, not more.
    title.setAttribute(ARIA_LABEL, run.segments.join("/"));
    ourTooltips.add(title);
  } else if (ourTooltips.has(title)) {
    title.removeAttribute(ARIA_LABEL);
    ourTooltips.delete(title);
  }
  title.parentElement?.classList.add(CLS.compacted);
  drawn?.add(title);
}

/**
 * Give a row that is not a compacted tip back to Obsidian.
 *
 * Unconditional, and cheap: both removals are no-ops on a row that was never
 * compacted. Gating them on the class would make the class the record of what
 * to undo, which is the kind of stashed state this pass does not keep.
 *
 * The tooltip is the one exception, and it is taken off only where this
 * module put it: `aria-label` is a DOM attribute anyone may use, and a blanket
 * removal here would strip one Obsidian had put on a row this plugin never
 * labelled -- or on one it labelled in full, which never carries a tooltip of
 * ours. `ourTooltips` is that record, and `drawRow` reads the same one.
 *
 * `drawn` is the caller's record of rows carrying a prefix, kept in step here
 * so teardown does not reach back into a row that has already been given back.
 */
function restoreRow(title: HTMLElement, drawn?: Set<HTMLElement>): void {
  const prefix = title.querySelector<HTMLElement>(`:scope > .${CLS_COMPACT_PREFIX}`);
  if (prefix) prefix.remove();
  if (ourTooltips.has(title)) {
    title.removeAttribute(ARIA_LABEL);
    ourTooltips.delete(title);
  }
  title.parentElement?.classList.remove(CLS.compacted);
  drawn?.delete(title);
}
