// @vitest-environment jsdom
/**
 * Keyboard focus in the picker survives a redraw.
 *
 * Every redraw replaces the rows, so the focused one is destroyed. Expanding
 * always put focus back; picking never did, so every Enter or Space pick
 * dropped it to `<body>` and lost the user's place in the tree.
 *
 * Mounts through the shared harness in `helpers/createPanel.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { byKey, makeHarness, resetPanelDom, rowFor, tagRowFor } from "./helpers/createPanel";

beforeEach(resetPanelDom);

const press = (el: HTMLElement, key: string): void => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
};

describe("keyboard focus in the picker", () => {
  it("stays on the row after picking it with Enter", () => {
    makeHarness();
    byKey("mode-curate").click();
    const row = rowFor("inbox.md");
    row.focus();
    press(row, "Enter");
    expect(rowFor("inbox.md").classList.contains("is-selected")).toBe(true);
    expect(document.activeElement).toBe(rowFor("inbox.md"));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("stays on the row after picking it with Space", () => {
    makeHarness();
    byKey("mode-curate").click();
    const row = rowFor("inbox.md");
    row.focus();
    press(row, " ");
    expect(document.activeElement).toBe(rowFor("inbox.md"));
  });

  it("stays on the row after picking it in the tag body", () => {
    makeHarness();
    byKey("mode-curate").click();
    byKey("body-tags").click();
    const row = tagRowFor("archive");
    row.focus();
    press(row, "Enter");
    expect(tagRowFor("archive").classList.contains("is-selected")).toBe(true);
    expect(document.activeElement).toBe(tagRowFor("archive"));
  });

  it("stays on the row after expanding it", () => {
    makeHarness();
    byKey("mode-curate").click();
    const row = rowFor("Projects");
    row.focus();
    press(row, "ArrowRight");
    expect(rowFor("Projects/Work")).toBeTruthy();
    expect(document.activeElement).toBe(rowFor("Projects"));
  });

  it("stays on the tag row after expanding it", () => {
    makeHarness();
    byKey("mode-curate").click();
    byKey("body-tags").click();
    const row = tagRowFor("project");
    row.focus();
    press(row, "ArrowRight");
    expect(tagRowFor("project/console")).toBeTruthy();
    expect(document.activeElement).toBe(tagRowFor("project"));
  });
});

describe("a caret click", () => {
  it("leaves focus where it was", () => {
    makeHarness();
    byKey("mode-curate").click();
    const other = rowFor("inbox.md");
    other.focus();
    const caret = rowFor("Projects").querySelector<HTMLElement>(".spaces-create-tree-caret");
    caret?.click();
    expect(rowFor("Projects/Work")).toBeTruthy();
    expect(document.activeElement).toBe(rowFor("inbox.md"));
  });

  it("does not move focus when no row had it", () => {
    makeHarness();
    byKey("mode-curate").click();
    const before = document.activeElement;
    rowFor("Projects").querySelector<HTMLElement>(".spaces-create-tree-caret")?.click();
    expect(rowFor("Projects/Work")).toBeTruthy();
    expect(document.activeElement).toBe(before);
  });
});
