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

describe("the active space style control", () => {
  it("is a dropdown on the Appearance page offering both looks", () => {
    const control = flatten(page("Appearance").items).find(
      (i) => i.control?.key === "activeSpaceStyle"
    )?.control;
    expect(control?.type).toBe("dropdown");
    // Both one short word: a native select sizes to its selected option, so
    // an uneven pair makes the settings row jump on every change.
    expect(control?.options).toEqual({ box: "Box", bold: "Bold" });
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
