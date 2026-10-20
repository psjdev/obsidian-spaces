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
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { noticeLog } from "./helpers/obsidian-stub";
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
    mutate: async (fn: (d: SpacesDefinitions) => void): Promise<void> => {
      fn({ spaces: current } as unknown as SpacesDefinitions);
    },
  } as unknown as DefinitionStore;
  return { store, set: (next) => (current = next) };
}

function tabOf(spaces: SpaceDefinition[]) {
  const { store, set } = storeOf(spaces);
  const app = { vault: { getAbstractFileByPath: () => null } };
  const tab = new SpacesSettingTab(app as never, {} as never, store, () => createMapTagIndex(new Map()));
  // `update()` is Obsidian's; the harness does not model rendering, and what
  // matters here is only whether the tab asks for it.
  const update = vi.fn();
  (tab as unknown as { update: () => void }).update = update;
  return { tab, update, set, store };
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

/** What a row's render callback asks of Obsidian's Setting, recorded. */
interface RecordedButton {
  text: string;
  tooltip: string;
  destructive: boolean;
  click: () => unknown;
}
interface RecordedRow {
  name: string;
  buttons: RecordedButton[];
  hasNameField: boolean;
}

function renderRow(item: unknown): RecordedRow {
  const def = item as { name: string; render: (s: unknown) => void };
  const row: RecordedRow = { name: def.name, buttons: [], hasNameField: false };
  const setting = {
    addText: (cb: (t: unknown) => void) => {
      row.hasNameField = true;
      cb({
        setValue: () => undefined,
        getValue: () => "",
        inputEl: { addEventListener: () => undefined },
      });
      return setting;
    },
    addButton: (cb: (b: unknown) => void) => {
      const b: RecordedButton = { text: "", tooltip: "", destructive: false, click: () => undefined };
      const api = {
        setButtonText: (t: string) => ((b.text = t), api),
        setTooltip: (t: string) => ((b.tooltip = t), api),
        setDestructive: () => ((b.destructive = true), api),
        onClick: (f: () => unknown) => ((b.click = f), api),
      };
      cb(api);
      row.buttons.push(b);
      return setting;
    },
  };
  def.render(setting);
  return row;
}

function spacesPage(tab: SpacesSettingTab): Array<Record<string, unknown>> {
  const page = tab
    .getSettingDefinitions()
    .find((i) => (i as { name?: string }).name === "Spaces") as unknown as { items: Array<Record<string, unknown>> };
  return page.items;
}

function archivedSection(tab: SpacesSettingTab): {
  heading: string;
  emptyState: string;
  items: unknown[];
} {
  return spacesPage(tab).find((i) => i.heading === "Archived") as never;
}

function folderSpace(id: string, name: string): SpaceDefinition {
  return { ...space(id, name), root: "Projects" };
}

describe("archiving from the settings tab", () => {
  it("puts Archive immediately before Delete on a curated space row", () => {
    const { tab } = tabOf([space("a", "Alpha")]);
    const row = renderRow(spacesPage(tab)[0]);
    expect(row.buttons.map((b) => b.text)).toEqual(["Contents…", "Archive", "Delete"]);
  });

  it("puts Archive immediately before Delete on a folder space row", () => {
    const { tab } = tabOf([folderSpace("f", "Work")]);
    const row = renderRow(spacesPage(tab)[0]);
    expect(row.buttons.map((b) => b.text)).toEqual(["Archive", "Delete"]);
  });

  it("gives Archive its tooltip, and archives the space when clicked", async () => {
    const a = space("a", "Alpha");
    const { tab, update } = tabOf([a]);
    const archive = renderRow(spacesPage(tab)[0]).buttons.find((b) => b.text === "Archive")!;
    expect(archive.tooltip).toBe("Put Alpha away without deleting it");
    archive.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(a.archived).toBe(true);
    expect(update).toHaveBeenCalled();
    // The row vanishes into a list that may be below the fold, so the notice
    // names the space and says where it went.
    expect(noticeLog.map((n) => String(n.message))).toContain(
      'Archived "Alpha". Find it under Archived below.'
    );
  });

  it("lists archived spaces in their own section with Restore and Delete", () => {
    const b = { ...space("b", "Bravo"), archived: true as const };
    const { tab } = tabOf([space("a", "Alpha"), b]);

    const active = spacesPage(tab).filter((i) => i.render);
    expect(active.map((i) => i.name)).toEqual(["Alpha"]);

    const section = archivedSection(tab);
    expect(section.items).toHaveLength(1);
    const row = renderRow(section.items[0]);
    expect(row.name).toBe("Bravo");
    expect(row.hasNameField).toBe(false);
    expect(row.buttons.map((x) => x.text)).toEqual(["Restore", "Delete"]);
    expect(row.buttons[0]!.tooltip).toBe("Put Bravo back on the strip");
  });

  it("restores the space when Restore is clicked", async () => {
    const b = { ...space("b", "Bravo"), archived: true as const };
    const { tab, update } = tabOf([b]);
    renderRow(archivedSection(tab).items[0]).buttons[0]!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(b.archived).toBeUndefined();
    expect(update).toHaveBeenCalled();
    // Restoring does not enter the space, and nothing else says so.
    expect(noticeLog.map((n) => String(n.message))).toContain(
      'Restored "Bravo". Click it on the strip to open it.'
    );
  });

  it("shows the Archived section when nothing is archived", () => {
    const { tab } = tabOf([space("a", "Alpha")]);
    const section = archivedSection(tab);
    expect(section.items).toEqual([]);
    // An instruction, not an explanation: the one place on this page that
    // described the feature instead of saying what to click.
    expect(section.emptyState).toBe("Nothing archived. Click Archive beside a space to put it here.");
  });

  it("draws no Archived section at all on a vault with no spaces", () => {
    // "No spaces yet" is the whole answer there. A heading and an empty state
    // under it describe a feature of a thing the reader has none of.
    const { tab } = tabOf([]);
    expect(spacesPage(tab).some((i) => i.heading === "Archived")).toBe(false);
  });

  it("redraws the tab after a space is archived", () => {
    const a = space("a", "Alpha");
    const { tab, update, set } = tabOf([a]);
    tab.refreshIfSpacesChanged();
    update.mockClear();

    set([{ ...a, archived: true as const }]);
    tab.refreshIfSpacesChanged();

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("says every space is archived, not that there are none, when nothing is active", () => {
    const { tab } = tabOf([{ ...space("a", "Alpha"), archived: true as const }]);
    const first = spacesPage(tab)[0] as { name: string; desc: string };
    expect(first.name).toBe("Every space is archived");
    expect(first.desc).toBe("Restore one below to put it back on the strip.");
    expect(archivedSection(tab).items).toHaveLength(1);
  });

  it("still says there are no spaces when there are none at all", () => {
    const { tab } = tabOf([]);
    const first = spacesPage(tab)[0] as { name: string; desc: string };
    expect(first.name).toBe("No spaces yet");
    expect(first.desc).toBe("Use the + button at the bottom of the file explorer to make one.");
  });
});

describe("the settings tab resamples the vault after startup", () => {
  it("cannot see the vault start answering, and resampleVault is what makes it look again", () => {
    // Reported during manual testing of 0.13.0: a folder space whose folder is
    // perfectly healthy read "Projects/Kitchen (missing)" in Settings, while
    // `getSettingDefinitions()` recomputed at the same moment did not say
    // missing. `addSettingTab` builds the definitions inside `onload()`, one
    // line before `onLayoutReady`, so `exists` is asked before the vault can
    // answer; `desc` is a plain string, so nothing re-evaluates it per render;
    // and `refreshIfSpacesChanged` is gated on the SPACE LIST, which has not
    // moved. The row stayed wrong for the whole session.
    let present = false;
    const { store } = storeOf([
      {
        id: "k",
        name: "Kitchen",
        icon: "box",
        color: "#5b5bff",
        root: "Projects/Kitchen",
        members: [],
      },
    ]);
    const app = {
      vault: {
        getAbstractFileByPath: (path: string): unknown =>
          present && path === "Projects/Kitchen" ? { path } : null,
      },
    };
    const tab = new SpacesSettingTab(
      app as never,
      {} as never,
      store,
      () => createMapTagIndex(new Map())
    );
    const update = vi.fn();
    (tab as unknown as { update: () => void }).update = update;

    const summaries = (): string => JSON.stringify(tab.getSettingDefinitions());

    // What the page was built with, before the vault could answer.
    expect(summaries()).toContain("Projects/Kitchen (missing)");

    tab.refreshIfSpacesChanged(); // establishes the baseline
    update.mockClear();

    // The vault finishes loading. The space list is byte for byte the same,
    // so the signature cannot tell anything happened.
    present = true;
    tab.refreshIfSpacesChanged();
    tab.refreshIfSpacesChanged();
    expect(update).not.toHaveBeenCalled();

    // The resample asks for the redraw anyway, which is the whole point.
    tab.resampleVault();
    expect(update).toHaveBeenCalledTimes(1);

    // And what it redraws with is correct.
    expect(summaries()).toContain("Projects/Kitchen");
    expect(summaries()).not.toContain("(missing)");
  });
});
