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
import { CLS_COMPACT_PREFIX } from "../../src/explorer/selectors";
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
 * `sortedView` stays null, so when the transform reaches `observeSortOrder()`
 * — which is after the hidden-segment and hoist branches, not at the top — it
 * sees a null sort order, `sortGestureFrom` returns "none", and that step does
 * nothing: no timer is armed and nothing needs tearing down.
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
  /**
   * Paths the VAULT has but this pane holds no tree item for.
   *
   * Obsidian normally keeps an item for every path whether or not it is
   * rendered (measured), so this is a deliberately abnormal pane. It exists
   * because the seam has a fail-open branch for exactly that state —
   * `substituteCompacted` leaves a run uncompacted when the view cannot
   * resolve its tip — and a branch no fixture can reach is a branch nothing
   * holds to anything.
   *
   * WHAT IT CAN MODEL is the seam side: a path the index knows about that this
   * pane answers nothing for, which is what `compactParentPointers.test.ts`
   * drives. WHAT IT CANNOT MODEL is that path with a RENDERED ROW, because the
   * explorer's rows ARE those items' elements — no item, no row — so a probe
   * combining the two measures a fixture artifact and not Obsidian.
   */
  unknownToView?: string[];
  /**
   * How this pane's private sort seam behaves. Defaults to `"ok"`, the state
   * every other suite here assumes.
   */
  seam?: SeamShape;
  /**
   * A SECOND explorer pane, with its own seam shape. Absent by default.
   *
   * Obsidian permits two file explorers (drag the Files tab into a split), and
   * `patch` is per view while the chain index is one object shared by both. A
   * second pane whose seam is not `"ok"` is the two-pane divergence state.
   */
  secondPane?: SeamShape;
  /**
   * Make `explorerViews()` throw, which is how `bindExplorer`'s step 5 fails:
   * the step is wrapped in its own try/catch there, so the plugin carries on
   * with NOTHING patched.
   */
  explorerViewsThrows?: boolean;
  /**
   * Paths to draw as explorer rows in a container bound to the plugin's real
   * `ExplorerAdapter`, so a test can ask which rows were actually labelled.
   *
   * Bound BEFORE the snapshot is applied, the order `bindExplorer` and
   * `controller.refresh()` run in.
   *
   * A FLAT list, which is what most suites here need: one row per path, all
   * siblings, drawn whatever the seam does. Ignored under `renderNested`,
   * which lets the seam decide what exists instead — see there for why that
   * independence matters.
   */
  rows?: string[];
  /**
   * Draw the pane the way Obsidian does: rebuilt by `view.sort()` from
   * whatever the seam returns, recursively.
   *
   * AN ADDITION, NOT A REPLACEMENT. The flat `rows:` path above stays the
   * default and stays faithful for the suites that need one row and no
   * nesting. This mode exists for the questions that are about WHERE a row is
   * drawn, which is the half of compaction a flat fixture cannot pose: a
   * chain that compacted draws as one row where its head was, and a chain
   * that did not draws nested, and here the difference comes out of the seam
   * rather than out of the test's own markup.
   *
   * It also makes `requestResort` mean something. `sort()` is the renderer,
   * so a forced re-sort really does redraw the pane and a test can assert the
   * TREE instead of a call count.
   *
   * The container is bound EMPTY, before the patch, because that is the order
   * production runs in: `bindExplorer` binds and patches, and only the first
   * re-sort puts rows in it.
   */
  renderNested?: boolean;
}

/**
 * How a pane's private sort seam behaves.
 *
 * Every shape but `"ok"` is a state in which nothing re-sorts the tree, so the
 * compacted substitution never reaches the DOM however good the index is.
 *
 * - `"ok"` — the real seam; `probe` answers "ok" and `patch` installs.
 * - `"absent"` — an Obsidian build exposing neither private method, so `probe`
 *   answers "unknown".
 * - `"refused"` — the seam is there, but its own property is non-configurable.
 *   `patch` declines that shape outright rather than shadowing something it
 *   could never remove, which is the co-installed-plugin case.
 * - `"sort-throws"` — patched normally, but `sort()` throws, so
 *   `requestResort` answers false and the tree keeps its previous render.
 */
type SeamShape = "ok" | "absent" | "refused" | "sort-throws";

/**
 * Applies a seam shape to a view that currently has the real one.
 *
 * Called AFTER the native sort is captured and BEFORE `ensureOrderingPatched`,
 * because `patch` reads the property descriptor it is about to shadow.
 */
