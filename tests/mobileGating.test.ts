// @vitest-environment jsdom
/**
 * The file-tree reorder drag must be inert on mobile, and inert *by its own
 * decision* rather than by the manifest's.
 *
 * Obsidian's mobile app fires no HTML5 `dragstart` from touch, so the
 * drag-to-reorder gesture does not degrade there — it does not exist. `SwitcherView` already
 * gates its space-icon drag on `Platform.isMobile`; the file-tree drag did not,
 * so it was silently dead: no error, no explanation, and a settings toggle
 * ("Allow reordering a space's notes and folders") still advertising it.
 *
 * `manifest.json` says `isDesktopOnly: true`, so this is unreachable today.
 * That is exactly why it is worth pinning: the guard's whole purpose is to stop
 * the code depending on the manifest for its correctness, and an unpinned guard
 * would be deleted by the first person who notices it "can never fire".
 *
 * Gated in `main.ts`'s `dragDeps()`, not in `DragOrdering`, because that module
 * imports nothing from `"obsidian"` on purpose.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import SpacesPlugin from "../src/main";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { Platform } from "./helpers/obsidian-stub";
import { SCHEMA_VERSION } from "../src/types";

function definitions() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: {
      globalIgnore: [],
      restoreLayouts: true,
      revealVisitors: true,
      allowReordering: true,
      allowReorderingAll: true,
      showSpaceHeader: true,
      pinAllSpace: false,
      customColors: [],
    },
    spaces: [],
  };
}

async function makePlugin(): Promise<SpacesPlugin> {
  const plugin = new SpacesPlugin(
    {} as ConstructorParameters<typeof SpacesPlugin>[0],
    {} as ConstructorParameters<typeof SpacesPlugin>[1]
  );
  let stored: unknown = definitions();
  plugin["defs"] = new DefinitionStore({
    read: async () => stored,
    write: async (d) => {
      stored = d;
    },
  });
  await plugin["defs"].load();
  const backing = new Map<string, unknown>();
  plugin["runtime"] = new RuntimeStateStore({
    get: (k) => backing.get(k),
    set: (k, v) => void backing.set(k, v),
  });
  plugin["runtime"].load();
  return plugin;
}

describe("the file-tree reorder drag is gated on mobile", () => {
  const wasMobile = Platform.isMobile;
  afterEach(() => {
    Platform.isMobile = wasMobile;
  });

  let plugin: SpacesPlugin;
  beforeEach(async () => {
    plugin = await makePlugin();
  });

  it("is enabled on desktop with reordering allowed in All", () => {
    // The discriminator. Without it, the mobile assertion below would also
    // pass against a `dragDeps` that disabled the gesture unconditionally.
    Platform.isMobile = false;
    expect(plugin["dragDeps"]().enabled()).toBe(true);
  });

  it("is disabled on mobile even with every setting turned on", () => {
    Platform.isMobile = true;
    expect(plugin["dragDeps"]().enabled()).toBe(false);
  });

  it("stays disabled on mobile regardless of the reordering settings", async () => {
    Platform.isMobile = true;
    await plugin["defs"].mutate((d) => {
      d.settings.allowReordering = true;
      d.settings.allowReorderingAll = true;
    });
    expect(plugin["dragDeps"]().enabled()).toBe(false);
  });
});
