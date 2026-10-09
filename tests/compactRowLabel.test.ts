// @vitest-environment jsdom
/**
 * The label on a compacted row, and putting it back.
 *
 * The text belongs to Obsidian, which also uses it for inline rename, so this
 * pass must be able to restore it exactly. Restoration is stateless: the
 * original text is the path's last segment, so nothing has to be stashed and
 * nothing can be stashed wrong.
 *
 * THE FIXTURE IS THE REAL ROW SHAPE, and that matters more here than in most
 * tests. Measured against Obsidian 1.13.7, the `[data-path]` element is
 * `.tree-item-self` inside a `.tree-item` wrapper, and its own children are the
 * collapse chevron and `.tree-item-inner`. An earlier fixture put `data-path`
 * straight onto an element classed `tree-item-inner`, which made writing the
 * label onto the `[data-path]` element look correct — in the real DOM it
 * destroyed the chevron and the text element, and they did not come back when
 * the label was removed.
 */
import { describe, expect, it } from "vitest";
import { ExplorerAdapter, applyCompactLabels } from "../src/explorer/ExplorerAdapter";
import { CLS, SEL } from "../src/explorer/selectors";
import type { VisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { buildChainIndex } from "../src/visibility/compactChains";

interface Row {
  /** The `.tree-item` wrapper, which carries our classes. */
  wrapper: HTMLElement;
  /** The `[data-path]` element: `.tree-item-self`. What the pass is HANDED. */
  title: HTMLElement;
  /** `.tree-item-inner`: the only thing the pass may write. */
  textEl: HTMLElement;
  /** Obsidian's collapse chevron, which must survive untouched. */
  chevron: HTMLElement;
}

function row(host: HTMLElement, path: string, text: string): Row {
  const doc = host.ownerDocument;
  const wrapper = doc.createElement("div");
  wrapper.className = "tree-item nav-folder";
  const title = doc.createElement("div");
  title.className = "tree-item-self nav-folder-title is-clickable mod-collapsible";
  title.setAttribute("data-path", path);
  const chevron = doc.createElement("div");
  chevron.className = "tree-item-icon collapse-icon";
  const textEl = doc.createElement("div");
  textEl.className = "tree-item-inner nav-folder-title-content";
  textEl.textContent = text;
  title.appendChild(chevron);
  title.appendChild(textEl);
  wrapper.appendChild(title);
  host.appendChild(wrapper);
  return { wrapper, title, textEl, chevron };
}

/** A row with no `.tree-item-inner` at all: the shape we must not touch. */
function rowWithoutText(host: HTMLElement, path: string, text: string): HTMLElement {
  const doc = host.ownerDocument;
  const wrapper = doc.createElement("div");
  wrapper.className = "tree-item";
  const title = doc.createElement("div");
  title.className = "tree-item-self";
  title.setAttribute("data-path", path);
  title.textContent = text;
  wrapper.appendChild(title);
  host.appendChild(wrapper);
  return title;
}

const TREE = {
  visibleChildrenOf: (p: string) =>
    p === "Work" ? ["Work/Clients"] : p === "Work/Clients" ? ["Work/Clients/a.md"] : [],
  isFolder: (p: string) => p === "Work" || p === "Work/Clients",
  isScaffold: (p: string) => p === "Work" || p === "Work/Clients",
  parentOf: (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : null),
  nameOf: (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p),
};

const INDEX = buildChainIndex(["Work"], TREE);
/** The same tree with nothing indexed: what a space with no runs looks like. */
const EMPTY = buildChainIndex([], TREE);

describe("applyCompactLabels", () => {
  it("labels a tip row with the joined path", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    expect(r.textEl.textContent).toBe("Work/Clients");
  });

  it("leaves a row that is not a tip alone", () => {
    const host = document.createElement("div");
    const r = row(host, "Archive", "Archive");
    applyCompactLabels([r.title], INDEX);
    expect(r.textEl.textContent).toBe("Archive");
  });

  // Review Focus 5.
  it("puts the original name back when the index goes away", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    applyCompactLabels([r.title], null);
    expect(r.textEl.textContent).toBe("Clients");
  });

  it("puts the original name back when a row stops being a tip", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    applyCompactLabels([r.title], EMPTY);
    expect(r.textEl.textContent).toBe("Clients");
  });

  it("is idempotent, so a repeated pass does not stack separators", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    applyCompactLabels([r.title], INDEX);
    expect(r.textEl.textContent).toBe("Work/Clients");
    expect(r.textEl.children.length).toBe(3);
  });

  it("does not rebuild the spans on a repeated pass", () => {
    // Same text and same child count would also come from tearing the spans
    // down and rebuilding them every pass, which is DOM churn on every
    // mutation the observer sees. Identity is what tells the two apart.
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    const first = Array.from(r.textEl.children);
    applyCompactLabels([r.title], INDEX);
    const second = Array.from(r.textEl.children);
    expect(second.length).toBe(3);
    second.forEach((el, i) => expect(el).toBe(first[i]));
  });

  it("adds spaces-compacted with the label and removes it with the restore", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    expect(r.wrapper.classList.contains(CLS.compacted)).toBe(true);
    applyCompactLabels([r.title], null);
    expect(r.wrapper.classList.contains(CLS.compacted)).toBe(false);
  });

  it("never gives the class to a row that is not a tip", () => {
    const host = document.createElement("div");
    const r = row(host, "Archive", "Archive");
    applyCompactLabels([r.title], INDEX);
    expect(r.wrapper.classList.contains(CLS.compacted)).toBe(false);
  });

  it("draws each part as its own span, so a stylesheet can tell them apart", () => {
    // The reason `compactLabel` returns parts rather than a finished string:
    // muted separators and dimmed leading folders are style changes only if
    // the pieces are separately addressable.
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    expect(Array.from(r.textEl.children).map((c) => c.className)).toEqual([
      "spaces-compact-lead",
      "spaces-compact-sep",
      "spaces-compact-tip",
    ]);
  });

  it("restores a plain text node, leaving no spans behind", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    applyCompactLabels([r.title], EMPTY);
    expect(r.textEl.children.length).toBe(0);
    expect(r.textEl.textContent).toBe("Clients");
  });

  /**
   * THE DEFECT THIS SUITE EXISTS FOR. Writing the label onto the `[data-path]`
   * element replaced Obsidian's own children of the row — chevron included —
   * and the restore left a bare text node behind, so the row stayed degraded
   * until Obsidian happened to rebuild it. Measured in a running vault before
   * the fix: compacted children were the three `spaces-compact-*` spans, and
   * after turning the setting off, `[]`.
   */
  it("leaves the chevron and the text element themselves intact through a cycle", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");

    applyCompactLabels([r.title], INDEX);
    expect(Array.from(r.title.children)).toEqual([r.chevron, r.textEl]);
    expect(r.title.querySelector(SEL.rowText)).toBe(r.textEl);
    expect(r.chevron.parentElement).toBe(r.title);

    applyCompactLabels([r.title], null);
    expect(Array.from(r.title.children)).toEqual([r.chevron, r.textEl]);
    expect(r.title.querySelector(SEL.rowText)).toBe(r.textEl);
    expect(r.chevron.parentElement).toBe(r.title);
    expect(r.textEl.textContent).toBe("Clients");
  });

  it("writes the text element, never the data-path row's own text", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    // The row has no text of its own: everything it reads comes from the
    // child. If the label had landed on the row, this would be a text node.
    const own = Array.from(r.title.childNodes).filter((n) => n.nodeType === 3);
    expect(own).toEqual([]);
  });

  /**
   * Fail open. A row with no text element is left exactly as Obsidian drew it
   * — not labelled on the row as a fallback, and not classed either, because a
   * class with no label is a style on a row that reads as an ordinary folder.
   */
  it("leaves a row with no text element completely alone", () => {
    const host = document.createElement("div");
    const title = rowWithoutText(host, "Work/Clients", "Clients");
    applyCompactLabels([title], INDEX);
    expect(title.textContent).toBe("Clients");
    expect(title.children.length).toBe(0);
    expect(title.parentElement!.classList.contains(CLS.compacted)).toBe(false);
  });

  it("does not reach into a child row's text element", () => {
    // A collapsed folder still holds its subtree in the DOM, so a descendant
    // query from the row could find the wrong `.tree-item-inner`.
    const host = document.createElement("div");
    const parent = row(host, "Work/Clients", "Clients");
    const children = document.createElement("div");
    children.className = "tree-item-children";
    parent.wrapper.appendChild(children);
    const child = row(children, "Work/Clients/a.md", "a");
    applyCompactLabels([parent.title, child.title], INDEX);
    expect(parent.textEl.textContent).toBe("Work/Clients");
    expect(child.textEl.textContent).toBe("a");
  });
});

