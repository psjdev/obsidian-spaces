// @vitest-environment jsdom
/**
 * The net under the plugin's headline feature.
 *
 * `filterAndOrderFolder` is the transform EVERY folder in the tree passes
 * through. Before the `obsidian` alias in `vitest.config.ts` existed, nothing
 * in `tests/` could reach it: changing the unkeyable-item exit at
 * `main.ts:1092` from `return visible` to `return items` silently drops
 * source filtering for every user on every folder — with `tsc` clean and
 * 674/674 green.
 *
 * The source comment at `main.ts:1054-1065` warns about exactly that
 * regression ("EVERY exit from this function returns the FILTERED items, never
 * the raw ones"). These tests are that comment made executable: there is one
 * test per exit, and each asserts the FILTERING, not just the ordering.
 *
 * Layer: this is a unit test (it would pass against a
 * mocked `obsidian`, because it runs against one). It is evidence about the
 * transform, not about the real app. What it buys is that the transform can no
 * longer be deleted in silence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { noticeLog } from "./helpers/obsidian-stub";
import SpacesPlugin from "../src/main";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { buildVisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { compileIgnore } from "../src/visibility/glob";
import { buildFakeVault } from "./helpers/fakeVault";
import type { SpaceController } from "../src/controller/SpaceController";
import type { FolderItemLike, TransformItems } from "../src/layout/nativeExplorerSort";
import type { VisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { DEFAULT_DEFINITIONS, SCHEMA_VERSION, type SpaceDefinition } from "../src/types";
import { CLS_ELSEWHERE } from "../src/explorer/selectors";

const RESEARCH: SpaceDefinition = {
  id: "research",
  name: "Research",
  icon: "microscope",
  color: "#4ecdc4",
  // An EXACT file member, so its siblings in the same folder are non-members
  // and the folder is a mixed one — which is what makes filtering observable.
  members: [{ path: "Papers/Attention.md", kind: "file" }],
};

const vault = buildFakeVault({
  Papers: "folder",
  "Papers/Attention.md": "file",
  "Papers/Draft.md": "file",
  "Papers/Notes.md": "file",
  "Recipes.md": "file",
});

/** One entry in the shape Obsidian hands to `getSortedFolderItems`. */
function item(path: string): FolderItemLike {
  return { file: { path } };
}

function pathsOf(items: FolderItemLike[]): (string | undefined)[] {
  return items.map((i) => i.file?.path);
}

/**
 * A plugin instance with the four collaborators the transform reads, and
 * nothing else. `onload()` is never called: the field initialisers are the
 * only construction work, and `adapter = new ExplorerAdapter()` is the only
 * one that builds anything.
 *
 * `sortedView` stays null, so `observeSortOrder()` sees a null sort order,
 * `sortGestureFrom` returns "none", and the transform's first statement is a
 * no-op — no timer is armed and nothing needs tearing down.
 */
function makePlugin(): SpacesPlugin {
  const plugin = new SpacesPlugin(
    {} as ConstructorParameters<typeof SpacesPlugin>[0],
    {} as ConstructorParameters<typeof SpacesPlugin>[1]
  );
  plugin["defs"] = new DefinitionStore({
    read: async () => undefined,
    write: async () => undefined,
  });
  const runtimeBacking = new Map<string, unknown>();
  plugin["runtime"] = new RuntimeStateStore({
    get: (k) => runtimeBacking.get(k),
    set: (k, v) => void runtimeBacking.set(k, v),
  });
  return plugin;
}

/**
 * The snapshot the transform reads is the CONTROLLER's. It is a domain
 * decision — which files exist in this space's tree — and the adapter's copy is
 * the DOM layer's, nulled by a DOM-presence event (`unbind()`) that says nothing
 * about the space. The adapter is still handed the same snapshot here, because
 * that is what classes the rows; what changed is that nothing reads it back.
 */
function useSnapshot(plugin: SpacesPlugin, snap: VisibilitySnapshot | null): void {
  plugin["controller"] = { currentSnapshot: () => snap } as unknown as SpaceController;
  plugin["adapter"].apply(snap);
}

/**
 * The private transform, reached the way the sort seam reaches it.
 *
 * The bracket access above (`plugin["defs"]`, `plugin["runtime"]`,
 * `plugin["adapter"]`) is the same device used to reach those eight plugin
 * fields, which are marked `private` because they were the plugin's
 * accidental public API. Nothing about what these tests assert changed.
 */
function transformOf(plugin: SpacesPlugin): TransformItems {
  return plugin["filterAndOrderFolder"];
}

