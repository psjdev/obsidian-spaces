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
 * SO THE SWEEP HAS THREE REACHES, and no one of them subsumes the others:
 *  - the bound CONTAINERS, which are the only way back to a row inside a
 *    container the layout has already detached: it is in no document, and its
 *    rows carry no prefix unless they were compacted, so the record misses
 *    them too.
 *  - the DOCUMENT, asked for our own classes and for our own prefix element,
 *    which finds a row that is still rendered but has left the container the
 *    adapter holds. `bindExplorer` already documents that window:
 *    `changeLayout()` replaces `.nav-files-container`, and a cleanup scoped to
 *    the held container "can never reach the live tree either". The prefix
 *    half also finds one left by a session whose teardown never ran, where the
 *    record starts empty.
 *  - the RECORD of rows a label was drawn on, which is the only thing that
 *    reaches a detached one.
 *
 * The document reach is for teardown ALONE, because the outgoing-container
 * window is the only thing it is for. The sweep's other two callers -- a
 * paused apply and an unhealthy pass -- still hold their containers, so they
 * ask those AND the record, and skip only the documents. The record is not
 * optional on that path: a row the explorer detached while the pause was
 * being entered is in no container either.
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

  it("clears an owned class off a row inside a container that is itself detached", () => {
    // The CONTAINERS reach, which neither of the other two subsumes.
    // `changeLayout()` can detach the whole `.nav-files-container` the
    // adapter is holding: its rows are then in no document, so the document
    // reach cannot see them, and they carry no prefix, so the record does not
    // hold them either. Only the container the adapter still has a reference
    // to leads back to them.
    const c = container(TIP);
    const a = new ExplorerAdapter(() => false);
    a.bind(c);
    a.setChainIndex(null, ON);
    a.apply(SNAP);
    const title = titleIn(c, TIP);
    const wrapper = title.parentElement as HTMLElement;
    expect(wrapper.classList.contains(CLS.scaffold)).toBe(true);

    c.remove();

    a.unbind();

    expect(wrapper.classList.contains(CLS.scaffold)).toBe(false);
  });

  it("clears a prefix left behind by a session whose teardown never ran", () => {
    // The `.spaces-compact-prefix` query, which the record subsumes in every
    // ordinary pass and in nothing else. A crash or a skipped unload leaves a
    // prefix ELEMENT in the user's explorer reading `Clients/` beside a folder
    // named `Meetings`; the next session's record is EMPTY, so the only thing
    // that can find it is a query for our own element.
    const c = container(TIP);
    const title = titleIn(c, TIP);
    const stale = document.createElement("span");
    stale.className = CLS_COMPACT_PREFIX;
    stale.textContent = "Clients/Northwind/";
    title.insertBefore(stale, title.firstChild);

    const a = new ExplorerAdapter(() => false);
    a.bind(c);
    expect(a["drawn"].size).toBe(0);

    a.unbind();

    expect(prefixOf(title)).toBeNull();
    expect(a["drawn"].size).toBe(0);
  });

  it("takes our tooltip off a recorded row whose prefix has already gone", () => {
    // `restoreRow` is unconditional on purpose: it does not read the prefix to
    // decide whether there is anything to undo. A row can be in the record,
    // carrying an `aria-label` this module wrote, with the prefix element gone
    // -- Obsidian replacing a row's children is enough. Gating the rest of the
    // restoration on the prefix would strand that tooltip and leave the row in
    // the record forever.
    const c = container(TIP);
    const a = new ExplorerAdapter(() => true);
    a.bind(c);
    a.setChainIndex(INDEX, ON);
    a.apply(SNAP);
    const title = titleIn(c, TIP);
    expect(title.getAttribute("aria-label")).toBe(FULL);
    (prefixOf(title) as HTMLElement).remove();
    expect(a["drawn"].size).toBe(1);

    a.unbind();

    expect(title.hasAttribute("aria-label")).toBe(false);
    expect(a["drawn"].size).toBe(0);
  });

  it("still reaches a DETACHED row on a paused apply, through the record", () => {
    // The `"bound"` scope is the containers AND the record, not the
    // containers alone. The explorer windows its tree, so a row the plugin
    // drew a prefix on can be detached by the time the pause arrives -- it is
    // in no container, and the paused path deliberately asks no document. The
    // record is the only thing left that reaches it, and without it the user
    // pauses filtering and a `Clients/` prefix stays on a row that scrolls
    // back into view reading the wrong thing.
    const c = container(TIP);
    const a = new ExplorerAdapter(() => true);
    a.bind(c);
    a.setChainIndex(INDEX, ON);
    a.apply(SNAP);
    const title = titleIn(c, TIP);
    expect(prefixOf(title)).not.toBeNull();
    expect(title.getAttribute("aria-label")).toBe(FULL);

    // The row scrolls out of the render window.
    (title.parentElement as HTMLElement).remove();

    // The pause, which never touches a document.
    a.apply(null);

    expect(prefixOf(title)).toBeNull();
    expect(title.hasAttribute("aria-label")).toBe(false);
    expect(a["drawn"].size).toBe(0);

    a.unbind();
  });

  it("sweeps only the bound tree on a paused apply, and the document on unbind", () => {
    // A paused apply is an ORDINARY state, not a degraded one, and it reaches
    // the sweep on every `file-open` while the pause is on. The document reach
    // exists for the outgoing-container window -- the moment between
    // `changeLayout()` replacing `.nav-files-container` and the adapter being
    // re-bound -- which a pause is not in. Asking every document for our
    // three classes and our prefix element on every paused apply is work for
    // a window that is not open.
    const c = container(TIP);
    const elsewhere = document.createElement("div");
    elsewhere.className = CLS.scaffold;
    document.body.appendChild(elsewhere);

    const a = new ExplorerAdapter(() => false);
    a.bind(c);
    a.setChainIndex(null, ON);
    a.apply(SNAP);
    const wrapper = titleIn(c, TIP).parentElement as HTMLElement;
    expect(wrapper.classList.contains(CLS.scaffold)).toBe(true);

    // The pause: `applyAdapterSnapshot` hands over a null snapshot.
    a.apply(null);
    expect(wrapper.classList.contains(CLS.scaffold)).toBe(false);
    expect(elsewhere.classList.contains(CLS.scaffold)).toBe(true);

    // Teardown keeps all three reaches, because that IS the window.
    a.unbind();
    expect(elsewhere.classList.contains(CLS.scaffold)).toBe(false);
  });

  it("sweeps only the bound tree when the DOM contract looks broken", () => {
    // The unhealthy branch runs on every MutationObserver pass for as long as
    // the tree looks unrecognisable, which can be the rest of the session.
    // Same reasoning as the paused branch: the containers are still held, so
    // the document reach buys nothing and costs four queries a pass -- one
    // per owned class, plus the prefix element.
    const c = container(TIP);
    const elsewhere = document.createElement("div");
    elsewhere.className = CLS.scaffold;
    document.body.appendChild(elsewhere);

    const a = new ExplorerAdapter(() => false);
    a.bind(c);
    a.setChainIndex(null, ON);
    a.apply(SNAP);
    const wrapper = titleIn(c, TIP).parentElement as HTMLElement;
    expect(wrapper.classList.contains(CLS.scaffold)).toBe(true);

    // Rows, but none of them path-bearing: the shape that says the contract
    // changed.
    titleIn(c, TIP).removeAttribute("data-path");
    a.apply(SNAP);

    expect(wrapper.classList.contains(CLS.scaffold)).toBe(false);
    expect(elsewhere.classList.contains(CLS.scaffold)).toBe(true);

    a.unbind();
    expect(elsewhere.classList.contains(CLS.scaffold)).toBe(false);
  });
});
