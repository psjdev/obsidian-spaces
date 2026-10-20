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