describe("SpacesPlugin.filterAndOrderFolder", () => {
  let plugin: SpacesPlugin;
  let transform: TransformItems;

  beforeEach(async () => {
    plugin = makePlugin();
    transform = transformOf(plugin);
    await plugin["defs"].mutate((d) => {
      d.spaces = [RESEARCH];
    });
    plugin["runtime"].setSelection({ kind: "space", id: "research" });
    // The snapshot is DERIVED by the real engine rather than hand-written, so
    // The test cannot disagree with the precedence rules.
    useSnapshot(
      plugin,
      buildVisibilitySnapshot(vault, RESEARCH, new Set(), compileIgnore([]))
    );
  });

  async function storeOrder(folder: string, order: string[]): Promise<void> {
    await plugin["defs"].mutate((d) => {
      d.orders = { bySpaceId: { research: { [folder]: order } } };
    });
  }

  it("drops a non-member row when no order is stored (exit: no order map)", () => {
    const out = transform("Papers", [
      item("Papers/Attention.md"),
      item("Papers/Draft.md"),
    ]);
    expect(pathsOf(out)).toEqual(["Papers/Attention.md"]);
  });

  it("drops a non-member row when this folder has no stored order (exit: no order)", async () => {
    await storeOrder("SomeOtherFolder", ["a", "b"]);
    const out = transform("Papers", [
      item("Papers/Attention.md"),
      item("Papers/Draft.md"),
    ]);
    expect(pathsOf(out)).toEqual(["Papers/Attention.md"]);
  });

  it("still filters when an item cannot be keyed (exit: main.ts:1092)", async () => {
    // THE regression the source comment warns about. This exit declines to
    // ORDER — an unkeyable item cannot be placed safely — but it must still
    // hand back the FILTERED set. Returning the parameter here is `tsc`-clean
    // and looks like the three correct exits, which is why it needs a test.
    await storeOrder("Papers", ["Papers/Draft.md", "Papers/Attention.md"]);
    const out = transform("Papers", [
      item("Papers/Attention.md"),
      item("Papers/Draft.md"),
      {}, // an item with no `file`
    ]);
    expect(pathsOf(out)).not.toContain("Papers/Draft.md");
    expect(pathsOf(out)).toEqual(["Papers/Attention.md", undefined]);
  });

  it("still filters when a duplicate path blocks ordering (exit: main.ts:1092)", async () => {
    // The other trigger for the same exit, so deleting either half of the
    // `typeof p !== "string" || byPath.has(p)` guard is also caught.
    await storeOrder("Papers", ["Papers/Notes.md", "Papers/Attention.md"]);
    const out = transform("Papers", [
      item("Papers/Attention.md"),
      item("Papers/Draft.md"),
      item("Papers/Attention.md"),
    ]);
    expect(pathsOf(out)).toEqual(["Papers/Attention.md", "Papers/Attention.md"]);
  });

  it("orders the FILTERED set, never the raw one (exit: ordered)", async () => {
    // A stored order that names a filtered-out path must not resurrect it:
    // ordering runs over what survived filtering, not over what arrived.
    await storeOrder("Papers", ["Papers/Draft.md", "Papers/Notes.md"]);
    const out = transform("Papers", [
      item("Papers/Attention.md"),
      item("Papers/Draft.md"),
      item("Papers/Notes.md"),
    ]);
    expect(pathsOf(out)).toEqual(["Papers/Attention.md"]);
  });

  it("orders what survives when several members share a folder", async () => {
    const both: SpaceDefinition = {
      ...RESEARCH,
      members: [
        { path: "Papers/Attention.md", kind: "file" },
        { path: "Papers/Notes.md", kind: "file" },
      ],
    };
    await plugin["defs"].mutate((d) => {
      d.spaces = [both];
    });
    useSnapshot(plugin, buildVisibilitySnapshot(vault, both, new Set(), compileIgnore([])));
    plugin["adapter"].apply(
      buildVisibilitySnapshot(vault, both, new Set(), compileIgnore([]))
    );
    await storeOrder("Papers", ["Papers/Notes.md", "Papers/Attention.md"]);

    const out = transform("Papers", [
      item("Papers/Attention.md"),
      item("Papers/Draft.md"),
      item("Papers/Notes.md"),
    ]);
    expect(pathsOf(out)).toEqual(["Papers/Notes.md", "Papers/Attention.md"]);
  });

  it("filters nothing in All, where the snapshot is null (fail-open)", () => {
    plugin["runtime"].setSelection({ kind: "all" });
    useSnapshot(plugin, null);
    const out = transform("Papers", [
      item("Papers/Attention.md"),
      item("Papers/Draft.md"),
    ]);
    expect(pathsOf(out)).toEqual(["Papers/Attention.md", "Papers/Draft.md"]);
  });

  it("filters from the CONTROLLER's snapshot when the adapter's copy is null", () => {
    // The two owners disagree on purpose. `unbind()` nulls the adapter's copy
    // on a DOM-presence event — `changeLayout()` destroying the container, a
    // layout-change landing mid-rebuild — while the space is still active and
    // the controller's snapshot is still the truth. Reading the DOM layer's
    // copy here made a domain decision fail open for the duration.
    const snap = buildVisibilitySnapshot(vault, RESEARCH, new Set(), compileIgnore([]));
    plugin["controller"] = { currentSnapshot: () => snap } as unknown as SpaceController;
    plugin["adapter"].apply(null);
    plugin["runtime"].setSelection({ kind: "all" });
    plugin["adapter"].apply(null);
    const out = transform("Papers", [
      item("Papers/Attention.md"),
      item("Papers/Draft.md"),
    ]);
    expect(pathsOf(out)).toEqual(["Papers/Attention.md"]);
  });

  it("filters nothing when the CONTROLLER says All, whatever the adapter holds", () => {
    // The other direction, so the test cannot pass by reading either field.
    plugin["controller"] = { currentSnapshot: () => null } as unknown as SpaceController;
    plugin["adapter"].apply(
      buildVisibilitySnapshot(vault, RESEARCH, new Set(), compileIgnore([]))
    );
    const out = transform("Papers", [
      item("Papers/Attention.md"),
      item("Papers/Draft.md"),
    ]);
    expect(pathsOf(out)).toEqual(["Papers/Attention.md", "Papers/Draft.md"]);
  });

  it("maps Obsidian's root folder path '/' onto storage's ''", async () => {
    await storeOrder("", ["Recipes.md", "Papers"]);
    const rootVault = buildFakeVault({
      Papers: "folder",
      "Papers/Attention.md": "file",
      "Recipes.md": "file",
      "Private.md": "file",
    });
    useSnapshot(
      plugin,
      buildVisibilitySnapshot(rootVault, RESEARCH, new Set(["Recipes.md"]), compileIgnore([]))
    );
    const out = transform("/", [item("Papers"), item("Recipes.md"), item("Private.md")]);
    expect(pathsOf(out)).toEqual(["Recipes.md", "Papers"]);
  });
});

/* -------------------------------------------------------------------- *
 * Folder spaces — hoisting
 *
 * `hoistedRootItems` (main.ts) reads TWO different fakes, and they must not
 * be confused for one another:
 *
 *  - `this.app.vault.getAbstractFileByPath` is Obsidian's OWN vault API —
 *    real `TFolder`/`TFile` instances, never the `VaultIndex` abstraction
 *    `buildFakeVault` produces (that one feeds `buildVisibilitySnapshot`,
 *    which is a different concern: what the visibility engine, not the
 *    hoist, considers a member).
 *  - `explorerViews()[0].fileItems` is the seam's own item map, read by
 *    `itemsForPaths` (nativeExplorerSort.ts).
 * -------------------------------------------------------------------- */

