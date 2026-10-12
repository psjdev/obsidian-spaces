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
import type { CompactLabelPolicy } from "../src/ui/compactLabel";
import type { VisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { buildChainIndex, type ChainIndex } from "../src/visibility/compactChains";

/** Shortening turned off: the whole joined path, whatever it costs. */
const PLAIN: CompactLabelPolicy = { abbreviateWhenOverflowing: false };
/** Shortening left on, the shipped default. */
const ABBREV: CompactLabelPolicy = { abbreviateWhenOverflowing: true };

/**
 * `applyCompactLabels` with shortening OFF, so every assertion below about the
 * prefix, the text element and restoration reads the way it did before
 * shortening existed. The shortening block passes `ABBREV` explicitly.
 *
 * THE PANE IS NARROW BY DEFAULT HERE. Whether a row shortens is a measurement,
 * and jsdom lays nothing out -- every element reports a width of 0, so the
 * real probe answers "it fits" for every row a test can build. The default
 * below says "nothing fits", which is the condition the shortening block is
 * about; with `PLAIN` it changes nothing, because a policy of off never
 * measures at all.
 */
const label = (
  titles: readonly HTMLElement[],
  index: ChainIndex | null,
  opts: CompactLabelPolicy = PLAIN,
  overflows: () => boolean = () => true
): void => {
  applyCompactLabels(titles, index, opts, { overflows });
};

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
    label([r.title], INDEX);
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

    label([r.title], INDEX);
    expect(r.textEl.textContent).toBe("Clients");

    label([r.title], null);
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
    label([r.title], INDEX);
    expect(r.textEl.children.length).toBe(0);
    expect(Array.from(r.textEl.childNodes).map((n) => n.nodeType)).toEqual([3]);
  });

  it("puts the prefix immediately BEFORE the text element, inside the row", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    label([r.title], INDEX);
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
    label([r.title], INDEX);
    expect(r.textEl.textContent).toBe("Archive");
    expect(prefixOf(r.title)).toBeNull();
  });

  // Review Focus 5.
  it("takes the prefix away when the index goes away", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    label([r.title], INDEX);
    label([r.title], null);
    expect(prefixOf(r.title)).toBeNull();
    expect(r.title.textContent).toBe("Clients");
  });

  it("takes the prefix away when a row stops being a tip", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    label([r.title], INDEX);
    label([r.title], EMPTY);
    expect(prefixOf(r.title)).toBeNull();
    expect(r.title.textContent).toBe("Clients");
  });

  it("is idempotent, so a repeated pass does not stack prefixes", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    label([r.title], INDEX);
    label([r.title], INDEX);
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
    label([r.title], INDEX);
    const firstPrefix = prefixOf(r.title);
    const first = Array.from(firstPrefix!.children);
    label([r.title], INDEX);
    const second = Array.from(prefixOf(r.title)!.children);
    expect(prefixOf(r.title)).toBe(firstPrefix);
    expect(second.length).toBe(2);
    second.forEach((el, i) => expect(el).toBe(first[i]));
  });

  it("adds spaces-compacted with the prefix and removes it with the restore", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    label([r.title], INDEX);
    expect(r.wrapper.classList.contains(CLS.compacted)).toBe(true);
    label([r.title], null);
    expect(r.wrapper.classList.contains(CLS.compacted)).toBe(false);
  });

  it("never gives the class to a row that is not a tip", () => {
    const host = document.createElement("div");
    const r = row(host, "Archive", "Archive");
    label([r.title], INDEX);
    expect(r.wrapper.classList.contains(CLS.compacted)).toBe(false);
  });

  it("draws each part as its own span, so a stylesheet can tell them apart", () => {
    // The reason `compactLabel` returns parts rather than a finished string:
    // muted separators and dimmed leading folders are style changes only if
    // the pieces are separately addressable. They live INSIDE the prefix, so
    // the roles survive the move off `.tree-item-inner`.
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    label([r.title], INDEX);
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
    label([r.title], INDEX);
    expect(r.title.querySelector(".spaces-compact-tip")).toBeNull();
    expect(r.title.textContent).toBe("Work/Clients");
  });

  it("restores by removing one element, leaving no spans behind", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    label([r.title], INDEX);
    label([r.title], EMPTY);
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

    label([r.title], INDEX);
    expect(r.title.querySelector(SEL.rowText)).toBe(textBefore);
    expect(r.chevron.parentElement).toBe(r.title);

    label([r.title], null);
    expect(Array.from(r.title.children)).toEqual([chevronBefore, textBefore]);
    expect(r.title.querySelector(SEL.rowText)).toBe(textBefore);
    expect(r.chevron.parentElement).toBe(r.title);
    expect(r.textEl.textContent).toBe("Clients");
  });

  it("writes no text of its own onto the data-path row", () => {
    const host = document.createElement("div");
    const r = row(host, "Work/Clients", "Clients");
    label([r.title], INDEX);
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
    label([title], INDEX);
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
    label([parent.title, child.title], INDEX);
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
    a.setChainIndex(INDEX, PLAIN);
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
    a.setChainIndex(INDEX, PLAIN);
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

/**
 * A SHORTENED row, and the tooltip that makes it readable.
 *
 * The run here is the one measured in a real vault at a 246px pane:
 * `Research/2026/Q4/Projects/Atlas/Design/Decisions`, 48 characters, whose
 * joined label overflowed so far that `.tree-item-inner` — the TIP, the one
 * segment naming the row — was laid out at a client width of zero. Shortened
 * to `../Design/Decisions` it fits, and the folders it passed through move to
 * a tooltip instead of being silently cut off.
 *
 * Everything the suite above pins still holds here, and two of those
 * assertions are repeated against the shortened label rather than assumed:
 * `.tree-item-inner` is still never written, and restoration still returns the
 * row to Obsidian's own elements.
 */
describe("applyCompactLabels, shortened", () => {
  const CHAIN = [
    "Research",
    "Research/2026",
    "Research/2026/Q4",
    "Research/2026/Q4/Projects",
    "Research/2026/Q4/Projects/Atlas",
    "Research/2026/Q4/Projects/Atlas/Design",
    "Research/2026/Q4/Projects/Atlas/Design/Decisions",
  ];
  const TIP = CHAIN[CHAIN.length - 1];
  const FULL = "Research/2026/Q4/Projects/Atlas/Design/Decisions";

  const DEEP_TREE = {
    visibleChildrenOf: (p: string) => {
      const i = CHAIN.indexOf(p);
      if (i >= 0 && i < CHAIN.length - 1) return [CHAIN[i + 1]];
      if (p === TIP) return [`${TIP}/why.md`];
      return [];
    },
    isFolder: (p: string) => CHAIN.includes(p),
    isScaffold: (p: string) => CHAIN.includes(p),
    parentOf: (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : null),
    nameOf: (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p),
  };
  const DEEP = buildChainIndex(CHAIN, DEEP_TREE);
  /** Nothing indexed, which is what restoration hands the pass. */
  const NONE = buildChainIndex([], DEEP_TREE);

  const deepRow = (): ReturnType<typeof row> =>
    row(document.createElement("div"), TIP, "Decisions");

  it("renders the prefix as ../Design/, so the row reads ../Design/Decisions", () => {
    const r = deepRow();
    label([r.title], DEEP, ABBREV);
    expect(prefixOf(r.title)!.textContent).toBe("../Design/");
    expect(r.title.textContent).toBe("../Design/Decisions");
  });

  it("still never writes the text element", () => {
    // The defect the whole feature is shaped around does not get a pass
    // because the label got shorter.
    const r = deepRow();
    label([r.title], DEEP, ABBREV);
    expect(r.textEl.textContent).toBe("Decisions");
    expect(r.textEl.children.length).toBe(0);
    expect(Array.from(r.textEl.childNodes).map((n) => n.nodeType)).toEqual([3]);
    label([r.title], null, ABBREV);
    expect(r.textEl.textContent).toBe("Decisions");
  });

  it("gives the gap its own span, so a stylesheet can tell it from a name", () => {
    const r = deepRow();
    label([r.title], DEEP, ABBREV);
    expect(Array.from(prefixOf(r.title)!.children).map((c) => c.className)).toEqual([
      "spaces-compact-gap",
      "spaces-compact-sep",
      "spaces-compact-lead",
      "spaces-compact-sep",
    ]);
  });

  it("draws the whole joined path when shortening is off", () => {
    const r = deepRow();
    label([r.title], DEEP, PLAIN);
    expect(r.title.textContent).toBe(FULL);
    expect(prefixOf(r.title)!.textContent).toBe("Research/2026/Q4/Projects/Atlas/Design/");
  });

  it("switches back to the whole path when the setting goes off", () => {
    // The same row, re-passed. The prefix is REUSED, so this also pins that
    // the idempotence check compares text rather than skipping the rebuild.
    const r = deepRow();
    label([r.title], DEEP, ABBREV);
    label([r.title], DEEP, PLAIN);
    expect(r.title.textContent).toBe(FULL);
    expect(r.title.querySelectorAll(`.${CLS_COMPACT_PREFIX}`).length).toBe(1);
    expect(r.title.querySelector(".spaces-compact-gap")).toBeNull();
  });

  it("leaves a run that FITS in full, and gives it no tooltip", () => {
    // Three folders, the run the design names. Under the old folder count it
    // was the default threshold that left this whole; now it is the pane.
    const host = document.createElement("div");
    const tree = {
      visibleChildrenOf: (p: string) =>
        p === "Clients"
          ? ["Clients/Northwind"]
          : p === "Clients/Northwind"
            ? ["Clients/Northwind/Meetings"]
            : p === "Clients/Northwind/Meetings"
              ? ["Clients/Northwind/Meetings/a.md"]
              : [],
      isFolder: (p: string) => !p.endsWith(".md"),
      isScaffold: (p: string) => !p.endsWith(".md"),
      parentOf: DEEP_TREE.parentOf,
      nameOf: DEEP_TREE.nameOf,
    };
    const index = buildChainIndex(["Clients"], tree);
    const r = row(host, "Clients/Northwind/Meetings", "Meetings");
    label([r.title], index, ABBREV, () => false);
    expect(r.title.textContent).toBe("Clients/Northwind/Meetings");
    expect(r.title.querySelector(".spaces-compact-gap")).toBeNull();
    expect(r.title.hasAttribute("aria-label")).toBe(false);
  });

  it("shortens the same three folder run once it stops fitting", () => {
    // The pair above and this one are the whole of D-B: one run, two pane
    // widths, two labels. A folder count could not tell them apart.
    const host = document.createElement("div");
    const tree = {
      visibleChildrenOf: (p: string) =>
        p === "Clients"
          ? ["Clients/Northwind"]
          : p === "Clients/Northwind"
            ? ["Clients/Northwind/Meetings"]
            : p === "Clients/Northwind/Meetings"
              ? ["Clients/Northwind/Meetings/a.md"]
              : [],
      isFolder: (p: string) => !p.endsWith(".md"),
      isScaffold: (p: string) => !p.endsWith(".md"),
      parentOf: DEEP_TREE.parentOf,
      nameOf: DEEP_TREE.nameOf,
    };
    const index = buildChainIndex(["Clients"], tree);
    const r = row(host, "Clients/Northwind/Meetings", "Meetings");
    label([r.title], index, ABBREV, () => true);
    expect(r.title.textContent).toBe("../Northwind/Meetings");
    expect(r.title.getAttribute("aria-label")).toBe("Clients/Northwind/Meetings");
  });

  it("carries the full path in aria-label when it shortened the label", () => {
    const r = deepRow();
    label([r.title], DEEP, ABBREV);
    expect(r.title.getAttribute("aria-label")).toBe(FULL);
  });

  it("sets no aria-label when the label was NOT shortened", () => {
    const r = deepRow();
    label([r.title], DEEP, PLAIN);
    expect(r.title.hasAttribute("aria-label")).toBe(false);
  });

  it("takes the aria-label off when shortening is turned off", () => {
    const r = deepRow();
    label([r.title], DEEP, ABBREV);
    label([r.title], DEEP, PLAIN);
    expect(r.title.hasAttribute("aria-label")).toBe(false);
  });

  it("takes the aria-label off on restoration", () => {
    const r = deepRow();
    label([r.title], DEEP, ABBREV);
    label([r.title], null, ABBREV);
    expect(r.title.hasAttribute("aria-label")).toBe(false);
    expect(prefixOf(r.title)).toBeNull();
    expect(r.title.textContent).toBe("Decisions");
  });

  it("takes the aria-label off when the row stops being a tip", () => {
    const r = deepRow();
    label([r.title], DEEP, ABBREV);
    label([r.title], NONE, ABBREV);
    expect(r.title.hasAttribute("aria-label")).toBe(false);
  });

  /**
   * The attribute is ours only where our element is. A blanket removal would
   * delete one Obsidian had put on a row this plugin never labelled, which is
   * a loss of a real accessible name for no gain.
   */
  it("leaves an aria-label alone on a row it never compacted", () => {
    const r = row(document.createElement("div"), "Archive", "Archive");
    r.title.setAttribute("aria-label", "Obsidian's own");
    label([r.title], DEEP, ABBREV);
    expect(r.title.getAttribute("aria-label")).toBe("Obsidian's own");
  });

  /**
   * DS-6. The sibling rule, on the branch that was missing it.
   *
   * A row drawn in FULL carries no tooltip of ours, so the branch that reaches
   * that state used to call `removeAttribute` unconditionally — on a row we
   * had never put an attribute on. `aria-label` is a plain DOM attribute that
   * Obsidian and any other plugin may set for their own reasons, and a row
   * being compacted says nothing about who set this one. Removing it strips a
   * real accessible name from the screen reader for no gain, exactly as the
   * blanket removal above would.
   */
  it("leaves an aria-label it did not set on a compacted row drawn in full", () => {
    const r = deepRow();
    r.title.setAttribute("aria-label", "Obsidian's own");
    label([r.title], DEEP, PLAIN);
    expect(prefixOf(r.title)).not.toBeNull();
    expect(r.title.getAttribute("aria-label")).toBe("Obsidian's own");
  });

  /**
   * And the row that survives a pass without a tooltip is still not ours on
   * the NEXT one: our prefix being on the row is not a record that the
   * attribute came from here.
   */
  it("still leaves it alone on a second pass over the same compacted row", () => {
    const r = deepRow();
    label([r.title], DEEP, PLAIN);
    r.title.setAttribute("aria-label", "Obsidian's own");
    label([r.title], DEEP, PLAIN);
    expect(r.title.getAttribute("aria-label")).toBe("Obsidian's own");
  });

  /**
   * The same rule on the RESTORE side. Our prefix being on the row is a
   * record that the ROW is ours, not that the ATTRIBUTE is: a compacted row
   * drawn in full never gets a tooltip from here, so an `aria-label` on one is
   * somebody else's and survives being given back.
   */
  it("leaves an aria-label it did not set when it gives the row back", () => {
    const r = deepRow();
    label([r.title], DEEP, PLAIN);
    expect(prefixOf(r.title)).not.toBeNull();
    r.title.setAttribute("aria-label", "Obsidian's own");

    label([r.title], null, PLAIN);

    expect(prefixOf(r.title)).toBeNull();
    expect(r.title.getAttribute("aria-label")).toBe("Obsidian's own");
  });

  /** The other side of the same rule: ours still comes off when it is ours. */
  it("takes its OWN tooltip off when the row stops being shortened", () => {
    const r = deepRow();
    label([r.title], DEEP, ABBREV);
    expect(r.title.getAttribute("aria-label")).toBe(FULL);
    // The pane is widened and settles, so the kept decision is re-opened and
    // the full label fits. There is nothing a tooltip could add now, and a
    // stale one would claim a shortening that is no longer happening.
    applyCompactLabels([r.title], DEEP, ABBREV, { remeasure: true, overflows: () => false });
    expect(r.title.hasAttribute("aria-label")).toBe(false);
  });

  it("restores by removing one element, leaving no spans and no attribute", () => {
    const r = deepRow();
    const chevronBefore = r.chevron;
    const textBefore = r.textEl;
    label([r.title], DEEP, ABBREV);
    label([r.title], NONE, ABBREV);
    expect(Array.from(r.title.children)).toEqual([chevronBefore, textBefore]);
    expect(r.title.querySelectorAll("[class^='spaces-compact']").length).toBe(0);
    expect(r.title.hasAttribute("aria-label")).toBe(false);
  });

  /** Through a real adapter, so the wiring cannot quietly stop passing them. */
  describe("through the adapter", () => {
    const SNAP: VisibilitySnapshot = {
      decisionFor: () => ({
        visible: true,
        reason: "scaffold",
        canRemoveMembership: false,
        overridesIgnore: false,
      }),
      visiblePaths: () => new Set(CHAIN),
    };

    function mountDeep(): { container: HTMLElement; title: HTMLElement } {
      document.body.innerHTML = `<div class="nav-files-container">
        <div class="tree-item nav-folder">
          <div class="tree-item-self nav-folder-title is-clickable mod-collapsible" data-path="${TIP}">
            <div class="tree-item-icon collapse-icon"></div>
            <div class="tree-item-inner nav-folder-title-content">Decisions</div>
          </div>
        </div>
      </div>`;
      const container = document.querySelector(".nav-files-container") as HTMLElement;
      return { container, title: container.querySelector("[data-path]") as HTMLElement };
    }

    it("applyNow shortens and tooltips from the options it was handed", () => {
      const { container, title } = mountDeep();
      // The pane is too narrow for this label. See `label` above for why that
      // has to be said rather than laid out.
      const a = new ExplorerAdapter(() => true);
      a.bind(container);
      a.setChainIndex(DEEP, ABBREV);
      a.apply(SNAP);
      expect(title.textContent!.trim()).toBe("../Design/Decisions");
      expect(title.getAttribute("aria-label")).toBe(FULL);
      expect((title.querySelector(SEL.rowText) as HTMLElement).textContent).toBe("Decisions");
      a.unbind();
    });

    it("draws the whole path, and no tooltip, with shortening off", () => {
      const { container, title } = mountDeep();
      const a = new ExplorerAdapter(() => true);
      a.bind(container);
      a.setChainIndex(DEEP, PLAIN);
      a.apply(SNAP);
      expect(title.textContent!.trim()).toBe(FULL);
      expect(title.hasAttribute("aria-label")).toBe(false);
      a.unbind();
    });

    it("unbind takes the tooltip off with the prefix", () => {
      const { container, title } = mountDeep();
      const a = new ExplorerAdapter(() => true);
      a.bind(container);
      a.setChainIndex(DEEP, ABBREV);
      a.apply(SNAP);
      a.unbind();
      expect(title.hasAttribute("aria-label")).toBe(false);
      expect(prefixOf(title)).toBeNull();
      expect((title.querySelector(SEL.rowText) as HTMLElement).textContent).toBe("Decisions");
    });
  });
});

/**
 * A TIP IS ONLY A COMPACTED ROW WHERE THE HEAD WAS.
 *
 * The index is a promise that the sort seam substituted the run's tip for its
 * head, so the chain draws as one row at the head's position. The gate in
 * `main.ts` settles every way the seam can be dead BEFORE the attempt, and
 * `applyFilterAndOrdering` settles the refusal after it — but neither can be
 * asked about an override DISPLACED after `patch` succeeded. Another plugin
 * assigns its own `getSortedFolderItems` over ours without calling through:
 * `isPatched` still answers true, `requestResort` still answers true, the
 * index is still built, and the pane renders the honest NESTED tree because
 * our transform is off the stack. `runByTip` holds the run all the same, so
 * the joined path would land on a folder visibly sitting under its own
 * parent.
 *
 * That state and `isPatched`'s deliberate looseness are ONE DECISION:
 * tightening the gate would turn compaction off for a plugin that merely
 * WRAPS our override, and this check is what makes leaving it loose safe.
 * `tests/compactSeamGate.test.ts` drives the pair end to end, against a pane
 * the seam itself renders; the four tests below pin the rule in isolation.
 *
 * So the pass stops predicting and MEASURES. A row that is a tip but is drawn
 * UNDER one of its own run's hidden segments is a chain that did not compact,
 * whatever anything upstream believed, and the answer is in the DOM in front
 * of the pass. The same measurement would cover a per-run fail-open in
 * `substituteCompacted` too, IF a pane ever held a row for a path it has no
 * tree item for — Obsidian does not do that, since the rows ARE those items'
 * elements, so it is a clause and not the reason.
 *
 * Every unknown resolves toward labelling, so a tree that does not match this
 * shape costs nothing.
 */
describe("applyCompactLabels only labels a tip drawn where the head was", () => {
  const TIP = "Top/Work/Clients/Meetings";
  const KIDS: Record<string, string[]> = {
    // Two visible children, so `Top` itself is not a run and keeps its row.
    Top: ["Top/Work", "Top/note.md"],
    "Top/Work": ["Top/Work/Clients"],
    "Top/Work/Clients": [TIP],
    [TIP]: [`${TIP}/a.md`],
    // A SECOND, unrelated run, so "a hidden segment" and "a hidden segment of
    // THIS run" can be told apart.
    Other: ["Other/Thing"],
    "Other/Thing": ["Other/Thing/b.md"],
  };
  const FOLDERS = ["Top", "Top/Work", "Top/Work/Clients", TIP, "Other", "Other/Thing"];
  const NESTED_TREE = {
    visibleChildrenOf: (p: string) => KIDS[p] ?? [],
    isFolder: (p: string) => FOLDERS.includes(p),
    isScaffold: (p: string) => FOLDERS.includes(p),
    parentOf: (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : null),
    nameOf: (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p),
  };
  /**
   * `Top/Work -> Clients -> Meetings`, whose hidden segments are `Top/Work`
   * and `Top/Work/Clients`, plus `Other -> Thing`, whose hidden segment is
   * `Other`.
   */
  const NESTED = buildChainIndex(FOLDERS, NESTED_TREE);
  const FULL = "Work/Clients/Meetings";

  /** The `.tree-item-children` subtree Obsidian draws a row's children into. */
  function childrenOf(r: ReturnType<typeof row>): HTMLElement {
    const kids = r.wrapper.ownerDocument.createElement("div");
    kids.className = "tree-item-children nav-folder-children";
    r.wrapper.appendChild(kids);
    return kids;
  }

  const labelled = (title: HTMLElement): boolean => prefixOf(title) !== null;

  it("labels a tip drawn as a sibling where its head was", () => {
    // The ordinary case, and the control for the three below: the
    // substitution happened, so the tip's row sits under `Top` — the head's
    // own parent — with nothing of the run between them.
    const host = document.createElement("div");
    const top = row(host, "Top", "Top");
    const tip = row(childrenOf(top), TIP, "Meetings");
    label([top.title, tip.title], NESTED, ABBREV);
    expect(labelled(tip.title)).toBe(true);
    expect(tip.title.getAttribute("aria-label")).toBe(FULL);
  });

  it("leaves a tip drawn under its own run's hidden segment alone", () => {
    // The seventh state, as a tree: nothing was substituted, so `Top/Work`
    // and `Top/Work/Clients` still have rows and the tip is three levels
    // down. A label here would read `Work/Clients/Meetings` on a folder the
    // user can see nested under `Clients`.
    const host = document.createElement("div");
    const top = row(host, "Top", "Top");
    const head = row(childrenOf(top), "Top/Work", "Work");
    const mid = row(childrenOf(head), "Top/Work/Clients", "Clients");
    const tip = row(childrenOf(mid), TIP, "Meetings");
    label([top.title, head.title, mid.title, tip.title], NESTED, ABBREV);
    expect(labelled(tip.title)).toBe(false);
    expect(tip.wrapper.classList.contains(CLS.compacted)).toBe(false);
    expect(tip.title.hasAttribute("aria-label")).toBe(false);
    // Untouched, not merely unlabelled: the row still reads what Obsidian
    // drew.
    expect(tip.title.textContent).toBe("Meetings");
  });

  it("labels a tip drawn under a DIFFERENT run's hidden segment", () => {
    // Identity against THIS run, not membership of the map. `Other` is
    // hidden because `Other -> Thing` compacted, which says nothing about
    // where `Top/Work`'s run was drawn — and suppressing on it would turn
    // one run's compaction into another run's loss.
    const host = document.createElement("div");
    const other = row(host, "Other", "Other");
    const tip = row(childrenOf(other), TIP, "Meetings");
    label([other.title, tip.title], NESTED, ABBREV);
    expect(labelled(tip.title)).toBe(true);
    expect(tip.title.getAttribute("aria-label")).toBe(FULL);
  });

  it("labels a tip at the top level, with no ancestor row at all", () => {
    // A run whose head was top-level draws its one row at the top level, so
    // there is no ancestor to ask. Unknown resolves toward labelling, which
    // is also what a detached row gets.
    const host = document.createElement("div");
    const tip = row(host, TIP, "Meetings");
    label([tip.title], NESTED, ABBREV);
    expect(labelled(tip.title)).toBe(true);
    expect(tip.title.getAttribute("aria-label")).toBe(FULL);
  });
});
