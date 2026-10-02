/**
 * The space-switch pipeline used to read the selection
 * BEFORE its own serialization queue and commit it regardless of the
 * transition's outcome.
 *
 * Layer 1: `SpaceController` and `LayoutCoordinator` are pure, so the
 * real coordinator runs here against a fake `WorkspaceLayoutPort` and no
 * `"obsidian"` import is needed. Every test below gates the first restore on a
 * promise the test resolves, so the second activation genuinely lands while
 * the first is parked on an `await` — the ordering IS the bug, and a fake that
 * resolved synchronously would pass against the unfixed code.
 */

import { describe, expect, it, vi } from "vitest";
import { SpaceController } from "../src/controller/SpaceController";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { LayoutCoordinator } from "../src/layout/LayoutCoordinator";
import { sameSelection } from "../src/order/sortOverride";
import { buildFakeVault } from "./helpers/fakeVault";
import { SCHEMA_VERSION } from "../src/types";
import type { ActiveSelection, LayoutBlob, SwitchOutcome } from "../src/types";

const vault = buildFakeVault({
  Papers: "folder",
  "Papers/A.md": "file",
  Ledger: "folder",
  "Ledger/B.md": "file",
  "Recipes.md": "file",
});

const ALL: ActiveSelection = { kind: "all" };
const RESEARCH: ActiveSelection = { kind: "space", id: "research" };
const LEDGER: ActiveSelection = { kind: "space", id: "ledger" };

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
      {
        id: "ledger",
        name: "Ledger",
        icon: "book",
        color: "#5b5bff",
        members: [{ path: "Ledger", kind: "folder" }],
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

/** Let a queued closure start and reach the await inside `transition`. */
async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("switch serialization and outcome", () => {
  it("a second same-target activation does not overwrite the target's saved layout with the pruned blob changeLayout produced", async () => {
    // V2's failure-free route. No restore has to fail: the second run is a
    // `transition(B, B)`, whose unconditional capture reads what
    // `changeLayout()` actually built — which drops leaves it could not
    // resolve (Spike B F20) — and writes that back over B's saved layout.
    const { store, rt, host } = await base();
    const SAVED: LayoutBlob = { main: "RESEARCH", leaves: ["Papers/A.md", "Recipes.md"] };
    const PRUNED: LayoutBlob = { main: "RESEARCH", leaves: ["Papers/A.md"] };
    rt.setLayoutFor(RESEARCH, SAVED);

    let live: LayoutBlob = { main: "ALL", leaves: ["Recipes.md"] };
    let captures = 0;
    let restores = 0;
    let releaseFirstRestore!: () => void;
    const firstRestore = new Promise<void>((resolve) => {
      releaseFirstRestore = resolve;
    });
    const coord = new LayoutCoordinator(
      {
        capture: () => {
          captures++;
          return live;
        },
        restore: async (l: LayoutBlob) => {
          restores++;
          // Only the FIRST restore is parked, so the second activation is
          // issued while run 1 sits inside its await.
          if (restores === 1) await firstRestore;
          live = l === SAVED ? PRUNED : l;
        },
        mainLeafCount: () => 2,
      },
      rt
    );
    const controller = new SpaceController(store, rt, vault, host, createMapTagIndex(new Map()), {
      transition: (from, to) => coord.transition(from, to, true),
    });

    const first = controller.switchTo(RESEARCH);
    await settleMicrotasks();
    const second = controller.switchTo(RESEARCH); // OS key repeat / double click
    releaseFirstRestore();
    await Promise.all([first, second]);

    expect(rt.getLayoutFor(RESEARCH)).toEqual(SAVED);
    // One transition per two same-target switches (the review's assertion).
    expect(captures).toBe(1);
    expect(restores).toBe(1);
  });

  it("a switch back to the pre-switch selection during an in-flight switch is honoured, not dropped", async () => {
    // The user is in All, clicks Research, then clicks All again before the
    // transition resolves. The idempotence check used to read the
    // pre-commit selection, so this second click compared All against All and
    // was silently dropped — the user landed in Research.
    const { store, rt, host } = await base();
    const seen: Array<{ from: ActiveSelection; to: ActiveSelection }> = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const controller = new SpaceController(store, rt, vault, host, createMapTagIndex(new Map()), {
      transition: async (from, to): Promise<SwitchOutcome> => {
        seen.push({ from, to });
        if (seen.length === 1) await gate;
        return { kind: "restored" };
      },
    });

    const first = controller.switchTo(RESEARCH);
    await settleMicrotasks();
    const back = controller.switchTo(ALL);
    releaseFirst();
    await Promise.all([first, back]);

    expect(rt.getSelection()).toEqual(ALL);
    expect(seen).toEqual([
      { from: ALL, to: RESEARCH },
      { from: RESEARCH, to: ALL },
    ]);
  });

  it("does not commit the selection when the restore rolled back", async () => {
    // The outgoing workspace is what is on screen after a rollback. Committing
    // the target anyway means the NEXT departure captures the outgoing
    // workspace into the target's slot.
    const { store, rt, host, apply } = await base();
    const controller = new SpaceController(store, rt, vault, host, createMapTagIndex(new Map()), {
      transition: async (): Promise<SwitchOutcome> => ({
        kind: "rolled-back",
        reason: "restore produced an empty workspace",
      }),
    });

    await controller.switchTo(RESEARCH);

    expect(rt.getSelection()).toEqual(ALL);
    // The tree filter is never blocked by a layout failure.
    expect(apply).toHaveBeenCalled();
  });

  it("does not commit the selection when neither the restore nor the rollback worked", async () => {
    const { store, rt, host, apply } = await base();
    const controller = new SpaceController(store, rt, vault, host, createMapTagIndex(new Map()), {
      transition: async (): Promise<SwitchOutcome> => ({
        kind: "failed-open",
        reason: "boom; rollback: boom",
      }),
    });

    await controller.switchTo(RESEARCH);

    expect(rt.getSelection()).toEqual(ALL);
    expect(apply).toHaveBeenCalled();
  });

  it("reports a rejected transition to the host, so refusing to commit is not a silent no-op", async () => {
    // Gating the commit on the outcome (above) would otherwise turn a
    // partly-visible failure into an invisible one: a rejected `transition`
    // produced no outcome, so nothing reached `onOutcome`, nothing reached
    // `reportLayoutOutcome`, and the user clicked a space and saw literally
    // nothing happen. The controller synthesizes an outcome for the throw so
    // the host can say the switch did not occur (report, never block).
    const { store, rt, host, apply } = await base();
    const seen: Array<{ kind: string; reason?: string }> = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const controller = new SpaceController(store, rt, vault, host, createMapTagIndex(new Map()), {
      transition: async (): Promise<SwitchOutcome> => {
        throw new Error("changeLayout blew up");
      },
      onOutcome: (outcome) => {
        seen.push(outcome);
      },
    });

    await controller.switchTo(RESEARCH);

    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("aborted");
    expect(String(seen[0].reason)).toContain("changeLayout blew up");
    // Still uncommitted, and the tree filter still ran.
    expect(rt.getSelection()).toEqual(ALL);
    expect(apply).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("still commits on every outcome that left the target's layout on screen", async () => {
    // The guard above must not over-correct: restored, adopted and skipped all
    // mean the switch happened.
    for (const outcome of [
      { kind: "restored" },
      { kind: "adopted" },
      { kind: "skipped" },
    ] as SwitchOutcome[]) {
      const { store, rt, host } = await base();
      const controller = new SpaceController(
        store,
        rt,
        vault,
        host,
        createMapTagIndex(new Map()),
        {
          transition: async (): Promise<SwitchOutcome> => outcome,
        }
      );
      await controller.switchTo(RESEARCH);
      expect(rt.getSelection()).toEqual(RESEARCH);
    }
  });

  it("two rapid cycle presses advance two spaces, not one plus a self-transition", async () => {
    // `cycle()` in main.ts resolves its target through this overload, so the
    // index it reads is the COMMITTED selection rather than the one the first
    // press has not finished writing.
    const { store, rt, host } = await base();
    const order: ActiveSelection[] = [ALL, RESEARCH, LEDGER];
    const nextSpace = (current: ActiveSelection): ActiveSelection => {
      const i = order.findIndex((o) => sameSelection(o, current));
      return order[(i + 1 + order.length) % order.length];
    };
    const seen: Array<{ from: ActiveSelection; to: ActiveSelection }> = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const controller = new SpaceController(store, rt, vault, host, createMapTagIndex(new Map()), {
      transition: async (from, to): Promise<SwitchOutcome> => {
        seen.push({ from, to });
        if (seen.length === 1) await gate;
        return { kind: "restored" };
      },
    });

    const first = controller.switchTo(nextSpace);
    await settleMicrotasks();
    const second = controller.switchTo(nextSpace);
    releaseFirst();
    await Promise.all([first, second]);

    expect(rt.getSelection()).toEqual(LEDGER);
    expect(seen).toEqual([
      { from: ALL, to: RESEARCH },
      { from: RESEARCH, to: LEDGER },
    ]);
  });
});