/** `Projects/Work/{Hardware,Overview.md}`, `Projects`, and `Archive/Old.md`. */
const HARDWARE = Object.assign(new TFolder(), {
  path: "Projects/Work/Hardware",
  name: "Hardware",
});
const OVERVIEW = Object.assign(new TFile(), {
  path: "Projects/Work/Overview.md",
  name: "Overview.md",
});
const WORK_FOLDER = Object.assign(new TFolder(), {
  path: "Projects/Work",
  name: "Work",
  // Order matters: this is what `hoistedRootItems` hands to
  // `itemsForPaths`, and the test pins the result staying in this order.
  children: [HARDWARE, OVERVIEW],
});
const PROJECTS_FOLDER = Object.assign(new TFolder(), {
  path: "Projects",
  name: "Projects",
  children: [WORK_FOLDER],
});
const OLD_FILE = Object.assign(new TFile(), {
  path: "Archive/Old.md",
  name: "Old.md",
});
const ARCHIVE_FOLDER = Object.assign(new TFolder(), {
  path: "Archive",
  name: "Archive",
  children: [OLD_FILE],
});

const folderSpaceTree = new Map<string, TFolder | TFile>([
  [PROJECTS_FOLDER.path, PROJECTS_FOLDER],
  [WORK_FOLDER.path, WORK_FOLDER],
  [HARDWARE.path, HARDWARE],
  [OVERVIEW.path, OVERVIEW],
  [ARCHIVE_FOLDER.path, ARCHIVE_FOLDER],
  [OLD_FILE.path, OLD_FILE],
]);

/**
 * Stands in for `app.vault` and `app.workspace`; `Projects/Gone` is
 * deliberately absent. `iterateRootLeaves` walks nothing by default — the
 * elsewhere-group tests below override `liveLeafPaths` directly (the same
 * bracket-notation device `explorerViews` already uses in this file) rather
 * than driving it through a fake leaf, so every OTHER test here sees an
 * empty elsewhere group, matching the hoist-only behaviour they assert on.
 */
const folderSpaceApp = {
  vault: {
    getAbstractFileByPath: (p: string) => folderSpaceTree.get(p) ?? null,
  },
  workspace: {
    iterateRootLeaves: (_cb: (leaf: unknown) => void) => {
      // No live leaves by default.
    },
  },
};

/** Stands in for the explorer view `hoistedRootItems` reads via `itemsForPaths`. */
const folderSpaceView = {
  fileItems: {
    [HARDWARE.path]: item(HARDWARE.path),
    [OVERVIEW.path]: item(OVERVIEW.path),
    [OLD_FILE.path]: item(OLD_FILE.path),
  },
};

/**
 * A plugin whose active space is a folder space rooted at `root`, over a fake
 * vault containing `Projects/Work/{Hardware,Overview.md}` and `Archive/Old.md`.
 *
 * `defs`'s internal state is seeded directly (the same bracket-notation device
 * `beforeEach` above uses for `plugin["defs"]`/`plugin["controller"]`)
 * rather than through `load()`/`mutate()`: both are async, and these tests are
 * not, so the definitions must exist synchronously the moment this returns.
 *
 * The controller's snapshot defaults to null, which — like the "filters
 * nothing in All" case above — is a pass-through visibility engine. That
 * isolates the HOISTING mechanism under test in most of the cases below; a
 * real `snapshot` or a broken `view` can be supplied where a test needs one.
 */
function makeFolderSpacePlugin(
  root: string,
  opts: { snapshot?: VisibilitySnapshot | null; view?: object } = {}
): SpacesPlugin {
  const plugin = makePlugin();
  const store = new DefinitionStore({
    read: async () => undefined,
    write: async () => undefined,
  });
  store["defs"] = {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_DEFINITIONS.settings },
    spaces: [
      { id: "work", name: "Work", icon: "briefcase", color: "#5b5bff", root, members: [] },
    ],
  };
  plugin["defs"] = store;
  plugin["runtime"].setSelection({ kind: "space", id: "work" });
  plugin["controller"] = {
    currentSnapshot: () => opts.snapshot ?? null,
  } as unknown as SpaceController;
  (plugin as unknown as { app: unknown }).app = folderSpaceApp;
  (plugin as unknown as { explorerViews: () => object[] }).explorerViews = () => [
    opts.view ?? folderSpaceView,
  ];
  return plugin;
}

async function storeOrderFor(plugin: SpacesPlugin, folder: string, order: string[]): Promise<void> {
  await plugin["defs"].mutate((d) => {
    d.orders = { bySpaceId: { work: { [folder]: order } } };
  });
}

/** A curated (non-folder) space, so the hoisting branch must not engage. */
function makeCuratedPlugin(): SpacesPlugin {
  const plugin = makePlugin();
  const papers: SpaceDefinition = {
    id: "papers",
    name: "Papers",
    icon: "folder",
    color: "#5b5bff",
    members: [{ path: "Papers", kind: "folder" }],
  };
  const curatedVault = buildFakeVault({
    Papers: "folder",
    "Private.md": "file",
  });
  const store = new DefinitionStore({
    read: async () => undefined,
    write: async () => undefined,
  });
  store["defs"] = {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_DEFINITIONS.settings },
    spaces: [papers],
  };
  plugin["defs"] = store;
  plugin["runtime"].setSelection({ kind: "space", id: "papers" });
  plugin["controller"] = {
    currentSnapshot: () =>
      buildVisibilitySnapshot(curatedVault, papers, new Set(), compileIgnore([])),
  } as unknown as SpaceController;
  return plugin;
}

