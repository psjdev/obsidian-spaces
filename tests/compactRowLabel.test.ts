// @vitest-environment jsdom
/**
 * The label on a compacted row, and taking it off again.
 *
 * `.tree-item-inner` IS NEVER WRITTEN, and that is what this suite is for.
 * Obsidian seeds its inline-rename editor from that element's text, so a
 * joined label written there offered `Clients/Meetings` for a folder actually
 * named `Meetings`; accepting it resolved against the parent and failed with
 * `ENOENT ... -> ...\Clients\Clients\Meetings`. Measured in a live vault: a
 * compacted folder could not be renamed at all unless the user deleted the
 * `Clients/` prefix by hand, with nothing on screen to say why.
 *
 * So the lead and the separator go into an OWNED element inserted before the
 * inner, and the tip is not drawn at all because the inner already holds it.
 * Restoration is removing that one element — no text is rewritten, so nothing
 * can be restored wrongly, and the assertions below are mostly about what did
 * NOT change.
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
import { CLS, CLS_COMPACT_PREFIX, SEL } from "../src/explorer/selectors";
import type { VisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { buildChainIndex } from "../src/visibility/compactChains";

interface Row {
  /** The `.tree-item` wrapper, which carries our classes. */
  wrapper: HTMLElement;
  /** The `[data-path]` element: `.tree-item-self`. What the pass is HANDED. */
  title: HTMLElement;
  /** `.tree-item-inner`: Obsidian's, and never written. */
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