function shapeSeam(view: Record<string, unknown>, shape: SeamShape): void {
  if (shape === "absent") {
    // From the PROTOTYPE, which is where `seamView` puts them.
    const proto = Object.getPrototypeOf(view) as Record<string, unknown>;
    delete proto.getSortedFolderItems;
    delete proto.sort;
    delete view.getSortedFolderItems;
    delete view.sort;
    return;
  }
  if (shape === "refused") {
    Object.defineProperty(view, "getSortedFolderItems", {
      value: view.getSortedFolderItems,
      writable: true,
      enumerable: true,
      configurable: false,
    });
    return;
  }
  if (shape === "sort-throws") {
    view.sort = (): void => {
      throw new Error("Spaces test: this pane's sort() throws");
    };
  }
}

/**
 * An explorer view whose two seam methods live on a PROTOTYPE.
 *
 * NOT an object literal, and the difference is load-bearing. `patch` shadows
 * `getSortedFolderItems` with an OWN property and `unpatch` `delete`s that own
 * property to restore what was underneath — which is how Obsidian's real
 * `FileExplorerView` works, because its methods come from its class. A fixture
 * holding the method as its own property loses it outright on the first
 * unpatch, so every later `probe` answers "unknown" for a pane that is
 * perfectly healthy, and a pause/resume test would be measuring the fixture
 * rather than the plugin.
 */
function seamView(
  fileItems: Record<string, SeamItem>,
  onSort: () => void
): {
  fileItems: Record<string, SeamItem>;
  sortOrder: string;
  getSortedFolderItems(folder: unknown): FolderItemLike[];
  sort(): void;
} {
  const proto = {
    // Per folder, the way Obsidian's does: the RAW, unfiltered children. This
    // is what `patch`'s override hands the transform, and what it falls back
    // to when `isAllowed` rejects the result.
    getSortedFolderItems(folder: unknown): FolderItemLike[] {
      const kids = (folder as { children?: { path: string }[] } | null)?.children;
      if (!Array.isArray(kids)) return [];
      return kids.flatMap((c) => (fileItems[c.path] ? [fileItems[c.path]] : []));
    },
    sort(): void {
      onSort();
    },
  };
  return Object.assign(Object.create(proto) as typeof proto, {
    fileItems,
    sortOrder: "alphabetical",
  });
}

/**
 * One explorer row, in the shape `applyCompactLabels` is handed and
 * `compact-chains.mjs` measures in a running Obsidian: a `.tree-item` wrapper
 * whose first child is the `[data-path]` `.tree-item-self`, which holds the
 * collapse chevron and `.tree-item-inner`.
 *
 * ONE definition, used by both render modes, so the flat fixture and the
 * nested one cannot drift about what a row looks like.
 */
function rowElement(doc: Document, path: string): HTMLElement {
  const wrapper = doc.createElement("div");
  wrapper.className = "tree-item nav-folder";
  const self = doc.createElement("div");
  self.className = "tree-item-self nav-folder-title";
  self.setAttribute("data-path", path);
  const icon = doc.createElement("div");
  icon.className = "tree-item-icon collapse-icon";
  const inner = doc.createElement("div");
  inner.className = "tree-item-inner nav-folder-title-content";
  inner.textContent = nameOf(path);
  self.appendChild(icon);
  self.appendChild(inner);
  wrapper.appendChild(self);
  return wrapper;
}

/**
 * Rebuild the pane from whatever the view's seam returns, the way Obsidian's
 * own `sort()` does.
 *
 * THE DOM IS A CONSEQUENCE OF THE SEAM HERE, not a second claim about it.
 * Nothing hand-nests the markup beside an assertion: this walks down from the
 * vault root asking `view.getSortedFolderItems` for each folder's rows and
 * draws exactly what comes back. So a chain that compacted draws as one row
 * where its head was, a chain that did not draws nested, and no test can
 * arrange one while the seam is doing the other.
 *
 * IT RENDERS ONLY WHAT THE SEAM RETURNS, which rules out the state the first
 * review's DEFECT 3 probe rested on. A pane that holds no tree item for a path
 * cannot draw a row for it, because the rows ARE those items' elements
 * (`itemsForPaths`'s docblock records the measurement). A fixture with a
 * `rows:` list deciding independently of `fileItems` what exists can model a
 * rendered row with no item behind it, and Obsidian cannot produce one.
 *
 * TOP-LEVEL ROWS GO DIRECTLY INTO `.nav-files-container`, with no root
 * wrapper, and a folder's children into a `.tree-item-children
 * nav-folder-children` that is a direct child of its `.tree-item`, after the
 * `.tree-item-self`. Both are measured shapes: `compact-chains.mjs` asserts a
 * top-level compacted row is at `depth 0`, counting `.nav-folder-children`
 * ancestors.
 *
 * `seen` is a cycle brake and nothing more. A run's tip is returned for its
 * head's parent and the run's hidden segments answer `[]`, so no path is
 * reached twice on any path the transform produces; a fixture that broke that
 * should fail an assertion, not hang the suite.
 */
