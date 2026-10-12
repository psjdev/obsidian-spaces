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

/**
 * A tree item as this harness holds it: Obsidian's own shape plus the `parent`
 * back-pointer, which is the field the C2 defect corrupts.
 *
 * `parent` is not part of `FolderItemLike` because the SEAM never reads it —
 * only Obsidian's `sort()` writes it, through `vChildren.addChild`. It is
 * modelled here and nowhere in `src/` for exactly that reason.
 */
export interface SeamItem extends FolderItemLike {
  parent?: SeamItem | null;
}

export interface SeamHarness {
  filterAndOrderFolder(folderPath: string, items: FolderItemLike[]): FolderItemLike[];
  /**
   * Obsidian's `sort()`, modelled only as far as PARENT POINTERS.
   *
   * `sort()` walks every folder the view knows, calls `getSortedFolderItems`
   * for each, and hands the result to `vChildren.addChild`, which REASSIGNS
   * each returned child's `parent` to the folder being sorted. That last step
   * is the whole mechanism behind C2: a compacted run's tip is returned twice
   * in one pass — once for the head's parent, which is where it is drawn, and
   * once for the run's own unrendered intermediate, which is where it is not —
   * and the later write wins.
   *
   * Folders are visited in `fileItems` insertion order with the VAULT ROOT
   * LAST. The ordering is not arbitrary: the C2 probe measured a real
   * Obsidian 1.13.7 reporting the correct `(root)` parent for a TOP-LEVEL run
   * and the wrong intermediate for a NESTED one, and a root sorted after the
   * run's own folders is the only visit order that produces both. A harness
   * that sorted the root first would make the top-level case look broken too,
   * and would stop telling the two apart.
   */
  sortWholeTree(): void;
  /**
   * The path of the item `sortWholeTree` left as this path's `parent`, `null`
   * for an item nothing adopted, or `undefined` for a path the view does not
   * know. A top-level row reports `""`, the vault root item's own path; the
   * vault root itself reports `null`, because nothing sorts its parent.
   */
  parentPointerOf(path: string): string | null | undefined;
  /** The plugin's own `livePermits`, so the subset guard can be asserted directly. */
  livePermits(folderPath: string, itemPath: string | undefined): boolean;
  /**
   * The vault root's rows out of the REAL patched seam: `ensureOrderingPatched()`
   * installs the override, and this then calls the view's own (now overridden)
   * `getSortedFolderItems`.
   *
   * The distinction `tests/folderSpaceHoistSeam.test.ts` exists for. Reaching
   * `plugin["filterAndOrderFolder"]` by hand bypasses `patch()` entirely — the
   * `isAllowed` guard and the raw-items fallback at
   * `nativeExplorerSort.ts:214` are never on the stack — so a transform
   * returning an out-of-input row that nothing admits still looks correct.
   * Compaction is the SECOND producer of out-of-input rows, and this is how it
   * is held to the same standard.
   */
  sortRootThroughSeam(): FolderItemLike[];
  /** What the seam falls back to on a rejection: the raw, unfiltered rows. */
  rawRootItems(): FolderItemLike[];
  /** The plugin and its one explorer view, for tests that drive the re-sort memo. */
  plugin: SpacesPlugin;
  view: { sort(): void };
}

/** Every folder in the tree, vault root last. See `sortWholeTree` for why. */
function folderVisitOrder(tree: Record<string, string[]>): string[] {
  const folders = Object.keys(tree);
  return [...folders.filter((p) => p !== ""), ...folders.filter((p) => p === "")];
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
  //
  // `fileItems` is also where the NATIVE sort below reads from, so a row that
  // arrives as input and the same row looked up as a substitution tip are the
  // same object — which is what makes the seam's identity-based subset rule
  // mean anything here: the head is in-input, the tip is not.
  const fileItems: Record<string, SeamItem> = Object.fromEntries(
    [...nodes.keys()].map((p) => [p, folderItem(p) as SeamItem])
  );
  const rootNode = nodes.get("");
  // Enough of an explorer view for `probe()` to answer "ok", so
  // `ensureOrderingPatched` will install the real override on it.
  const view = {
    fileItems,
    sortOrder: "alphabetical",
    // Per folder, the way Obsidian's does: the RAW, unfiltered children. This
    // is what `patch`'s override hands the transform, and what it falls back
    // to when `isAllowed` rejects the result.
    getSortedFolderItems(folder: unknown): FolderItemLike[] {
      const kids = (folder as { children?: { path: string }[] } | null)?.children;
      if (!Array.isArray(kids)) return [];
      return kids.flatMap((c) => (fileItems[c.path] ? [fileItems[c.path]] : []));
    },
    sort(): void {
      // Nothing to re-render here.
    },
  };
  (plugin as unknown as { explorerViews: () => object[] }).explorerViews = () => [view];
  // Captured BEFORE the patch, or this would call the override and report the
  // seam's own output as though it were the raw tree.
  const nativeSortRoot = view.getSortedFolderItems.bind(view);
  const rawRootItems = (): FolderItemLike[] => nativeSortRoot(rootNode ?? null);

  // THE point of this harness: the real apply path, which is what calls
  // `rebuildChainIndex`.
  plugin["onSnapshotApplied"](snapshot);

  return {
    // `view` is passed the way the per-view closure in `ensureOrderingPatched`
    // passes it, which is the only way the production seam ever calls this.
    filterAndOrderFolder: (folderPath, items) =>
      plugin["filterAndOrderFolder"](folderPath, items, view),
    sortWholeTree: () => {
      // The production install, so every folder below goes through `patch()`'s
      // override, `isAllowed` and the raw-items fallback — the same stack
      // Obsidian's own `sort()` runs on.
      plugin["ensureOrderingPatched"]();
      for (const path of folderVisitOrder(tree)) {
        const node = nodes.get(path);
        if (!(node instanceof TFolder)) continue;
        const folderItemForPath = fileItems[path];
        // `vChildren.addChild(child)`: the adoption, which is the only part of
        // Obsidian's sort this harness reproduces.
        for (const kid of view.getSortedFolderItems(node)) {
          (kid as SeamItem).parent = folderItemForPath ?? null;
        }
      }
    },
    parentPointerOf: (path) => {
      const item = fileItems[path];
      if (!item) return undefined;
      return item.parent ? (item.parent.file?.path ?? null) : null;
    },
    livePermits: (folderPath, itemPath) => plugin["livePermits"](folderPath, itemPath),
    sortRootThroughSeam: () => {
      // The production install, not a hand-rolled `patch()` call: it is what
      // supplies `livePermits` as the seam's `permits` argument, and that
      // argument is the thing under test.
      plugin["ensureOrderingPatched"]();
      return view.getSortedFolderItems(rootNode ?? null);
    },
    rawRootItems,
    plugin,
    view,
  };
}
