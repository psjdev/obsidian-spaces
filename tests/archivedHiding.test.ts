// @vitest-environment jsdom
/**
 * An archived space stays in `defs.spaces` and stops appearing anywhere the
 * user picks one: the strip, Next and Previous space, the Switch to space
 * picker and the add to space menu.
 *
 * The one place it must NOT stop appearing is the list handed to
 * `reconcileLayouts`, which deletes the stored layout and sort override of any
 * id it is not given. That test exists so a later reader does not "fix" it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Menu, TAbstractFile } from "obsidian";

const captured = vi.hoisted(() => ({ deps: null as null | { entries: () => { label: string }[] } }));
vi.mock("../src/ui/SpaceSuggestModal", () => ({
  SpaceSuggestModal: class {
    constructor(deps: { entries: () => { label: string }[] }) {
      captured.deps = deps;
    }
    open(): void {}
  },
}));

import SpacesPlugin from "../src/main";
import { SwitcherView } from "../src/ui/SwitcherView";
import { moveVisibleTo, visibleIndexOf } from "../src/ui/spaceReorder";
import { decorate } from "../src/actions/membership";
import { archiveSpace, restoreSpace } from "../src/actions/archiveSpace";
import { PublicApi } from "../src/api/PublicApi";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { SpaceController } from "../src/controller/SpaceController";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { buildFakeVault } from "./helpers/fakeVault";
import { DEFAULT_DEFINITIONS, type ActiveSelection, type SpaceDefinition } from "../src/types";
import { DEFAULT_SPACE_COLOR } from "../src/definitions/appearance";

const vault = buildFakeVault({ "notes.md": "file" });

function space(id: string, name: string): SpaceDefinition {
  return { id, name, icon: "leaf", color: DEFAULT_SPACE_COLOR, members: [{ path: "x.md", kind: "file" }] };
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
  const backing = new Map<string, unknown>();
  const runtime = new RuntimeStateStore({
    get: (k) => backing.get(k),
    set: (k, v) => void backing.set(k, v),
  });
  runtime.load();
  const controller = new SpaceController(
    defs,
    runtime,
    vault,
    { apply: vi.fn(), livePaths: () => new Set<string>() },
    createMapTagIndex(new Map()),
    () => ({ status: "unavailable", unparsed: [] })
  );
  return { defs, runtime, controller };
}

async function plugin(spaces: SpaceDefinition[]) {
  const built = await build(spaces);
  const p = new SpacesPlugin(
    {} as ConstructorParameters<typeof SpacesPlugin>[0],
    {} as ConstructorParameters<typeof SpacesPlugin>[1]
  );
  p["defs"] = built.defs;
  p["runtime"] = built.runtime;
  p["controller"] = built.controller;
  return { p, ...built };
}

function mountStrip(b: Awaited<ReturnType<typeof build>>) {
  const switcher = new SwitcherView(
    b.defs,
    b.runtime,
    b.controller,
    () => undefined,
    () => false,
    () => undefined,
    { dragged: () => ({ paths: [], truncated: false }), onDropped: () => undefined, onRefused: () => undefined }
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  switcher.mount(host);
  return { switcher, host };
}

const THREE = () => [space("a", "Alpha"), space("b", "Beta"), space("c", "Gamma")];

describe("archived spaces stop appearing", () => {
  it("the strip renders only active spaces", async () => {
    const b = await build(THREE());
    const { switcher, host } = mountStrip(b);
    expect(host.innerHTML).toContain("Beta");
    await archiveSpace(b.defs, "b");
    switcher.render();
    expect(host.innerHTML).not.toContain("Beta");
    expect(host.innerHTML).toContain("Alpha");
    expect(host.innerHTML).toContain("Gamma");
  });

  it("next space and previous space skip an archived space", async () => {
    const { p, defs, runtime } = await plugin(THREE());
    await archiveSpace(defs, "b");
    runtime.setSelection({ kind: "space", id: "a" });
    await p["cycle"](1);
    expect(runtime.getSelection()).toEqual({ kind: "space", id: "c" });
    await p["cycle"](-1);
    expect(runtime.getSelection()).toEqual({ kind: "space", id: "a" });
  });

  it("the Switch to space picker does not list an archived space", async () => {
    const { p, defs } = await plugin(THREE());
    await archiveSpace(defs, "b");
    const cmd = p["commandSpecs"]().find((c) => c.id === "switch-to-space");
    cmd?.callback?.();
    const labels = captured.deps?.entries().map((e) => e.label);
    expect(labels).toEqual(["All", "Alpha", "Gamma"]);
  });

  it("the add to space menu does not offer an archived space", async () => {
    const { defs, controller } = await build(THREE());
    await archiveSpace(defs, "b");
    const titles: string[] = [];
    const menu = {
      addItem(build: (item: unknown) => unknown) {
        const item = {
          setTitle: (t: string) => (titles.push(t), item),
          setIcon: () => item,
          setDisabled: () => item,
          setSubmenu: () => ({ addItem: menu.addItem }),
          onClick: () => item,
        };
        build(item);
        return menu;
      },
      addSeparator: () => menu,
    } as unknown as Menu;
    decorate(menu, { defs, controller }, [{ path: "notes.md", name: "notes.md" } as unknown as TAbstractFile]);
    const all = titles.join("|");
    expect(all).toContain("Alpha");
    expect(all).toContain("Gamma");
    expect(all).not.toContain("Beta");
  });

  it("falls back to All when the active space is archived", async () => {
    const { defs, runtime, controller } = await build(THREE());
    runtime.setSelection({ kind: "space", id: "b" });
    expect(controller.activeSpace()?.id).toBe("b");
    await archiveSpace(defs, "b");
    expect(controller.activeSpace()).toBeNull();
  });

  it("a refresh rewrites the selection to All, and restoring does not bring it back", async () => {
    const { defs, runtime, controller } = await build(THREE());
    runtime.setSelection({ kind: "space", id: "b" });
    await archiveSpace(defs, "b");
    controller.refresh();
    expect(runtime.getSelection()).toEqual({ kind: "all" } satisfies ActiveSelection);
    await restoreSpace(defs, "b");
    controller.refresh();
    // Intended: landing in All after a restore is the documented behavior.
    expect(runtime.getSelection()).toEqual({ kind: "all" } satisfies ActiveSelection);
    expect(controller.activeSpace()).toBeNull();
  });

  it("the public API reports no marked space after archive plus refresh", async () => {
    const { defs, runtime, controller } = await build(THREE());
    const api = new PublicApi({
      spaces: () => defs.get().spaces,
      selection: () => runtime.getSelection(),
      filteringPaused: () => false,
    });
    runtime.setSelection({ kind: "space", id: "b" });
    expect(api.markedSpace()?.id).toBe("b");
    await archiveSpace(defs, "b");
    controller.refresh();
    expect(api.markedSpace()).toBeNull();
  });

  it("still hands every space id to reconcileLayouts, archived included", () => {
    // onload cannot run under the obsidian stub, so the call is pinned at its
    // source: the argument must stay the full list. Filtering it would make
    // reconcileLayouts delete the layout and sort override archiving keeps.
    const src = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const call = /reconcileLayouts\(([^;]*)\);/.exec(src);
    expect(call?.[1].replace(/\s+/g, " ").trim()).toBe("this.defs.get().spaces.map((s) => s.id)");
  });

  it("reconcileLayouts drops the layout of an id it is not given, which is why that list stays whole", async () => {
    const { runtime } = await build(THREE());
    const sel: ActiveSelection = { kind: "space", id: "b" };
    runtime.setLayoutFor(sel, { tabs: 1 });
    runtime.reconcileLayouts(["a", "b", "c"]);
    expect(runtime.getLayoutFor(sel)).toEqual({ tabs: 1 });
    runtime.reconcileLayouts(["a", "c"]);
    expect(runtime.getLayoutFor(sel)).toBeNull();
  });

  it("archiving the last space leaves the strip with All and does not throw", async () => {
    const b = await plugin([space("a", "Alpha")]);
    const { switcher, host } = mountStrip(b);
    await archiveSpace(b.defs, "a");
    expect(() => switcher.render()).not.toThrow();
    expect(host.innerHTML).not.toContain("Alpha");
    expect(host.innerHTML).toContain("All");
    await expect(b.p["cycle"](1)).resolves.toBeUndefined();
  });
});

/** Gives each rendered icon a 28px box along x, so a drop resolves by pointer. */
function layOut(host: HTMLElement): void {
  const rect = (left: number, width: number) =>
    ({ left, right: left + width, top: 0, bottom: 28, width, height: 28, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
  host.querySelector<HTMLElement>(".spaces-switcher-rail")!.getBoundingClientRect = () => rect(0, 400);
  let at = 40;
  for (const el of Array.from(host.querySelectorAll<HTMLElement>("[data-space-id]"))) {
    const left = at;
    el.getBoundingClientRect = () => rect(left, 28);
    at += 32;
  }
}

/** Drag `id` and drop with the pointer at `x`, then return the stored order. */
async function dragTo(b: Awaited<ReturnType<typeof build>>, id: string, x: number): Promise<string[]> {
  const { host } = mountStrip(b);
  layOut(host);
  host
    .querySelector<HTMLElement>(`[data-space-id="${id}"]`)!
    .dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
  host
    .querySelector<HTMLElement>(".spaces-switcher-rail")!
    .dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: 10 }));
  await new Promise((r) => setTimeout(r, 0));
  return b.defs.get().spaces.map((s) => s.id);
}