function renderNestedInto(
  container: HTMLElement,
  view: { getSortedFolderItems(folder: unknown): FolderItemLike[] },
  nodes: Map<string, TFolder | TFile>,
  rootNode: TFolder | TFile | undefined
): void {
  const doc = container.ownerDocument;
  const seen = new Set<string>();
  const draw = (folder: TFolder | TFile | undefined, into: HTMLElement): void => {
    if (!folder) return;
    for (const item of view.getSortedFolderItems(folder)) {
      const path = item.file?.path;
      if (typeof path !== "string" || seen.has(path)) continue;
      seen.add(path);
      const wrapper = rowElement(doc, path);
      into.appendChild(wrapper);
      const node = nodes.get(path);
      if (!(node instanceof TFolder)) continue;
      const kids = doc.createElement("div");
      kids.className = "tree-item-children nav-folder-children";
      wrapper.appendChild(kids);
      draw(node, kids);
    }
  };
  container.replaceChildren();
  draw(rootNode, container);
}

/**
 * A tree item as this harness holds it: Obsidian's own shape plus the `parent`
 * back-pointer, which is the field the C2 defect corrupts.
 *
 * `parent` is not part of `FolderItemLike` because the SEAM never reads it —
 * only Obsidian's `sort()` writes it, through `vChildren.addChild`. It is
 * modelled here and nowhere in `src/` for exactly that reason.
 */
interface SeamItem extends FolderItemLike {
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
   * Folders are visited in the order the FIXTURE declares them (the key order
   * of `tree`), with the VAULT ROOT moved LAST. The root's position is not
   * arbitrary: the C2 probe measured a real Obsidian 1.13.7 reporting the
   * correct `(root)` parent for a TOP-LEVEL run and the wrong intermediate for
   * a NESTED one, and a root sorted after the run's own folders is the only
   * visit order that produces both. A harness that sorted the root first would
   * make the top-level case look broken too, and would stop telling the two
   * apart. Nothing is claimed about the order of the rest: every fixture here
   * declares parents before children, which is enough to reach a run's
   * intermediate after the folder its row is drawn under.
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
  /**
   * `ensureOrderingPatched()` and nothing else.
   *
   * `displayedPaths` reads a folder's rows by calling the view's own
   * `getSortedFolderItems`, so it sees compaction only once the override is
   * installed. The drag tests need that install without also sorting the vault
   * root, which `sortRootThroughSeam` does.
   */
  patchSeam(): void;
  /** The plugin and its one explorer view, for tests that drive the re-sort memo. */
  plugin: SpacesPlugin;
  view: { sort(): void };
  /**
   * The container `opts.rows` or `opts.renderNested` drew into, or null when
   * neither was asked for. Detached from `document.body`, so no suite can
   * bleed rows into another's.
   */
  container: HTMLElement | null;
  /**
   * The paths of the rows the adapter has actually drawn a compacted prefix
   * on, which is the only on-screen evidence that a chain was labelled.
   */
  labelledPaths(): string[];
  /**
   * Every drawn row, in document order, with the depth the user sees it at:
   * the number of `.tree-item-children` wrappers between it and the pane.
   *
   * The on-screen half of compaction, and the only thing that can tell a
   * chain that compacted from one that did not. `compact-chains.mjs` measures
   * exactly this in a running Obsidian and calls a top-level row `depth 0`.
   */
  renderedRows(): { path: string; depth: number }[];
}

