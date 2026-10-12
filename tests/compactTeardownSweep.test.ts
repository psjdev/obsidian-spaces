// @vitest-environment jsdom
/**
 * Teardown has to reach every row this plugin wrote to, not the ones that
 * happen to be on screen when it runs (C1).
 *
 * WHY THIS IS A DIFFERENT CATEGORY FROM A STALE CLASS. A leftover
 * `spaces-scaffold` stops mattering the moment the stylesheet unloads: the
 * class is still in the DOM but nothing renders differently. A leftover PREFIX
 * ELEMENT is an element. It reads `Clients/` beside a folder named `Meetings`
 * in the user's file explorer, and it is still there after the plugin is gone.
 *
 * WHY THE ROWS ARE NOT ON SCREEN. Obsidian's explorer renders a window of
 * roughly 49 rows and DETACHES the rest, keeping each row's element on its own
 * tree item so it can be re-attached on scroll. `onunload` makes that worse on
 * purpose: `teardownOrdering()` runs before `adapter.unbind()`, and `unpatch`
 * forces a `sort()` that re-renders the whole unfiltered vault — which pushes
 * the compacted rows out of the window before the sweep ever looks. A detached
 * row is in no container and in no document, so no query can find it; only a
 * record of what was written can.
 *
 * SO THE SWEEP HAS TWO REACHES, and neither subsumes the other:
 *  - the DOCUMENT, asked for our own classes, which finds a row that is still
 *    rendered but has left the container the adapter holds. `bindExplorer`
 *    already documents that window: `changeLayout()` replaces
 *    `.nav-files-container`, and a cleanup scoped to the held container
 *    "can never reach the live tree either".
 *  - the RECORD of rows a label was drawn on, which is the only thing that
 *    reaches a detached one.
 */