describe("folder spaces — hoisting", () => {
  it("answers the vault root with the root folder's children", () => {
    const plugin = makeFolderSpacePlugin("Projects/Work");
    const out = transformOf(plugin)("/", [item("Archive"), item("Projects")]);
    expect(pathsOf(out)).toEqual(["Projects/Work/Hardware", "Projects/Work/Overview.md"]);
  });

  it("does not show the root folder itself", () => {
    const plugin = makeFolderSpacePlugin("Projects/Work");
    const out = transformOf(plugin)("/", [item("Projects")]);
    expect(pathsOf(out)).not.toContain("Projects");
    expect(pathsOf(out)).not.toContain("Projects/Work");
  });

  it("passes a folder under the root through unchanged", () => {
    const plugin = makeFolderSpacePlugin("Projects/Work");
    const input = [item("Projects/Work/Hardware/Board.md")];
    expect(transformOf(plugin)("Projects/Work/Hardware", input)).toEqual(input);
  });

  it("returns the input unchanged for an unreachable folder", () => {
    // Never asked in practice, because the folder is not rendered. Failing
    // open rather than empty is the rule everywhere else in this transform.
    const plugin = makeFolderSpacePlugin("Projects/Work");
    const input = [item("Archive/Old.md")];
    expect(transformOf(plugin)("Archive", input)).toEqual(input);
  });

  // A missing root always produces the empty state, never a fallback to the
  // raw (here, whole-vault) items: `makeFolderSpacePlugin`'s default null
  // snapshot makes `filterVisibleItems` pass everything through regardless of
  // root shape, which is not what the real `SpaceController` hands this
  // transform for an active space. The "SpacesPlugin.filterAndOrderFolder —
  // the missing-root state empties the tree" block below covers this root
  // (and the `""`/`"/"` spellings) against a snapshot shaped like the real
  // one.

  it("leaves a curated space's behaviour untouched", () => {
    const plugin = makeCuratedPlugin();
    const input = [item("Papers"), item("Private.md")];
    const out = transformOf(plugin)("/", input);
    expect(pathsOf(out)).toEqual(["Papers"]);
  });

  it("keys the hoisted level's order by the root, not the vault root", async () => {
    // Both All and this space order the same visual level. Sharing a key would
    // make one silently adopt the other's arrangement.
    const plugin = makeFolderSpacePlugin("Projects/Work");
    await storeOrderFor(plugin, "", ["Projects/Work/Overview.md", "Projects/Work/Hardware"]);
    const out = transformOf(plugin)("/", [item("Projects")]);
    // The order stored against "" is All's, and must not apply here.
    expect(pathsOf(out)).toEqual(["Projects/Work/Hardware", "Projects/Work/Overview.md"]);
  });

  // Replacing `return this.filterAndOrderFolder(root, hoisted)` with `return
  // hoisted` leaves the whole suite green otherwise, because
  // `makeFolderSpacePlugin`'s null snapshot and the "" order key above make
  // neither half of "filter then order" observable. These two probes fail
  // under that bypass.
  it("filters a hidden root child out of the hoisted rows, not just the raw items", () => {
    const snapshot = buildVisibilitySnapshot(
      buildFakeVault({
        "Projects/Work/Overview.md": "file",
        "Projects/Work/Hardware": "folder",
      }),
      {
        id: "work",
        name: "Work",
        icon: "briefcase",
        color: "#5b5bff",
        root: "Projects/Work",
        // Only Overview.md is a member: Hardware is not, so a snapshot-aware
        // hoist must hide it — a bypass that skips filtering cannot.
        members: [{ path: "Projects/Work/Overview.md", kind: "file" }],
      },
      new Set(),
      compileIgnore([])
    );
    const plugin = makeFolderSpacePlugin("Projects/Work", { snapshot });
    const out = transformOf(plugin)("/", [item("Archive"), item("Projects")]);
    expect(pathsOf(out)).toEqual(["Projects/Work/Overview.md"]);
  });

  it("orders the hoisted rows by an order stored under the root key, not just returns them raw", async () => {
    const plugin = makeFolderSpacePlugin("Projects/Work");
    // Unlike the "" test above (which proves the WRONG key is ignored), this
    // stores under the RIGHT key and proves it actually gets applied — a
    // bypass that returns the hoisted rows straight back would never consult
    // this order at all.
    await storeOrderFor(plugin, "Projects/Work", [
      "Projects/Work/Overview.md",
      "Projects/Work/Hardware",
    ]);
    const out = transformOf(plugin)("/", [item("Projects")]);
    expect(pathsOf(out)).toEqual(["Projects/Work/Overview.md", "Projects/Work/Hardware"]);
  });

  // A folder WITH children but no items to show is a FAILURE (nothing to
  // read `fileItems` off), not "this folder is empty" — `hoistedRootItems`
  // must fall back to normal filtering rather than rendering an empty vault
  // root in that case.
  it("falls back to normal filtering when the view has no item map to read", () => {
    const plugin = makeFolderSpacePlugin("Projects/Work", { view: {} });
    const input = [item("Archive"), item("Projects")];
    expect(transformOf(plugin)("/", input)).toEqual(input);
  });

  // The `""`/`"/"` spellings of the vault root (the missing-root state,
  // `isFolderSpace` true but `rootOf` null) are covered instead by the
  // "missing-root state empties the tree" block below, against a snapshot
  // shaped like the real one.

  // The elsewhere group: a path open outside the root has no scaffold to
  // hang off in a hoisted tree, so it is appended flat, after the hoisted
  // children, rather than dropped.
  it("appends open outside files after the hoisted children", () => {
    const plugin = makeFolderSpacePlugin("Projects/Work");
    (plugin as unknown as { liveLeafPaths: () => Set<string> }).liveLeafPaths = () =>
      new Set(["Archive/Old.md"]);
    const out = transformOf(plugin)("/", [item("Archive"), item("Projects")]);
    expect(pathsOf(out)).toEqual([
      "Projects/Work/Hardware",
      "Projects/Work/Overview.md",
      "Archive/Old.md",
    ]);
  });
});