/**
 * Every folder the fixture declares, in its own key order, with the vault root
 * moved last. See `sortWholeTree` for why the root's place matters and the
 * rest's does not.
 */
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
      if (!child) return [];
      // The `parent` BACK-POINTER, which Obsidian maintains on every
      // `TAbstractFile` and which `describeRow` is the one reader of here. The
      // stub defaults it to null, so a fixture without this line answers ""
      // for every row's parent - the vault root - and a translation that got
      // the parent wrong would look identical to one that got it right.
      //
      // Distinct from the `parent` on `SeamItem`: that one is the TREE item's
      // pointer, written by Obsidian's `sort()`, and is what C2 corrupts. This
      // one is the VAULT's, which `src/` only ever reads.
      child.parent = node;
      return [child];
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
    [...nodes.keys()]
      .filter((p) => !(opts.unknownToView ?? []).includes(p))
      .map((p) => [p, folderItem(p) as SeamItem])
  );
  const rootNode = nodes.get("");
  // Assigned once the container exists, which is after the view: `sort()`
  // renders into a container that `bindExplorer`'s order says is built later.
  // Null until then, and null forever in the flat mode, where `sort()` has
  // nothing to re-render.
  let renderTree: (() => void) | null = null;
  // Enough of an explorer view for `probe()` to answer "ok", so
  // `ensureOrderingPatched` will install the real override on it.
  const view = seamView(fileItems, () => renderTree?.());
  // Captured BEFORE the patch, or this would call the override and report the
  // seam's own output as though it were the raw tree. Captured before
  // `shapeSeam` too, so a `"absent"` pane can still be asked what the raw
  // tree was.
  const nativeSortRoot = view.getSortedFolderItems.bind(view);
  const rawRootItems = (): FolderItemLike[] => nativeSortRoot(rootNode ?? null);

  shapeSeam(view as unknown as Record<string, unknown>, opts.seam ?? "ok");
  // A second pane needs only what `probe`, `patch` and `requestResort` read;
  // nothing in these tests sorts through it, so it gets an empty item map.
  const secondView =
    opts.secondPane === undefined
      ? null
      : (() => {
          const v = seamView({}, () => {
            // A second pane renders nothing: it exists for `probe`, `patch`
            // and `requestResort`, and no test reads its tree.
          });
          shapeSeam(v as unknown as Record<string, unknown>, opts.secondPane);
          return v as object;
        })();
  const views = secondView === null ? [view as object] : [view as object, secondView];
  (plugin as unknown as { explorerViews: () => object[] }).explorerViews = opts
    .explorerViewsThrows
    ? () => {
        throw new Error("Spaces test: the workspace lookup throws");
      }
    : () => views;

  // Rows first, then the patch, then the snapshot: the order production runs
  // in (`bindExplorer` binds the adapter and installs the seam patch, and only
  // then does `controller.refresh()` reach `onSnapshotApplied`).
  let container: HTMLElement | null = null;
  if (opts.rows || opts.renderNested) {
    container = document.createElement("div");
    container.className = "nav-files-container";
    if (opts.renderNested) {
      // EMPTY at bind time, and filled by the first `requestResort`. That is
      // the production sequence, and it is also what makes the rendered tree
      // evidence about the seam: nothing put a row here that the seam did not
      // return.
      const pane = container;
      renderTree = () => renderNestedInto(pane, view, nodes, rootNode);
    } else if (opts.rows) {
      for (const path of opts.rows) container.appendChild(rowElement(document, path));
    }
    plugin["adapter"].bind(container);
  }

  // Guarded the way `bindExplorer` guards its own step 5: a throw there does
  // not stop the plugin, it just leaves nothing patched.
  try {
    plugin["ensureOrderingPatched"]();
  } catch {
    // The `explorerViewsThrows` shape. Nothing is patched; that is the point.
  }

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
    patchSeam: () => plugin["ensureOrderingPatched"](),
    plugin,
    view,
    container,
    renderedRows: () => {
      if (!container) return [];
      const out: { path: string; depth: number }[] = [];
      container.querySelectorAll<HTMLElement>("[data-path]").forEach((title) => {
        const path = title.getAttribute("data-path");
        if (!path) return;
        let depth = 0;
        for (let el = title.parentElement; el && el !== container; el = el.parentElement) {
          if (el.classList.contains("tree-item-children")) depth += 1;
        }
        out.push({ path, depth });
      });
      return out;
    },
    labelledPaths: () => {
      if (!container) return [];
      const out: string[] = [];
      container.querySelectorAll<HTMLElement>("[data-path]").forEach((title) => {
        if (!title.querySelector(`:scope > .${CLS_COMPACT_PREFIX}`)) return;
        const p = title.getAttribute("data-path");
        if (p) out.push(p);
      });
      return out;
    },
  };
}
