// @vitest-environment jsdom
/**
 * What the picker says to a screen reader.
 *
 * Mounts through the shared harness in `helpers/createPanel.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { byKey, makeHarness, panelEl, resetPanelDom } from "./helpers/createPanel";
import type { NodeKind } from "../src/ui/vaultTree";

beforeEach(resetPanelDom);

const rowsHost = (): HTMLElement => {
  const el = panelEl().querySelector<HTMLElement>("[role=tree]");
  if (!el) throw new Error("no tree");
  return el;
};
const summaryText = (): string =>
  panelEl().querySelector(".spaces-create-summary")?.textContent ?? "";

describe("what the picker announces", () => {
  it("is multi-select in curated mode", () => {
    makeHarness();
    byKey("mode-curate").click();
    expect(rowsHost().getAttribute("aria-multiselectable")).toBe("true");
  });

  it("is not multi-select in folder mode", () => {
    makeHarness();
    byKey("mode-folder").click();
    expect(rowsHost().hasAttribute("aria-multiselectable")).toBe(false);
  });

  it("stays multi-select after a round trip through the tag body", () => {
    makeHarness();
    byKey("mode-curate").click();
    byKey("body-tags").click();
    byKey("body-items").click();
    expect(rowsHost().getAttribute("aria-multiselectable")).toBe("true");
  });

  it("names what it holds in the plugin's own words", () => {
    makeHarness();
    byKey("mode-curate").click();
    expect(rowsHost().getAttribute("aria-label")).toBe("Choose notes and folders");
  });

  it("labels the vault button Vault", () => {
    makeHarness();
    byKey("mode-curate").click();
    expect(byKey("body-items").textContent).toBe("Vault");
  });

  it("every child of the tree is a treeitem, even when the tree is empty", () => {
    makeHarness({ folders: { allPaths: () => [], kindOf: () => null } });
    byKey("mode-curate").click();
    expect(panelEl().querySelector(".spaces-create-tree-empty")).not.toBeNull();
    for (const child of Array.from(rowsHost().children)) {
      expect(child.getAttribute("role")).toBe("treeitem");
    }
  });

  it("keeps the empty message out of the tag tree too", () => {
    makeHarness({ tags: { knownTags: () => [] } });
    byKey("mode-curate").click();
    byKey("body-tags").click();
    expect(panelEl().querySelector(".spaces-create-tree-empty")).not.toBeNull();
    expect(rowsHost().querySelector(".spaces-create-tree-empty")).toBeNull();
    expect(rowsHost().children).toHaveLength(0);
  });

  it("drops the empty message once there are rows again", () => {
    makeHarness();
    byKey("mode-curate").click();
    const f = byKey("item-filter") as HTMLInputElement;
    f.value = "zzzz";
    f.dispatchEvent(new Event("input", { bubbles: true }));
    expect(panelEl().querySelectorAll(".spaces-create-tree-empty")).toHaveLength(1);
    f.value = "";
    f.dispatchEvent(new Event("input", { bubbles: true }));
    expect(panelEl().querySelector(".spaces-create-tree-empty")).toBeNull();
  });

  it("has exactly one live region", () => {
    makeHarness();
    byKey("mode-curate").click();
    expect(panelEl().querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("shows only the figures after a switch of body, with no lead sentence", () => {
    // The switch is deliberately not announced in the live region: the owner
    // asked for the row to carry the numbers and nothing else.
    makeHarness();
    byKey("mode-curate").click();
    byKey("body-tags").click();
    expect(summaryText()).toBe("Nothing selected");
    panelEl().querySelector<HTMLElement>("[data-tag='archive']")?.click();
    byKey("body-items").click();
    expect(summaryText()).not.toMatch(/Showing/);
    expect(summaryText()).toMatch(/^(\d+ notes?|no notes)/);
  });

  it("the overflow row is inert: disabled, unselected, and not in the tab order", () => {
    // 300 notes at the root exceed the 200-row budget, so the tree draws its
    // overflow row. Asserted against that real row, with no early return: if
    // the fixture ever stops producing one, `expect(...).not.toBeNull()` fails.
    const many: Record<string, NodeKind> = {};
    for (let i = 0; i < 300; i += 1) many[`note-${String(i).padStart(3, "0")}.md`] = "file";
    makeHarness({
      folders: { allPaths: () => Object.keys(many), kindOf: (p) => many[p] ?? null },
    });
    byKey("mode-curate").click();
    const overflow = panelEl().querySelector<HTMLElement>(".is-overflow");
    expect(overflow).not.toBeNull();
    expect(overflow!.getAttribute("role")).toBe("treeitem");
    expect(overflow!.getAttribute("aria-disabled")).toBe("true");
    expect(overflow!.getAttribute("aria-selected")).toBe("false");
    expect(overflow!.hasAttribute("tabindex")).toBe(false);
    const before = summaryText();
    overflow!.click();
    overflow!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(summaryText()).toBe(before);
  });
});
