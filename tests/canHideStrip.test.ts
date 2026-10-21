// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
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
