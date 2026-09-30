import { describe, expect, it, vi } from "vitest";
import { SpaceController } from "../src/controller/SpaceController";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { buildFakeVault } from "./helpers/fakeVault";
import { createLazyTagIndex, createMapTagIndex } from "../src/visibility/TagIndex";
import { SCHEMA_VERSION, type MemberEntry } from "../src/types";
import type { SwitchOutcome } from "../src/types";
import { createSpace } from "../src/actions/spaceLifecycle";

const vault = buildFakeVault({
  Papers: "folder",
  "Papers/A.md": "file",
  "Recipes.md": "file",
});

function defs() {
  return {
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
}

async function build() {
  let stored: unknown = defs();
  const store = new DefinitionStore({
    read: async () => stored,
    write: async (d) => {
      stored = d;
    },
  });
  await store.load();
  const runtime = new RuntimeStateStore({ get: () => null, set: () => undefined });
  runtime.load();
  const apply = vi.fn();
  const controller = new SpaceController(
    store,
    runtime,
    vault,
    {
      apply,
      livePaths: () => new Set<string>(),
    },
    createMapTagIndex(new Map())
  );
  return { controller, apply, store, runtime };
}

describe("SpaceController", () => {
  it("starts in All and applies no filtering", async () => {
    const { controller, apply } = await build();
    controller.refresh();
    expect(controller.currentSnapshot()).toBeNull();
    expect(apply).toHaveBeenCalledWith(null);
  });

  it("switching to a space applies a snapshot", async () => {
    const { controller, apply } = await build();
    await controller.switchTo({ kind: "space", id: "research" });
    const snap = controller.currentSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.decisionFor("Papers/A.md").visible).toBe(true);
    expect(snap!.decisionFor("Recipes.md").visible).toBe(false);
    expect(apply).toHaveBeenLastCalledWith(snap);
  });

  it("ignores a switch to the already active selection", async () => {
    const { controller, apply } = await build();
    await controller.switchTo({ kind: "space", id: "research" });
    const calls = apply.mock.calls.length;
    await controller.switchTo({ kind: "space", id: "research" });
    expect(apply.mock.calls.length).toBe(calls);
  });

  it("falls back to All when the active space no longer exists", async () => {
    const { controller, store } = await build();
    await controller.switchTo({ kind: "space", id: "research" });
    await store.mutate((d) => {
      d.spaces = [];
    });
    controller.refresh();
    expect(controller.currentSnapshot()).toBeNull();
    expect(controller.activeSpace()).toBeNull();
  });

  it("persists the selection", async () => {
    const { controller, runtime } = await build();
    await controller.switchTo({ kind: "space", id: "research" });
    expect(runtime.getSelection()).toEqual({ kind: "space", id: "research" });
  });

  it("serializes rapid switches and ends on the last target", async () => {
    const { controller, store } = await build();
    await store.mutate((d) => {
      d.spaces.push({
        id: "work",
        name: "Work",
        icon: "briefcase",
        color: "#5b5bff",
        members: [{ path: "Recipes.md", kind: "file" }],
      });
    });
    await Promise.all([
      controller.switchTo({ kind: "space", id: "research" }),
      controller.switchTo({ kind: "space", id: "work" }),
    ]);
    expect(controller.activeSpace()?.id).toBe("work");
  });

  it("recomputes against a replaced vault index", async () => {
    const { controller } = await build();
    await controller.switchTo({ kind: "space", id: "research" });
    expect(controller.currentSnapshot()!.decisionFor("Papers/A.md").visible).toBe(true);

    // The member folder no longer exists in the new index.
    controller.setVaultIndex(buildFakeVault({ "Recipes.md": "file" }));
    controller.refresh();
    expect(controller.currentSnapshot()!.decisionFor("Papers/A.md").visible).toBe(false);
  });

  it("asks the layout hooks to transition on a switch, with from and to", async () => {
    const calls: Array<{ from: unknown; to: unknown }> = [];
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: () => undefined, livePaths: () => new Set<string>() },
      createMapTagIndex(new Map()),
      {
        transition: async (from, to): Promise<SwitchOutcome> => {
          calls.push({ from, to });
          return { kind: "skipped" };
        },
      }
    );

    await controller.switchTo({ kind: "space", id: "research" });

    expect(calls).toHaveLength(1);
    expect(calls[0].from).toEqual({ kind: "all" });
    expect(calls[0].to).toEqual({ kind: "space", id: "research" });
  });

  it("commits the selection only after the transition resolves", async () => {
    let seenDuring: unknown = null;
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: () => undefined, livePaths: () => new Set<string>() },
      createMapTagIndex(new Map()),
      {
        transition: async (): Promise<SwitchOutcome> => {
          seenDuring = rt.getSelection();
          return { kind: "skipped" };
        },
      }
    );

    await controller.switchTo({ kind: "space", id: "research" });

    expect(seenDuring).toEqual({ kind: "all" });
    expect(rt.getSelection()).toEqual({ kind: "space", id: "research" });
  });

  it("calls host.apply only AFTER the new selection is committed", async () => {
    // This is the premise the whole ordering feature rests on. The
    // whole-slice review found a Critical because `main.ts` hung its re-sort
    // off `onOutcome`, which runs BEFORE `setSelection` — so a switch sorted
    // the tree with the OUTGOING space's order. `host.apply` is the hook that
    // is safe, and this test is what stops that from silently changing.
    const seen: unknown[] = [];
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => {
        stored = d;
      },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const controller = new SpaceController(
      store,
      rt,
      vault,
      {
        apply: () => {
          seen.push(rt.getSelection());
        },
        livePaths: () => new Set<string>(),
      },
      createMapTagIndex(new Map()),
      {
        transition: async (): Promise<SwitchOutcome> => ({ kind: "skipped" }),
      }
    );

    await controller.switchTo({ kind: "space", id: "research" });

    expect(seen.length).toBeGreaterThan(0);
    // Every apply during the switch sees the new selection, not the old one.
    for (const sel of seen) expect(sel).toEqual({ kind: "space", id: "research" });
  });

  it("calls host.apply even when the layout transition is skipped", async () => {
    // The second half of the same Critical: with `restoreLayouts` off the
    // outcome is "skipped", so anything hanging off `onOutcome`'s non-skipped
    // branch never runs. `host.apply` must still fire, or a switch with
    // restoration off would not re-sort at all.
    let applied = 0;
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => {
        stored = d;
      },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const controller = new SpaceController(
      store,
      rt,
      vault,
      {
        apply: () => {
          applied++;
        },
        livePaths: () => new Set<string>(),
      },
      createMapTagIndex(new Map()),
      { transition: async (): Promise<SwitchOutcome> => ({ kind: "skipped" }) }
    );

    await controller.switchTo({ kind: "space", id: "research" });
    expect(applied).toBeGreaterThan(0);
  });

  it("still switches when there are no layout hooks at all", async () => {
    const { controller } = await build();
    await controller.switchTo({ kind: "space", id: "research" });
    expect(controller.activeSpace()?.id).toBe("research");
  });

  // Changed the expectation here, deliberately. A rejected transition
  // never got the target's layout onto the screen, so committing the target
  // would leave the selection describing a workspace that is not there — and
  // the next departure would capture the OUTGOING workspace into the target's
  // slot. A layout failure must not block the tree
  // filter, and it still does not: the recompute runs, against the selection
  // that is actually on screen.
  it("does not commit the selection when transition rejects, but still recomputes", async () => {
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const apply = vi.fn();
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply, livePaths: () => new Set<string>() },
      createMapTagIndex(new Map()),
      {
        transition: async (): Promise<SwitchOutcome> => {
          throw new Error("boom");
        },
      }
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await controller.switchTo({ kind: "space", id: "research" });

    expect(rt.getSelection()).toEqual({ kind: "all" });
    expect(controller.activeSpace()).toBeNull();
    // The filter pipeline ran anyway — All applies a null snapshot.
    expect(apply).toHaveBeenCalledWith(null);
    errorSpy.mockRestore();
  });

  it("still commits the selection and recomputes when onOutcome throws", async () => {
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const apply = vi.fn();
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply, livePaths: () => new Set<string>() },
      createMapTagIndex(new Map()),
      {
        transition: async (): Promise<SwitchOutcome> => ({ kind: "skipped" }),
        onOutcome: () => {
          throw new Error("boom");
        },
      }
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await controller.switchTo({ kind: "space", id: "research" });

    expect(rt.getSelection()).toEqual({ kind: "space", id: "research" });
    expect(controller.activeSpace()?.id).toBe("research");
    expect(controller.currentSnapshot()).not.toBeNull();
    expect(apply).toHaveBeenCalledWith(controller.currentSnapshot());
    errorSpy.mockRestore();
  });

  it("suppresses refresh() while a switch's transition is in flight, but still ends up correct", async () => {
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const apply = vi.fn();
    let releaseTransition!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply, livePaths: () => new Set<string>() },
      createMapTagIndex(new Map()),
      {
        transition: async (): Promise<SwitchOutcome> => {
          await gate;
          return { kind: "skipped" };
        },
      }
    );

    const switching = controller.switchTo({ kind: "space", id: "research" });
    // Let switchTo's queued run start and reach the await inside transition
    // before touching refresh() — otherwise this would race the guard being
    // set at all.
    await Promise.resolve();
    await Promise.resolve();

    const callsWhileSwitching = apply.mock.calls.length;
    controller.refresh();
    expect(apply.mock.calls.length).toBe(callsWhileSwitching);

    releaseTransition();
    await switching;

    // The guard suppressed the reentrant recompute rather than losing it:
    // switchTo's own post-commit recompute still lands the correct snapshot.
    expect(controller.activeSpace()?.id).toBe("research");
    expect(controller.currentSnapshot()!.decisionFor("Papers/A.md").visible).toBe(true);
    expect(apply).toHaveBeenLastCalledWith(controller.currentSnapshot());
  });

  it("clears the switching guard when the transition rejects, so a later refresh() still works", async () => {
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const apply = vi.fn();
    // The rejection must be GATED. Awaiting switchTo() to completion first
    // would leave the guard already down, so both a guarded and an unguarded
    // implementation would pass — the assertion has to straddle the moment
    // the transition is still pending.
    let rejectTransition!: (e: Error) => void;
    const gate = new Promise<SwitchOutcome>((_resolve, reject) => {
      rejectTransition = reject;
    });
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply, livePaths: () => new Set<string>() },
      createMapTagIndex(new Map()),
      { transition: () => gate }
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const switching = controller.switchTo({ kind: "space", id: "research" });
    await Promise.resolve();
    await Promise.resolve();

    // Suppressed while the transition is pending.
    const callsWhilePending = apply.mock.calls.length;
    controller.refresh();
    expect(apply.mock.calls.length).toBe(callsWhilePending);

    rejectTransition(new Error("boom"));
    await switching;

    // And released once it rejected: the flag comes down in `finally`, not on
    // the happy path only.
    const callsAfterReject = apply.mock.calls.length;
    controller.refresh();
    expect(apply.mock.calls.length).toBe(callsAfterReject + 1);
    errorSpy.mockRestore();
  });

  it("keeps a revealed path visible across a switch that restores a layout", async () => {
    // The exact sequence a user reported: open a file in All, switch into a
    // space, expect it dimmed rather than gone. The restore closes the tab, so
    // a derived visitor set would lose it here.
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const apply = vi.fn();
    let live = new Set<string>(["Recipes.md"]);
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply, livePaths: () => live },
      createMapTagIndex(new Map()),
      {
        transition: async (): Promise<SwitchOutcome> => {
          // changeLayout() replaced the workspace: the revealed file is gone
          // and the space's own tab is open instead.
          live = new Set<string>(["Papers/A.md"]);
          return { kind: "restored" };
        },
      }
    );

    controller.onFileOpened("Recipes.md");
    await controller.switchTo({ kind: "space", id: "research" });

    const snap = controller.currentSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.decisionFor("Recipes.md").visible).toBe(true);
    expect(snap!.decisionFor("Recipes.md").reason).toBe("visitor");

    // `pruneClosed: false` protects only the
    // switch's own post-commit recompute. The very next ORDINARY refresh()
    // (exactly what main.ts's file-open/layout-change/defs listeners trigger
    // with no user action at all) must not delete the path merely because
    // spaces's own restore is still the reason it is off `live`.
    controller.refresh();
    const after = controller.currentSnapshot();
    expect(after!.decisionFor("Recipes.md").visible).toBe(true);
    expect(after!.decisionFor("Recipes.md").reason).toBe("visitor");
  });

  // A restoring sync that sees a path in BOTH `dismissed` and `livePaths`
  // clears the dismissal, because spaces put the tab back and the
  // dismissal is therefore stale: dismiss a file in All, switch to a space
  // whose stored layout contains it, and the restore puts the tab back.
  // Leaving the un-dismiss dropped inside the `switching` guard would give
  // `visible: false` for a file open in front of the user, with no row to
  // reach for if it is the active leaf — the hiding-a-real-file failure
  // that must never happen. "spaces's own actions must not mutate
  // spaces's own bookkeeping" still holds for the case it was written
  // about — see the next test, where the restore-driven open names a path
  // the leaf walk does not see.
  //
  // Scope, stated honestly: the wipe fires on ANY restoring sync while the
  // path is live — `live` never changes in this test, and no sync observes
  // the intermediate closed state, so "the restore reopened it" and "the
  // restore never closed it" are indistinguishable at this interface.
  // Narrowing this further needs the coordinator to report what it closed.
  it("clears a dismissal for a path that is live at a restoring switch", async () => {
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const live = new Set<string>(["Recipes.md"]);
    let controller!: SpaceController;
    controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map()),
      {
        transition: async (): Promise<SwitchOutcome> => {
          // Simulates the restore reopening the dismissed path and main.ts's
          // file-open listener firing for it, all while the switch is in
          // flight.
          controller.onFileOpened("Recipes.md");
          return { kind: "restored" };
        },
      }
    );

    controller.onFileOpened("Recipes.md");
    controller.dismissRevealed("Recipes.md");

    await controller.switchTo({ kind: "space", id: "research" });

    const snap = controller.currentSnapshot()!;
    expect(snap.decisionFor("Recipes.md").visible).toBe(true);
    expect(snap.decisionFor("Recipes.md").reason).toBe("visitor");
  });

  it("a restore-driven file-open the leaf walk cannot see does not erase a dismissal", async () => {
    // `livePaths()` is narrower than Obsidian's `file-open` — it excludes
    // sidebar and pop-out leaves — so a restore-driven open can name a path
    // the walk never reports. Nothing then proves spaces put a tab back,
    // so an explicit "Stop showing here" must stand.
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const live = new Set<string>(["Papers/A.md"]);
    let controller!: SpaceController;
    controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map()),
      {
        transition: async (): Promise<SwitchOutcome> => {
          controller.onFileOpened("Recipes.md");
          return { kind: "restored" };
        },
      }
    );

    controller.onFileOpened("Recipes.md");
    controller.dismissRevealed("Recipes.md");

    await controller.switchTo({ kind: "space", id: "research" });

    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(false);
  });

  it("drops a revealed path once the user actually closes it", async () => {
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    let live = new Set<string>(["Recipes.md"]);
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map())
    );
    await controller.switchTo({ kind: "space", id: "research" });
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(true);

    live = new Set<string>();
    controller.refresh();
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(false);
  });

  it("reveals nothing when revealVisitors is off, and changes nothing else", async () => {
    let stored: unknown = { ...defs(), settings: { globalIgnore: [], restoreLayouts: true, revealVisitors: false } };
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: vi.fn(), livePaths: () => new Set(["Recipes.md"]) },
      createMapTagIndex(new Map())
    );
    await controller.switchTo({ kind: "space", id: "research" });
    const snap = controller.currentSnapshot()!;
    expect(snap.decisionFor("Recipes.md").visible).toBe(false);
    // Members are untouched.
    expect(snap.decisionFor("Papers").visible).toBe(true);
  });

  it("dismissRevealed hides a revealed path that is still open", async () => {
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: vi.fn(), livePaths: () => new Set(["Recipes.md"]) },
      createMapTagIndex(new Map())
    );
    await controller.switchTo({ kind: "space", id: "research" });
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(true);

    controller.dismissRevealed("Recipes.md");
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(false);
  });

  // A reveal from one space must not follow the user into every later
  // space, so carried reveals expire. A visitor is a path open in a
  // qualifying leaf; nothing was open here.
  it("does not carry a reveal into a space where it was never opened", async () => {
    const twoSpaceVault = buildFakeVault({
      Papers: "folder",
      "Papers/A.md": "file",
      "Ledger.md": "file",
      "Recipes.md": "file",
    });
    let stored: unknown = {
      schemaVersion: SCHEMA_VERSION,
      settings: { globalIgnore: [], restoreLayouts: true },
      spaces: [
        { id: "research", name: "Research", icon: "microscope", color: "#4ecdc4", members: [{ path: "Papers", kind: "folder" }] },
        { id: "ledger", name: "Ledger", icon: "coins", color: "#ffd166", members: [{ path: "Ledger.md", kind: "file" }] },
      ],
    };
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    let live = new Set<string>(["Recipes.md"]);
    const controller = new SpaceController(
      store,
      rt,
      twoSpaceVault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map()),
      {
        transition: async (_from, to): Promise<SwitchOutcome> => {
          // Each restore replaces the workspace with the target's own tabs.
          live = new Set<string>([
            to.kind === "space" && to.id === "ledger" ? "Ledger.md" : "Papers/A.md",
          ]);
          return { kind: "restored" };
        },
      }
    );

    controller.onFileOpened("Recipes.md");
    await controller.switchTo({ kind: "space", id: "research" });
    // The reveal survives the restore that closed it, for this visit.
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").reason).toBe("visitor");

    await controller.switchTo({ kind: "space", id: "ledger" });
    controller.refresh();
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(false);
  });

  it("does not resurrect a removed member as a visitor with nothing open", async () => {
    let stored: unknown = { ...defs(), settings: { globalIgnore: [], restoreLayouts: true } };
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    let live = new Set<string>(["Recipes.md"]);
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map()),
      {
        transition: async (): Promise<SwitchOutcome> => {
          live = new Set<string>(["Papers/A.md"]);
          return { kind: "restored" };
        },
      }
    );

    controller.onFileOpened("Recipes.md");
    await controller.switchTo({ kind: "space", id: "research" });
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").reason).toBe("visitor");

    // Add to Research, then Remove from Research, with no tab open anywhere.
    await store.mutate((d) => {
      d.spaces[0].members.push({ path: "Recipes.md", kind: "file" });
    });
    controller.refresh();
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").reason).toBe("exact-member");

    await store.mutate((d) => {
      d.spaces[0].members = d.spaces[0].members.filter(
        (m) => m.kind === "tag" || m.path !== "Recipes.md"
      );
    });
    controller.refresh();
    // "Remove from space" must actually remove the row: no leaf backs it.
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(false);
  });

  // `Recipes.md` is an exact member of Research, so precedence returns
  // `exact-member` whether or not `forget()` ever touches it — the FIRST
  // assertion below cannot tell a live-member gate being present from it
  // being deleted. What that gate actually does: a deliberate reveal keeps
  // its provenance through a space where it is a live member, because
  // `forget()` clears `RevealedSet`'s `deliberate` flag. That is pinned by
  // the separate test below: "a deliberate reveal survives being a live
  // member of one space, then a restore that closes it in the next (R1
  // provenance)". This test's remaining job is the SECOND block: a
  // self-healed (non-deliberate) reveal that was a live member here does
  // not resurface as a visitor once a different space's restore closes it.
  //
  // `Recipes.md` is revealed here only because `sync` saw it backing a live
  // leaf while it was a member of Research — it is never opened by the
  // user in this test (no `noteOpened` call). A visitor is a path open in
  // a qualifying leaf, and once Ledger's own restore closes the tab it is
  // open nowhere, so it must not remain a visitor. A reveal that was never
  // deliberate earns no carry past that close — the carry exists for a
  // file the user opened, not as a general amnesty for anything a restore
  // happens to touch.
  it("a live member's tab, once its own space's restore closes it, is pruned in the next space rather than shown as a visitor", async () => {
    const twoSpaceVault = buildFakeVault({
      Papers: "folder",
      "Papers/A.md": "file",
      "Ledger.md": "file",
      "Recipes.md": "file",
    });
    let stored: unknown = {
      schemaVersion: SCHEMA_VERSION,
      settings: { globalIgnore: [], restoreLayouts: true },
      spaces: [
        {
          id: "research",
          name: "Research",
          icon: "microscope",
          color: "#4ecdc4",
          // Recipes.md is an exact member HERE and nowhere else.
          members: [{ path: "Papers", kind: "folder" }, { path: "Recipes.md", kind: "file" }],
        },
        { id: "ledger", name: "Ledger", icon: "coins", color: "#ffd166", members: [{ path: "Ledger.md", kind: "file" }] },
      ],
    };
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    // Open in Research and STILL OPEN there: the restore keeps its own tab.
    let live = new Set<string>(["Recipes.md"]);
    const controller = new SpaceController(
      store,
      rt,
      twoSpaceVault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map()),
      {
        transition: async (_from, to): Promise<SwitchOutcome> => {
          // Ledger's restore closes it; Research's keeps it.
          live = new Set<string>(
            to.kind === "space" && to.id === "ledger" ? ["Ledger.md"] : ["Recipes.md"]
          );
          return { kind: "restored" };
        },
      }
    );

    await controller.switchTo({ kind: "space", id: "research" });
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").reason).toBe("exact-member");

    await controller.switchTo({ kind: "space", id: "ledger" });
    // No refresh() first: the immediate post-switch frame must already show
    // this pruned. The frame the switch renders must never show the
    // outgoing space's leftover reveal, even for one tick — pruning it only
    // on a later recompute is not enough.
    const snap = controller.currentSnapshot()!;
    // `reason` too, not just `visible` — a bare `visible: false` check would
    // also pass on `hidden-ignore`, which is not what this test claims.
    expect(snap.decisionFor("Recipes.md").visible).toBe(false);
    expect(snap.decisionFor("Recipes.md").reason).toBe("hidden-nonmember");
  });

  // The gate's job: `RevealedSet.forget()` clears `deliberate` (it must —
  // see its own comment), so a DELIBERATE reveal that becomes a live member
  // of some space would lose its provenance marking if the gate below did
  // not skip it while live. Without the gate: deliberate open in *All*,
  // then a space where the file is a live exact member, then a DIFFERENT
  // space whose restore closes it — comes back `hidden-nonmember` instead
  // of `visitor`, because the test above never covers a member that is
  // ALSO deliberate.
  it("a deliberate reveal survives being a live member of one space, then a restore that closes it in the next (R1 provenance)", async () => {
    const vaultWithMember = buildFakeVault({
      Papers: "folder",
      "Papers/A.md": "file",
      "Ledger.md": "file",
      "Recipes.md": "file",
    });
    let stored: unknown = {
      schemaVersion: SCHEMA_VERSION,
      settings: { globalIgnore: [], restoreLayouts: true },
      spaces: [
        {
          id: "research",
          name: "Research",
          icon: "microscope",
          color: "#4ecdc4",
          // Recipes.md is an exact member HERE and nowhere else.
          members: [{ path: "Papers", kind: "folder" }, { path: "Recipes.md", kind: "file" }],
        },
        { id: "ledger", name: "Ledger", icon: "coins", color: "#ffd166", members: [{ path: "Ledger.md", kind: "file" }] },
      ],
    };
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    // Deliberately opened in *All*, before any space is active.
    let live = new Set<string>(["Recipes.md"]);
    const controller = new SpaceController(
      store,
      rt,
      vaultWithMember,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map()),
      {
        transition: async (_from, to): Promise<SwitchOutcome> => {
          // Research's restore keeps Recipes.md's tab (it is a member and
          // still open there); Ledger's restore closes it.
          live = new Set<string>(
            to.kind === "space" && to.id === "ledger" ? ["Ledger.md"] : ["Recipes.md"]
          );
          return { kind: "restored" };
        },
      }
    );

    controller.onFileOpened("Recipes.md"); // deliberate, while still in *All*
    await controller.switchTo({ kind: "space", id: "research" });
    // Live AND a member: reason is exact-member either way (precedence), so
    // this alone proves nothing about the gate.
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").reason).toBe("exact-member");

    await controller.switchTo({ kind: "space", id: "ledger" });
    // Immediate frame, no refresh() first.
    const snap2 = controller.currentSnapshot()!;
    expect(snap2.decisionFor("Recipes.md").visible).toBe(true);
    expect(snap2.decisionFor("Recipes.md").reason).toBe("visitor");
  });

  // Entry into the revealed set is ungated by `revealVisitors`, so the
  // membership exit must be too — the setting "does not change what a
  // space contains, only what a space shows". Gating the exit on
  // `visitors` would let the whole add/remove journey run with the exit
  // disabled, and turning the setting back on would then resurface the
  // stale membership through a supported setting.
  it("forgets a path that becomes a member even while revealVisitors is off", async () => {
    let stored: unknown = {
      ...defs(),
      settings: { globalIgnore: [], restoreLayouts: true, revealVisitors: false },
    };
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    let live = new Set<string>(["Recipes.md"]);
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map()),
      {
        transition: async (): Promise<SwitchOutcome> => {
          live = new Set<string>(["Papers/A.md"]);
          return { kind: "restored" };
        },
      }
    );

    // Entry is ungated: the path enters `revealed` with the setting off, and
    // the switch's restore carries it.
    controller.onFileOpened("Recipes.md");
    await controller.switchTo({ kind: "space", id: "research" });

    await store.mutate((d) => {
      d.spaces[0].members.push({ path: "Recipes.md", kind: "file" });
    });
    controller.refresh();
    await store.mutate((d) => {
      d.spaces[0].members = d.spaces[0].members.filter(
        (m) => m.kind === "tag" || m.path !== "Recipes.md"
      );
    });
    controller.refresh();

    // Now the user turns visitors back on. Nothing is open, and the path is
    // no longer a member, so there must be no row.
    await store.mutate((d) => {
      d.settings.revealVisitors = true;
    });
    controller.refresh();
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(false);
  });

  it("the visible set is identical whether a layout hook runs or not", async () => {
    // Same space, same revealed set, restoration on vs off. The visible
    // rows must not differ. With restoration "on" the transition also swaps the
    // live leaves, which is exactly the perturbation that must not matter.
    const build = async (withLayout: boolean) => {
      let stored: unknown = defs();
      const store = new DefinitionStore({
        read: async () => stored,
        write: async (d) => { stored = d; },
      });
      await store.load();
      const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
      rt.load();
      let live = new Set<string>(["Recipes.md"]);
      const controller = new SpaceController(
        store,
        rt,
        vault,
        { apply: vi.fn(), livePaths: () => live },
        createMapTagIndex(new Map()),
        withLayout
          ? {
              transition: async (): Promise<SwitchOutcome> => {
                live = new Set<string>();
                return { kind: "restored" };
              },
            }
          : undefined
      );
      controller.onFileOpened("Recipes.md");
      await controller.switchTo({ kind: "space", id: "research" });
      return [...controller.currentSnapshot()!.visiblePaths()].sort();
    };

    expect(await build(true)).toEqual(await build(false));
  });

  it("onActiveFileChanged(null) recomputes with pruning, without dispatching to onFileOpened", async () => {
    // This decision moved out of main.ts's file-open
    // listener into the controller.
    //
    // An earlier version of this test asserted only side
    // effects (pruning happened; a dismissal survived) — both of which a
    // SWAPPED implementation still produces. Under the swap the null branch
    // calls `onFileOpened(path)` with `path` still `null`; that reaches
    // `RevealedSet.noteOpened(null)`, which deletes `null` from `dismissed`
    // and `carried` and adds `null` to `revealed` — none of which touches
    // "Recipes.md". So pruning still ran (`onFileOpened` calls `refresh()`
    // internally) and "Recipes.md"'s dismissal was still untouched, and the
    // old assertions passed anyway. Spying on `onFileOpened` directly is
    // what actually distinguishes "the null branch pruned" from "the null
    // branch dispatched somewhere it shouldn't have."
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    let live = new Set<string>(["Recipes.md"]);
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map())
    );
    await controller.switchTo({ kind: "space", id: "research" });
    controller.onActiveFileChanged("Recipes.md");
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(true);

    const openedSpy = vi.spyOn(controller, "onFileOpened");

    // The active pane becomes a non-file view, and the tab closes: null must
    // still recompute with pruning, exactly like an ordinary refresh().
    live = new Set<string>();
    controller.onActiveFileChanged(null);
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(false);
    // The discriminating assertion: null must reach `refresh()` directly,
    // never `onFileOpened` — under the swap described above this call count
    // is 1, not 0, and the test fails.
    expect(openedSpy).not.toHaveBeenCalled();

    openedSpy.mockRestore();
  });

  // Main.ts dispatches `onActiveFileChanged` for EVERY Obsidian
  // `file-open`, while `livePaths()` is deliberately narrower — it
  // excludes sidebar and pop-out leaves, and `livePathsFrom`'s per-leaf catch
  // can drop a leaf. Treating such an open as deliberate erased a
  // dismissal and un-carried a reveal, and the recompute then pruned the row
  // because the path is not live: a dimmed row vanishing with the user having
  // closed nothing.
  it("onActiveFileChanged does not clear a dismissal for a path the leaf walk cannot see", async () => {
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    let live = new Set<string>(["Recipes.md"]);
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map())
    );
    await controller.switchTo({ kind: "space", id: "research" });
    controller.dismissRevealed("Recipes.md");
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(false);

    // The path is no longer anything `livePaths()` reports — a sidebar pane
    // tracking it, or a leaf that failed to identify itself.
    live = new Set<string>();
    controller.onActiveFileChanged("Recipes.md");
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(false);

    // The discriminating half: an ungated `noteOpened` would already have
    // deleted the dismissal here, and the row would come back the moment the
    // path is live again. The dismissal must still stand.
    live = new Set<string>(["Recipes.md"]);
    controller.refresh();
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(false);
  });

  it("onActiveFileChanged does not un-carry a reveal for a path the leaf walk cannot see", async () => {
    let stored: unknown = { ...defs(), settings: { globalIgnore: [], restoreLayouts: true } };
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    let live = new Set<string>(["Recipes.md"]);
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map()),
      {
        transition: async (): Promise<SwitchOutcome> => {
          live = new Set<string>(["Papers/A.md"]);
          return { kind: "restored" };
        },
      }
    );

    controller.onFileOpened("Recipes.md");
    await controller.switchTo({ kind: "space", id: "research" });
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").reason).toBe("visitor");

    // A `file-open` naming the carried path, from a leaf the walk does not
    // report. Un-carrying here would let the very same recompute prune it.
    controller.onActiveFileChanged("Recipes.md");
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(true);
  });

  it("onActiveFileChanged both un-dismisses and un-carries when the path IS live", async () => {
    let stored: unknown = { ...defs(), settings: { globalIgnore: [], restoreLayouts: true } };
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    let live = new Set<string>(["Recipes.md"]);
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map()),
      {
        transition: async (): Promise<SwitchOutcome> => {
          live = new Set<string>(["Papers/A.md"]);
          return { kind: "restored" };
        },
      }
    );

    controller.onFileOpened("Recipes.md");
    controller.dismissRevealed("Recipes.md");
    await controller.switchTo({ kind: "space", id: "research" });

    // The user genuinely reopens it inside the space: the walk sees it, so
    // the open is deliberate and the dismissal goes.
    live = new Set<string>(["Recipes.md", "Papers/A.md"]);
    controller.onActiveFileChanged("Recipes.md");
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").reason).toBe("visitor");

    // And it un-carried: an ordinary path again, so closing it now prunes it.
    live = new Set<string>(["Papers/A.md"]);
    controller.refresh();
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(false);
  });

  it("onActiveFileChanged(path) records the open, un-dismissing a hidden reveal", async () => {
    let stored: unknown = defs();
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => { stored = d; },
    });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    const live = new Set<string>(["Recipes.md"]);
    const controller = new SpaceController(
      store,
      rt,
      vault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map())
    );
    await controller.switchTo({ kind: "space", id: "research" });
    controller.onActiveFileChanged("Recipes.md");
    controller.dismissRevealed("Recipes.md");
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(false);

    // Deliberately reopening a dismissed file un-dismisses
    // it. A swap onto the null branch (a bare refresh()) would leave it
    // dismissed, since refresh() never clears a dismissal.
    controller.onActiveFileChanged("Recipes.md");
    expect(controller.currentSnapshot()!.decisionFor("Recipes.md").visible).toBe(true);
  });

  // --- The carry must only protect DELIBERATELY-opened paths -------------
  //
  // `RevealedSet.test.ts` pins the mechanism directly; these two pin it at
  // the controller, where `switchTo` drives `releaseCarried` and the
  // restoring `recompute` the way the real app does.
  function twoSpaceStore() {
    const twoSpaceVault = buildFakeVault({
      A: "folder",
      "A/Doc.md": "file",
      B: "folder",
      "B/Doc.md": "file",
      "Visitor1.md": "file",
      "Visitor2.md": "file",
      "Deliberate.md": "file",
    });
    let stored: unknown = {
      schemaVersion: SCHEMA_VERSION,
      settings: { globalIgnore: [], restoreLayouts: true },
      spaces: [
        { id: "spaceA", name: "A", icon: "a", color: "#4ecdc4", members: [{ path: "A", kind: "folder" }] },
        { id: "spaceB", name: "B", icon: "b", color: "#ffd166", members: [{ path: "B", kind: "folder" }] },
      ],
    };
    return { twoSpaceVault, getStored: () => stored, setStored: (d: unknown) => { stored = d; } };
  }

  it("does not carry the outgoing space's visitor into the incoming space, in either direction", async () => {
    const { twoSpaceVault, getStored, setStored } = twoSpaceStore();
    const store = new DefinitionStore({ read: async () => getStored(), write: async (d) => setStored(d) });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    let live = new Set<string>();
    const controller = new SpaceController(
      store,
      rt,
      twoSpaceVault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map()),
      {
        transition: async (_from, to): Promise<SwitchOutcome> => {
          // Each space's OWN restore opens its own visitor tab — never via
          // `onFileOpened`/`noteOpened`. This is the self-healing clause (a
          // path revealed because it backs a live leaf), not a deliberate
          // open.
          live = new Set<string>([
            to.kind === "space" && to.id === "spaceB" ? "Visitor2.md" : "Visitor1.md",
          ]);
          return { kind: "restored" };
        },
      }
    );

    await controller.switchTo({ kind: "space", id: "spaceA" });
    // Assert the IMMEDIATE post-switch frame, before any refresh() — the
    // shape the layout-restoration test above already uses. A `refresh()`
    // here would step past the exact frame where the leak shows: if the
    // restoring recompute returns before its own prune loop, a
    // non-deliberate reveal survives THIS frame and only vanishes on the
    // next recompute — invisible to a test that calls refresh() before
    // looking.
    let snap = controller.currentSnapshot()!;
    expect(snap.decisionFor("Visitor1.md").reason).toBe("visitor");

    await controller.switchTo({ kind: "space", id: "spaceB" });
    snap = controller.currentSnapshot()!; // immediate frame again, no refresh()
    expect(snap.decisionFor("Visitor2.md").reason).toBe("visitor");
    // The bug: Visitor1.md's leaf was just closed by spaceB's OWN restore,
    // not by the user, but it was never opened by the user either — it must
    // not leak into spaceB, and must not leak for even one frame.
    expect(snap.decisionFor("Visitor1.md").visible).toBe(false);

    await controller.switchTo({ kind: "space", id: "spaceA" });
    snap = controller.currentSnapshot()!; // immediate frame
    expect(snap.decisionFor("Visitor1.md").reason).toBe("visitor");
    // The symmetric leak, the other direction — the exact A -> B -> A
    // sequence the user reported.
    expect(snap.decisionFor("Visitor2.md").visible).toBe(false);

    // Refreshing afterward must not change any of this — no flicker, no
    // second-tick surprise.
    controller.refresh();
    snap = controller.currentSnapshot()!;
    expect(snap.decisionFor("Visitor1.md").reason).toBe("visitor");
    expect(snap.decisionFor("Visitor2.md").visible).toBe(false);
  });

  // The transition here must genuinely CLOSE Visitor1.md when switching to
  // spaceA rather than reopen it, and the deliberate open must happen while
  // `live` already contains the file. Otherwise the final assertion would
  // pass merely because Visitor1.md is spaceA's own live visitor by the
  // time it runs, a different and uninteresting claim, rather than because
  // the carry protected a deliberately-opened path.
  it("a visitor the user opens BY HAND in one space follows them into the next — deliberate, so this is not a carry leak", async () => {
    // The carry is a deliberate exception for deliberate opens, not a
    // general rule about restores. A path the user opens while sitting in
    // spaceB, then closed by spaceA's own restore on switching, DOES
    // follow them.
    const { twoSpaceVault, getStored, setStored } = twoSpaceStore();
    const store = new DefinitionStore({ read: async () => getStored(), write: async (d) => setStored(d) });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    let live = new Set<string>();
    const controller = new SpaceController(
      store,
      rt,
      twoSpaceVault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map()),
      {
        transition: async (_from, to): Promise<SwitchOutcome> => {
          // NEITHER space's own restore ever opens Visitor1.md — each
          // space's restore opens only its own member tab, so switching to
          // spaceA genuinely CLOSES Visitor1.md if it was open.
          live = new Set<string>([to.kind === "space" && to.id === "spaceA" ? "A/Doc.md" : "B/Doc.md"]);
          return { kind: "restored" };
        },
      }
    );

    await controller.switchTo({ kind: "space", id: "spaceB" });
    // The user opens Visitor1.md by hand while sitting in spaceB. It is
    // genuinely live at this instant — included in `live` BEFORE the
    // deliberate-open call, unlike the vacuous version above, so
    // `onFileOpened`'s own `refreshWith` sees it live and does not prune it.
    live = new Set<string>([...live, "Visitor1.md"]);
    controller.onFileOpened("Visitor1.md");
    expect(controller.currentSnapshot()!.decisionFor("Visitor1.md").reason).toBe("visitor");

    await controller.switchTo({ kind: "space", id: "spaceA" });
    // spaceA's own restore does not reopen Visitor1.md (see the transition
    // above) — its tab is genuinely closed here. The open was deliberate,
    // so it must still show, on the immediate post-switch frame.
    const snap = controller.currentSnapshot()!;
    expect(snap.decisionFor("Visitor1.md").visible).toBe(true);
    expect(snap.decisionFor("Visitor1.md").reason).toBe("visitor");
  });

  it("still carries a deliberately-opened path through a restore that closes it, amid other spaces — must not regress", async () => {
    const { twoSpaceVault, getStored, setStored } = twoSpaceStore();
    const store = new DefinitionStore({ read: async () => getStored(), write: async (d) => setStored(d) });
    await store.load();
    const rt = new RuntimeStateStore({ get: () => null, set: () => undefined });
    rt.load();
    // Deliberate.md is "open in All" before the switch.
    let live = new Set<string>(["Deliberate.md"]);
    const controller = new SpaceController(
      store,
      rt,
      twoSpaceVault,
      { apply: vi.fn(), livePaths: () => live },
      createMapTagIndex(new Map()),
      {
        transition: async (): Promise<SwitchOutcome> => {
          // spaceA's own restore closes Deliberate.md's tab and opens its own.
          live = new Set<string>(["Visitor1.md"]);
          return { kind: "restored" };
        },
      }
    );

    controller.onFileOpened("Deliberate.md");
    await controller.switchTo({ kind: "space", id: "spaceA" });
    // The immediate post-switch frame, before any refresh().
    let snap = controller.currentSnapshot()!;
    expect(snap.decisionFor("Deliberate.md").visible).toBe(true);
    expect(snap.decisionFor("Deliberate.md").reason).toBe("visitor");

    // This must hold for the WHOLE visit, not just the one
    // frame the switch renders — prove it across several consecutive
    // ordinary refreshes, exactly what main.ts's listeners trigger with no
    // user action at all.
    for (let i = 0; i < 3; i++) {
      controller.refresh();
      snap = controller.currentSnapshot()!;
      expect(snap.decisionFor("Deliberate.md").visible).toBe(true);
      expect(snap.decisionFor("Deliberate.md").reason).toBe("visitor");
    }
  });

  // A space created with starting folders (createSpace's `members` option,
  // wired by CreateSpacePanel's toCreateOptions in the real UI) must show
  // those folders' subtrees the moment switchTo() lands on it, with no
  // intervening refresh(). Main.ts has no tests and the real app is never
  // driven through an actual Create click, so this pins the seeding half
  // of the create -> switch -> close path directly.
  it("createSpace + switchTo: the new space's snapshot contains the seeded folders' subtrees", async () => {
    const seedVault = buildFakeVault({
      Papers: "folder",
      "Papers/A.md": "file",
      Projects: "folder",
      "Projects/Plan.md": "file",
      "Recipes.md": "file",
    });
    const store = new DefinitionStore({
      read: async () => ({
        schemaVersion: SCHEMA_VERSION,
        settings: { globalIgnore: [], restoreLayouts: false },
        spaces: [],
      }),
      write: async () => undefined,
    });
    await store.load();
    const runtime = new RuntimeStateStore({ get: () => null, set: () => undefined });
    runtime.load();
    const controller = new SpaceController(
      store,
      runtime,
      seedVault,
      {
        apply: vi.fn(),
        livePaths: () => new Set<string>(),
      },
      createMapTagIndex(new Map())
    );

    const id = await createSpace(store, "Projects Space", {
      members: [{ path: "Projects", kind: "folder" }],
    });
    await controller.switchTo({ kind: "space", id });

    const snap = controller.currentSnapshot();
    expect(snap).not.toBeNull();
    // The seeded folder's child is visible...
    expect(snap!.decisionFor("Projects/Plan.md").visible).toBe(true);
    // ...and a file under an UN-seeded folder is not — proving this is the
    // seeded member's subtree specifically, not "everything visible by
    // default". If createSpace's `members` copy (spaceLifecycle.ts) were
    // dropped, the new space would have no members and both assertions
    // below would fail together with the one above.
    expect(snap!.decisionFor("Papers/A.md").visible).toBe(false);
    expect(snap!.decisionFor("Recipes.md").visible).toBe(false);
  });

  it("treats a folder space's root as its sole member, respecting globalIgnore", async () => {
    // A folder space stores no members at all (main.ts's hoist relies on this:
    // `membersForSnapshot` is what makes anything under the root visible).
    // Exercised through the real `recompute()` call site, not a hand-built
    // snapshot, so a wiring mistake at SpaceController.ts:348 would be caught
    // here even if VisibilityEngine's own behaviour (tests/visibility.test.ts)
    // were untouched.
    const { controller, store } = await build();
    controller.setVaultIndex(
      buildFakeVault({
        Papers: "folder",
        "Papers/A.md": "file",
        "Papers/Ignored.md": "file",
        "Recipes.md": "file",
      })
    );
    await store.mutate((d) => {
      d.settings.globalIgnore = ["Papers/Ignored.md"];
      d.spaces.push({
        id: "work",
        name: "Work",
        icon: "briefcase",
        color: "#5b5bff",
        root: "Papers",
        members: [],
      });
    });
    await controller.switchTo({ kind: "space", id: "work" });

    const snap = controller.currentSnapshot();
    expect(snap).not.toBeNull();
    // Only reachable via the shim: the space itself has no members, so
    // without it nothing under the root would be visible at all.
    expect(snap!.decisionFor("Papers/A.md").visible).toBe(true);
    // globalIgnore still applies to what the shim exposes.
    expect(snap!.decisionFor("Papers/Ignored.md").visible).toBe(false);
    expect(snap!.decisionFor("Recipes.md").visible).toBe(false);
  });

  describe("the missing-root state renders empty through the real production path", () => {
    // "Its tree is empty... It is never auto-repaired to the vault
    // root." `SpaceController.membersForSnapshot` (SpaceController.ts:313)
    // is the ONLY code that turns a missing root into an empty tree — every
    // emptiness assertion in `tests/filterAndOrderFolder.test.ts` injects an
    // all-hidden snapshot that forces `[]` regardless of what
    // `membersForSnapshot` does (its own siblings there assert `[]` for a
    // healthy root and a curated space too, proving the fixture itself is
    // what produces the emptiness). None of that exercises this branch.
    // These tests drive the real `membersForSnapshot` → `recompute` →
    // `buildVisibilitySnapshot` path through `switchTo`, exactly as
    // `main.ts` does.
    //
    // These three are production-path COVERAGE, not a regression pin — that
    // distinction matters because the ablation below still passes them.
    //
    // The obvious ablation — making `membersForSnapshot` unconditionally
    // return `[{ path: "", kind: "folder" }]`, the whole-vault bypass this
    // branch must never repeat — does NOT redden them, and cannot:
    // `ObsidianVaultIndex.ts:18` keeps `""` and `"/"` out of the index, so
    // `resolveLivePath("")` finds no top-level path equal to `""` and
    // returns null. The synthetic member resolves to nothing, the snapshot
    // stays empty, and these three still pass. The only test that fails
    // under it is the healthy-root contrast below.
    //
    // What pins the missing-root behaviour is the "declared but unusable
    // root, WITH stored members" case further down: reverting the
    // `hasRoot` guard reddens exactly that one, for the right reason. These
    // three earn their place by proving all three spellings reach
    // `buildVisibilitySnapshot` through the real path — but they are not
    // what would catch a regression.
    const missingRootVault = () =>
      buildFakeVault({
        Papers: "folder",
        "Papers/A.md": "file",
        "Recipes.md": "file",
      });

    it.each([
      ['""', ""],
      ['"/"', "/"],
      ["a root naming no folder (\"Projects/Gone\")", "Projects/Gone"],
    ])("is empty for a root spelled %s", async (_label, root) => {
      const { controller, store } = await build();
      controller.setVaultIndex(missingRootVault());
      await store.mutate((d) => {
        d.spaces.push({
          id: "broken",
          name: "Broken",
          icon: "briefcase",
          color: "#5b5bff",
          root,
          members: [],
        });
      });
      await controller.switchTo({ kind: "space", id: "broken" });

      const snap = controller.currentSnapshot();
      expect(snap).not.toBeNull();
      expect(snap!.visiblePaths()).toEqual(new Set());
      expect(snap!.decisionFor("Papers/A.md").visible).toBe(false);
      expect(snap!.decisionFor("Recipes.md").visible).toBe(false);
    });

    // A hand-edited `root: ""` WITH a non-empty `members` must not fall
    // back to rendering those members (`rootOf` null routing straight to
    // `space.members` would do exactly that), because that would diverge
    // from `root: "Gone"` — which already renders empty, since it names a
    // MEMBER path that resolves to nothing rather than falling back at
    // all. Both must be treated as the missing-root state and render
    // empty. This is the one case among the three above that the plain
    // `members: []` shape cannot distinguish: reverting `membersForSnapshot`
    // to `hasRoot(space) ? (rootOf(space) === null ? space.members : [...]) :
    // space.members` (i.e. dropping the `hasRoot` guard so `rootOf`'s null
    // alone decides) makes ONLY this test fail — `Papers/A.md` comes back
    // visible instead of hidden, because the leftover `members` entry is
    // exactly a real, resolvable folder.
    it("is empty for a declared-but-unusable root even when the space still carries stored members", async () => {
      const { controller, store } = await build();
      controller.setVaultIndex(missingRootVault());
      await store.mutate((d) => {
        d.spaces.push({
          id: "broken-with-members",
          name: "Broken with members",
          icon: "briefcase",
          color: "#5b5bff",
          root: "",
          // A hand-edited data.json, or a curated space that gained a root
          // without its members being cleared — either way, storage keeps
          // this entry; only the render must not use it.
          members: [{ path: "Papers", kind: "folder" }],
        });
      });
      await controller.switchTo({ kind: "space", id: "broken-with-members" });

      const snap = controller.currentSnapshot();
      expect(snap).not.toBeNull();
      expect(snap!.visiblePaths()).toEqual(new Set());
      expect(snap!.decisionFor("Papers/A.md").visible).toBe(false);
      // The stored space itself is untouched — nothing here deletes stored members.
      expect(store.get().spaces.find((s) => s.id === "broken-with-members")?.members).toEqual([
        { path: "Papers", kind: "folder" },
      ]);
    });

    it("is non-empty for a healthy root, for contrast with the missing-root cases above", async () => {
      const { controller, store } = await build();
      controller.setVaultIndex(missingRootVault());
      await store.mutate((d) => {
        d.spaces.push({
          id: "healthy",
          name: "Healthy",
          icon: "briefcase",
          color: "#5b5bff",
          root: "Papers",
          members: [],
        });
      });
      await controller.switchTo({ kind: "space", id: "healthy" });

      const snap = controller.currentSnapshot();
      expect(snap).not.toBeNull();
      expect(snap!.visiblePaths().size).toBeGreaterThan(0);
      expect(snap!.decisionFor("Papers/A.md").visible).toBe(true);
    });
  });
});