/**
 * `SpaceController.membersForSnapshot` never returns `null` for the
 * missing-root state: it returns `[]` directly for a DECLARED-but-unusable
 * root (`""`/`"/"`, `hasRoot` true and `rootOf` null) and a single member
 * entry naming a root that resolves to nothing for a root spelled as a real
 * path that just isn't there (`"Projects/Gone"`) — either way
 * `buildVisibilitySnapshot` resolves to an EMPTY visible set, pinned at the
 * controller level in `tests/controller.test.ts`. `emptySnapshot` below
 * models that shape.
 *
 * The missing-root state must render the empty state — the tree empty, with
 * a message naming the missing folder — and must never be auto-repaired to
 * the vault root: honouring `""` or `"/"` as a live root would show the
 * entire vault with nothing hidden, which is *All* wearing a different name
 * and color. Given a missing root, this transform must produce the empty
 * state, never the whole vault, so these tests assert the EMPTY result.
 */
describe("SpacesPlugin.filterAndOrderFolder — the missing-root state empties the tree", () => {
  const emptySnapshot: VisibilitySnapshot = {
    decisionFor: () => ({
      visible: false,
      reason: "hidden-nonmember",
      canRemoveMembership: false,
      overridesIgnore: false,
    }),
    visiblePaths: () => new Set(),
  };

  it("empties the vault root's raw items when the root names a folder gone from the vault", () => {
    const plugin = makeFolderSpacePlugin("Projects/Gone", { snapshot: emptySnapshot });
    const out = transformOf(plugin)("/", [item("Archive"), item("Projects")]);
    expect(out).toEqual([]);
  });

  it('empties the vault root\'s raw items when the root is the unset spelling ""', () => {
    const plugin = makeFolderSpacePlugin("", { snapshot: emptySnapshot });
    const out = transformOf(plugin)("/", [item("Archive"), item("Projects")]);
    expect(out).toEqual([]);
  });

  it('empties the vault root\'s raw items when the root is spelled "/"', () => {
    const plugin = makeFolderSpacePlugin("/", { snapshot: emptySnapshot });
    const out = transformOf(plugin)("/", [item("Archive"), item("Projects")]);
    expect(out).toEqual([]);
  });

  it("empties filtering elsewhere in the tree too, not just at the vault root", () => {
    // A space with no usable root has nothing to show anywhere in the tree,
    // not just at the vault root — the same as a curated space with no
    // members would.
    const plugin = makeFolderSpacePlugin("Projects/Gone", { snapshot: emptySnapshot });
    const out = transformOf(plugin)("Archive", [item("Archive/Old.md")]);
    expect(out).toEqual([]);
  });

  it("still filters normally for a healthy folder space", () => {
    const plugin = makeFolderSpacePlugin("Projects/Work", { snapshot: emptySnapshot });
    const out = transformOf(plugin)("Projects/Work/Hardware", [
      item("Projects/Work/Hardware/Board.md"),
    ]);
    // The root resolves, so this is a legitimately empty space (or folder),
    // same mechanism, nothing special about the missing-root state at all.
    expect(out).toEqual([]);
  });

  it("still filters normally for a curated space with an empty visible set", () => {
    const plugin = makeCuratedPlugin();
    (plugin["controller"] as unknown as { currentSnapshot: () => VisibilitySnapshot }).currentSnapshot =
      () => emptySnapshot;
    const out = transformOf(plugin)("/", [item("Papers"), item("Private.md")]);
    // `isFolderSpace` is false for a curated space; this and the test above
    // confirm the missing-root state needs no special case in this transform
    // at all — it is exactly what plain filtering already does.
    expect(out).toEqual([]);
  });
});

/**
 * `main.ts`'s `apply` callback (passed to `SpaceController` in `onload()`)
 * forwards `elsewhereFirstPath()` into `adapter.apply`'s second argument at
 * ONE call site, extracted here as `applyAdapterSnapshot` precisely so a test
 * can reach it — reverting that line to the old `this.adapter.apply(snap)`
 * passes the whole 1101-test suite, because nothing called it.
 * `explorerAdapter.test.ts` only proves the adapter classes the row it is
 * TOLD about; this proves the caller tells it.
 */
