// @vitest-environment jsdom
/**
 * The plugin's registered commands, plus the fail-open escape hatch that is
 * not part of that set.
 *
 * `spaces:add-active-file-to-space` sat outside the registered-commands
 * table and was registered nowhere. It is the answer to the cold-start
 * problem: a new space's tree is empty, so the only route to its first
 * member was to open a file, let it appear as a visitor, and right-click a
 * scaffold ancestor.
 *
 * `spaces:pause-filtering` is new. The plugin's whole posture is fail-open
 * and every fail-open path today is automatic; "Switch to All" is not the same
 * thing, because *All* is still a managed mode that applies `orders.all`, the
 * switch mask and the sort patch. A plugin that patches the explorer's sort
 * ought to ship a "show me the raw tree" control.
 *
 * The specs are read back from `commandSpecs()` rather than from
 * `Plugin.addCommand`, which the `obsidian` stub declines to model. That is
 * also why the registration loop in `start()` iterates this list: a command
 * that is not in it is not registered, so the list IS the registration.
 *
 * Layer: unit, against the stub.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import SpacesPlugin from "../src/main";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import type { SpaceDefinition } from "../src/types";

const RESEARCH: SpaceDefinition = {
  id: "research",
  name: "Research",
  icon: "microscope",
  color: "#4ecdc4",
  members: [
    { path: "Papers/Attention.md", kind: "file" },
    { path: "Inbox", kind: "folder" },
  ],
};

interface Harness {
  plugin: SpacesPlugin;
  /** What `app.workspace.getActiveFile()` answers. */
  setActiveFile(path: string | null): void;
  /** How many times `ensureOrderingPatched` looked for the explorer leaf. */
  leafLookups(): number;
}

function makeHarness(): Harness {
  let active: TFile | null = null;
  let lookups = 0;
  const app = {
    workspace: {
      containerEl: document.createElement("div"),
      getActiveFile: () => active,
      getLeavesOfType: () => {
        lookups += 1;
        return [];
      },
    },
  };
  const plugin = new SpacesPlugin(
    app as unknown as ConstructorParameters<typeof SpacesPlugin>[0],
    {} as ConstructorParameters<typeof SpacesPlugin>[1]
  );
  plugin["defs"] = new DefinitionStore({
    read: async () => undefined,
    write: async () => undefined,
  });
  const backing = new Map<string, unknown>();
  plugin["runtime"] = new RuntimeStateStore({
    get: (k) => backing.get(k),
    set: (k, v) => void backing.set(k, v),
  });
  return {
    plugin,
    setActiveFile(path) {
      if (path === null) {
        active = null;
        return;
      }
      const file = new TFile();
      file.path = path;
      active = file;
    },
    leafLookups: () => lookups,
  };
}

type Spec = ReturnType<SpacesPlugin["commandSpecs"]> extends readonly (infer T)[]
  ? T
  : never;

function specFor(plugin: SpacesPlugin, id: string): Spec {
  const spec = plugin["commandSpecs"]().find((c) => c.id === id);
  if (!spec) throw new Error(`no command registered with id ${id}`);
  return spec;
}

/** Runs a `checkCallback` command, returning whether it offered itself. */
function invoke(plugin: SpacesPlugin, id: string, checking: boolean): boolean {
  const spec = specFor(plugin, id);
  if (spec.checkCallback) return spec.checkCallback(checking) === true;
  spec.callback?.();
  return true;
}

describe("the registered command list", () => {
  it("registers every product-defined command id, plus the fail-open hatch", () => {
    const { plugin } = makeHarness();
    // Exact, not a superset: the README and main.ts are meant to name exactly
    // this one list, and a spec table that quietly drifts from the code is a bug.
    expect(plugin["commandSpecs"]().map((c) => c.id).sort()).toEqual([
      "add-active-file-to-space",
      "create-space",
      "lock-strip",
      "move-strip-bottom",
      "move-strip-left",
      "move-strip-right",
      "move-strip-top",
      "new-folder-in-active-space",
      "new-note-in-active-space",
      "next-space",
      "pause-filtering",
      "previous-space",
      "restore-saved-ordering",
      "switch-to-all",
      "switch-to-space",
      "unlock-strip",
    ]);
  });

  it("gives every command a name", () => {
    const { plugin } = makeHarness();
    for (const spec of plugin["commandSpecs"]()) {
      expect(spec.name, spec.id).toBeTruthy();
    }
  });
});

