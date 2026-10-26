// @vitest-environment jsdom
/**
 * The Export button on a space's row in Settings.
 *
 * Offered on ACTIVE rows only. An archived space can be broken, and
 * restoring it runs a repair window that asks what to do about members whose
 * notes have moved or gone; a button beside Restore would let someone skip
 * that gate and get a quietly partial export.
 *
 * Driven the way `settingsSpaceListRefresh.test.ts` drives these rows: the
 * declaration carries a `render(setting)` callback and the buttons are added
 * imperatively inside it, so the test supplies a `Setting` that records.
 */
import { describe, expect, it } from "vitest";
import { SpacesSettingTab } from "../src/ui/SettingsTab";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import type { DefinitionStore } from "../src/definitions/DefinitionStore";
import type { SpaceDefinition, SpacesDefinitions } from "../src/types";

const space = (over: Partial<SpaceDefinition> = {}): SpaceDefinition => ({
  id: "kitchen",
  name: "Kitchen",
  icon: "hammer",
  color: "#ff6b6b",
  members: [],
  ...over,
});

function storeOf(spaces: SpaceDefinition[]): DefinitionStore {
  return {
    get: (): SpacesDefinitions =>
      ({
        spaces,
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
    mutate: async (): Promise<void> => undefined,
  } as unknown as DefinitionStore;
}

function tabOf(
  spaces: SpaceDefinition[],
  exportSpace?: (s: SpaceDefinition) => Promise<void>
): SpacesSettingTab {
  const app = { vault: { getAbstractFileByPath: () => null } };
  return new SpacesSettingTab(
    app as never,
    {} as never,
    storeOf(spaces),
    () => createMapTagIndex(new Map()),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    exportSpace
  );
}

interface Button {
  text: string;
  tooltip: string;
  click: () => unknown;
}

/** The buttons a row draws, by driving its `render` with a recorder. */
function buttonsOf(tab: SpacesSettingTab, rowName: string): Button[] {
  const flat = (rows: unknown[] | undefined): Record<string, unknown>[] =>
    (rows ?? []).flatMap((r) => {
      const row = r as Record<string, unknown>;
      return [row, ...flat(row.items as unknown[] | undefined)];
    });
  const row = flat(tab.getSettingDefinitions() as unknown[]).find((r) => r.name === rowName);
  if (!row || typeof row.render !== "function") return [];
  const buttons: Button[] = [];
  const setting: Record<string, unknown> = {
    addText: (cb: (t: unknown) => void) => {
      cb({
        setValue: () => undefined,
        getValue: () => "",
        inputEl: { addEventListener: () => undefined },
      });
      return setting;
    },
    addButton: (cb: (b: unknown) => void) => {
      const b: Button = { text: "", tooltip: "", click: () => undefined };
      const api: Record<string, unknown> = {
        setButtonText: (t: string) => ((b.text = t), api),
        setTooltip: (t: string) => ((b.tooltip = t), api),
        setDestructive: () => api,
        setCta: () => api,
        onClick: (f: () => unknown) => ((b.click = f), api),
      };
      cb(api);
      buttons.push(b);
      return setting;
    },
  };
  (row.render as (s: unknown) => void)(setting);
  return buttons;
}

const labels = (tab: SpacesSettingTab, row: string): string[] =>
  buttonsOf(tab, row).map((b) => b.text);

describe("the Export button in Settings", () => {
  it("is offered on an active space's row", () => {
    expect(labels(tabOf([space()], async () => undefined), "Kitchen")).toContain("Export");
  });

  it("sits before Archive, which anchors the end of the row with Delete", () => {
    const l = labels(tabOf([space()], async () => undefined), "Kitchen");
    expect(l.indexOf("Export")).toBeGreaterThanOrEqual(0);
    expect(l.indexOf("Export")).toBeLessThan(l.indexOf("Archive"));
  });

  it("names the space in its tooltip, and says the folder is outside the vault", () => {
    const b = buttonsOf(tabOf([space()], async () => undefined), "Kitchen").find(
      (x) => x.text === "Export"
    );
    expect(b?.tooltip).toContain("Kitchen");
    expect(b?.tooltip).toMatch(/outside your vault/i);
  });

  it("is NOT drawn when no export is wired in", () => {
    // Drawn dead would be worse than absent: the tab is built in `onload()`,
    // before the controller the export needs exists.
    expect(labels(tabOf([space()]), "Kitchen")).not.toContain("Export");
  });

  it("is NOT offered on an archived space's row", () => {
    // A broken archived space must go through Restore's repair window
    // rather than quietly exporting a partial copy.
    const l = labels(tabOf([space({ id: "old", name: "Old", archived: true })], async () => undefined), "Old");
    expect(l).not.toContain("Export");
  });

  it("exports the space whose row was clicked, not whichever is active", () => {
    // The whole reason the controller gained `snapshotFor`.
    const seen: string[] = [];
    const tab = tabOf([space(), space({ id: "garden", name: "Garden" })], async (s) => {
      seen.push(s.id);
    });
    buttonsOf(tab, "Garden").find((b) => b.text === "Export")?.click();
    expect(seen).toEqual(["garden"]);
  });
});