describe("SpacesPlugin.applyAdapterSnapshot — the elsewhere separator's call site", () => {
  function row(path: string): string {
    return `<div class="tree-item"><div class="tree-item-self" data-path="${path}"></div></div>`;
  }

  function wrapperOf(container: HTMLElement, path: string): HTMLElement {
    return container.querySelector(`[data-path="${path}"]`)!.parentElement!;
  }

  // A minimal, hand-written snapshot in both tests below: they are about
  // WIRING (does the call site forward `elsewhereFirstPath()` to the
  // adapter), not about the real visibility engine, which is covered by
  // `visibleItems.test.ts` and the hoisting tests above.
  const passthrough: VisibilitySnapshot = {
    decisionFor: () => ({
      visible: true,
      reason: "visitor",
      canRemoveMembership: false,
      overridesIgnore: false,
    }),
    visiblePaths: () => new Set(),
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("passes elsewhereFirstPath() through to the adapter", () => {
    const plugin = makeFolderSpacePlugin("Projects/Work");
    (plugin as unknown as { liveLeafPaths: () => Set<string> }).liveLeafPaths = () =>
      new Set([OLD_FILE.path]);
    document.body.innerHTML = `<div class="nav-files-container">
      ${row(HARDWARE.path)}${row(OVERVIEW.path)}${row(OLD_FILE.path)}
    </div>`;
    const container = document.querySelector(".nav-files-container") as HTMLElement;
    plugin["adapter"].bind(container);

    plugin["applyAdapterSnapshot"](passthrough);

    expect(wrapperOf(container, OLD_FILE.path).classList.contains(CLS_ELSEWHERE)).toBe(true);
    expect(wrapperOf(container, HARDWARE.path).classList.contains(CLS_ELSEWHERE)).toBe(false);
    expect(wrapperOf(container, OVERVIEW.path).classList.contains(CLS_ELSEWHERE)).toBe(false);
    plugin["adapter"].unbind();
  });

  it("marks nothing when the elsewhere group is empty", () => {
    const plugin = makeFolderSpacePlugin("Projects/Work"); // default liveLeafPaths: empty
    document.body.innerHTML = `<div class="nav-files-container">${row(HARDWARE.path)}${row(OVERVIEW.path)}</div>`;
    const container = document.querySelector(".nav-files-container") as HTMLElement;
    plugin["adapter"].bind(container);
    plugin["applyAdapterSnapshot"](passthrough);
    expect(container.querySelectorAll(`.${CLS_ELSEWHERE}`)).toHaveLength(0);
    plugin["adapter"].unbind();
  });
});

/**
 * `main.ts`'s `apply` callback — the one `SpaceController`'s host actually
 * calls on every switch, refresh, defs change and external change — used to
 * be an inline closure built inside `onload()`, which `Plugin.onload()`
 * refuses to run under Vitest (`obsidian-stub.ts`). Tests reached
 * `applyAdapterSnapshot` and `reportMissingRootIfNeeded` only by calling each
 * directly, so deleting either call FROM the closure left the whole suite
 * green. `main.ts` now names the closure's body `onSnapshotApplied`, so this
 * block calls it the same way `onload()` does and pins both halves.
 */
describe("SpacesPlugin.onSnapshotApplied — the controller's apply callback", () => {
  function row(path: string): string {
    return `<div class="tree-item"><div class="tree-item-self" data-path="${path}"></div></div>`;
  }

  function wrapperOf(container: HTMLElement, path: string): HTMLElement {
    return container.querySelector(`[data-path="${path}"]`)!.parentElement!;
  }

  const passthrough: VisibilitySnapshot = {
    decisionFor: () => ({
      visible: true,
      reason: "visitor",
      canRemoveMembership: false,
      overridesIgnore: false,
    }),
    visiblePaths: () => new Set(),
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("reaches both `adapter.apply`'s elsewhereFirst argument and the missing-root report", () => {
    const plugin = makeFolderSpacePlugin("Projects/Work");
    (plugin as unknown as { liveLeafPaths: () => Set<string> }).liveLeafPaths = () =>
      new Set([OLD_FILE.path]);
    // `onSnapshotApplied` also touches `setSwitchMask`/`syncSpaceSurface`,
    // which read `app.workspace.containerEl.ownerDocument.body` — a fresh
    // element, not the real `document.body`, so this test cannot bleed
    // classList/attribute state into any other test in this file.
    const fakeBody = document.createElement("div");
    (plugin as unknown as { app: unknown }).app = {
      ...folderSpaceApp,
      workspace: { ...folderSpaceApp.workspace, containerEl: { ownerDocument: { body: fakeBody } } },
    };
    document.body.innerHTML = `<div class="nav-files-container">
      ${row(HARDWARE.path)}${row(OVERVIEW.path)}${row(OLD_FILE.path)}
    </div>`;
    const container = document.querySelector(".nav-files-container") as HTMLElement;
    plugin["adapter"].bind(container);
    const reportSpy = vi.spyOn(plugin["missingRoot"], "report");

    plugin["onSnapshotApplied"](passthrough);

    // Half 1: elsewhereFirst reached `adapter.apply` through the real
    // callback, not just through a direct `applyAdapterSnapshot` call —
    // proven the same way `applyAdapterSnapshot`'s own tests above prove it,
    // by the DOM class the adapter applies.
    expect(wrapperOf(container, OLD_FILE.path).classList.contains(CLS_ELSEWHERE)).toBe(true);
    expect(wrapperOf(container, HARDWARE.path).classList.contains(CLS_ELSEWHERE)).toBe(false);
    // Half 2: the missing-root report was actually invoked from here, not
    // just independently testable.
    expect(reportSpy).toHaveBeenCalledTimes(1);

    plugin["adapter"].unbind();
  });
});

/**
 * `reportMissingRootIfNeeded` is the Notice half of the missing-root state —
 * the tree fails open (tested above), but silently: a user watching the
 * vault root suddenly show everything needs to be told why, or it reads as
 * spaces having stopped filtering for no reason.
 */
/** The stub moves a DocumentFragment `message` into `noticeEl` on construction. */
function noticeText(n: (typeof noticeLog)[number]): string {
  return n.noticeEl.textContent ?? "";
}
function noticeChangeButton(n: (typeof noticeLog)[number]): HTMLButtonElement | null {
  return n.noticeEl.querySelector("button");
}

describe("the missing-root Notice", () => {
  beforeEach(() => {
    for (const n of noticeLog) n.__destroy();
    noticeLog.length = 0;
  });

  it("notices once, naming the space and the vanished root, persistently, with a Change folder button", () => {
    const plugin = makeFolderSpacePlugin("Projects/Gone");
    plugin["missingRoot"].report();
    expect(noticeLog).toHaveLength(1);
    // duration: 0 — "the Notice will stay visible until the user manually
    // dismisses it" (obsidian.d.ts) — so the toast never fades on its own.
    expect(noticeLog[0].duration).toBe(0);
    const text = noticeText(noticeLog[0]);
    expect(text).toContain("Work");
    expect(text).toContain("Projects/Gone");
    expect(text).toContain("no longer exists");
    const button = noticeChangeButton(noticeLog[0]);
    expect(button?.textContent).toBe("Change folder…");

    // Still active, still broken, still on screen: a second call must not
    // stack a duplicate Notice on top of the first.
    plugin["missingRoot"].report();
    expect(noticeLog).toHaveLength(1);
  });

  // The tree's empty state must always be explained — an unexplained empty
  // pane is a failure — so both spellings notice too, with wording that says
  // "not chosen" rather than "no longer exists". That distinction is real
  // (nothing broke), even though the tree empties the same way.
  it('notices for the unset root ""', () => {
    const plugin = makeFolderSpacePlugin("");
    plugin["missingRoot"].report();
    expect(noticeLog).toHaveLength(1);
    const text = noticeText(noticeLog[0]);
    expect(text).toContain("Work");
    expect(text).not.toContain("no longer exists");
    expect(text).toContain("no folder has been chosen");
    expect(noticeChangeButton(noticeLog[0])?.textContent).toBe("Change folder…");
  });

  it('notices for the root spelled "/"', () => {
    const plugin = makeFolderSpacePlugin("/");
    plugin["missingRoot"].report();
    expect(noticeLog).toHaveLength(1);
    const text = noticeText(noticeLog[0]);
    expect(text).not.toContain("no longer exists");
    expect(text).toContain("no folder has been chosen");
  });

  it("says nothing for a healthy folder space", () => {
    const plugin = makeFolderSpacePlugin("Projects/Work");
    plugin["missingRoot"].report();
    expect(noticeLog).toEqual([]);
  });

  it("says nothing for a curated space", () => {
    const plugin = makeCuratedPlugin();
    plugin["missingRoot"].report();
    expect(noticeLog).toEqual([]);
  });

  it("hides the Notice (rather than leaving it stale) once the root resolves, and notices again on a fresh break", () => {
    const plugin = makeFolderSpacePlugin("Projects/Gone");
    plugin["missingRoot"].report();
    expect(noticeLog).toHaveLength(1);
    expect(noticeLog[0].hidden).toBe(false);

    // Repaired: the space's root now resolves. The synchronous bracket
    // mutation mirrors how `makeFolderSpacePlugin` seeds `defs` in the first
    // place (both are async elsewhere; this fixture is not).
    plugin["defs"]["defs"].spaces[0].root = "Projects/Work";
    plugin["missingRoot"].report();
    // No SECOND Notice — the first one is hidden, not replaced.
    expect(noticeLog).toHaveLength(1);
    expect(noticeLog[0].hidden).toBe(true);

    // Broken again: reported once more, not silenced forever by the first fix.
    plugin["defs"]["defs"].spaces[0].root = "Projects/Gone";
    plugin["missingRoot"].report();
    expect(noticeLog).toHaveLength(2);
    expect(noticeLog[1].hidden).toBe(false);
  });

  // The SAME space can stay broken while WHAT is wrong
  // about it changes — a "Clear" turns a vanished path into "no folder
  // chosen yet" without the space ever becoming healthy in between, so the
  // toast never went through the resolved branch that would have hidden it.
  it("refreshes the toast's wording in place when the detail changes while the same space stays broken", () => {
    const plugin = makeFolderSpacePlugin("Projects/Gone");
    plugin["missingRoot"].report();
    expect(noticeLog).toHaveLength(1);
    expect(noticeText(noticeLog[0])).toContain("no longer exists");

    // "Cleared" without ever resolving: still broken, different fact.
    plugin["defs"]["defs"].spaces[0].root = "";
    plugin["missingRoot"].report();

    // Same Notice, not a new one — and its own text, not stale wording.
    expect(noticeLog).toHaveLength(1);
    expect(noticeLog[0].hidden).toBe(false);
    const text = noticeText(noticeLog[0]);
    expect(text).not.toContain("no longer exists");
    expect(text).not.toContain("Projects/Gone");
    expect(text).toContain("no folder has been chosen");
  });

  // The SAME fault (the root is still gone) but the SPACE's name changes —
  // `detail` alone does not notice this, because `missingRootDetail` never
  // looks at `space.name`; only `buildMissingRootMessage` does. If the
  // compared key were `detail` alone, this case would fall into the "same,
  // do nothing" branch and the toast would keep showing the pre-rename name
  // until some unrelated change to the root refreshed it too.
  it("refreshes the toast's wording in place when the SPACE is renamed while it stays broken", () => {
    const plugin = makeFolderSpacePlugin("Projects/Gone");
    plugin["missingRoot"].report();
    expect(noticeLog).toHaveLength(1);
    expect(noticeText(noticeLog[0])).toContain("Work");

    // Renamed, still broken, still on screen — the fault text itself
    // (`missingRootDetail`) is unchanged.
    plugin["defs"]["defs"].spaces[0].name = "Renamed";
    plugin["missingRoot"].report();

    // Same Notice, not a new one — but its text now names the new space.
    expect(noticeLog).toHaveLength(1);
    expect(noticeLog[0].hidden).toBe(false);
    const text = noticeText(noticeLog[0]);
    expect(text).toContain("Renamed");
    expect(text).not.toContain('"Work"');
    expect(text).toContain("no longer exists");
    expect(text).toContain("Projects/Gone");
  });

  // The liveness check (`noticeEl.isConnected`) that
  // the coordinator's acceptance of a persistent Notice rests on. The stub's
  // `hide()` deliberately does NOT detach — `main.ts`'s own comment above
  // records the measured real behaviour this mirrors: a Notice stays
  // connected at opacity 1 for a time after `hide()` returns, so making the
  // stub detach synchronously would model the OPPOSITE of what was measured.
  // `__destroy()` is the stub's existing, documented stand-in for "this
  // toast is now actually gone" (already used by `creation.test.ts`'s
  // `beforeEach`), and is what a user's own dismissal — or Obsidian's fade
  // finishing — eventually produces; it is the faithful way to reach this
  // branch without inventing a timer this suite does not want (its own
  // docstring: "inventing a schedule would put a sleep in the suite").
  it("shows a fresh Notice after the user dismisses the toast while the space is still broken", () => {
    const plugin = makeFolderSpacePlugin("Projects/Gone");
    plugin["missingRoot"].report();
    expect(noticeLog).toHaveLength(1);

    // The user dismissed it (or Obsidian's own fade finished) — still broken,
    // nothing else changed.
    noticeLog[0].__destroy();
    plugin["missingRoot"].report();

    // A second Notice, not silence: the liveness check caught that the first
    // one is gone, so this space is not being left to look silently empty.
    expect(noticeLog).toHaveLength(2);
    expect(noticeText(noticeLog[1])).toContain("Projects/Gone");
  });

  it("replaces the Notice, rather than reusing it, when a DIFFERENT broken space becomes active", () => {
    const OTHER: SpaceDefinition = {
      id: "other",
      name: "Other",
      icon: "briefcase",
      color: "#ff5b5b",
      root: "Projects/AlsoGone",
      members: [],
    };
    const plugin = makeFolderSpacePlugin("Projects/Gone");
    // Synchronous bracket mutation, same device as elsewhere in this
    // describe block: `defs.mutate()` is async and this test is not.
    plugin["defs"]["defs"].spaces.push(OTHER);
    plugin["missingRoot"].report();
    expect(noticeLog).toHaveLength(1);
    expect(noticeText(noticeLog[0])).toContain("Work");

    plugin["runtime"].setSelection({ kind: "space", id: "other" });
    plugin["missingRoot"].report();
    expect(noticeLog).toHaveLength(2);
    expect(noticeLog[0].hidden).toBe(true); // the FIRST space's notice came down
    expect(noticeText(noticeLog[1])).toContain("Other");
    expect(noticeText(noticeLog[1])).toContain("Projects/AlsoGone");
  });

  // The affordance, end to end: the button opens a popover (degrading to a
  // plain input under this stub, since `AbstractInputSuggest` requires a real
  // `App` — obsidian-stub.ts's own documented limit), and committing a real
  // folder writes through `setSpaceRoot`, the same validated path creation
  // uses (normalization included).
  it("opens the folder picker from the Change folder button, and a real pick writes through setSpaceRoot", async () => {
    document.body.innerHTML = "";
    const plugin = makeFolderSpacePlugin("Projects/Gone");
    plugin["missingRoot"].report();
    const button = noticeChangeButton(noticeLog[0]);
    expect(button).not.toBeNull();

    button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const popoverInput = document.querySelector(
      ".spaces-folder-picker-popover input"
    ) as HTMLInputElement | null;
    expect(popoverInput).not.toBeNull();

    // "Archive" is a real folder in `folderSpaceTree` (this file's own
    // fixture) — the degraded fallback's `kindOf(...) === "folder"` re-check
    // must accept it.
    popoverInput!.value = "Archive";
    popoverInput!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    // `setSpaceRoot`'s write is a microtask (DefinitionStore.mutate).
    await Promise.resolve();
    await Promise.resolve();

    expect(plugin["defs"]["defs"].spaces[0].root).toBe("Archive");
  });

  it("the picker's Clear action writes an explicit empty root, not a deletion", async () => {
    document.body.innerHTML = "";
    const plugin = makeFolderSpacePlugin("Projects/Gone");
    plugin["missingRoot"].report();
    const button = noticeChangeButton(noticeLog[0]);
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const clearButton = Array.from(
      document.querySelectorAll(".spaces-folder-picker-popover button")
    ).find((b) => b.textContent === "Clear") as HTMLButtonElement | undefined;
    expect(clearButton).toBeDefined();
    clearButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    const space = plugin["defs"]["defs"].spaces[0];
    expect(space.root).toBe("");
    expect(Object.prototype.hasOwnProperty.call(space, "root")).toBe(true);
  });
});

/**
 * `elsewhereOf`'s sorted order is not the same thing as what actually
 * renders. A row can drop out between "sorted into the group" and "rendered
 * as a tree row" — the snapshot can refuse it (a dismissed visitor), or
 * `itemsForPaths` can fail to resolve it — and marking a path that never
 * becomes a row draws no separator at all.
 */
describe("SpacesPlugin.elsewhereFirstPath — marks the first SURVIVING row", () => {
  it("skips a row the snapshot refuses (a dismissed visitor) for the next one", () => {
    const view = {
      fileItems: {
        [HARDWARE.path]: item(HARDWARE.path),
        [OVERVIEW.path]: item(OVERVIEW.path),
        "Alpha/A.md": item("Alpha/A.md"),
        "Zed/Z.md": item("Zed/Z.md"),
      },
    };
    const snapshot: VisibilitySnapshot = {
      decisionFor: (p) =>
        p === "Alpha/A.md"
          ? { visible: false, reason: "hidden-nonmember", canRemoveMembership: false, overridesIgnore: false }
          : { visible: true, reason: "visitor", canRemoveMembership: false, overridesIgnore: false },
      visiblePaths: () => new Set(["Zed/Z.md"]),
    };
    const plugin = makeFolderSpacePlugin("Projects/Work", { view, snapshot });
    // Sorted order is "Alpha/A.md" then "Zed/Z.md" — Alpha is dismissed.
    (plugin as unknown as { liveLeafPaths: () => Set<string> }).liveLeafPaths = () =>
      new Set(["Alpha/A.md", "Zed/Z.md"]);
    expect(plugin["elsewhereFirstPath"]()).toBe("Zed/Z.md");
  });

  it("skips a row itemsForPaths cannot resolve for the next one", () => {
    const view = {
      fileItems: {
        [HARDWARE.path]: item(HARDWARE.path),
        [OVERVIEW.path]: item(OVERVIEW.path),
        "Zed/Z.md": item("Zed/Z.md"),
        // "Alpha/A.md" deliberately absent from `fileItems`: unresolvable.
      },
    };
    const plugin = makeFolderSpacePlugin("Projects/Work", { view });
    (plugin as unknown as { liveLeafPaths: () => Set<string> }).liveLeafPaths = () =>
      new Set(["Alpha/A.md", "Zed/Z.md"]);
    expect(plugin["elsewhereFirstPath"]()).toBe("Zed/Z.md");
  });

  it("returns null when every elsewhere candidate is dropped", () => {
    const view = {
      fileItems: {
        [HARDWARE.path]: item(HARDWARE.path),
        [OVERVIEW.path]: item(OVERVIEW.path),
        "Alpha/A.md": item("Alpha/A.md"),
      },
    };
    const snapshot: VisibilitySnapshot = {
      decisionFor: () => ({
        visible: false,
        reason: "hidden-nonmember",
        canRemoveMembership: false,
        overridesIgnore: false,
      }),
      visiblePaths: () => new Set(),
    };
    const plugin = makeFolderSpacePlugin("Projects/Work", { view, snapshot });
    (plugin as unknown as { liveLeafPaths: () => Set<string> }).liveLeafPaths = () =>
      new Set(["Alpha/A.md"]);
    expect(plugin["elsewhereFirstPath"]()).toBeNull();
  });
});