import { describe, expect, it, afterEach } from "vitest";
import { ExplorerAdapter } from "../src/explorer/ExplorerAdapter";
import { CLS, CLS_COMPACT_PREFIX } from "../src/explorer/selectors";
import type { CompactLabelPolicy } from "../src/ui/compactLabel";
import type { VisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { buildChainIndex, type ChainIndex } from "../src/visibility/compactChains";

const ON: CompactLabelPolicy = { abbreviateWhenOverflowing: true };

const CHAIN = ["Clients", "Clients/Northwind", "Clients/Northwind/Meetings"];
const TIP = "Clients/Northwind/Meetings";
/** What the whole run reads as: the joined segments, which is also the tip path. */
const FULL = "Clients/Northwind/Meetings";

const INDEX: ChainIndex = buildChainIndex([CHAIN[0]], {
  visibleChildrenOf: (p: string) => {
    const i = CHAIN.indexOf(p);
    if (i >= 0 && i < CHAIN.length - 1) return [CHAIN[i + 1]];
    if (p === TIP) return [`${TIP}/a.md`];
    return [];
  },
  isFolder: (p: string) => CHAIN.includes(p),
  isScaffold: (p: string) => CHAIN.includes(p),
  parentOf: (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : null),
  nameOf: (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p),
});

/** Everything visible and scaffold, which is all `applyNow` asks of a snapshot. */
const SNAP: VisibilitySnapshot = {
  decisionFor: () => ({
    visible: true,
    reason: "scaffold",
    canRemoveMembership: false,
    overridesIgnore: false,
  }),
  visiblePaths: () => new Set(CHAIN),
};

/** A real `.nav-files-container` in the document, holding one row per path. */
function container(...paths: string[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "nav-files-container";
  // No whitespace between the elements: `textContent` is read below to pin
  // that nothing of Obsidian's was rewritten, and stray text nodes would make
  // that assertion about the fixture's formatting instead.
  el.innerHTML = paths
    .map(
      (p) =>
        `<div class="tree-item nav-folder">` +
        `<div class="tree-item-self nav-folder-title" data-path="${p}">` +
        `<div class="tree-item-icon collapse-icon"></div>` +
        `<div class="tree-item-inner nav-folder-title-content">${p.split("/").pop()}</div>` +
        `</div></div>`
    )
    .join("");
  document.body.appendChild(el);
  return el;
}

const titleIn = (root: ParentNode, path: string): HTMLElement =>
  root.querySelector(`[data-path="${path}"]`) as HTMLElement;

const prefixOf = (title: HTMLElement): HTMLElement | null =>
  title.querySelector<HTMLElement>(`:scope > .${CLS_COMPACT_PREFIX}`);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("teardown sweeps the whole tree, not the render window", () => {
  it("takes the prefix and the tooltip off a row the explorer has detached", () => {
    const c = container(TIP);
    // Narrow pane, so the label shortens and carries a tooltip: both halves of
    // what a detached row would keep forever.
    const a = new ExplorerAdapter(() => true);
    a.bind(c);
    a.setChainIndex(INDEX, ON);
    a.apply(SNAP);
    const title = titleIn(c, TIP);
    expect(prefixOf(title)).not.toBeNull();
    expect(title.getAttribute("aria-label")).toBe(FULL);

    // The row scrolls out of the window: Obsidian detaches the element and
    // keeps it on its tree item. This is the state `unpatch`'s forced sort
    // puts the compacted rows into, moments before `adapter.unbind()` runs.
    const wrapper = title.parentElement as HTMLElement;
    wrapper.remove();

    a.unbind();

    expect(prefixOf(title)).toBeNull();
    expect(title.hasAttribute("aria-label")).toBe(false);
    expect(wrapper.classList.contains(CLS.compacted)).toBe(false);
  });

  it("gives a detached row its own text back, unchanged", () => {
    // The restoration contract, held for the detached case too: one element
    // comes off and nothing is rewritten, so the row reads exactly what
    // Obsidian drew when it is re-attached on the next scroll.
    const c = container(TIP);
    const a = new ExplorerAdapter(() => false);
    a.bind(c);
    a.setChainIndex(INDEX, ON);
    a.apply(SNAP);
    const title = titleIn(c, TIP);
    expect(title.textContent).toBe(FULL);

    (title.parentElement as HTMLElement).remove();
    a.unbind();

    expect(title.textContent).toBe("Meetings");
  });

  it("clears an owned class off a row that has left the container it was bound through", () => {
    // `changeLayout()` replaces `.nav-files-container` while the adapter still
    // holds the outgoing node. A sweep scoped to what the adapter holds cannot
    // reach the tree the user is looking at; one that asks the DOCUMENT for
    // our own classes can.
    const bound = container(TIP);
    const live = container();
    const a = new ExplorerAdapter(() => false);
    a.bind(bound);
    a.setChainIndex(null, ON);
    a.apply(SNAP);
    const title = titleIn(bound, TIP);
    const wrapper = title.parentElement as HTMLElement;
    expect(wrapper.classList.contains(CLS.scaffold)).toBe(true);

    live.appendChild(wrapper);

    a.unbind();

    expect(wrapper.classList.contains(CLS.scaffold)).toBe(false);
  });

  it("clears a prefix off a row that has left the container it was bound through", () => {
    const bound = container(TIP);
    const live = container();
    const a = new ExplorerAdapter(() => false);
    a.bind(bound);
    a.setChainIndex(INDEX, ON);
    a.apply(SNAP);
    const title = titleIn(bound, TIP);
    expect(prefixOf(title)).not.toBeNull();

    live.appendChild(title.parentElement as HTMLElement);

    a.unbind();

    expect(prefixOf(title)).toBeNull();
  });

  it("forgets a row as soon as the label comes off, so the record cannot grow", () => {
    // The record is what reaches a detached row, and it holds DOM elements, so
    // it has to shrink as well as grow: a row given back while the plugin is
    // still loaded is no longer ours and must not be kept alive until unload.
    // Nothing else here can see that -- a second `restoreRow` on a restored
    // row is inert -- so the bound is asserted directly.
    const c = container(TIP);
    const a = new ExplorerAdapter(() => true);
    a.bind(c);
    a.setChainIndex(INDEX, ON);
    a.apply(SNAP);
    expect(a["drawn"].size).toBe(1);

    a.setChainIndex(null, ON);
    a.apply(SNAP);
    expect(a["drawn"].size).toBe(0);

    a.unbind();
  });

  it("stops remembering a row once the label has come off, so a later sweep is a no-op", () => {
    // The record must not be a growing list of every row ever labelled: a row
    // restored while the plugin is still loaded is no longer ours, and a later
    // teardown must not reach back into it. Obsidian is free to put its own
    // `aria-label` on a row we have given back.
    const c = container(TIP);
    const a = new ExplorerAdapter(() => true);
    a.bind(c);
    a.setChainIndex(INDEX, ON);
    a.apply(SNAP);
    const title = titleIn(c, TIP);

    // The run goes away (the setting is turned off, say), so the row is
    // restored in the ordinary pass.
    a.setChainIndex(null, ON);
    a.apply(SNAP);
    expect(prefixOf(title)).toBeNull();

    title.setAttribute("aria-label", "Obsidian's own");
    a.unbind();
    expect(title.getAttribute("aria-label")).toBe("Obsidian's own");
  });
});