/**
 * What a recompute is allowed to COST when nothing in the space depends on a
 * note's contents.
 *
 * `createObsidianTagIndex` walks every markdown file in the vault and reads
 * each one's metadata cache. The coalescer replaces the tag index on every
 * burst of vault events, so an eagerly built one charged that walk to every
 * user on every burst, including everyone who has never put a tag in a space.
 */
describe("SpaceController tag index laziness", () => {
  async function buildWith(members: MemberEntry[]) {
    let stored: unknown = {
      schemaVersion: SCHEMA_VERSION,
      settings: { globalIgnore: [], restoreLayouts: false },
      spaces: [
        { id: "research", name: "Research", icon: "microscope", color: "#4ecdc4", members },
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
      vault,
      { apply: vi.fn(), livePaths: () => new Set<string>() },
      createLazyTagIndex(() => {
        builds++;
        return createMapTagIndex(new Map([["Recipes.md", ["project"]]]));
      })
    );
    return { controller, builds: () => builds };
  }

  it("never builds it for a space of files and folders", async () => {
    const { controller, builds } = await buildWith([{ path: "Papers", kind: "folder" }]);
    await controller.switchTo({ kind: "space", id: "research" });
    controller.refresh();
    expect(controller.currentSnapshot()?.decisionFor("Papers/A.md").visible).toBe(true);
    expect(builds()).toBe(0);
  });

  it("builds it, once, for a space holding a tag member", async () => {
    const { controller, builds } = await buildWith([{ kind: "tag", tag: "project" }]);
    await controller.switchTo({ kind: "space", id: "research" });
    controller.refresh();
    expect(controller.currentSnapshot()?.decisionFor("Recipes.md").visible).toBe(true);
    expect(builds()).toBe(1);
  });
});