/** The one element this pass owns, resolved the way the pass itself resolves it. */
const prefixOf = (title: HTMLElement): HTMLElement | null =>
  title.querySelector<HTMLElement>(`:scope > .${CLS_COMPACT_PREFIX}`);

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
  it("makes a tip row READ as the joined path", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    // What the user sees is the row, which is now the prefix plus Obsidian's
    // own text element. Neither half says `Work/Clients` on its own.
    expect(r.title.textContent).toBe("Work/Clients");
  });

  /**
   * THE DEFECT THIS SUITE EXISTS FOR, as a test.
   *
   * Obsidian seeds the inline-rename editor from this element. If anything
   * here ever reads `Work/Clients`, renaming the folder offers a path where a
   * name belongs and the commit fails with ENOENT against
   * `Work/Work/Clients`.
   */
  it("never changes the text element, compacted or not", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    const before = r.textEl.textContent;

    applyCompactLabels([r.title], INDEX);
    expect(r.textEl.textContent).toBe("Clients");

    applyCompactLabels([r.title], null);
    expect(r.textEl.textContent).toBe("Clients");
    expect(r.textEl.textContent).toBe(before);
  });

  it("adds no children to the text element either", () => {
    // Not covered by the text assertion above: three spans reading
    // `Work`, `/`, `Clients` concatenate to the right `textContent` for the
    // ROW and the wrong one for the inner, which is the shape that caused
    // the defect in the first place.
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    expect(r.textEl.children.length).toBe(0);
    expect(Array.from(r.textEl.childNodes).map((n) => n.nodeType)).toEqual([3]);
  });

  it("puts the prefix immediately BEFORE the text element, inside the row", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    const prefix = prefixOf(r.title);
    expect(prefix).not.toBeNull();
    expect(prefix!.textContent).toBe("Work/");
    // Order is what makes the row read left to right, and the chevron stays
    // first because Obsidian draws it there.
    expect(Array.from(r.title.children)).toEqual([r.chevron, prefix, r.textEl]);
    expect(prefix!.nextElementSibling).toBe(r.textEl);
  });

  it("leaves a row that is not a tip alone", () => {
    const host = document.createElement("div");
    const r = row(host, "Archive", "Archive");
    applyCompactLabels([r.title], INDEX);
    expect(r.textEl.textContent).toBe("Archive");
    expect(prefixOf(r.title)).toBeNull();
  });

  // Review Focus 5.
  it("takes the prefix away when the index goes away", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    applyCompactLabels([r.title], null);
    expect(prefixOf(r.title)).toBeNull();
    expect(r.title.textContent).toBe("Clients");
  });

  it("takes the prefix away when a row stops being a tip", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    applyCompactLabels([r.title], EMPTY);
    expect(prefixOf(r.title)).toBeNull();
    expect(r.title.textContent).toBe("Clients");
  });

  it("is idempotent, so a repeated pass does not stack prefixes", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    applyCompactLabels([r.title], INDEX);
    expect(r.title.querySelectorAll(`.${CLS_COMPACT_PREFIX}`).length).toBe(1);
    expect(r.title.textContent).toBe("Work/Clients");
    expect(prefixOf(r.title)!.children.length).toBe(2);
  });

  it("does not rebuild the prefix or its spans on a repeated pass", () => {
    // Same text and same child count would also come from tearing the spans
    // down and rebuilding them every pass, which is DOM churn on every
    // mutation the observer sees. Identity is what tells the two apart.
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    const firstPrefix = prefixOf(r.title);
    const first = Array.from(firstPrefix!.children);
    applyCompactLabels([r.title], INDEX);
    const second = Array.from(prefixOf(r.title)!.children);
    expect(prefixOf(r.title)).toBe(firstPrefix);
    expect(second.length).toBe(2);
    second.forEach((el, i) => expect(el).toBe(first[i]));
  });

  it("adds spaces-compacted with the prefix and removes it with the restore", () => {
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
    // the pieces are separately addressable. They live INSIDE the prefix, so
    // the roles survive the move off `.tree-item-inner`.
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    expect(Array.from(prefixOf(r.title)!.children).map((c) => c.className)).toEqual([
      "spaces-compact-lead",
      "spaces-compact-sep",
    ]);
  });

  it("never renders the tip part, because Obsidian already drew it", () => {
    // `compactLabel` still RETURNS the tip — it describes the whole label, and
    // a presentation variant may yet want it. The adapter dropping it is the
    // deliberate half: `.tree-item-inner` is the tip, and writing it again is
    // the defect.
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    expect(r.title.querySelector(".spaces-compact-tip")).toBeNull();
    expect(r.title.textContent).toBe("Work/Clients");
  });

  it("restores by removing one element, leaving no spans behind", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    applyCompactLabels([r.title], EMPTY);
    expect(r.title.querySelectorAll("[class^='spaces-compact']").length).toBe(0);
    expect(r.title.textContent).toBe("Clients");
  });

  /**
   * RESTORATION IS AN ELEMENT REMOVAL, so the row Obsidian drew comes back
   * BY IDENTITY, not by being rewritten to look the same. An earlier version
   * wrote the label onto the `[data-path]` element, replacing Obsidian's own
   * children — chevron included — and the restore left a bare text node
   * behind. Measured in a running vault before that fix: compacted children
   * were three `spaces-compact-*` spans, and after turning the setting off,
   * `[]`.
   */
  it("leaves the chevron and the text element themselves intact through a cycle", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    const chevronBefore = r.chevron;
    const textBefore = r.textEl;

    applyCompactLabels([r.title], INDEX);
    expect(r.title.querySelector(SEL.rowText)).toBe(textBefore);
    expect(r.chevron.parentElement).toBe(r.title);

    applyCompactLabels([r.title], null);
    expect(Array.from(r.title.children)).toEqual([chevronBefore, textBefore]);
    expect(r.title.querySelector(SEL.rowText)).toBe(textBefore);
    expect(r.chevron.parentElement).toBe(r.title);
    expect(r.textEl.textContent).toBe("Clients");
  });

  it("writes no text of its own onto the data-path row", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    applyCompactLabels([r.title], INDEX);
    // Everything the row reads comes from an element. A bare text node here
    // is the signature of a label written onto the row itself.
    const own = Array.from(r.title.childNodes).filter((n) => n.nodeType === 3);
    expect(own).toEqual([]);
  });

  /**
   * Fail open. A row with no text element is left exactly as Obsidian drew it
   * — no prefix, and not classed either, because a class with no label is a
   * style on a row that reads as an ordinary folder.
   */
  it("leaves a row with no text element completely alone", () => {
    const host = document.createElement("div");
    const title = rowWithoutText(host, "Work/Clients", "Clients");
    applyCompactLabels([title], INDEX);
    expect(title.textContent).toBe("Clients");
    expect(title.children.length).toBe(0);
    expect(prefixOf(title)).toBeNull();
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
    expect(parent.title.textContent).toBe("Work/Clients");
    expect(prefixOf(child.title)).toBeNull();
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
    // Trimmed: `mount` builds the row from indented HTML, so the row carries
    // Obsidian-irrelevant whitespace text nodes the hand-built fixture above
    // does not.
    expect(title.textContent!.trim()).toBe("Work/Clients");
    expect(textEl.textContent).toBe("Clients");
    expect(title.parentElement!.classList.contains(CLS.compacted)).toBe(true);
    a.unbind();
  });

  it("labels nothing when no index was handed over", () => {
    const { container, title, textEl } = mount();
    const a = new ExplorerAdapter();
    a.bind(container);
    a.apply(SNAP);
    expect(textEl.textContent).toBe("Clients");
    expect(prefixOf(title)).toBeNull();
    a.unbind();
  });

  it("unbind removes the prefix and the class and leaves the row Obsidian's", () => {
    const { container, title, textEl } = mount();
    const a = new ExplorerAdapter();
    a.bind(container);
    a.setChainIndex(INDEX);
    a.apply(SNAP);
    a.unbind();
    expect(prefixOf(title)).toBeNull();
    expect(textEl.textContent).toBe("Clients");
    expect(textEl.children.length).toBe(0);
    expect(title.parentElement!.classList.contains(CLS.compacted)).toBe(false);
    // The chevron and the text element are still Obsidian's own.
    expect(title.querySelector(SEL.rowText)).toBe(textEl);
    expect(title.querySelector(".collapse-icon")).not.toBeNull();
  });
});
