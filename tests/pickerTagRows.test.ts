// @vitest-environment jsdom
/**
 * A tag that is chosen always has a row, whatever the vault now reports.
 *
 * Mounts through the shared harness in `helpers/createPanel.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { byKey, makeHarness, panelEl, resetPanelDom, tagRows } from "./helpers/createPanel";

beforeEach(resetPanelDom);

const summaryText = (): string =>
  panelEl().querySelector(".spaces-create-summary")?.textContent ?? "";
const redraw = (): void => {
  byKey("item-filter").dispatchEvent(new Event("input", { bubbles: true }));
};
const tagRow = (tag: string): HTMLElement | undefined =>
  tagRows().find((r) => r.dataset.tag === tag);

function openTags(known: { current: string[] | null }): void {
  makeHarness({ tags: { knownTags: () => known.current } });
  byKey("mode-curate").click();
  byKey("body-tags").click();
}

describe("a chosen tag that leaves the vault", () => {
  it("still has a row and can be deselected", () => {
    const known: { current: string[] | null } = { current: ["#project", "#archive"] };
    openTags(known);
    tagRow("project")!.click();
    expect(summaryText()).toMatch(/1 tag/);
    known.current = ["#archive"]; // the note carrying it was deleted
    redraw();
    const row = tagRow("project");
    expect(row).toBeDefined();
    expect(row!.getAttribute("aria-selected")).toBe("true");
    row!.click();
    expect(summaryText()).toBe("Nothing selected");
  });

  it("survives knownTags returning null", () => {
    const known: { current: string[] | null } = { current: ["#project"] };
    openTags(known);
    tagRow("project")!.click();
    known.current = null; // documented as a future Obsidian without getTags
    expect(() => redraw()).not.toThrow();
    expect(tagRow("project")).toBeDefined();
  });

  it("still says the tags cannot be listed when null and nothing is chosen", () => {
    const known: { current: string[] | null } = { current: null };
    openTags(known);
    expect(panelEl().querySelector(".spaces-create-tree-empty")?.textContent).toMatch(
      /Settings, Contents/
    );
  });
});
