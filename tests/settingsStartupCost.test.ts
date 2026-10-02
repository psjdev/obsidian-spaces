// @vitest-environment jsdom
/**
 * What the settings tab is allowed to COST at plugin load.
 *
 * `onload()` calls `addSettingTab`, and Obsidian builds a declarative tab
 * immediately by calling `getSettingDefinitions()`. That reached
 * `spaceItems()`, which built a complete tag index to draw a member count.
 * Measured in a real Obsidian on a 10,000 note vault: 20.9 ms and 10,000
 * `getFileCache` calls, inside the load Obsidian awaits, before the workspace
 * exists, for a settings page nobody had opened. With a tag space also active
 * the vault's metadata was walked TWICE per load — 20,000 calls — and load
 * went from 84.9 ms to 146.3 ms.
 *
 * A declarative tab never gets `display()`, so "compute it when the page is
 * shown" is not available. The count moved to the Contents dialog, which the
 * user opens deliberately, and the settings row says how many ENTRIES a space
 * stores — which is what it always counted a tag as anyway.
 *
 * `getMarkdownFiles` is the first thing `createObsidianTagIndex` does and
 * nothing else on this path calls it, so a throwing stub is a precise tripwire.
 */
import { describe, expect, it } from "vitest";
import { SpacesSettingTab } from "../src/ui/SettingsTab";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { DEFAULT_DEFINITIONS, SCHEMA_VERSION, type SpacesDefinitions } from "../src/types";
import type { DefinitionStore } from "../src/definitions/DefinitionStore";

interface Item {
  type?: string;
  name?: string;
  desc?: string;
  items?: Item[];
}

const WITH_TAGS: SpacesDefinitions = {
  ...structuredClone(DEFAULT_DEFINITIONS),
  schemaVersion: SCHEMA_VERSION,
  spaces: [
    {
      id: "research",
      name: "Research",
      icon: "microscope",
      color: "#4ecdc4",
      members: [
        { kind: "tag", tag: "project" },
        { path: "Papers/A.md", kind: "file" },
      ],
    },
  ],
};

/** An `app` that reports a walk of the vault's metadata as a test failure. */
function tab(defs: SpacesDefinitions): { tab: SpacesSettingTab; walks: () => number } {
  let walks = 0;
  const store = { get: (): SpacesDefinitions => structuredClone(defs) } as unknown as DefinitionStore;
  const app = {
    vault: {
      // Everything the fixture names exists, so no row is `missing`.
      getAbstractFileByPath: () => ({}),
      getMarkdownFiles: () => {
        walks++;
        return [];
      },
    },
    metadataCache: {
      getFileCache: () => {
        throw new Error("the settings tab read a file's metadata cache");
      },
    },
  };
  return {
    tab: new SpacesSettingTab(app as never, {} as never, store, () => createMapTagIndex(new Map())),
    walks: () => walks,
  };
}

function spacesPage(t: SpacesSettingTab): Item {
  const pages = t.getSettingDefinitions() as unknown as Item[];
  const found = pages.find((p) => p.name === "Spaces");
  if (!found) throw new Error("no Spaces page");
  return found;
}

describe("building the settings tab", () => {
  it("never walks the vault's markdown files", () => {
    const { tab: t, walks } = tab(WITH_TAGS);
    spacesPage(t);
    expect(walks()).toBe(0);
  });

  it("never walks it for a vault with no spaces either", () => {
    const { tab: t, walks } = tab(structuredClone(DEFAULT_DEFINITIONS));
    spacesPage(t);
    expect(walks()).toBe(0);
  });

  it("still lists the space, and still counts a tag as one stored entry", () => {
    // A tag counts as one entry the way a folder counts as one rather than as
    // its contents. That was already the rule; only the per-tag note count is
    // gone from this row.
    const { tab: t } = tab(WITH_TAGS);
    const rows = spacesPage(t).items ?? [];
    expect(rows.map((r) => r.name)).toEqual(["Research"]);
    expect(rows[0].desc).toBe("Curated · 2 members");
  });
});
