/**
 * Plugin instances for the sort seam, shared by the tests that drive it.
 *
 * `makeBarePlugin` and `folderItem` are lifted verbatim out of
 * `tests/filterAndOrderFolder.test.ts`, which now imports them from here: one
 * construction of a plugin-with-four-collaborators, so a second suite cannot
 * invent a subtly different one.
 *
 * `makePluginForSeam` is the compaction harness. It drives the REAL
 * `onSnapshotApplied`, which is what builds the chain index; setting the index
 * by hand would make the tests pass even if the production wiring had never
 * been written.
 */
import { TFile, TFolder } from "obsidian";
import SpacesPlugin from "../../src/main";
import { DefinitionStore } from "../../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../../src/runtime/RuntimeStateStore";
import type { SpaceController } from "../../src/controller/SpaceController";
import type { FolderItemLike } from "../../src/layout/nativeExplorerSort";
import type { VisibilitySnapshot } from "../../src/visibility/VisibilityEngine";
import { DEFAULT_DEFINITIONS, SCHEMA_VERSION } from "../../src/types";

/** One entry in the shape Obsidian hands to `getSortedFolderItems`. */
export function folderItem(path: string): FolderItemLike {
  return { file: { path } };
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
export function makeBarePlugin(): SpacesPlugin {
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

export interface SeamHarnessOptions {
  compactFolderChains: boolean;
  /** Path to children. A path absent from this map is a note. "" is the vault root. */
  tree?: Record<string, string[]>;
  /** Paths the snapshot reports visible. Everything else is hidden. */
  visible?: string[];
  /** Visible paths whose reason is `exact-member`. Every other visible folder is `scaffold`. */
  members?: string[];
  /** A stored manual order, keyed by folder path with "" for the vault root. */
  order?: Record<string, string[]>;
  /** Pass `null` for All, where the controller has no snapshot. Defaults to a built one. */
  snapshot?: null;
}

export interface SeamHarness {
  filterAndOrderFolder(folderPath: string, items: FolderItemLike[]): FolderItemLike[];
  /** The plugin's own `livePermits`, so the subset guard can be asserted directly. */
  livePermits(folderPath: string, itemPath: string | undefined): boolean;
}

function nameOf(path: string): string {
  return path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
}

/**
 * Real `TFolder`/`TFile` instances for `app.vault.getAbstractFileByPath`.
 *
 * `rebuildChainIndex` asks `instanceof TFolder` and reads `folder.children`,
 * so the `VaultIndex` abstraction `buildFakeVault` produces is the wrong fake
 * here — that one feeds the visibility engine, which this harness stubs out
 * directly instead.
 */
function buildVaultNodes(tree: Record<string, string[]>): Map<string, TFolder | TFile> {
  const paths = new Set<string>();
  for (const [folder, kids] of Object.entries(tree)) {
    paths.add(folder);
    for (const kid of kids) paths.add(kid);
  }
  const nodes = new Map<string, TFolder | TFile>();
  for (const path of paths) {
    const isFolder = Object.prototype.hasOwnProperty.call(tree, path);
    nodes.set(
      path,
      isFolder
        ? Object.assign(new TFolder(), {
            path,
            name: nameOf(path),
            children: [] as (TFolder | TFile)[],
          })
        : Object.assign(new TFile(), { path, name: nameOf(path) })
    );
  }
  for (const [folder, kids] of Object.entries(tree)) {
    const node = nodes.get(folder) as TFolder;
    node.children = kids.flatMap((kid) => {
      const child = nodes.get(kid);
      return child ? [child] : [];
    });
  }
  return nodes;
}

/**
 * A snapshot stated directly rather than derived from the engine: these tests
 * are about what the seam does with "this is visible and it is scaffold", and
 * driving the engine would make the fixture argue about membership precedence
 * instead (`visibleItems.test.ts` owns that).
 */
function snapshotFor(visible: readonly string[], members: readonly string[]): VisibilitySnapshot {
  const vis = new Set(visible);
  const mem = new Set(members);
  return {
    decisionFor: (path) =>
      vis.has(path)
        ? {
            visible: true,
            reason: mem.has(path) ? "exact-member" : "scaffold",
            canRemoveMembership: mem.has(path),
            overridesIgnore: false,
          }
        : {
            visible: false,
            reason: "hidden-nonmember",
            canRemoveMembership: false,
            overridesIgnore: false,
          },
    visiblePaths: () => new Set(vis),
  };
}

/**
 * A plugin whose active space is CURATED (no root, so the hoist branch stays
 * out of the way), over the given tree, with the snapshot already applied
 * through `onSnapshotApplied` — the production call that builds the chain
 * index.
 *
 * `defs`'s internal state is seeded directly (the bracket-notation device
 * `filterAndOrderFolder.test.ts` already uses) rather than through
 * `load()`/`mutate()`: both are async, and these tests are not.
 */
export function makePluginForSeam(opts: SeamHarnessOptions): SeamHarness {
  const tree = opts.tree ?? {};
  const nodes = buildVaultNodes(tree);
  const plugin = makeBarePlugin();

  const store = new DefinitionStore({
    read: async () => undefined,
    write: async () => undefined,
  });
  store["defs"] = {
    schemaVersion: SCHEMA_VERSION,
    settings: {
      ...DEFAULT_DEFINITIONS.settings,
      compactFolderChains: opts.compactFolderChains,
    },
    spaces: [{ id: "space", name: "Space", icon: "folder", color: "#5b5bff", members: [] }],
    ...(opts.order ? { orders: { bySpaceId: { space: opts.order } } } : {}),
  };
  plugin["defs"] = store;
  plugin["runtime"].setSelection({ kind: "space", id: "space" });

  const snapshot =
    opts.snapshot === null ? null : snapshotFor(opts.visible ?? [], opts.members ?? []);
  plugin["controller"] = {
    currentSnapshot: () => snapshot,
  } as unknown as SpaceController;

  // `setSwitchMask`/`syncSpaceSurface` reach `containerEl.ownerDocument.body`;
  // a detached element keeps this harness from bleeding state into any other
  // suite's `document.body`.
  const fakeBody = document.createElement("div");
  (plugin as unknown as { app: unknown }).app = {
    vault: { getAbstractFileByPath: (p: string) => nodes.get(p) ?? null },
    workspace: {
      iterateRootLeaves: (_cb: (leaf: unknown) => void) => {
        // No live leaves: the elsewhere group is empty in a curated space.
      },
      containerEl: { ownerDocument: { body: fakeBody } },
    },
  };

  // The pane `itemsForPaths` reads the substituted tip off. Obsidian keeps an
  // item for every path in the vault, rendered or not, so every node is here.
  const view = {
    fileItems: Object.fromEntries([...nodes.keys()].map((p) => [p, folderItem(p)])),
  };
  (plugin as unknown as { explorerViews: () => object[] }).explorerViews = () => [view];

  // THE point of this harness: the real apply path, which is what calls
  // `rebuildChainIndex`.
  plugin["onSnapshotApplied"](snapshot);

  return {
    // `view` is passed the way the per-view closure in `ensureOrderingPatched`
    // passes it, which is the only way the production seam ever calls this.
    filterAndOrderFolder: (folderPath, items) =>
      plugin["filterAndOrderFolder"](folderPath, items, view),
    livePermits: (folderPath, itemPath) => plugin["livePermits"](folderPath, itemPath),
  };
}