/**
 * The wiring, through a REAL adapter. The pure function above cannot notice if
 * `applyNow` stops calling it or `clearOwnedClasses` stops restoring.
 */
describe("ExplorerAdapter label wiring", () => {
  const SNAP: VisibilitySnapshot = {
    decisionFor: () => ({
      visible: true,
      reason: "scaffold",
      canRemoveMembership: false,
      overridesIgnore: false,
    }),
    visiblePaths: () => new Set(["Work", "Work/Clients"]),
  };

  function mount(): { container: HTMLElement; title: HTMLElement; textEl: HTMLElement } {
    document.body.innerHTML = `<div class="nav-files-container">
      <div class="tree-item nav-folder">
        <div class="tree-item-self nav-folder-title is-clickable mod-collapsible" data-path="Work/Clients">
          <div class="tree-item-icon collapse-icon"></div>
          <div class="tree-item-inner nav-folder-title-content">Clients</div>
        </div>
      </div>
    </div>`;
    const container = document.querySelector(".nav-files-container") as HTMLElement;
    const title = container.querySelector("[data-path]") as HTMLElement;
    return { container, title, textEl: title.querySelector(SEL.rowText) as HTMLElement };
  }

  it("applyNow labels a tip row from the index it was handed", () => {
    const { container, title, textEl } = mount();
    const a = new ExplorerAdapter();
    a.bind(container);
    a.setChainIndex(INDEX);
    a.apply(SNAP);
    expect(textEl.textContent).toBe("Work/Clients");
    expect(title.parentElement!.classList.contains(CLS.compacted)).toBe(true);
    a.unbind();
  });

  it("labels nothing when no index was handed over", () => {
    const { container, textEl } = mount();
    const a = new ExplorerAdapter();
    a.bind(container);
    a.apply(SNAP);
    expect(textEl.textContent).toBe("Clients");
    a.unbind();
  });

  it("unbind restores the plain name and leaves no spans or class behind", () => {
    const { container, title, textEl } = mount();
    const a = new ExplorerAdapter();
    a.bind(container);
    a.setChainIndex(INDEX);
    a.apply(SNAP);
    a.unbind();
    expect(textEl.textContent).toBe("Clients");
    expect(textEl.children.length).toBe(0);
    expect(title.parentElement!.classList.contains(CLS.compacted)).toBe(false);
    // The chevron and the text element are still Obsidian's own.
    expect(title.querySelector(SEL.rowText)).toBe(textEl);
    expect(title.querySelector(".collapse-icon")).not.toBeNull();
  });
});
