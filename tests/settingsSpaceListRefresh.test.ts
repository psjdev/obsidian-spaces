// @vitest-environment jsdom
/**
 * The settings tab's space list, and the reason it needs telling.
 *
 * Reported against 0.2.1: create a space and it does not appear in Settings
 * until Obsidian restarts. Obsidian builds a declarative tab from
 * `getSettingDefinitions()` when the tab is registered and renders the stored
 * result; it never re-asks, because the thing that used to be called on every
 * open — `display()` — is not called at all for a tab that returns
 * definitions. So a space created from the explorer's + button changed the
 * store and nothing told the tab.
 *
 * The fix is `refreshIfSpacesChanged()`, driven by the plugin's existing
 * definition subscription. These tests pin both halves: that it refreshes when
 * the list moves, and that it stays quiet when it does not — a settings toggle
 * writes to the same store, and redrawing the tab under the user's cursor on
 * every switch flip is what `save()` has always avoided.
 */
import { describe, expect, it, vi } from "vitest";
import { SpacesSettingTab } from "../src/ui/SettingsTab";
import type { DefinitionStore } from "../src/definitions/DefinitionStore";
import type { SpaceDefinition, SpacesDefinitions } from "../src/types";

function space(id: string, name: string): SpaceDefinition {
  return { id, name, icon: "box", color: "#5b5bff", members: [] };
}

/** Only the two reads the tab makes of the store. */
function storeOf(spaces: SpaceDefinition[]): {
  store: DefinitionStore;
  set: (next: SpaceDefinition[]) => void;
} {
  let current = spaces;
  const store = {
    get: (): SpacesDefinitions =>
      ({
        spaces: current,
        settings: {
          globalIgnore: [],
          allowReordering: true,
          allowReorderingAll: true,
          showSpaceHeader: true,
          showPinnedFolder: true,
          pinAllSpace: false,
          autoAssignColor: true,
          customColors: [],
          restoreLayouts: false,
          revealVisitors: true,
        },
        orders: {},
      }) as unknown as SpacesDefinitions,
  } as unknown as DefinitionStore;
  return { store, set: (next) => (current = next) };
}

function tabOf(spaces: SpaceDefinition[]) {
  const { store, set } = storeOf(spaces);
  const app = { vault: { getAbstractFileByPath: () => null } };
  const tab = new SpacesSettingTab(app as never, {} as never, store);
  // `update()` is Obsidian's; the harness does not model rendering, and what
  // matters here is only whether the tab asks for it.
  const update = vi.fn();
  (tab as unknown as { update: () => void }).update = update;
  return { tab, update, set };
}

describe("the settings tab follows the space list", () => {
  it("refreshes when a space is added", () => {
    const { tab, update, set } = tabOf([space("a", "Alpha")]);
    tab.refreshIfSpacesChanged(); // first call establishes the baseline
    update.mockClear();

    set([space("a", "Alpha"), space("b", "Bravo")]);
    tab.refreshIfSpacesChanged();

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refreshes when a space is removed", () => {
    const { tab, update, set } = tabOf([space("a", "Alpha"), space("b", "Bravo")]);
    tab.refreshIfSpacesChanged();
    update.mockClear();

    set([space("a", "Alpha")]);
    tab.refreshIfSpacesChanged();

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refreshes when a space is renamed, since the row shows the name", () => {
    const { tab, update, set } = tabOf([space("a", "Alpha")]);
    tab.refreshIfSpacesChanged();
    update.mockClear();

    set([space("a", "Renamed")]);
    tab.refreshIfSpacesChanged();

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refreshes when spaces are reordered, since the rows are in that order", () => {
    const a = space("a", "Alpha");
    const b = space("b", "Bravo");
    const { tab, update, set } = tabOf([a, b]);
    tab.refreshIfSpacesChanged();
    update.mockClear();

    set([b, a]);
    tab.refreshIfSpacesChanged();

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when nothing about the list changed", () => {
    const { tab, update } = tabOf([space("a", "Alpha"), space("b", "Bravo")]);
    tab.refreshIfSpacesChanged();
    update.mockClear();

    // What a settings toggle looks like from here: the store notifies, the
    // space list is identical. Redrawing would move the control the user is
    // still touching.
    tab.refreshIfSpacesChanged();
    tab.refreshIfSpacesChanged();

    expect(update).not.toHaveBeenCalled();
  });
});
