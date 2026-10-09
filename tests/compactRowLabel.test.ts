// @vitest-environment jsdom
/**
 * The label on a compacted row, and putting it back.
 *
 * The text belongs to Obsidian, which also uses it for inline rename, so this
 * pass must be able to restore it exactly. Restoration is stateless: the
 * original text is the path's last segment, so nothing has to be stashed and
 * nothing can be stashed wrong.
 */
import { describe, expect, it } from "vitest";
import { ExplorerAdapter, applyCompactLabels } from "../src/explorer/ExplorerAdapter";
import { CLS } from "../src/explorer/selectors";
import type { VisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { buildChainIndex } from "../src/visibility/compactChains";

function row(host: HTMLElement, path: string, text: string): HTMLElement {
  const wrapper = host.ownerDocument.createElement("div");
  const title = host.ownerDocument.createElement("div");
  title.className = "tree-item-inner";
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
    const title = row(host, "Work/Clients", "Clients");
    applyCompactLabels([title], INDEX);
    expect(title.textContent).toBe("Work/Clients");
  });

  it("leaves a row that is not a tip alone", () => {
    const host = document.createElement("div");
    const title = row(host, "Archive", "Archive");
    applyCompactLabels([title], INDEX);
    expect(title.textContent).toBe("Archive");
  });

  // Review Focus 5.
  it("puts the original name back when the index goes away", () => {
    const host = document.createElement("div");
    const title = row(host, "Work/Clients", "Clients");
    applyCompactLabels([title], INDEX);
    applyCompactLabels([title], null);
    expect(title.textContent).toBe("Clients");
  });

  it("puts the original name back when a row stops being a tip", () => {
    const host = document.createElement("div");
    const title = row(host, "Work/Clients", "Clients");
    applyCompactLabels([title], INDEX);
    applyCompactLabels([title], EMPTY);
    expect(title.textContent).toBe("Clients");
  });

  it("is idempotent, so a repeated pass does not stack separators", () => {
    const host = document.createElement("div");
    const title = row(host, "Work/Clients", "Clients");
    applyCompactLabels([title], INDEX);
    applyCompactLabels([title], INDEX);
    expect(title.textContent).toBe("Work/Clients");
    expect(title.children.length).toBe(3);
  });

  it("does not rebuild the spans on a repeated pass", () => {
    // Same text and same child count would also come from tearing the spans
    // down and rebuilding them every pass, which is DOM churn on every
    // mutation the observer sees. Identity is what tells the two apart.
    const host = document.createElement("div");
    const title = row(host, "Work/Clients", "Clients");
    applyCompactLabels([title], INDEX);
    const first = Array.from(title.children);
    applyCompactLabels([title], INDEX);
    const second = Array.from(title.children);
    expect(second.length).toBe(3);
    second.forEach((el, i) => expect(el).toBe(first[i]));
  });

  it("adds spaces-compacted with the label and removes it with the restore", () => {
    const host = document.createElement("div");
    const title = row(host, "Work/Clients", "Clients");
    applyCompactLabels([title], INDEX);
    expect(title.parentElement!.classList.contains(CLS.compacted)).toBe(true);
    applyCompactLabels([title], null);
    expect(title.parentElement!.classList.contains(CLS.compacted)).toBe(false);
  });

  it("never gives the class to a row that is not a tip", () => {
    const host = document.createElement("div");
    const title = row(host, "Archive", "Archive");
    applyCompactLabels([title], INDEX);
    expect(title.parentElement!.classList.contains(CLS.compacted)).toBe(false);
  });

  it("draws each part as its own span, so a stylesheet can tell them apart", () => {
    // The reason `compactLabel` returns parts rather than a finished string:
    // muted separators and dimmed leading folders are style changes only if
    // the pieces are separately addressable.
    const host = document.createElement("div");
    const title = row(host, "Work/Clients", "Clients");
    applyCompactLabels([title], INDEX);
    expect(Array.from(title.children).map((c) => c.className)).toEqual([
      "spaces-compact-lead",
      "spaces-compact-sep",
      "spaces-compact-tip",
    ]);
  });

  it("restores a plain text node, leaving no spans behind", () => {
    const host = document.createElement("div");
    const title = row(host, "Work/Clients", "Clients");
    applyCompactLabels([title], INDEX);
    applyCompactLabels([title], EMPTY);
    expect(title.children.length).toBe(0);
    expect(title.textContent).toBe("Clients");
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

  function mount(): { container: HTMLElement; title: HTMLElement } {
    document.body.innerHTML = `<div class="nav-files-container">
      <div class="tree-item"><div class="tree-item-self" data-path="Work/Clients">Clients</div></div>
    </div>`;
    const container = document.querySelector(".nav-files-container") as HTMLElement;
    return { container, title: container.querySelector("[data-path]") as HTMLElement };
  }

  it("applyNow labels a tip row from the index it was handed", () => {
    const { container, title } = mount();
    const a = new ExplorerAdapter();
    a.bind(container);
    a.setChainIndex(INDEX);
    a.apply(SNAP);
    expect(title.textContent).toBe("Work/Clients");
    expect(title.parentElement!.classList.contains(CLS.compacted)).toBe(true);
    a.unbind();
  });

  it("labels nothing when no index was handed over", () => {
    const { container, title } = mount();
    const a = new ExplorerAdapter();
    a.bind(container);
    a.apply(SNAP);
    expect(title.textContent).toBe("Clients");
    a.unbind();
  });

  it("unbind restores the plain name and leaves no spans or class behind", () => {
    const { container, title } = mount();
    const a = new ExplorerAdapter();
    a.bind(container);
    a.setChainIndex(INDEX);
    a.apply(SNAP);
    a.unbind();
    expect(title.textContent).toBe("Clients");
    expect(title.children.length).toBe(0);
    expect(title.parentElement!.classList.contains(CLS.compacted)).toBe(false);
  });
});
