// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { canHideStrip } from "../src/ui/canHideStrip";
import { SpacesSettingTab } from "../src/ui/SettingsTab";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { DEFAULT_DEFINITIONS } from "../src/types";
import type { DefinitionStore } from "../src/definitions/DefinitionStore";
import type { StripPlacement } from "../src/types";

describe("canHideStrip", () => {
  it("is true only for the left placement on a device with hover", () => {
    expect(canHideStrip("left", true)).toBe(true);
    expect(canHideStrip("left", false)).toBe(false);
    expect(canHideStrip("bottom", true)).toBe(false);
    expect(canHideStrip("bottom", false)).toBe(false);
    expect(canHideStrip("top", true)).toBe(false);
    expect(canHideStrip("right", true)).toBe(false);
    expect(canHideStrip("right", false)).toBe(false);
  });
});

interface Item {
  items?: Item[];
  control?: { key?: string };
}

function offersHideStrip(placement: StripPlacement, hover: boolean): boolean {
  const defs = structuredClone(DEFAULT_DEFINITIONS);
  defs.settings.stripPlacement = placement;
  const store = { get: () => defs } as unknown as DefinitionStore;
  const app = { vault: { getAbstractFileByPath: () => null } };
  const tab = new SpacesSettingTab(
    app as never,
    {} as never,
    store,
    () => createMapTagIndex(new Map()),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => hover
  );
  const flat = (items: Item[] | undefined): Item[] =>
    (items ?? []).flatMap((i) => [i, ...flat(i.items)]);
  return flat(tab.getSettingDefinitions() as unknown as Item[]).some(
    (i) => i.control?.key === "hideStrip"
  );
}

describe("the hide-strip setting row", () => {
  it("is offered for a left strip on a hover device", () => {
    expect(offersHideStrip("left", true)).toBe(true);
  });
  it("is withheld with no hover, or for any other placement", () => {
    expect(offersHideStrip("left", false)).toBe(false);
    expect(offersHideStrip("bottom", true)).toBe(false);
    expect(offersHideStrip("right", true)).toBe(false);
  });
});

interface Row {
  name?: string;
  desc?: unknown;
  items?: Row[];
  control?: { key?: string };
}

function tabAt(placement: StripPlacement, hover = true) {
  const defs = structuredClone(DEFAULT_DEFINITIONS);
  defs.settings.stripPlacement = placement;
  const store = { get: () => defs } as unknown as DefinitionStore;
  const app = { vault: { getAbstractFileByPath: () => null } };
  const tab = new SpacesSettingTab(
    app as never,
    {} as never,
    store,
    () => createMapTagIndex(new Map()),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => hover
  );
  const update = vi.fn();
  (tab as unknown as { update: () => void }).update = update;
  const flat = (items: Row[] | undefined): Row[] =>
    (items ?? []).flatMap((i) => [i, ...flat(i.items)]);
  const row = () =>
    flat(tab.getSettingDefinitions() as unknown as Row[]).find(
      (i) => i.control?.key === "hideStrip"
    );
  return { tab, update, row, defs };
}

describe("the hide-strip row copy", () => {
  const { row } = tabAt("left");
  it("says what it does and which placement it applies to", () => {
    expect(row()?.name).toBe("Hide the space strip");
    expect(row()?.desc).toBe(
      "Show it when you move the pointer to the left edge of the file tree. Available when the strip is on the left."
    );
  });
  it("never uses an em dash, and never calls notes and folders items or files", () => {
    const text = `${row()?.name} ${String(row()?.desc)}`;
    expect(text).not.toContain(String.fromCharCode(0x2014));
    expect(text).not.toMatch(/\b(items?|files)\b/i);
  });
});

describe("the hide-strip row follows the placement, whatever changed it", () => {
  it("redraws when the placement leaves left by a route other than the dropdown", () => {
    const { tab, update, defs, row } = tabAt("left");
    tab.refreshIfSpacesChanged(); // baseline
    update.mockClear();
    defs.settings.stripPlacement = "bottom"; // a command or a strip drag
    tab.refreshIfSpacesChanged();
    expect(update).toHaveBeenCalledTimes(1);
    expect(row()).toBeUndefined();
  });
  it("redraws when the placement returns to left", () => {
    const { tab, update, defs, row } = tabAt("right");
    tab.refreshIfSpacesChanged();
    update.mockClear();
    defs.settings.stripPlacement = "left";
    tab.refreshIfSpacesChanged();
    expect(update).toHaveBeenCalledTimes(1);
    expect(row()).toBeDefined();
  });
  it("does not redraw between two placements that both withhold the row", () => {
    const { tab, update, defs } = tabAt("bottom");
    tab.refreshIfSpacesChanged();
    update.mockClear();
    defs.settings.stripPlacement = "top";
    tab.refreshIfSpacesChanged();
    expect(update).not.toHaveBeenCalled();
  });
});
