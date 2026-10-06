// @vitest-environment jsdom
/**
 * Two things the switcher strip has to survive a redraw with: the keyboard
 * user's focus, and the identity of the icon a drag is holding.
 *
 * `render()` begins with `el.replaceChildren()`, which destroys every control
 * in the strip. Both defects below are the same shape — state captured against
 * the OLD children, used after they are gone — but they fail differently, so
 * they are pinned separately.
 *
 * Built against a REAL `SwitcherView`, `DefinitionStore`, `RuntimeStateStore`
 * and `SpaceController`, the same construction `tests/switcherGripIcon.test.ts`
 * uses, because both defects live in how those real pieces interact across a
 * render rather than in any one of them.
 *
 * GEOMETRY: jsdom lays nothing out, so every `getBoundingClientRect` reads
 * zero. That is enough for the reorder test and is used deliberately: with
 * zero-size boxes `insertionIndexAt` answers "after the last item" for any
 * pointer at or past 0, which is a real drop position and the one furthest from
 * where the dragged icon started. The index arithmetic itself is pinned against
 * real numbers in `tests/spaceReorder.test.ts`; what this file pins is WHICH
 * space the view hands that arithmetic.
 */
import { describe, expect, it, vi } from "vitest";
import { SwitcherView } from "../src/ui/SwitcherView";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { SpaceController } from "../src/controller/SpaceController";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { buildFakeVault } from "./helpers/fakeVault";
import { DEFAULT_DEFINITIONS, type SpaceDefinition } from "../src/types";

function space(id: string): SpaceDefinition {
  return { id, name: id.toUpperCase(), icon: "box", color: "#000000", members: [] };
}

async function build(spaces: SpaceDefinition[]) {
  let stored: unknown = { ...DEFAULT_DEFINITIONS, spaces };
  const defs = new DefinitionStore({
    read: async () => stored,
    write: async (d) => {
      stored = d;
    },
  });
  await defs.load();
  const runtime = new RuntimeStateStore({ get: () => null, set: () => undefined });
  runtime.load();
  const controller = new SpaceController(
    defs,
    runtime,
    buildFakeVault({}),
    { apply: vi.fn(), livePaths: () => new Set<string>() },
    createMapTagIndex(new Map())
  );
  const switcher = new SwitcherView(
    defs,
    runtime,
    controller,
    () => undefined,
    () => false,
    () => undefined,
    () => [],
    () => undefined
  );
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  switcher.mount(host);
  return { switcher, defs, host };
}

function iconFor(host: HTMLElement, id: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-space-id="${id}"]`);
  if (!el) throw new Error(`no switcher icon for ${id}`);
  return el;
}

function ids(defs: DefinitionStore): string[] {
  return defs.get().spaces.map((s) => s.id);
}

describe("the strip keeps the keyboard where it was across a redraw", () => {
  it("refocuses the same space after a render destroys its button", async () => {
    // What a keyboard user does: tab to a space, press Enter. Activating
    // re-renders the strip, and before this fix focus fell to `<body>` — so
    // reaching the next space meant tabbing in from the top of the document
    // again. Asserted against the space's IDENTITY, not a position, because a
    // render can also change how many icons there are.
    const { switcher, host } = await build([space("a"), space("b")]);
    iconFor(host, "b").focus();
    switcher.render();
    const after = iconFor(host, "b");
    expect(document.activeElement).toBe(after);
    // The element really was rebuilt, so the assertion above is about
    // restoring focus rather than about focus never having been disturbed.
    expect(after.isConnected).toBe(true);
  });

  it("leaves focus alone when it was never in the strip", async () => {
    // Restoring unconditionally would be its own bug: a render fires on every
    // definitions change, including ones the user caused from the settings tab
    // or another window, and stealing focus from whatever they were typing in
    // is worse than losing it.
    const { switcher, host } = await build([space("a"), space("b")]);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    switcher.render();
    expect(document.activeElement).toBe(outside);
    expect(host.contains(document.activeElement)).toBe(false);
  });

  it("falls back to the add button when the focused space is gone", async () => {
    // A space can be deleted from elsewhere while its icon holds focus. The
    // add control is the one thing in the strip that is always there, and it
    // is where the user is now nearest to making a new space.
    const { switcher, defs, host } = await build([space("a"), space("b")]);
    iconFor(host, "b").focus();
    await defs.mutate((d) => {
      d.spaces = d.spaces.filter((s) => s.id !== "b");
    });
    switcher.render();
    expect(document.activeElement).toBe(host.querySelector(".spaces-switcher-add"));
  });
});

describe("a space drag survives a render landing mid-gesture", () => {
  it("moves the space the user grabbed, not whatever now sits at its old index", async () => {
    // `render()` is called from five sites in `main.ts`, one of them inside
    // `onSnapshotApplied` — so it runs on every file open and every coalesced
    // vault flush, which is to say it can and does land between a dragstart
    // and its drop. The definitions can change in the same window:
    // `onExternalSettingsChange` applies a `data.json` written on another
    // device. An index captured at dragstart then names a different space.
    const { switcher, defs, host } = await build([space("a"), space("b"), space("c")]);
    iconFor(host, "b").dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));

    // Another device's `data.json`, arriving mid-drag: one space prepended,
    // so every index shifts by one and `b` is no longer at 1.
    await defs.mutate((d) => {
      d.spaces = [space("x"), ...d.spaces];
    });
    switcher.render();

    const rail = host.querySelector<HTMLElement>(".spaces-switcher-rail");
    expect(rail).not.toBeNull();
    rail!.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true }));
    // The write is fire-and-forget; let its promise settle.
    await Promise.resolve();
    await Promise.resolve();

    // With zero-size boxes the drop resolves to the end of the list, so the
    // space the user grabbed — `b` — is the one that should be last.
    expect(ids(defs)).toEqual(["x", "a", "c", "b"]);
  });

  it("declines the drop when the dragged space is gone by the time it lands", async () => {
    // Deleted on another device mid-drag. There is no position to compute and
    // nothing the user could mean, so nothing is written.
    //
    // FOUR spaces, so the stale index is a discriminator: with `b` gone, index
    // 1 names `c`, and a drop that trusted the index would move `c` to the end
    // rather than decline.
    const { switcher, defs, host } = await build([
      space("a"),
      space("b"),
      space("c"),
      space("d"),
    ]);
    iconFor(host, "b").dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    await defs.mutate((d) => {
      d.spaces = d.spaces.filter((s) => s.id !== "b");
    });
    switcher.render();

    const rail = host.querySelector<HTMLElement>(".spaces-switcher-rail");
    rail!.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(ids(defs)).toEqual(["a", "c", "d"]);
  });
});