describe("add-active-file-to-space", () => {
  let h: Harness;

  beforeEach(async () => {
    h = makeHarness();
    await h.plugin["defs"].mutate((d) => {
      d.spaces = [RESEARCH];
    });
  });

  const ID = "add-active-file-to-space";

  it("is unavailable in All", () => {
    h.setActiveFile("Papers/Draft.md");
    expect(invoke(h.plugin, ID, true)).toBe(false);
  });

  it("is unavailable with no active file", () => {
    h.plugin["runtime"].setSelection({ kind: "space", id: "research" });
    h.setActiveFile(null);
    expect(invoke(h.plugin, ID, true)).toBe(false);
  });

  it("is unavailable for a file that is already an exact member", () => {
    h.plugin["runtime"].setSelection({ kind: "space", id: "research" });
    h.setActiveFile("Papers/Attention.md");
    expect(invoke(h.plugin, ID, true)).toBe(false);
  });

  it("is unavailable for a file a member folder already covers", () => {
    // An exact entry here would be a second claim on the same path — the same
    // check `joinOnCreate` makes before it writes.
    h.plugin["runtime"].setSelection({ kind: "space", id: "research" });
    h.setActiveFile("Inbox/Today.md");
    expect(invoke(h.plugin, ID, true)).toBe(false);
  });

  it("adds the active file to the active space", async () => {
    h.plugin["runtime"].setSelection({ kind: "space", id: "research" });
    h.setActiveFile("Papers/Draft.md");
    expect(invoke(h.plugin, ID, true)).toBe(true);
    expect(invoke(h.plugin, ID, false)).toBe(true);
    await h.plugin["addActiveFileToSpace"]();
    expect(h.plugin.api.memberPaths("research")).toContain("Papers/Draft.md");
    expect(h.plugin.api.isMember("Papers/Draft.md", "research")).toBe(true);
    // Written as a file, not a folder: the kind decides whether descendants
    // inherit membership.
    const stored = h.plugin["defs"].get().spaces[0].members;
    expect(stored.find((m) => m.path === "Papers/Draft.md")?.kind).toBe("file");
  });
});

describe("pause-filtering", () => {
  let h: Harness;

  beforeEach(async () => {
    document.body.removeAttribute("data-spaces-space");
    h = makeHarness();
    await h.plugin["defs"].mutate((d) => {
      d.spaces = [RESEARCH];
    });
    h.plugin["runtime"].setSelection({ kind: "space", id: "research" });
    h.plugin["syncSpaceSurface"]();
  });

  it("toggles, and says which way it went", () => {
    expect(h.plugin["filteringPaused"]).toBe(false);
    invoke(h.plugin, "pause-filtering", false);
    expect(h.plugin["filteringPaused"]).toBe(true);
    invoke(h.plugin, "pause-filtering", false);
    expect(h.plugin["filteringPaused"]).toBe(false);
  });

  it("drops the data-spaces-space marker while paused, and restores it", () => {
    expect(document.body.getAttribute("data-spaces-space")).toBe("research");
    invoke(h.plugin, "pause-filtering", false);
    // The marker means "this tree is filtered to that space". Paused, it is
    // not, so claiming it would be a lie to every consumer reading the marker.
    expect(document.body.hasAttribute("data-spaces-space")).toBe(false);
    expect(h.plugin.api.getActiveSpace()).toBeNull();
    invoke(h.plugin, "pause-filtering", false);
    expect(document.body.getAttribute("data-spaces-space")).toBe("research");
    expect(h.plugin.api.getActiveSpace()?.id).toBe("research");
  });

  it("keeps the sort seam released while paused", () => {
    // The pause is only worth having if it survives the next `layout-change`
    // or definitions change, both of which call `ensureOrderingPatched()`.
    invoke(h.plugin, "pause-filtering", false);
    const before = h.leafLookups();
    h.plugin["ensureOrderingPatched"]();
    expect(h.leafLookups()).toBe(before);

    invoke(h.plugin, "pause-filtering", false);
    h.plugin["ensureOrderingPatched"]();
    expect(h.leafLookups()).toBeGreaterThan(before);
  });

  it("still reports membership while paused — the data is unchanged", () => {
    invoke(h.plugin, "pause-filtering", false);
    expect(h.plugin.api.listSpaces().map((s) => s.id)).toEqual(["research"]);
    expect(h.plugin.api.isMember("Papers/Attention.md", "research")).toBe(true);
  });
});
