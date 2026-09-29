/**
 * `onunload` must cancel work already parked on an await.
 *
 * The defect this pins is not a slow switch — it is a switch that finishes
 * AFTER the plugin has been disabled. `switchTo` parks on
 * `layout.transition()`, and everything downstream of that await re-installs
 * state the teardown has just removed: `onOutcome` is the host rebinding the
 * explorer (which re-patches the sort seam and re-attaches the
 * `MutationObserver`), `setSelection` writes runtime state for a plugin that
 * is gone, and `recompute` re-applies a snapshot to a tree nothing will ever
 * clean up again. The user is left with a filtered explorer belonging to a
 * disabled plugin — residue a disabled plugin must never leave.
 *
 * Reachability, measured by this repo: the window is ~40-80 ms, so no human
 * reaches a Settings toggle inside it. The routes that do are all
 * non-manual — hot-reload/BRAT, another plugin calling `disablePlugin`, and
 * this project's own documented dev loop, `Obsidian.com plugin:reload
 * id=spaces`. That last one hits it on every iteration, which is why it is
 * worth closing.
 *
 * Layer 1: the real `SpaceController` against fakes, with the
 * transition parked on a promise the test releases, so the cancellation
 * genuinely lands mid-flight. A fake that resolved synchronously would pass
 * against the unfixed code.
 */

import { describe, expect, it, vi } from "vitest";
import { SpaceController } from "../src/controller/SpaceController";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { buildFakeVault } from "./helpers/fakeVault";
import { SCHEMA_VERSION } from "../src/types";
import type { ActiveSelection, SwitchOutcome } from "../src/types";

const vault = buildFakeVault({
  Papers: "folder",
  "Papers/A.md": "file",
  "Recipes.md": "file",
});

const ALL: ActiveSelection = { kind: "all" };
const RESEARCH: ActiveSelection = { kind: "space", id: "research" };

function definitions() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { globalIgnore: [], restoreLayouts: true },
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
}

async function base() {
  let stored: unknown = definitions();
  const store = new DefinitionStore({
    read: async () => stored,
    write: async (d) => {
      stored = d;
    },
  });
  await store.load();
  const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
  rt.load();
  const apply = vi.fn();
  return { store, rt, apply, host: { apply, livePaths: () => new Set<string>() } };
}

/** Let the queued closure start and reach the await inside `transition`. */
async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("a switch parked on an await must not outlive unload", () => {
  it("runs none of the host rebind, the commit, or the recompute after dispose()", async () => {
    const { store, rt, apply, host } = await base();
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onOutcome = vi.fn();
    const controller = new SpaceController(store, rt, vault, host, createMapTagIndex(new Map()), {
      transition: async (): Promise<SwitchOutcome> => {
        await parked;
        return { kind: "restored" };
      },
      onOutcome,
    });

    const inFlight = controller.switchTo(RESEARCH);
    await settleMicrotasks();
    apply.mockClear();

    // The plugin is disabled while the restore is still parked.
    controller.dispose();
    release();
    await inFlight;

    // `onOutcome` is the host rebinding the explorer — the re-patch that
    // leaves a disabled plugin's filter on the tree.
    expect(onOutcome).not.toHaveBeenCalled();
    // Nothing committed: the selection is still whatever it was before.
    expect(rt.getSelection()).toEqual(ALL);
    // No snapshot re-applied to a tree the teardown has already cleaned.
    expect(apply).not.toHaveBeenCalled();
  });

  it("is idempotent, and a switch issued after dispose() does no work at all", async () => {
    const { store, rt, apply, host } = await base();
    const transition = vi.fn(async (): Promise<SwitchOutcome> => ({ kind: "restored" }));
    const controller = new SpaceController(
      store,
      rt,
      vault,
      host,
      createMapTagIndex(new Map()),
      { transition }
    );

    controller.dispose();
    controller.dispose();
    apply.mockClear();
    await controller.switchTo(RESEARCH);

    expect(transition).not.toHaveBeenCalled();
    expect(rt.getSelection()).toEqual(ALL);
    expect(apply).not.toHaveBeenCalled();
  });

  it("ignores refresh() and onActiveFileChanged() after dispose()", async () => {
    // The switch guards above cover the parked-await route. These are the
    // other way into `recompute`: host-driven entry points. Obsidian removes
    // the listeners that call them on unload, so this is defence in depth
    // rather than an observed route — but an untested guard is exactly the
    // kind of decoration this project has shipped before, so it is pinned
    // here rather than trusted.
    const { store, rt, apply, host } = await base();
    const controller = new SpaceController(store, rt, vault, host, createMapTagIndex(new Map()), {
      transition: async (): Promise<SwitchOutcome> => ({ kind: "restored" }),
    });
    await controller.switchTo(RESEARCH);

    controller.dispose();
    apply.mockClear();
    controller.refresh();
    controller.onActiveFileChanged("Recipes.md");

    expect(apply).not.toHaveBeenCalled();
  });

  it("still completes a switch that finishes BEFORE dispose(), so the guard is not just a no-op", async () => {
    // The discriminator: without it, a test asserting "nothing happened after
    // dispose" would also pass against a controller that never works at all.
    const { store, rt, apply, host } = await base();
    const onOutcome = vi.fn();
    const controller = new SpaceController(store, rt, vault, host, createMapTagIndex(new Map()), {
      transition: async (): Promise<SwitchOutcome> => ({ kind: "restored" }),
      onOutcome,
    });

    apply.mockClear();
    await controller.switchTo(RESEARCH);

    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(rt.getSelection()).toEqual(RESEARCH);
    expect(apply).toHaveBeenCalled();
  });
});