const arch = (id: string): SpaceDefinition => ({ ...space(id, id.toUpperCase()), archived: true });

describe("reordering the strip while something is archived", () => {
  // Visible gaps by pointer x with icons at 40, 72, 104...: x=0 is gap 0,
  // x=9999 is the last gap. The stored index and the visible index are not the
  // same thing once anything is hidden: the drag reads the full array while the
  // gap is measured from rendered icons.
  it("drops a dragged space where it was dropped when an earlier space is archived", async () => {
    const b = await build([space("a", "A"), arch("b"), space("c", "C"), space("d", "D")]);
    expect(await dragTo(b, "d", 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("the review's example: [A archived, B, C], C before B lands before B, not before A", async () => {
    const b = await build([arch("a"), space("b", "B"), space("c", "C")]);
    // gap 0 is "before B": x just left of B's midpoint (54)
    expect(await dragTo(b, "c", 45)).toEqual(["a", "c", "b"]);
  });

  it("dropping at the very end leaves a trailing archived space trailing", async () => {
    const b = await build([space("a", "A"), space("b", "B"), arch("c")]);
    expect(await dragTo(b, "a", 9999)).toEqual(["b", "a", "c"]);
  });

  it("dropping at the very start leaves a leading archived space leading", async () => {
    const b = await build([arch("a"), space("b", "B"), space("c", "C")]);
    expect(await dragTo(b, "c", 0)).toEqual(["a", "c", "b"]);
  });

  it("swapping two spaces with an archived run between them keeps the run in place", async () => {
    const b = await build([space("a", "A"), arch("x"), arch("y"), space("c", "C")]);
    expect(await dragTo(b, "c", 0)).toEqual(["c", "a", "x", "y"]);
    const b2 = await build([space("a", "A"), arch("x"), arch("y"), space("c", "C")]);
    expect(await dragTo(b2, "a", 9999)).toEqual(["x", "y", "c", "a"]);
  });

  it("a drop that changes nothing visibly writes nothing", async () => {
    const b = await build([space("a", "A"), arch("x"), space("c", "C")]);
    // c's own gap (after A's midpoint 54, before C's 86): a visible no-op
    expect(await dragTo(b, "c", 70)).toEqual(["a", "x", "c"]);
  });
});

describe("moveVisibleTo and visibleIndexOf", () => {
  const list = () => [arch("x"), space("a", "A"), arch("y"), arch("z"), space("b", "B"), space("c", "C"), arch("w")];
  const order = (l: SpaceDefinition[]) => l.map((s) => s.id).join("");

  it("never reorders the archived spaces relative to each other", () => {
    for (const id of ["a", "b", "c"]) {
      for (let gap = 0; gap <= 3; gap++) {
        const out = moveVisibleTo(list(), id, gap);
        expect(out.filter((s) => s.archived).map((s) => s.id)).toEqual(["x", "y", "z", "w"]);
        expect(out).toHaveLength(7);
      }
    }
  });

  it("translates each gap to the slot before the active space there", () => {
    expect(order(moveVisibleTo(list(), "c", 0))).toBe("xcayzbw");
    expect(order(moveVisibleTo(list(), "c", 1))).toBe("xayzcbw");
    expect(order(moveVisibleTo(list(), "a", 3))).toBe("xyzbcaw");
    expect(order(moveVisibleTo(list(), "a", 2))).toBe("xyzbacw");
  });

  it("clamps an out-of-range gap and ignores an archived or unknown id", () => {
    expect(order(moveVisibleTo(list(), "a", 99))).toBe("xyzbcaw");
    expect(order(moveVisibleTo(list(), "a", -4))).toBe("xayzbcw");
    expect(order(moveVisibleTo(list(), "x", 2))).toBe("xayzbcw");
    expect(order(moveVisibleTo(list(), "nope", 2))).toBe("xayzbcw");
  });

  it("counts visible position only", () => {
    expect(visibleIndexOf(list(), "c")).toBe(2);
    expect(visibleIndexOf(list(), "x")).toBeNull();
    expect(visibleIndexOf(list(), "nope")).toBeNull();
  });
});
