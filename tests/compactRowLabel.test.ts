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
import { applyCompactLabels } from "../src/explorer/ExplorerAdapter";
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
