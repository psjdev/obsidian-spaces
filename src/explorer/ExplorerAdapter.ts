import { ALL_OWNED_CLASSES, CLS, CLS_COMPACT_PREFIX, CLS_ELSEWHERE, SEL } from "./selectors";
import type { VisibilitySnapshot } from "../visibility/VisibilityEngine";
import { compactLabel } from "../ui/compactLabel";
import type { ChainIndex } from "../visibility/compactChains";

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

  /** Set with the snapshot, because the runs are a function of it. */
  setChainIndex(index: ChainIndex | null): void {
    this.chainIndex = index;
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
    }
  }

  unbind(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
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

  private clearOwnedClasses(): void {
    for (const c of this.containers) {
      for (const cls of ALL_OWNED_CLASSES) {
        c.querySelectorAll(`.${cls}`).forEach((el) => el.classList.remove(cls));
      }
      // Through the one function that owns this class, so the prefix element
      // it inserted goes with it. Stripping the class alone would leave a row
      // reading `Work/Clients` with nothing left to say it should not.
      const titles: HTMLElement[] = [];
      c.querySelectorAll<HTMLElement>(SEL.titleWithPath).forEach((t) => titles.push(t));
      applyCompactLabels(titles, null);
    }
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
    applyCompactLabels(titles, this.chainIndex);
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
 * WHAT IS WRITTEN, AND WHAT IS NOT. `titles` are `[data-path]` elements, which
 * in Obsidian are `.tree-item-self` — the ROW, whose children are the collapse
 * chevron and `.tree-item-inner`. NEITHER is written. `.tree-item-inner`
 * especially: Obsidian seeds its inline-rename editor from that element's
 * text, so a joined label written there offered `Clients/Meetings` for a
 * folder named `Meetings` and the commit failed with ENOENT against
 * `Clients/Clients/Meetings` — a compacted folder could not be renamed at all.
 * `SEL.rowText` documents that in full.
 *
 * Instead ONE element of our own (`CLS_COMPACT_PREFIX`) carries the lead and
 * the separator, inserted as a sibling immediately before the text element.
 * The row reads `Clients/` + `Meetings` exactly as it did, and the inner still
 * holds only `Meetings`.
 *
 * FAILS OPEN PER ROW. A row with no text element is skipped entirely — no
 * prefix, and not even classed. There is nothing to anchor the prefix to, and
 * a class with no label is a style on a row that reads as an ordinary folder.
 *
 * RESTORATION IS REMOVING ONE ELEMENT, plus the class. Nothing else. No text
 * is rewritten, so nothing can be restored wrongly, nothing is stashed in a
 * data attribute, and the row comes back as the elements Obsidian built rather
 * than as a rebuild that resembles them.
 */
export function applyCompactLabels(
  titles: readonly HTMLElement[],
  index: ChainIndex | null
): void {
  for (const title of titles) {
    const path = title.getAttribute("data-path");
    if (!path) continue;
    const run = index?.runByTip.get(path);
    const wrapper = title.parentElement;
    // `:scope >` is deliberate: a collapsed folder still holds its
    // `.tree-item-children` subtree in the DOM, and a plain descendant query
    // from the WRAPPER would find a child row's text element first. Searching
    // the row itself keeps that impossible either way, and the direct-child
    // form says so. The same reasoning applies to the prefix below.
    const textEl = title.querySelector<HTMLElement>(`:scope > ${SEL.rowText}`);
    if (!textEl) continue;
    const existing = title.querySelector<HTMLElement>(`:scope > .${CLS_COMPACT_PREFIX}`);
    if (run) {
      // The TIP part is dropped, and that is not an oversight. `compactLabel`
      // still returns it because it describes the whole label; the element it
      // would be drawn into already contains it, as the folder's real name,
      // and writing that element is the defect this shape exists to avoid.
      // A run is two segments or more (`runFrom`), so what is left is never
      // empty.
      const parts = compactLabel(run.segments).filter((p) => p.role !== "tip");
      const text = parts.map((p) => p.text).join("");
      let prefix = existing;
      if (!prefix) {
        // Created on the row's own window: a popout explorer is not this
        // one's document.
        prefix = textEl.ownerDocument.win.createSpan({ cls: CLS_COMPACT_PREFIX });
        title.insertBefore(prefix, textEl);
      }
      // Compared on the concatenated text, not on the parts: it is what
      // changes when a run changes, and `textContent` already reads through
      // the spans. Rebuilding them every pass would churn the DOM on every
      // mutation the observer sees — and REUSING the prefix rather than
      // appending a second one is what keeps a repeated pass idempotent.
      if (prefix.textContent !== text) {
        prefix.replaceChildren(
          ...parts.map((p) =>
            textEl.ownerDocument.win.createSpan({
              cls: `spaces-compact-${p.role}`,
              text: p.text,
            })
          )
        );
      }
      wrapper?.classList.add(CLS.compacted);
    } else {
      // Unconditional, and cheap: both are no-ops on a row that was never
      // compacted. Gating them on the class would make the class the record
      // of what to undo, which is the kind of stashed state this pass does
      // not keep.
      existing?.remove();
      wrapper?.classList.remove(CLS.compacted);
    }
  }
}
