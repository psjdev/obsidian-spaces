// @vitest-environment jsdom
/**
 * `main.ts`'s `exportSpace` — the layer that builds the export's context
 * out of the live app.
 *
 * It had no test at all, and a review showed what that cost: swapping
 * `controller.snapshotFor(space)` for `controller.currentSnapshot()` left
 * all 3111 tests green, which would have made the Settings button ship the
 * ACTIVE space's notes in a folder named after whichever row was clicked.
 *
 * These drive the real method with the controller and adapter stubbed, and
 * assert on what it hands the export rather than on what it writes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { noticeLog } from "./helpers/obsidian-stub";
import SpacesPlugin from "../src/main";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { buildFakeVault } from "./helpers/fakeVault";
import type { SpaceDefinition, VisibilityDecision } from "../src/types";
import type { VisibilitySnapshot } from "../src/visibility/VisibilityEngine";

const kitchen: SpaceDefinition = {
  id: "kitchen",
  name: "Kitchen",
  icon: "hammer",
  color: "#ff6b6b",
  root: "Projects/Kitchen",
  members: [],
};
const garden: SpaceDefinition = {
  id: "garden",
  name: "Garden",
  icon: "sprout",
  color: "#95e1d3",
  members: [{ path: "Garden/a.md", kind: "file" }],
};

const snapshotOf = (paths: string[]): VisibilitySnapshot => ({
  visiblePaths: () => new Set(paths),
  decisionFor: (): VisibilityDecision => ({
    visible: true,
    reason: "exact-member",
    canRemoveMembership: true,
    overridesIgnore: false,
  }),
});

const vault = buildFakeVault({
  Projects: "folder",
  "Projects/Kitchen": "folder",
  "Projects/Kitchen/plan.md": "file",
  Garden: "folder",
  "Garden/a.md": "file",
});

/** The plugin with just enough of itself to run `exportSpace`. */
function harness(over: { snapshotFor?: (s: SpaceDefinition) => VisibilitySnapshot | null } = {}) {
  const app = {
    workspace: { containerEl: document.createElement("div") },
    vault: { adapter: { readBinary: async () => new ArrayBuffer(0) } },
    metadataCache: { resolvedLinks: {} },
  };
  const plugin = new SpacesPlugin(
    app as unknown as ConstructorParameters<typeof SpacesPlugin>[0],
    {} as ConstructorParameters<typeof SpacesPlugin>[1]
  );
  const defs = new DefinitionStore({
    read: async () => ({
      schemaVersion: 4,
      settings: { globalIgnore: [], restoreLayouts: false },
      spaces: [kitchen, garden],
      orders: { bySpaceId: { garden: { Garden: ["Garden/a.md"] } } },
    }),
    write: async () => undefined,
  });
  plugin["defs"] = defs;

  const asked: SpaceDefinition[] = [];
  const currentSnapshot = vi.fn(() => snapshotOf(["WRONG/active.md"]));
  plugin["controller"] = {
    activeSpace: () => kitchen,
    currentSnapshot,
    vaultIndex: () => vault,
    snapshotFor: (s: SpaceDefinition) => {
      asked.push(s);
      return over.snapshotFor ? over.snapshotFor(s) : snapshotOf(["Garden/a.md"]);
    },
  } as unknown as (typeof plugin)["controller"];

  return { plugin, defs, asked, currentSnapshot };
}

/** Runs `exportSpace` with the picker cancelled, so nothing touches disk. */
async function runCancelled(plugin: SpacesPlugin, space: SpaceDefinition | null): Promise<void> {
  const electron = (await import("electron")) as unknown as {
    remote: { dialog: { showOpenDialog: () => Promise<unknown> } };
  };
  electron.remote.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  await (plugin as unknown as { exportSpace: (s: SpaceDefinition | null) => Promise<void> })
    .exportSpace(space);
}

describe("main.ts exportSpace", () => {
  beforeEach(() => {
    noticeLog.length = 0;
  });

  it("asks the controller for THAT space's snapshot, not the pane's", async () => {
    // The whole reason `snapshotFor` exists. With `currentSnapshot` here,
    // exporting Garden from Settings would write Kitchen's notes.
    const { plugin, defs, asked, currentSnapshot } = harness();
    await defs.load();
    await runCancelled(plugin, garden);
    expect(asked.map((s) => s.id)).toEqual(["garden"]);
    expect(currentSnapshot).not.toHaveBeenCalled();
  });

  it("asks for the active space when the command runs", async () => {
    const { plugin, defs, asked } = harness();
    await defs.load();
    await runCancelled(plugin, kitchen);
    expect(asked.map((s) => s.id)).toEqual(["kitchen"]);
  });

  it("does not ask at all when there is no space", async () => {
    const { plugin, defs, asked } = harness();
    await defs.load();
    await runCancelled(plugin, null);
    expect(asked).toEqual([]);
  });

  it("treats a folder space whose root is not a folder as missing", async () => {
    // `rootOf` never consults the vault, so this was revertible to the
    // pre-fix bug with no test failing: an empty export of a space whose
    // root had been deleted.
    const { plugin, defs } = harness();
    await defs.load();
    await runCancelled(plugin, { ...kitchen, root: "Projects/Gone" });
    expect(noticeLog.map((n) => String(n.message)).join(" ")).toMatch(/folder that exists/i);
  });

  it("accepts a folder space whose root IS a folder", async () => {
    const { plugin, defs, asked } = harness();
    await defs.load();
    await runCancelled(plugin, kitchen);
    expect(noticeLog).toEqual([]);
    expect(asked.map((s) => s.id)).toEqual(["kitchen"]);
  });
});
