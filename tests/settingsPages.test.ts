// @vitest-environment jsdom
/**
 * The shape of the settings tab: which pages exist, and where the appearance
 * controls live.
 *
 * Obsidian asks a declarative tab for its definitions ONCE, at registration,
 * and renders what it is handed. There is no `display()` to eyeball, so the
 * structure is only ever as correct as this says it is -- the 0.2.0 regression
 * that hid new spaces from Settings went unnoticed for exactly that reason.
 */
import { describe, expect, it } from "vitest";
import { SpacesSettingTab } from "../src/ui/SettingsTab";
import { DEFAULT_DEFINITIONS, type SpacesDefinitions } from "../src/types";
import type { DefinitionStore } from "../src/definitions/DefinitionStore";

interface Item {
  type?: string;
  name?: string;
  desc?: string;
  heading?: string;
  items?: Item[];
  control?: { type?: string; key?: string; options?: Record<string, string> };
}

function tab(): SpacesSettingTab {
  const store = {
    get: (): SpacesDefinitions => structuredClone(DEFAULT_DEFINITIONS),
  } as unknown as DefinitionStore;
  const app = { vault: { getAbstractFileByPath: () => null } };
  return new SpacesSettingTab(app as never, {} as never, store);
}

const pages = (): Item[] => tab().getSettingDefinitions() as unknown as Item[];

/** Every item at any depth, so a control can be found without knowing its nesting. */
function flatten(items: Item[] | undefined): Item[] {
  if (!items) return [];
  return items.flatMap((i) => [i, ...flatten(i.items)]);
}

function page(name: string): Item {
  const found = pages().find((p) => p.name === name);
  if (!found) throw new Error(`no page named ${name}; got ${pages().map((p) => p.name).join(", ")}`);
  return found;
}

describe("the settings pages", () => {
  it("offers Appearance, Preferences and Spaces, in that order", () => {
    expect(pages().map((p) => p.name)).toEqual(["Appearance", "Preferences", "Spaces"]);
    expect(pages().every((p) => p.type === "page")).toBe(true);
  });

  it("gives Appearance no group heading of its own", () => {
    // The page IS the heading. A group repeating the page name reads as a
    // stutter, and this is the only page whose items are returned flat.
    expect(flatten(page("Appearance").items).some((i) => i.heading === "Appearance")).toBe(false);
  });

  it("leaves the behavioural groups on Preferences", () => {
    const headings = flatten(page("Preferences").items)
      .map((i) => i.heading)
      .filter(Boolean);
    expect(headings).toEqual(["File tree", "Reordering", "Switching"]);
  });
});

describe("the theme icon colour control", () => {
  it("is a toggle on the Appearance page", () => {
    const control = flatten(page("Appearance").items).find(
      (i) => i.control?.key === "useThemeIconColor"
    )?.control;
    expect(control?.type).toBe("toggle");
  });

  it("sits with the other colour settings", () => {
    // Next to the setting that decides what colour a new space is GIVEN,
    // since this one decides whether any of them are drawn.
    const keys = flatten(page("Appearance").items)
      .map((i) => i.control?.key)
      .filter(Boolean);
    expect(keys).toContain("useThemeIconColor");
    expect(keys.indexOf("useThemeIconColor")).toBe(keys.indexOf("autoAssignColor") + 1);
  });

  it("says the colours are kept", () => {
    // The question anyone reading this setting will have. A toggle that
    // sounds like it discards your colours does not get turned on.
    const item = flatten(page("Appearance").items).find(
      (i) => i.control?.key === "useThemeIconColor"
    );
    expect(item?.desc).toMatch(/kept/i);
  });
});

describe("the active space style control", () => {
  it("is a dropdown on the Appearance page offering all three looks", () => {
    const control = flatten(page("Appearance").items).find(
      (i) => i.control?.key === "activeSpaceStyle"
    )?.control;
    expect(control?.type).toBe("dropdown");
    // One short word each, and close to the same length: a native select
    // sizes to its selected option, so uneven labels make the settings row
    // jump on every change.
    expect(control?.options).toEqual({
      shaded: "Shaded",
      boxed: "Boxed",
      bolded: "Bolded",
    });
  });

  it("is not on any other page", () => {
    for (const name of ["Preferences", "Spaces"]) {
      expect(
        flatten(page(name).items).some((i) => i.control?.key === "activeSpaceStyle")
      ).toBe(false);
    }
  });

  it("keeps the strip position control on Appearance too", () => {
    // It moved with the group. A settings reshuffle that stranded it on
    // Preferences would still typecheck and still render.
    expect(
      flatten(page("Appearance").items).some((i) => i.control?.key === "stripPlacement")
    ).toBe(true);
  });
});
