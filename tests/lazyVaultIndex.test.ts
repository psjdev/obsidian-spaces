/**
 * The vault index, built when it is read rather than when it is made.
 *
 * `createObsidianVaultIndex` walks the whole vault tree — 6.6 ms on a 10,000
 * note vault — and it was built eagerly in the `SpaceController` constructor,
 * inside the load Obsidian awaits. But `recompute` returns before it ever
 * touches `this.vault` when *All* is active, which is the majority case and
 * the only case for a user who has never made a space. So the walk was
 * provably unused and still paid for.
 *
 * The lazy pattern already existed one line below for the tag index; this is
 * the same wrapper applied to the same problem, and it preserves the same
 * ordering invariant — the build can only ever happen at or AFTER the moment
 * the wrapper was installed.
 */
import { describe, expect, it, vi } from "vitest";
import { createLazyVaultIndex } from "../src/visibility/VaultIndex";
import { SpaceController } from "../src/controller/SpaceController";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { buildFakeVault } from "./helpers/fakeVault";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { SCHEMA_VERSION } from "../src/types";

const tree = buildFakeVault({
  Papers: "folder",
  "Papers/A.md": "file",
  "Recipes.md": "file",
});

describe("createLazyVaultIndex", () => {
  it("does not build until something asks it a question", () => {
    let builds = 0;
    createLazyVaultIndex(() => {
      builds++;
      return tree;
    });
    expect(builds).toBe(0);
  });

  it("builds once and answers every later question from that one snapshot", () => {
    // One recompute must see ONE picture, exactly as an eagerly built
    // snapshot does. A wrapper that rebuilt per call would let `kindOf` and
    // `descendantsOf` disagree about the same vault inside one snapshot.
    let builds = 0;
    const lazy = createLazyVaultIndex(() => {
      builds++;
      return tree;
    });
    expect(lazy.exists("Papers/A.md")).toBe(true);
    expect(lazy.kindOf("Papers")).toBe("folder");
    expect(lazy.childrenOf("Papers")).toEqual(["Papers/A.md"]);
    expect(lazy.descendantsOf("Papers")).toEqual(["Papers/A.md"]);
    expect(lazy.allPaths().sort()).toEqual(["Papers", "Papers/A.md", "Recipes.md"]);
    expect(builds).toBe(1);
  });

  it("answers exactly as the index it wraps does", () => {
    const lazy = createLazyVaultIndex(() => tree);
    expect(lazy.exists("Nothing.md")).toBe(false);
    expect(lazy.kindOf("Nothing.md")).toBeNull();
    expect(lazy.childrenOf("Nothing")).toEqual([]);
  });
});

describe("what a recompute in All costs", () => {
  async function build() {
    let stored: unknown = {
      schemaVersion: SCHEMA_VERSION,
      settings: { globalIgnore: [], restoreLayouts: false },
      spaces: [
        {
          id: "research",
          name: "Research",
          icon: "microscope",
          color: "#4ecdc4",
          members: [{ path: "Papers", kind: "folder" }],
        },
      ],
    };
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => {
        stored = d;
      },
    });
    await store.load();
    const runtime = new RuntimeStateStore({ get: () => null, set: () => undefined });
    runtime.load();
    let builds = 0;
    const controller = new SpaceController(
      store,
      runtime,
      createLazyVaultIndex(() => {
        builds++;
        return tree;
      }),
      { apply: vi.fn(), livePaths: () => new Set<string>() },
      createMapTagIndex(new Map())
    );
    return { controller, builds: () => builds };
  }

  it("never walks the vault tree", async () => {
    const { controller, builds } = await build();
    controller.refresh();
    controller.refresh();
    expect(controller.currentSnapshot()).toBeNull();
    expect(builds()).toBe(0);
  });

  it("walks it, once, as soon as a space is active", async () => {
    const { controller, builds } = await build();
    await controller.switchTo({ kind: "space", id: "research" });
    controller.refresh();
    expect(controller.currentSnapshot()?.decisionFor("Papers/A.md").visible).toBe(true);
    expect(builds()).toBe(1);
  });
});
