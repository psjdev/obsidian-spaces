import {
  FileView,
  Menu,
  Notice,
  Platform,
  Plugin,
  TFile,
  TFolder,
  type Command,
  type WorkspaceLeaf,
} from "obsidian";
import { DefinitionStore } from "./definitions/DefinitionStore";
import { RuntimeStateStore } from "./runtime/RuntimeStateStore";
import { SpaceController } from "./controller/SpaceController";
import { ExplorerAdapter } from "./explorer/ExplorerAdapter";
import { CLS_SWITCHING, SEL } from "./explorer/selectors";
import { SwitcherView } from "./ui/SwitcherView";
import { SpaceHeaderView } from "./ui/SpaceHeaderView";
import { SpaceSuggestModal } from "./ui/SpaceSuggestModal";
import { spaceEntries } from "./ui/spaceEntries";
import { knownIconIds } from "./ui/knownIcons";
import { CreateSpacePanel } from "./ui/CreateSpacePanel";
import type { VaultSource } from "./ui/createSpaceForm";
import { createObsidianVaultIndex } from "./visibility/ObsidianVaultIndex";
import { repairOnRename, repairRenameIn } from "./lifecycle/pathRepair";
import {
  correlate,
  prune as pruneMoveBuffer,
  type VaultEventRecord,
} from "./lifecycle/moveCorrelator";
import { createVaultChangeCoalescer } from "./lifecycle/eventCoalescer";
import { registerMembershipMenus } from "./actions/membership";
import {
  createSpace,
  renameSpace,
  setSpaceRoot,
  startingSpaceColor,
} from "./actions/spaceLifecycle";
import { setStripPlacement } from "./actions/stripPlacement";
import {
  newNoteInActiveSpace,
  newFolderInActiveSpace,
  rootIsFolder,
} from "./actions/creation";
import { installNewFileRedirect } from "./actions/newFileLocation";
import { installNativeCreateRedirect } from "./actions/nativeNewFileParent";
import { armIntent, matchIntent, type CreationIntent } from "./actions/creationIntent";
import { canOfferCreateSpaceFromFolder } from "./actions/createSpaceMenu";
import { inheritedFromFolder } from "./actions/membershipMenu";
import { canonicalPath } from "./visibility/glob";
import { PublicApi } from "./api/PublicApi";
import { MissingRootNotice } from "./ui/MissingRootNotice";
import { SpacesSettingTab, type EffectiveRestoreState } from "./ui/SettingsTab";
import { createObsidianLayoutPort } from "./layout/ObsidianLayoutPort";
import { LayoutCoordinator } from "./layout/LayoutCoordinator";
import { detectNativeWorkspaces, effectiveRestoreLayouts } from "./layout/nativeWorkspaces";
import {
  displayedPaths,
  itemsForPaths,
  nativeSortedItems,
  patch as patchExplorerSort,
  probe as probeExplorerSort,
  readSortOrder,
  requestResort,
  unpatch as unpatchExplorerSort,
  type FolderItemLike,
  type SortSeamStatus,
} from "./layout/nativeExplorerSort";
import { filterVisibleItems } from "./visibility/visibleItems";
import type { VisibilitySnapshot } from "./visibility/VisibilityEngine";
import {
  elsewhereOf,
  isVaultRoot,
  makePermits,
  rootOf,
  type Permits,
} from "./visibility/folderSpace";
import { applyOrder, compact, type OrderMap } from "./order/orderModel";
import { orderingEnabledFor } from "./order/orderingScope";
import {
  isOverridden,
  isOverrideActionable,
  sortMenuRowState,
  sameSelection,
  shouldExplainBlockedDrag,
  shouldRecordSortOverride,
  sortGestureFrom,
} from "./order/sortOverride";
import {
  armMenuInjection,
  cancelMenuInjection,
  type MenuPrototype,
} from "./ui/nativeMenuInjection";
import { computeDrop, type DropEdge } from "./order/dropIntent";
import { DragOrdering } from "./order/DragOrdering";
import { livePathsFrom, type LeafProbe } from "./explorer/leafVisitors";
import type {
  ActiveSelection,
  SpacesApi,
  SpacesDefinitions,
  SwitchOutcome,
} from "./types";

/**
 * The label for spaces's own ordering, where it sits as a MODE among
 * Obsidian's six in the sort menu. Named once because the blocked-drag Notice
 * points at it by name, and a Notice naming a menu entry that reads differently
 * is worse than one naming no entry at all.
 */
const SORT_MENU_MODE = "User ordered";

/**
 * What the last re-sort was FOR: the transform's own inputs, read back
 * so a re-sort that would reproduce them can be skipped. See
 * `applyFilterAndOrdering` for the completeness argument.
 */
interface ResortSignature {
  /** *All* and the per-space maps stay structurally separate; so does this. */
  selection: string;
  /** `orderMapFor()`'s result, by identity — see the completeness argument. */
  order: OrderMap | undefined;
  /** The snapshot's own visible set, or null for *All*, where nothing filters. */
  visible: Set<string> | null;
}

function sameResortSignature(a: ResortSignature, b: ResortSignature): boolean {
  if (a.selection !== b.selection || a.order !== b.order) return false;
  if (a.visible === b.visible) return true;
  if (!a.visible || !b.visible) return false;
  // Membership, not a serialisation: this runs on every commit, and sorting
  // and joining the set would cost more than it saves in a large space.
  if (a.visible.size !== b.visible.size) return false;
  for (const p of a.visible) if (!b.visible.has(p)) return false;
  return true;
}

/**
 * Structural equality for the small, JSON-safe definitions shape.
 *
 * Exported only so `tests/renameEarlyOut.test.ts` can state the guarantee
 * `renameTouchesDefs` makes in terms of it; nothing in `src/` imports it.
 */
export function sameDefs(a: SpacesDefinitions, b: SpacesDefinitions): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The marker: the supported way for another plugin to detect that the file
 * tree it is looking at is a SUBSET of the vault. The sort seam renders only
 * the active space's rows, so a note-count badge, a folder decorator or a
 * file-icon plugin walking `.tree-item` is counting a filtered tree with
 * nothing to tell it so. (The seam's method name is deliberately not written
 * here: the quarantine greps only work while the private names appear in no
 * other file, comments included.)
 *
 * Lives on `document.body`, for the reason `CLS_SWITCHING` records in
 * `src/explorer/selectors.ts`: measured across a switch, `changeLayout()`
 * replaces the `.nav-files-container`, the view's `containerEl` and the left
 * split itself, so an attribute on any explorer element is destroyed by the
 * next switch. The body is the only node in the sequence that survives.
 * Belongs beside `CLS_SWITCHING`; it sits here until it can be moved.
 */
const ATTR_SPACE = "data-spaces-space";

/**
 * Whether a rename of `oldPath` -> `newPath` COULD change anything spaces
 * stores: a short-circuiting prefix scan over the stored strings, allocating
 * nothing.
 *
 * ONE-DIRECTIONAL by construction. `false` must mean "the repair provably
 * returns an equal document"; `true` only means "cannot rule it out", and the
 * exact `sameDefs(...repairOnRename(...))` comparison still runs behind it —
 * worth doing at V3's measured 0.2 ms per call at a realistic document size,
 * and not worth doing at any risk of a false `false`.
 *
 * Covers every string `repairOnRename` reads: `root`, each space's member
 * paths, and the KEYS as well as the entries of every order map (order lists
 * are keyed by folder path, so a folder rename rewrites keys too). `newPath`
 * counts as a hit because the move branch drops an entry already equal to the
 * destination, which is a change with no rewrite anywhere. Member
 * de-duplication needs no check: `validateMembers` de-duplicates on the way
 * in, so a document holding a member path twice cannot reach here.
 */
export function renameTouchesDefs(
  defs: SpacesDefinitions,
  oldPath: string,
  newPath: string
): boolean {
  const under = `${oldPath}/`;
  // Segment-aware, not a bare `startsWith`: "Papers2/A.md" is not under
  // "Papers", and treating it as though it were would spend the full
  // comparison on every rename of a folder whose name prefixes another's.
  const hit = (s: string): boolean =>
    s === oldPath || s === newPath || s.startsWith(under);

  for (const space of defs.spaces) {
    if (space.root !== undefined && hit(space.root)) return true;
    for (const m of space.members) if (hit(m.path)) return true;
  }

  const maps: OrderMap[] = [];
  if (defs.orders?.all) maps.push(defs.orders.all);
  if (defs.orders?.bySpaceId) maps.push(...Object.values(defs.orders.bySpaceId));
  for (const map of maps) {
    for (const [folder, order] of Object.entries(map)) {
      // "" is the vault root key and is never rewritten; `hit` cannot
      // match it anyway, since a vault path is never the empty string.
      if (hit(folder)) return true;
      for (const entry of order) if (hit(entry)) return true;
    }
  }
  return false;
}

export default class SpacesPlugin extends Plugin {
  /**
   * `private` here is a COMPILE-TIME marker: it stops a TypeScript consumer
   * and documents intent, but every one of these is still an ordinary own
   * property on the plugin instance, reachable from the console and from any
   * JavaScript plugin. Nothing in an Obsidian plugin can make them
   * unreachable, so the honest claim is "undeclared and unsupported", not
   * "enforced" — `api` below is the declared surface.
   */
  private defs!: DefinitionStore;
  private runtime!: RuntimeStateStore;
  private controller!: SpaceController;

  /**
   * Takes `fileManager.getNewFileParent` back off. Null until `start()`
   * installs it, and null again once teardown has run.
   */
  private restoreNewFileParent: (() => void) | null = null;

  /** Takes the two quarantined creation patches back off. */
  private restoreNativeCreate: (() => void) | null = null;
  private layout!: LayoutCoordinator;
  private nativeWorkspacesWarned = false;
  // A runtime-state write failure warns, but a Notice on every
  // failed write would be worse than the silence it replaces.
  private runtimeWriteWarned = false;
  private adapter = new ExplorerAdapter();
  private switcher: SwitcherView | null = null;
  private header: SpaceHeaderView | null = null;
  /** The one-shot gesture a native create may be attributed to. */
  private creationIntent: CreationIntent | null = null;
  /** A few seconds of create/delete history, never persisted. */
  private moveBuffer: VaultEventRecord[] = [];
  /** The sort order last seen, so a change can be told from a re-sort. */
  private lastSortOrder: string | null = null;
  /**
    * The deferred write's timer id, so it can be cancelled on unload rather
    * than firing for a plugin that is no longer loaded. Non-null also means a
    * gesture is already pending, which is what dedupes the write.
    */
  private sortGestureTimer: number | null = null;
  /**
   * The live blocked-drag Notice, or null. Kept only so a repeat attempt
   * REUSES the toast rather than stacking a second identical one; every
   * blocked drag still gets feedback. Not a notify-once flag — the predicate
   * that decides whether to speak is stateless, deliberately.
   *
   * `Notice.hide()` is the obvious way to do this and does not work: measured
   * against 1.13.7, a notice is still connected at opacity 1 seconds after
   * `hide()` returns. Removing the element by hand means reaching for
   * `noticeEl.parentElement` (`noticeEl` is the inner `.notice-message`, not
   * the toast) — undocumented structure, and a selector outside
   * `selectors.ts`. So the live one is reused instead.
   */
  private blockedDragNotice: Notice | null = null;
  // Built fresh per open (never cached/reused) so `defaultColor` — a
  // plain string captured at construction — reflects the rotation at the
  // moment the panel opens rather than whichever value was true the first
  // time this field was populated. Kept only for the open-check and
  // teardown; see openCreatePanel().
  private createPanel: CreateSpacePanel | null = null;
  // Guards start() against a race with onunload: onLayoutReady can fire
  // after the plugin has already been unloaded (a toggle during startup, or
  // a fast reload cycle). Without this, start() would install a
  // MutationObserver, append the switcher, and register vault listeners on
  // a Component that will never unload again.
  private loaded = false;
  private unsubscribeDefs: (() => void) | null = null;

  /**
   * Held, rather than handed to `addSettingTab` and forgotten, because a
   * declarative settings tab does not re-read its own definitions: Obsidian
   * asks once at registration and renders that. The definition subscription
   * below is what tells it the space list moved.
   */
  private settingTab: SpacesSettingTab | null = null;
  /**
   * The last probe result, kept so the fixture-vault verification and a
   * support question can both read it without reaching into the quarantine
   * module.
   *
   * `private` because it was one of the eight fields that formed the plugin's
   * accidental public API, and the deliberate surface is `api` below. The
   * fixture check reads it by bracket access, which keeps the intent visible at
   * the call site instead of implying support for it here.
   */
  private sortProbe: SortSeamStatus | null = null;
  /**
   * Every main-window explorer view we hold a patch on, in
   * workspace order. `sortedViews[0]` is the PRIMARY — the pane the chrome,
   * the drag gesture and the sort-order observation all read, because
   * each of those is one interaction with one pane. Filtering and ordering
   * are not: they are the selection, and the selection applies to
   * every leaf.
   */
  private sortedViews: object[] = [];
  /**
   * The signature of the last re-sort that actually happened, or null
   * for "the next one must run". See `applyFilterAndOrdering`.
   */
  private lastResort: ResortSignature | null = null;
  private sortProbeWarned = false;
  private dragOrdering: DragOrdering | null = null;
  // ExplorerAdapter.onHealthChange already fires only on a transition, but
  // this flag is a second guard against notifying more than once per break
  // — reset when health returns so a later break is reported again.
  private explorerHealthWarned = false;
  /**
   * The manual fail-open escape hatch. Every other fail-open
   * path is automatic, and "Switch to All" is not the same thing —
   * *All* is still a managed mode that applies `orders.all`, the switch mask
   * and the sort patch. While this is set the seam is released entirely, so
   * the explorer is Obsidian's own unfiltered, natively sorted tree.
   */
  private filteringPaused = false;
  /**
   * The declared extension surface, reachable the conventional way as
   * `app.plugins.plugins.spaces.api`. A field initialiser rather than
   * something built in `onload`, so a consumer that reaches the plugin object
   * at all reaches a complete API — the methods resolve their collaborators
   * when called, not when built.
   */
  /**
   * The declared surface, and the accessors behind it. Built here rather than
   * in `start()` because `api` must exist the moment the plugin object does;
   * every dependency is read per call for the same reason.
   */
  /**
   * Announces a folder pinned space whose folder is missing, and carries the
   * repair. Built here so it exists before `start()`; its dependencies are
   * read per call for the same reason.
   */
  private readonly missingRoot = new MissingRootNotice({
    app: () => this.app,
    activeSpace: () => this.publicApi.activeSpace(),
    folders: () => this.folderSource(),
    setRoot: (spaceId, path) => setSpaceRoot(this.defs, spaceId, path),
  });

  private readonly publicApi = new PublicApi({
    spaces: () => (this.defs as DefinitionStore | undefined)?.get().spaces ?? [],
    selection: () => (this.runtime as RuntimeStateStore | undefined)?.getSelection() ?? null,
    filteringPaused: () => this.filteringPaused,
  });

  readonly api: SpacesApi = this.publicApi.surface;

  override async onload(): Promise<void> {
    this.loaded = true;
    this.defs = new DefinitionStore(
      {
        read: () => this.loadData(),
        write: (d) => this.saveData(d),
        // Data.json is the only copy of a user's curation. Obsidian's
        // File Recovery core plugin snapshots Markdown only, so nothing else
        // in the app holds a previous version of it.
        //
        // A sidecar `.bak` rather than write-temp-then-rename because
        // `Plugin.saveData` must stay the writer of data.json itself: it is
        // what stamps the mtime Obsidian compares in `_onConfigFileChange`,
        // so a rename that bypassed it would make every local save look like
        // an external change and re-enter external-wins arbitration against
        // ourselves.
        // The sidecar sits beside it and is never read by Obsidian.
        backup: (d) =>
          this.app.vault.adapter.write(
            `${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json.bak`,
            JSON.stringify(d, null, 2)
          ),
      },
      (message) => new Notice(message)
    );
    const outcome = await this.defs.load();
    if (!outcome.ok) {
      // Say that nothing will be saved either, so the
      // user does not curate for twenty minutes into a store that is refusing
      // every write.
      new Notice(
        outcome.futureSchema
          ? "Spaces: settings are from a newer version. Showing all files, and not saving changes."
          : `Spaces: settings could not be read (${outcome.error}). Showing all files, and not saving changes.`
      );
    }

    this.runtime = new RuntimeStateStore(
      {
        get: (k): unknown => this.app.loadLocalStorage(k),
        set: (k, v) => this.app.saveLocalStorage(k, v),
      },
      (e) => {
        if (this.runtimeWriteWarned) return;
        this.runtimeWriteWarned = true;
        new Notice(
          `Spaces: could not save layout/selection state (${String(e)}).`
        );
      }
    );
    this.runtime.load();
    // A space removed by a data.json hand-edit (bypassing the Settings
    // Delete button) must not orphan its layout blob forever.
    //
    // Only when the load actually succeeded. A failed or corrupt read leaves
    // `defs` at DEFAULT_DEFINITIONS (spaces: []) without touching disk, so
    // reconciling against that list would delete every captured layout and
    // persist the deletion — turning a transient read error into permanent
    // data loss once the definitions come back.
    if (outcome.ok) {
      this.runtime.reconcileLayouts(this.defs.get().spaces.map((s) => s.id));
    }

    this.settingTab = new SpacesSettingTab(
        this.app,
        this,
        this.defs,
        {
          onDeleted: (id) => {
            this.runtime.dropLayoutFor(id);
            // A deleted space's Notice (and its "Change
            // folder…" popover, if open) must not outlive it — nothing else
            // would ever ask this space's root about anything again.
            this.missingRoot.clearIfAbout(id);
            // An override outlives its space otherwise, and runtime state
            // has no UI to tidy one.
            //
            // ORDERING: `deleteSpace` (src/actions/spaceLifecycle.ts) calls
            // `defs.mutate()` BEFORE this `onDeleted` hook, and `mutate()`'s
            // synchronous notify drives `controller.refresh()` (and so
            // `host.apply` / `applyFilterAndOrdering()`) off definitions that
            // already reflect the deletion. The re-sort has therefore happened
            // by the time this runs, so this hook need not force one; the
            // override it drops only guards against stale data if the id is
            // reused. Hook before mutate would run this cleanup while
            // `defs.get()` still holds the space, so `refresh()`'s
            // active-space lookup would still see it — do not reorder them.
            this.runtime.dropSortOverrideFor(id);
          },
        },
        () => this.effectiveRestoreState(),
        // "unknown" means the seam is gone, so the toggle says so
        // rather than silently doing nothing. Null means we have not probed
        // yet (no explorer bound), which is not a failure to report.
      () => ({ available: this.sortProbe !== "unknown" }),
      // The switcher does not exist yet at this point in `onload()`; deferred
      // the same way the two accessors above are, so it is read when a
      // placement change actually happens rather than now.
      () => this.switcher?.cancelDrag()
    );
    this.addSettingTab(this.settingTab);

    this.app.workspace.onLayoutReady(() => this.start());
  }

  /** Plugin.onExternalSettingsChange — the external-wins policy. */
  override async onExternalSettingsChange(): Promise<void> {
    // Capture the external bytes FIRST: before any queued local write (e.g.
    // from a membership change) can clobber a hand-edit of data.json. Nothing
    // may precede that capture, so the write token is taken before the read as
    // well — a write landing during the await is exactly the local write
    // `onExternalChange` has to detect before it re-persists the external
    // document and tells the user their change was superseded.
    //
    // Obsidian awaits this without a catch, so a rejection becomes an
    // unhandled rejection attributed to the host. The capture and the apply
    // are one unit, but the three repaints below are independent readers of
    // the same store, so each is guarded on its own: a switcher that cannot
    // draw must not leave the header showing the superseded space.
    try {
      const token = this.defs.writeToken();
      const snapshot: unknown = await this.loadData();
      await this.defs.onExternalChange(snapshot, token);
    } catch (e) {
      console.error("Spaces: could not apply an external data.json change", e);
      return;
    }
    this.repaintStep("controller.refresh", () => this.controller?.refresh());
    this.repaintStep("switcher.render", () => this.switcher?.render());
    this.repaintStep("header.render", () => this.header?.render());
  }

  /**
   * One chrome repaint, isolated. The switcher, the header and the
   * controller all read the same store and none depends on another having
   * drawn, so a throw from one must not leave the others showing state that
   * has already been replaced — the same reasoning as `bindExplorer` steps 3
   * and 3b, which are guarded separately from each other for this reason.
   */
  private repaintStep(what: string, step: () => void): void {
    try {
      step();
    } catch (e) {
      console.error(`Spaces: ${what} failed after an external change`, e);
    }
  }

  /**
   * `onload` ends at `workspace.onLayoutReady(() => this.start())` — a bare
   * callback Obsidian invokes with no catch of its own, so an unguarded throw
   * is reported against Obsidian rather than spaces, and the user is told
   * nothing at all while the file tree quietly never filters.
   *
   * A TOP-LEVEL guard, unlike the per-step guarding teardown uses: `onunload`'s
   * steps are independent removals, whereas `startSteps()` builds a chain, so
   * continuing past a failed step would install half a plugin that reports
   * itself as working. Stop, say so where the user can see it, and leave the
   * tree unfiltered: filtering fails open.
   */
  private start(): void {
    if (!this.loaded) return;
    try {
      this.startSteps();
    } catch (e) {
      console.error("Spaces: failed to start; the file tree is unfiltered", e);
      new Notice(
        "Spaces: failed to start — the file tree is showing every note, " +
          "unfiltered. Your spaces are untouched. See the developer console " +
          "for the error, then reload the plugin."
      );
    }
  }

  private startSteps(): void {
    this.adapter.onHealthChange((healthy) => {
      if (healthy) {
        this.explorerHealthWarned = false;
        return;
      }
      if (this.explorerHealthWarned) return;
      this.explorerHealthWarned = true;
      new Notice(
        "Spaces: stopped de-emphasising scaffold and visitor rows — the file " +
          "explorer layout was not recognised. Spaces still filter the tree; only " +
          "the dimming stopped."
      );
    });

    this.layout = new LayoutCoordinator(
      createObsidianLayoutPort(this.app),
      this.runtime
    );

    this.controller = new SpaceController(
      this.defs,
      this.runtime,
      createObsidianVaultIndex(this.app.vault),
      {
        apply: (snap) => this.onSnapshotApplied(snap),
        livePaths: () => this.liveLeafPaths(),
      },
      {
        transition: (from, to) =>
          this.runMaskedTransition(from, to),
        // ChangeLayout() tears down and rebuilds the explorer
        // view DOM, and the layout-change event it fires is not a reliable
        // signal to rebind — it can arrive before the new container exists,
        // leaving the adapter bound to a detached node with no notice. Rebind
        // explicitly here instead. onOutcome runs after transition resolves
        // and before the selection commits and recompute() runs (see the
        // controller.test.ts test asserting that ordering), so bind always
        // happens before the tree is re-classed. "skipped" means restoration
        // never touched the DOM, so there is nothing to rebind.
        onOutcome: (outcome) => {
          if (outcome.kind !== "skipped") this.bindExplorer();
          this.reportLayoutOutcome(outcome);
        },
      }
    );

    // Obsidian's own new-note gestures — Ctrl+N, the ribbon, the explorer
    // button, anything else that asks — land inside a folder space's pinned
    // folder. Installed ONCE here rather than in `bindExplorer`, which runs
    // many times; the module refuses a second install, but relying on that
    // would leave the intent unstated. `activeSpaceRoot` is passed as a
    // function and read per call: the patch outlives every space
    // switch, so a captured root would go on writing into the folder the
    // user used to be in.
    this.restoreNewFileParent = installNewFileRedirect(this.app, () => this.activeSpaceRoot());
    // The explorer's context menu takes a third route: its items create
    // straight into the menu's target folder and never ask `getNewFileParent`
    // at all (measured). Right-clicking the empty body reports the VAULT ROOT
    // as that target, so in a folder space the note landed outside the space
    // it was made in. Private API, quarantined — see the module header.
    this.restoreNativeCreate = installNativeCreateRedirect(this.app, () =>
      this.activeSpaceRoot()
    );

    this.bindExplorer();
    this.controller.refresh();

    // `New space` in the menu the explorer opens on a right-click below the
    // tree. `file-menu` is public and, as the handler further down notes,
    // fires for the empty explorer body with the vault root as the file,
    // which is exactly the case this wants and no other.
    //
    // Registered BEFORE `registerMembershipMenus` on purpose. Obsidian adds
    // its own four creation entries first, then runs listeners in
    // registration order, so this is what puts `New space` above
    // `Add to space` rather than below it. A listener of our own, rather
    // than moving the membership one, keeps that reordering out of the file
    // and folder menus, which are not part of this.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!isVaultRoot(file.path)) return;
        menu.addItem((i) =>
          i.setTitle("New space").setIcon("layers").onClick(() => this.openCreatePanel())
        );
      })
    );

    registerMembershipMenus(this, { defs: this.defs, controller: this.controller });

    // Routed through the controller, not a plain refresh(),
    // because opening is also un-dismissing. `onActiveFileChanged`'s string
    // branch clears any prior "Stop showing here" dismissal for that path, so
    // a file the user deliberately reopens reappears instead of staying
    // filtered out; a bare refresh() would re-add the path to the live set
    // but never touch the dismissal. Which branch to take, and what each one
    // does, is the controller's call — this file has no tests to catch the
    // two branches being swapped.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) =>
        this.controller.onActiveFileChanged(file instanceof TFile ? file.path : null)
      )
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        // Closing (rather than trying to survive) a panel whose
        // container was rebuilt is correct — but not on EVERY layout-change
        // (see bindExplorer(), which does this conditionally).
        this.bindExplorer();
        this.controller.refresh();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        // Voided, like the delete and create handlers below. Returning the
        // promise hands Obsidian's emitter something it never awaits, so a
        // rejection surfaces as an unhandled rejection blamed on Obsidian.
        void this.onVaultChange(async () => {
          // The repair is computed from the DRAFT, inside the queue.
          // Computing it out here and `Object.assign`ing it over the draft
          // overwrites anything that landed while the mutation waited —
          // another rename's repair, a membership add, a settings change.
          //
          // The read below stays outside on purpose, as a cheap early-out:
          // most renames touch no space, and `mutate` always validates, writes
          // and notifies, so skipping is worth a stale read. The window it can
          // get wrong is narrow and benign — only a reference to the OLD path
          // appearing after this check would skip a repair that was due,
          // leaving a dangling member, a state the rest of the plugin
          // tolerates. It cannot lose a write, which is the failure that would
          // matter. `renameTouchesDefs` is cheap in fact as well as in name:
          // a short-circuiting scan, with the exact whole-document comparison
          // running only when it cannot rule a change out.
          const current = this.defs.get();
          if (!renameTouchesDefs(current, oldPath, file.path)) return;
          if (sameDefs(current, repairOnRename(current, oldPath, file.path))) return;
          try {
            await this.defs.mutate((d) => repairRenameIn(d, oldPath, file.path));
          } catch (e) {
            // A failed write leaves members pointing at the old path, which the
            // rest of the plugin tolerates. `mutate` raises nothing itself when
            // the write fails, so without this the user sees nothing at all.
            // Matches what `repairIfMoved` does for the external-move path.
            console.error("Spaces: could not repair paths after a rename", e);
          }
        });
      })
    );
    // A delete removes NO metadata. Sweeping every member at or under the
    // deleted path silently destroys membership whenever a member is
    // rearranged on disk, because Obsidian reports an external move as
    // create-then-delete rather than a rename (measured). Do not add such a
    // sweep — see `pathRepair.ts`.
    //
    // The delete is also where an external move is usually recognised,
    // since the matching create has already arrived by then.
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        // The correlation runs INSIDE `onVaultChange`'s queue rather
        // than after it. `onVaultChange` no longer re-indexes per event, so
        // sequencing it before the repair bought nothing; being on the queue
        // does buy something, namely that a delete's repair cannot interleave
        // with a concurrent rename's.
        void this.onVaultChange(() => this.repairIfMoved(file, "delete"));
      })
    );
    // A native create is attributed to a preceding explorer gesture, or
    // to nothing at all.
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        void this.onVaultChange(async () => {
          // No full re-index is awaited first. The re-index is coalesced, and
          // nothing here needs it: `joinOnCreate` reads `creationIntent`,
          // `defs` and the active space, and never the vault index. The
          // coalesced flush lands after the write either way, so the settled
          // state is the same.
          await this.joinOnCreate(file);
          // Buffered here too. Create-first held in every measurement, but
          // that is watcher behaviour rather than a contract, so both
          // directions are recorded and either can complete the pair.
          await this.repairIfMoved(file, "create");
        });
      })
    );
    // The coalescing window is a live timer, so it must not outlive the
    // plugin. `register` runs this on unload with the rest of the teardown.
    this.register(() => this.vaultChanges.cancel());
    // The body marker comes off and every API subscriber is dropped.
    // Through `register` rather than a line in `onunload` for the same reason
    // the coalescer above uses it — the state is created here, so its release
    // belongs here.
    this.register(() => this.releaseSpaceSurface());

    // The right-click half of the gesture. `file-menu` is public and
    // carries the folder the user acted on — the empty explorer body reports
    // the vault root as "/", which is the case that started this. Not filtered
    // by `source`: `armIntent` already requires a FOLDER target, and arming on
    // a folder menu from anywhere is harmless because only a create in that
    // folder consumes it.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        this.creationIntent = armIntent({
          target: { path: file.path, isFolder: file instanceof TFolder },
          activeSpaceId: this.controller.activeSpace()?.id ?? null,
          now: Date.now(),
        });

        // The entry point for turning a folder into a
        // folder space. `canOfferCreateSpaceFromFolder` (createSpaceMenu.ts)
        // owns the decision — "only in All" (since inside a space
        // the same folder may be a scaffold, a member, or hoisted content,
        // and the gesture reads differently in each) AND "never the vault
        // root" (the empty explorer body, per this handler's own comment
        // above, fires `file-menu` with exactly that folder — offering the
        // item there used to open the panel on an unusable, invisibly
        // rejected root). Extracted to a pure predicate rather than left
        // inline so this one-line, easy-to-regress condition has a direct
        // test.
        if (
          canOfferCreateSpaceFromFolder(
            { path: file.path, isFolder: file instanceof TFolder },
            this.controller.activeSpace()?.id ?? null
          )
        ) {
          menu.addItem((i) =>
            i
              .setTitle("Create folder pinned space")
              .setIcon("folder-plus")
              .onClick(() => this.openCreatePanel({ root: file.path }))
          );
        }
      })
    );

    // The button half. The explorer's own new-note/new-folder buttons
    // fire no `file-menu`, so the destination is computed the same way Obsidian
    // computes it, from public API. Registered once on the document rather than
    // per-bind, because `bindExplorer` runs many times and would stack
    // listeners; `registerDomEvent` takes it off on unload.
    this.registerDomEvent(
      document,
      "click",
      (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const btn = target.closest(SEL.navActionButton);
        if (!btn || !btn.closest(SEL.fileExplorerPane)) return;
        // "New folder", in a folder space, goes to the pinned folder.
        //
        // Measured: Obsidian's new-note path asks `getNewFileParent` (which
        // `installNewFileRedirect` patches), but its new-FOLDER path never
        // calls it at all — it dropped the folder at the vault root by its
        // own route. So this half cannot ride the same hook and the gesture
        // is taken over instead: stop Obsidian's handler and run ours, which
        // already lands in the root and already notices a missing one.
        //
        // Capture phase, so this runs before the explorer's own listener.
        // Only while a folder space is active; in All or a curated space the
        // click falls through untouched.
        if (btn.querySelector(SEL.newFolderButtonIcon) && this.activeSpaceRoot() !== null) {
          e.preventDefault();
          e.stopPropagation();
          void newFolderInActiveSpace(this.app, {
            defs: this.defs,
            controller: this.controller,
          });
          return;
        }
        const source = this.app.workspace.getActiveFile()?.path ?? "";
        this.creationIntent = armIntent({
          target: { path: this.app.fileManager.getNewFileParent(source).path, isFolder: true },
          activeSpaceId: this.controller.activeSpace()?.id ?? null,
          now: Date.now(),
        });
        if (btn.querySelector(SEL.sortButtonIcon)) this.armSortMenuRow(btn, e);
      },
      true
    );

    this.unsubscribeDefs = this.defs.subscribe(() => {
      // Covers `allowReordering` being toggled — the settings tab only
      // mutates defs. Patched BEFORE refreshing, not after: the first ever
      // bind has `sortedView` still null going in, and `controller.refresh()`
      // below reaches `host.apply` → `applyFilterAndOrdering()`, which is a
      // no-op while `sortedView` is null. Patching first means that call
      // lands against the freshly patched view instead of finding nothing to
      // resort. `bindExplorer` and `onOutcome` already patch-then-refresh;
      // this was the one call site with the order inverted.
      //
      // Guarded the same way, and for the same reason, as `bindExplorer` step
      // 5: now that this runs FIRST in the callback rather than
      // last, an uncaught throw here would take `controller.refresh()` and the
      // two repaints below down with it — DefinitionStore.notify only isolates
      // BETWEEN subscribers, not between statements within one.
      try {
        this.ensureOrderingPatched();
      } catch (e) {
        console.error(
          "Spaces: defs-subscription ensureOrderingPatched failed",
          e
        );
      }
      this.controller.refresh();
      // ORDER MATTERS: `applyPlacement` must run before `render()`, not
      // after. `render()` is the only place that draws the grip's icon and
      // measures the rail, and both derive from `this.axis`, which derives
      // from `this.placement` -- so a `render()` that runs first draws for
      // the placement this strip is LEAVING. Swapped, `render()` always
      // finishes with the placement definitions already hold.
      this.switcher?.applyPlacement(this.defs.get().settings.stripPlacement);
      this.switcher?.render();
      // A rename, icon or colour change repaints both chrome surfaces
      // together — two readers of one store.
      this.header?.render();
      // And the settings tab, which is a third reader and the only one that
      // cannot notice on its own: Obsidian asks a declarative tab for its
      // definitions once, at registration, so a space created from the
      // explorer never reached it. Guarded like the call above, because a
      // throw here would take the repaints with it, and no-ops unless the
      // space list actually moved.
      try {
        this.settingTab?.refreshIfSpacesChanged();
      } catch (e) {
        console.error("Spaces: defs-subscription settings refresh failed", e);
      }
    });

    // Registered from ONE list, so the table, README and this file
    // have a single thing to agree with — and so the set is readable by a test
    // (`Plugin.addCommand` is not modelled by the `obsidian` stub, and a
    // command that is not in the list is not registered).
    for (const spec of this.commandSpecs()) this.addCommand(spec);
  }

  /**
   * The commands, as data.
   *
   * Built per call rather than held as a field: `creationCtx` captures `defs`
   * and `controller`, and the controller does not exist until `start()` has
   * run.
   */
  private commandSpecs(): Command[] {
    const creationCtx = { defs: this.defs, controller: this.controller };
    return [
      {
        id: "switch-to-all",
        name: "Switch to All",
        callback: () => void this.controller.switchTo({ kind: "all" }),
      },
      {
        id: "next-space",
        name: "Next space",
        callback: () => void this.cycle(1),
      },
      {
        id: "previous-space",
        name: "Previous space",
        callback: () => void this.cycle(-1),
      },
      {
        id: "switch-to-space",
        name: "Switch to space",
        callback: () => {
          new SpaceSuggestModal({
            app: this.app,
            // Built at open time, not at registration: the list has to
            // reflect a space created, renamed or deleted since Obsidian
            // started, and commands are registered exactly once.
            entries: () =>
              spaceEntries(
                this.defs.get().spaces,
                this.runtime.getSelection(),
                knownIconIds()
              ),
            switchTo: (key) => this.controller.switchTo(key),
          }).open();
        },
      },
      {
        id: "create-space",
        name: "Create space",
        callback: () => {
          void (async () => {
            // The panel mounts into the file-explorer pane, so the
            // command must surface that pane first.
            const leaf = this.explorerLeaf();
            if (!leaf) return;
            await this.app.workspace.revealLeaf(leaf);
            this.openCreatePanel();
          })();
        },
      },
      {
        id: "new-note-in-active-space",
        name: "New note in active space",
        checkCallback: (checking) => {
          const ok = this.controller.activeSpace() !== null;
          if (ok && !checking) void newNoteInActiveSpace(this.app, creationCtx);
          return ok;
        },
      },
      {
        id: "new-folder-in-active-space",
        name: "New folder in active space",
        checkCallback: (checking) => {
          const ok = this.controller.activeSpace() !== null;
          if (ok && !checking) void newFolderInActiveSpace(this.app, creationCtx);
          return ok;
        },
      },
      {
        // The answer to the cold-start problem: a new space's tree is empty,
        // so without this the only route to its first member is to open a
        // file, let it appear as a visitor, and right-click a scaffold
        // ancestor.
        id: "add-active-file-to-space",
        name: "Add active file to space",
        checkCallback: (checking) => {
          // Offered only when it would DO something: it is disabled in *All*,
          // and a file that is already covered would gain a second claim on
          // the same path (the check `joinOnCreate` makes).
          if (!this.activeFileToAdd()) return false;
          if (!checking) void this.addActiveFileToSpace();
          return true;
        },
      },
      {
        // The manual fail-open hatch. Every fail-open path today is
        // automatic, and "Switch to All" is not one — *All* is still a
        // managed mode that applies `orders.all`, the switch mask and the sort
        // patch. A plugin that patches the explorer's sort should ship a way to
        // see the raw tree.
        //
        // One toggling command rather than a pause/resume pair: a command's
        // name is fixed at registration, so a palette holding both would always
        // show the one that does nothing.
        id: "pause-filtering",
        name: "Pause or resume space filtering",
        callback: () => this.setFilteringPaused(!this.filteringPaused),
      },
      {
        id: "restore-saved-ordering",
        name: "Restore saved ordering",
        checkCallback: (checking) => {
          // `isOverridden` alone would offer this command even when ordering
          // is blocked for the current selection anyway, in which case running
          // it clears the flag with no visible effect. Composed the same way
          // as the menu row and the Notice, so all three agree.
          const ok = isOverrideActionable(
            this.runtime.getSelection(),
            this.runtime.getSortOverrides(),
            this.defs.get().settings
          );
          if (ok && !checking) this.restoreSavedOrdering();
          return ok;
        },
      },
      // Same setter the Settings dropdown and a completed drag use, so a
      // hotkey can never disagree with either about where the strip is.
      ...(["top", "bottom", "left", "right"] as const).map((where) => ({
        id: `move-strip-${where}`,
        name: `Move the space strip to the ${where}`,
        callback: () => {
          // Cancels a drag in flight before writing, so a move command run
          // mid-gesture ends the gesture cleanly rather than racing it.
          void setStripPlacement(this.defs, where, () => this.switcher?.cancelDrag());
        },
      })),
      // A pair gated on `checkCallback`, not one command named "lock or
      // unlock the strip": a command's name is fixed at registration, so a
      // single toggle would either lie about which way it is about to go or
      // sit unhelpfully vague. Offering exactly one at a time, worded as the
      // action about to happen, is the point — unlike `pause-filtering`
      // above, which genuinely has only one name because it has no visible
      // "which way" to word.
      {
        id: "unlock-strip",
        name: "Unlock the space strip",
        checkCallback: (checking: boolean) => {
          if (!this.switcher || this.switcher.isUnlocked()) return false;
          if (!checking) this.switcher.setUnlocked(true);
          return true;
        },
      },
      {
        id: "lock-strip",
        name: "Lock the space strip",
        checkCallback: (checking: boolean) => {
          if (!this.switcher?.isUnlocked()) return false;
          if (!checking) this.switcher.setUnlocked(false);
          return true;
        },
      },
    ];
  }

  /**
   * The active file and space, when adding one to the other would
   * change something — and `null` otherwise, which is what makes the command
   * grey out rather than run to no effect.
   */
  private activeFileToAdd(): { spaceId: string; path: string } | null {
    const space = this.publicApi.activeSpace();
    if (!space) return null;
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    // The same fold the membership writes use, so a file the
    // space already stores in another casing is not offered again.
    if (space.members.some((m) => canonicalPath(m.path) === canonicalPath(file.path))) {
      return null;
    }
    // Already covered by a member folder, so an exact entry would be a second
    // claim on the same path — the same reasoning as `joinOnCreate`.
    if (inheritedFromFolder(space, file.path) !== null) return null;
    return { spaceId: space.id, path: file.path };
  }

  /**
   * The body of the `add-active-file-to-space` command.
   *
   * Re-reads the target inside, rather than trusting what `checkCallback`
   * saw: the palette can check and invoke on separate ticks, and the active
   * file can move between them.
   */
  private async addActiveFileToSpace(): Promise<void> {
    const target = this.activeFileToAdd();
    if (!target) return;
    try {
      await this.defs.mutate((d) => {
        const space = d.spaces.find((s) => s.id === target.spaceId);
        if (
          space &&
          !space.members.some((m) => canonicalPath(m.path) === canonicalPath(target.path))
        ) {
          // "file": the active file is a file. The kind decides whether
          // descendants inherit membership, so it is not cosmetic.
          space.members.push({ path: target.path, kind: "file" });
        }
      });
    } catch (e) {
      // The note is untouched; only the membership write failed.
      new Notice(`Spaces: could not add it to the space (${String(e)})`);
    }
  }

  /**
   * the fail-open escape hatch.
   *
   * Pausing RELEASES the sort seam rather than short-circuiting the transform:
   * `unpatch` deletes the override and forces `sort()`, so the explorer is
   * Obsidian's own unfiltered, natively sorted tree in the same tick — which is
   * what "show me the raw tree" has to mean if it is to be trusted when
   * something else has gone wrong.
   *
   * The active space is NOT changed. Nothing is written, no layout moves, and
   * resuming puts the same space back; the pause is a view state, not a switch.
   */
  private setFilteringPaused(paused: boolean): void {
    if (this.filteringPaused === paused) return;
    this.filteringPaused = paused;
    if (paused) {
      this.teardownOrdering();
    } else {
      this.ensureOrderingPatched();
      this.applyFilterAndOrdering();
    }
    // The marker describes what the tree IS, so it must not claim a filtered
    // tree while the filter is off.
    this.syncSpaceSurface();
    new Notice(
      paused
        ? "Spaces: filtering paused — the file explorer is showing the whole vault. " +
          "Run the command again to resume."
        : "Spaces: filtering resumed."
    );
  }

  /**
   * Grants membership for a create that a gesture accounts for, and
   * does nothing otherwise.
   *
   * Coverage is deliberately partial: a right-click in the
   * explorer (including the empty body) and the explorer's own action buttons
   * are attributable; Ctrl+N, Templater, QuickAdd, importers and sync are not,
   * and keep the behaviour.
   */
  private async joinOnCreate(file: TFile | TFolder | { path: string }): Promise<void> {
    const intent = this.creationIntent;
    if (!intent) return;

    const parentPath =
      "parent" in file && file.parent ? file.parent.path : null;
    const match = matchIntent({
      intent,
      created: { path: file.path, parentPath, isFolder: file instanceof TFolder },
      activeSpaceId: this.controller.activeSpace()?.id ?? null,
      now: Date.now(),
    });
    if (!match) return;
    // One-shot, consumed whether or not a write follows: the gesture produced
    // its file, and a second create must not ride the same right-click.
    this.creationIntent = null;

    const space = this.defs.get().spaces.find((s) => s.id === match.spaceId);
    if (!space) return;
    // Already covered by a folder member, so an exact entry would be a second
    // claim on the same path. Pure, and free of the two traps recorded in
    // creationIntent.ts: no stale snapshot, and no treating a visitor as a
    // member. A path under a member folder that `globalIgnore` hides stays
    // hidden — the ignore rule is as deliberate as the create.
    if (inheritedFromFolder(space, match.path) !== null) return;

    try {
      await this.defs.mutate((d) => {
        const s = d.spaces.find((x) => x.id === match.spaceId);
        // For consistency with the membership writes.
        if (s && !s.members.some((m) => canonicalPath(m.path) === canonicalPath(match.path))) {
          s.members.push({ path: match.path, kind: match.kind });
        }
      });
    } catch (e) {
      // The file exists and is never touched. Only membership failed.
      new Notice(`Spaces: created it, but could not add it to the space (${String(e)})`);
    }
  }

  /**
   * Recognises an external move and repairs the paths it broke.
   *
   * Obsidian reports such a move as `create` then `delete` with nothing linking
   * them. `correlate` joins the pair on `size`+`ctime`+`mtime` — the
   * filesystem's own stamps, identical on both sides of a move and of an
   * in-place rename — and hands back the `(oldPath, newPath)` that
   * `repairOnRename` already consumes.
   *
   * Declining is the default: no partner, an ambiguous partner, an empty folder,
   * a cross-volume move whose `ctime` changed, a file that left the vault
   * altogether — all fall through to the keep-the-entry. This can only ever
   * upgrade a delete to a move on positive evidence.
   */
  private async repairIfMoved(
    file: TFile | TFolder | { path: string },
    kind: "create" | "delete"
  ): Promise<void> {
    const now = Date.now();
    const record: VaultEventRecord = {
      kind,
      path: file.path,
      isFolder: file instanceof TFolder,
      size: "stat" in file && file.stat ? file.stat.size : null,
      ctime: "stat" in file && file.stat ? file.stat.ctime : null,
      mtime: "stat" in file && file.stat ? file.stat.mtime : null,
      at: now,
    };

    this.moveBuffer = pruneMoveBuffer(this.moveBuffer, now);
    const match = correlate({ buffer: this.moveBuffer, event: record });
    // Appended AFTER correlating, so an event can never pair with itself.
    this.moveBuffer.push(record);
    if (!match) return;

    // As in the rename handler above, the repair is computed from the DRAFT
    // inside the queue, so a change that lands while this mutation waits is
    // not overwritten by a document that predates it.
    //
    // The read here is the same cheap early-out, with the same bounds: most
    // moves touch nothing spaces stores, and staying silent matters as well
    // as staying cheap, because a Notice for a move that changed nothing of
    // ours would be noise. The scan short-circuits, and the exact
    // comparison runs only when it cannot rule a change out.
    const current = this.defs.get();
    if (!renameTouchesDefs(current, match.oldPath, match.newPath)) return;
    if (sameDefs(current, repairOnRename(current, match.oldPath, match.newPath))) return;

    try {
      await this.defs.mutate((d) => repairRenameIn(d, match.oldPath, match.newPath));
    } catch (e) {
      console.error("Spaces: could not repair paths after an external move", e);
      return;
    }
    // Announced on purpose. This is a correlation, not something Obsidian told
    // us, so a heuristic that rewrites stored metadata says so and stays
    // undoable by hand.
    new Notice(`Spaces: followed ${match.oldPath} → ${match.newPath}`);
  }

  /**
   * A full re-index, a full visibility snapshot and a forced full explorer
   * re-sort per vault event measures ~2-9 ms in *All* and up to ~1,630 ms for
   * a space of five real project folders, per event — and a sync, a `git
   * pull`, a restore or an importer pays that once per file.
   *
   * The membership work still runs immediately and in order; only the tail
   * behind it is coalesced. `eventCoalescer.ts` carries the correctness
   * argument and the choice of window.
   */
  private readonly vaultChanges = createVaultChangeCoalescer({
    timer: {
      set: (fn, ms) => window.setTimeout(fn, ms),
      clear: (handle) => window.clearTimeout(handle),
      now: () => Date.now(),
    },
    flush: () => {
      // The vault index is a snapshot; replace it in place so every captured
      // controller reference stays valid. Built at flush time, so it is the
      // burst's end state rather than any intermediate one.
      this.controller.setVaultIndex(createObsidianVaultIndex(this.app.vault));
      this.controller.refresh();
    },
  });

  private async onVaultChange(fn: () => Promise<unknown>): Promise<void> {
    await this.vaultChanges.submit(fn);
  }

  private async cycle(delta: number): Promise<void> {
    const spaces = this.defs.get().spaces;
    if (spaces.length === 0) return;
    const order: ActiveSelection[] = [
      { kind: "all" },
      ...spaces.map((s) => ({ kind: "space", id: s.id }) satisfies ActiveSelection),
    ];
    // Resolved inside switchTo's queue, from the COMMITTED selection.
    // Reading `runtime.getSelection()` here made a key-repeated "Next space"
    // resolve both presses against the same index: the second one advanced
    // nowhere and ran a self-transition that pruned the target's saved layout.
    await this.controller.switchTo((current) => {
      const i = order.findIndex((o) => sameSelection(o, current));
      return order[(i + delta + order.length) % order.length];
    });
  }

  /** Derived every time; the persisted preference is never rewritten. */
  private effectiveRestore(): boolean {
    const status = detectNativeWorkspaces(this.app);
    const configured = this.defs.get().settings.restoreLayouts;
    const effective = effectiveRestoreLayouts(configured, status);
    // Only notice when the user's own preference is on but something else
    // overrides it — a user who never wanted restoration should not be told
    // about a plugin they may not even know exists.
    if (configured && !effective && status !== "disabled" && !this.nativeWorkspacesWarned) {
      this.nativeWorkspacesWarned = true;
      new Notice(
        status === "enabled"
          ? "Spaces: the core Workspaces plugin is enabled, so spaces is not restoring layouts."
          : "Spaces: could not determine whether the core Workspaces plugin is active, so layout restoration is off."
      );
    }
    if (status === "disabled") this.nativeWorkspacesWarned = false;
    return effective;
  }

  /**
   * Side-effect-free counterpart of effectiveRestore(), for the Settings tab:
   * rendering settings must never fire a Notice or touch the warned flag —
   * only an actual switch attempt does that.
   *
   * Gated on the detected status alone, NOT on whether it currently changes
   * the toggle's effect: a user who reads the toggle ON has already read
   * "restoring", so if core Workspaces is enabled or undetectable the warning
   * must show whatever the toggle says. Gating on `effective !== configured`
   * would hide it exactly when it matters most, and `SettingsTab`'s `onChange`
   * does not re-render, so the pane would sit on "ON" with no warning until
   * the next real switch.
   */
  private effectiveRestoreState(): EffectiveRestoreState {
    const status = detectNativeWorkspaces(this.app);
    if (status === "disabled") return {};
    const reason =
      status === "enabled"
        ? "the core Workspaces plugin is enabled"
        : "spaces could not determine whether the core Workspaces plugin is active";
    return { reason };
  }

  /**
   * `aborted` is SpaceController's own kind, not the coordinator's, so it is
   * spelled structurally here rather than imported (see `TransitionAborted` in
   * src/controller/SpaceController.ts). It means the transition REJECTED:
   * nothing was applied, and the selection does not commit either,
   * so the switch simply did not happen. Without this branch that path is a
   * completely silent no-op — the user clicks a space and nothing at all
   * occurs. Deliberately not the `failed-open` wording: the workspace was not
   * left half-applied.
   */
  private reportLayoutOutcome(
    outcome: SwitchOutcome | { kind: "aborted"; reason: string }
  ): void {
    if (outcome.kind === "aborted") {
      new Notice("Spaces: could not switch space — the layout change failed, so you are still in the previous space.");
    } else if (outcome.kind === "rolled-back") {
      new Notice("Spaces: that space's saved layout could not be restored; kept the previous one.");
    } else if (outcome.kind === "failed-open") {
      new Notice("Spaces: layout restore failed. Your tabs may not match this space.");
    }
  }

  /**
   * The three Obsidian-specific facts `livePathsFrom` needs. Kept as
   * thin as possible: this file has no tests, so every line of judgement
   * belongs in `leafVisitors.ts` instead.
   */
  private leafProbe(): LeafProbe {
    return {
      fileViewPath: (leaf) => {
        const view = (leaf as { view?: unknown }).view;
        if (!(view instanceof FileView)) return null;
        const file = view.file;
        return file instanceof TFile ? file.path : null;
      },
      stateFilePath: (leaf) => {
        const state = (leaf as { getViewState(): { state?: unknown } })
          .getViewState().state as { file?: unknown } | undefined;
        return typeof state?.file === "string" ? state.file : null;
      },
      resolveFilePath: (path) => {
        const f = this.app.vault.getAbstractFileByPath(path);
        return f instanceof TFile ? f.path : null;
      },
    };
  }

  /**
   * Main-window leaves only. `iterateRootLeaves` walks the main
   * workspace root, so sidebar tool panes (backlink, outline, outgoing-link)
   * are excluded — each of those tracks whichever file it is describing and
   * carries that path in its view state, and they were previously revealing
   * three unrelated notes in every space.
   */
  private liveLeafPaths(): Set<string> {
    const leaves: unknown[] = [];
    this.app.workspace.iterateRootLeaves((leaf) => {
      leaves.push(leaf);
    });
    return livePathsFrom(leaves, this.leafProbe());
  }

  private bindExplorer(): void {
    // Every main-window leaf, not `[0]`. The chrome below still
    // takes the PRIMARY one — the switcher renders in one
    // pane — but the adapter binds them all, because row classes are the
    // selection and the selection applies to every leaf.
    const leaves = this.explorerLeaves();
    const containers: HTMLElement[] = [];
    let container: HTMLElement | null = null;
    for (let i = 0; i < leaves.length; i++) {
      const c = leaves[i].view?.containerEl?.querySelector<HTMLElement>(SEL.container) ?? null;
      // The primary's container specifically, for the create panel's coverage
      // check below — leaves[0] may be the one that has none.
      if (i === 0) container = c;
      if (c) containers.push(c);
    }
    const leaf = leaves[0] as WorkspaceLeaf | undefined;
    // `changeLayout()` destroys `.nav-files-container` while rebuilding the
    // explorer. A layout-change landing in that window finds no container —
    // without this branch the adapter keeps its old binding to the detached
    // node, so every later `apply()` writes classes nowhere visible,
    // `isHealthy()` stays true (a detached-but-populated container still has
    // titles), and `unbind()`'s cleanup, scoped to `this.container`, can never
    // reach the live tree either. Unbinding here is safe: an unfiltered tree
    // is the fail-open outcome, and the next layout-change/onOutcome rebinds.
    //
    // Guarded on its own: this runs inside a `layout-change` handler, and an
    // uncaught throw must not skip the close decision, the switcher (re)mount,
    // the re-sync below, or the `controller.refresh()` that both call sites
    // run right after `bindExplorer()` returns.
    try {
      if (containers.length > 0) this.adapter.bindAll(containers);
      else this.adapter.unbind();
    } catch (e) {
      console.error("Spaces: bindExplorer step 1 (adapter bind/unbind) failed", e);
    }

    const leafRoot = leaf?.view?.containerEl;

    // Close the panel only when it is no
    // longer covering the SAME `.nav-files-container` it inerted — not
    // merely when it is still parented under the same `leafRoot`. Checking
    // parent identity alone correctly
    // survives `revealLeaf()`'s debounced layout-change (nothing rebuilt,
    // so the panel must stay open) but ALSO survives a real
    // `changeLayout()` rebuild, because `containerEl` (`leafRoot`) persists
    // across that rebuild while `.nav-files-container` underneath it does
    // not (see the comment five lines up) — so the panel never closes and the
    // freshly-built tree, never scanned into its `inertSiblings`, is live
    // and tabbable behind the overlay. Reachable via the command palette
    // (not blocked by `inert`): open the panel, then "Next space" ->
    // switchTo -> a real changeLayout() restore. `container` is the same
    // node just queried above — no second query, no new selector string.
    if (this.createPanel && !(leafRoot && this.createPanel.isStillCovering(leafRoot, container))) {
      try {
        this.createPanel.close();
      } catch (e) {
        // This runs inside a workspace event handler
        // — a throw here must not skip the switcher (re)mount or
        // controller.refresh() below it.
        console.error("Spaces: create-space panel failed to close", e);
        this.createPanel = null;
      }
    }

    if (leafRoot) {
      // Guarded on its own, separately from the re-sync below.
      // `SwitcherView.mount()` (src/ui/SwitcherView.ts) appends its new
      // element to `leafRoot` *before* calling `render()`, so a throw from
      // `render()` (e.g. `setIcon()`, or a `defs.get()`/`getSelection()`
      // failure) still leaves a freshly-created, non-inert, tabbable
      // switcher node attached behind an open panel. Catching here
      // stops that throw from also skipping the re-sync immediately below.
      try {
        this.switcher ??= new SwitcherView(
          this.defs,
          this.runtime,
          this.controller,
          () => this.openCreatePanel(),
          // The same composition as the command and the Notice —
          // `isOverridden` alone would offer this row even when ordering is
          // blocked for the selection, where clicking it does nothing visible.
          (key) => isOverrideActionable(key, this.runtime.getSortOverrides(), this.defs.get().settings),
          (key) => {
            // Restoring a space you are not in would be a silent write
            // to something off screen, so switch there first.
            if (!sameSelection(key, this.runtime.getSelection())) {
              void this.controller
                .switchTo(key)
                .then(() => this.restoreSavedOrdering())
                .catch((e: unknown) => {
                  console.error("Spaces: switching space failed", e);
                });
              return;
            }
            this.restoreSavedOrdering();
          }
        );
        this.switcher.mount(leafRoot);
        this.switcher.applyPlacement(this.defs.get().settings.stripPlacement);
      } catch (e) {
        console.error("Spaces: bindExplorer step 3 (switcher.mount) failed", e);
      }

      // Guarded separately from the switcher above for the same
      // reason: `mount()` attaches its element before `render()` runs, so a
      // throw from `render()` would otherwise leave a bare, non-inert node
      // attached AND skip the inert re-sync below. Mounted BEFORE that
      // re-sync so an open create panel covers the header too.
      try {
        this.header ??= new SpaceHeaderView(
          this.defs,
          this.runtime,
          (id, name) => renameSpace(this.defs, id, name),
          (key) => this.controller.switchTo(key),
          // The same vault question `destinationFolder` asks, so the
          // header's "(missing)" and the creation path agree about what a
          // usable root is.
          (path) => rootIsFolder(this.app, path)
        );
        this.header.mount(leafRoot);
      } catch (e) {
        console.error("Spaces: bindExplorer step 3b (header.mount) failed", e);
      }

      // SwitcherView.mount() destroys and
      // recreates its own element on EVERY call, including when the panel
      // above was just kept open — a rebuilt-container check alone
      // misses this. Re-sync inert siblings after the remount, only when
      // the panel is still open, so the fresh switcher node (and anything
      // else new here) is covered too, not just whatever existed at the
      // panel's original mount().
      //
      // Guarded independently of step 3 above. This is the step
      // that actually keeps `inert` correct — SwitcherView.mount() rebuilds
      // its element on every call, so a switcher is never born inert, and
      // this re-sync is what fixes that — so it must still run even
      // when step 3 just threw.
      if (this.createPanel?.isOpen) {
        try {
          this.createPanel.resyncInertSiblings(leafRoot);
        } catch (e) {
          console.error("Spaces: bindExplorer step 4 (resyncInertSiblings) failed", e);
        }
      }
    }

    // Step 5: install or refresh the ordering patch. Last, because it
    // is the only step that depends on nothing else here, and guarded like its
    // neighbours so a failure cannot skip anything above it. This also
    // covers a space switch: `ensureOrderingPatched` no longer triggers a
    // re-sort itself, and `requestResort` is the direct `sort()`, not queued
    // (nativeExplorerSort.ts explains why the queued form left windowed rows
    // stale). The ordering that matters — filter reflecting the new space
    // before the tree re-sorts — holds because `onOutcome` runs before
    // `runtime.setSelection`, and the actual re-sort rides `host.apply` after
    // the selection commits. That ordering is ASSERTED, not assumed — it is
    // one of the four facts the fixture-vault pass verifies.
    try {
      this.ensureOrderingPatched();
    } catch (e) {
      console.error(
        "Spaces: bindExplorer step 5 (ensureOrderingPatched) failed",
        e
      );
    }
  }

  /**
   * Builds a fresh `CreateSpacePanel` per open, mounted into the file-explorer
   * leaf's `containerEl` - the same element `bindExplorer()` passes to
   * `this.switcher.mount()` - so the panel lands as a sibling of
   * `.nav-files-container` rather than a child of it.
   *
   * Deliberately NOT cached across opens: `defaultColor` is a plain string
   * captured once at construction, so a reused instance would keep offering
   * whichever rotation colour was true the first time this ran. Reading `defs`
   * here, before any push, is what makes a create right after open get the
   * swatch the panel actually offered. `this.createPanel` exists only for the
   * open-check below and for `layout-change`/`onunload` teardown to reach the
   * current instance.
   *
   * `opts.root`: the folder context menu's "Create space from this folder" is
   * the one caller that supplies it, pre-filling the form as a folder space
   * rooted there; every other caller gets the ordinary curated form.
   */
  private openCreatePanel(opts?: { root?: string }): void {
    if (this.createPanel?.isOpen) return;

    const leaf = this.explorerLeaf();
    const leafRoot = leaf?.view?.containerEl;
    if (!leafRoot) return; // explorerLeaf() already showed the Notice.

    const panel = new CreateSpacePanel({
      folders: this.folderSource(),
      // The rotation, or the neutral swatch, per the user's setting.
      // Read here rather than captured, so flipping the toggle takes effect on
      // the next open of this panel without a reload.
      defaultColor: startingSpaceColor(
        this.defs.get().settings.autoAssignColor,
        this.defs.get().spaces.length
      ),
      // Read at construction, like `defaultColor`: the panel is built fresh
      // per open, so this is the list as of the moment it opened.
      customColors: this.defs.get().settings.customColors,
      saveCustomColors: (customs) =>
        this.defs.mutate((d) => {
          d.settings.customColors = customs;
        }),
      root: opts?.root,
      onSubmit: async (name, opts) => {
        // Create, then switch — in that order, no close here. The
        // panel closes itself once this promise resolves. A `createSpace`
        // rejection must propagate so the panel stays open with the user's
        // typed values.
        const id = await createSpace(this.defs, name, opts);
        try {
          await this.controller.switchTo({ kind: "space", id });
        } catch (e) {
          // The space already exists at this point —
          // a switchTo failure is NOT a failed create. Letting it escape
          // would have handleSubmit's catch report "could not create the
          // space" for one that was created, and a retry would then create
          // a `name-2` duplicate. Notice it here instead and let onSubmit
          // resolve normally so the panel closes.
          console.error("Spaces: created the space but could not switch to it", e);
          new Notice(
            `Spaces: created the space, but could not switch to it (${String(e)}).`
          );
        }
      },
      onClose: () => {
        // Only clears the reference. The panel's own close() already ran
        // destroy() and is what invoked this callback — calling back into
        // close()/destroy() here would recurse.
        this.createPanel = null;
      },
    });
    this.createPanel = panel;

    try {
      panel.mount(leafRoot);
    } catch (e) {
      // mount() throws by design if `leafRoot` is not a
      // proper sibling ancestor of `.nav-files-container`. That is a
      // programming error here, not a state to degrade through silently —
      // but it must not escape into this workspace-command/event context.
      console.error("Spaces: failed to mount create-space panel", e);
      new Notice("Spaces: could not open the create-space panel.");
      this.createPanel = null;
    }
  }

  /**
   * The file-explorer leaf lookup and its "open the
   * file explorer" Notice, shared by the create-space
   * command and `openCreatePanel()`. Returns `null` (after showing the
   * Notice) when no file-explorer leaf exists at all.
   */
  private explorerLeaf(): WorkspaceLeaf | null {
    const leaf = this.explorerLeaves()[0];
    if (!leaf) {
      new Notice("Spaces: open the file explorer to create a space.");
      return null;
    }
    return leaf;
  }

  /**
   * The `VaultSource` the create panel's picker reads
   * (createSpaceForm.ts). Built fresh on every open (rather than
   * cached) so it reflects folders created since the plugin loaded.
   *
   * `getAllLoadedFiles()` includes the root `TFolder`, so excluding the vault
   * root is `folderCandidates`' job, where it is explicit.
   */
  private folderSource(): VaultSource {
    const vault = this.app.vault;
    return {
      // Files as well as folders: the create panel's picker offers both, and
      // every folder-only consumer filters with `kindOf` anyway.
      allPaths: () => vault.getAllLoadedFiles().map((f) => f.path),
      kindOf: (path) => {
        const f = vault.getAbstractFileByPath(path);
        if (f instanceof TFolder) return "folder";
        if (f instanceof TFile) return "file";
        return null;
      },
    };
  }

  /**
   * The order map for whatever is active now. All's map and the
   * per-space maps are structurally separate so no space id can collide with
   * All, exactly as RuntimeStateV1 already splits its layouts.
   */
  private orderMapFor(): OrderMap | undefined {
    const orders = this.defs.get().orders;
    if (!orders) return undefined;
    const sel = this.runtime.getSelection();
    // Undefined is how "not ordered here" is expressed: `filterAndOrderFolder`
    // hands back the filtered items in native order, which IS the native sort.
    // The patch deliberately stays installed — switching to a space still needs
    // the seam — and simply becomes a pass-through (of the filtered set) while
    // All is active.
    if (!orderingEnabledFor(sel, this.defs.get().settings)) return undefined;
    // An overridden space renders with Obsidian's own sort. Returning
    // undefined is how that is expressed — `filterAndOrderFolder` then hands
    // back the filtered items in native order, which IS the native sort. The
    // same mechanism the ordering-disabled check above uses, so there is no
    // second rendering path to disagree with.
    if (isOverridden(sel, this.runtime.getSortOverrides())) return undefined;
    if (sel.kind === "all") return orders.all;
    // Own-property lookup, mirroring `filterAndOrderFolder` and `storedOrder`
    // below: a space id of `__proto__` or `constructor` would otherwise
    // resolve up the prototype chain and hand back something that is not an
    // order map.
    const by = orders.bySpaceId;
    if (!by || !Object.prototype.hasOwnProperty.call(by, sel.id)) return undefined;
    return by[sel.id];
  }

  /**
   * Filter, then order. Filtering first needs no special rule: a stored order
   * need not be total, so ordering a shrunken set is already well defined.
   *
   * EVERY exit from this function returns the FILTERED items, never the raw
   * ones. The ordering half has three legitimate reasons to decline (no stored
   * order, an item it cannot key, a duplicate path); handing Obsidian its own
   * array back for any of them silently stops filtering the tree - for a user
   * who has never reordered anything, on every folder.
   */
  // Typed explicitly rather than as `TransformItems`: the third, optional
  // `view` parameter is not part of the seam's contract - `patch()` only ever
  // calls a `transform` with two arguments - it is how the per-view closure in
  // `ensureOrderingPatched` tells `hoistedRootItems` which pane is asking. A
  // plain `TransformItems` annotation would still be assignable to `patch()`'s
  // parameter, but would stop that closure passing `view` at all.
  private readonly filterAndOrderFolder: (
    folderPath: string,
    items: FolderItemLike[],
    view?: object | null
  ) => FolderItemLike[] = (folderPath, items, view) => {
    // Folder spaces. The vault root is answered with the
    // ROOT FOLDER's children, so the root itself never renders and its contents
    // sit at depth 0. Everything at or under the root is served by its own
    // children and needs no special case.
    //
    // A root that does not resolve falls through to normal filtering rather
    // than hoisting nothing: an empty tree here would be indistinguishable
    // from a broken one, and the missing-root state is a rendered message,
    // not a silently empty pane.
    const root = this.activeSpaceRoot();
    if (root !== null && isVaultRoot(folderPath)) {
      // Resolved ONCE here, before the hoist can hand
      // the seam an out-of-input item — the only case `isAllowed`
      // (nativeExplorerSort.ts) ever actually calls `livePermits` for (every
      // other folder's `out` is an identity subset of `items`, so the
      // permission check there always short-circuits unreached). This is
      // the one call site for the whole sort-seam invocation this call is
      // part of: the recursive `filterAndOrderFolder(root, hoisted)` call below
      // reaches this branch again only if `root` were ALSO the vault root,
      // which `activeSpaceRoot()` never returns (a space root may not be the
      // vault root), so it does not re-resolve. `livePermits` reads this
      // cached value for however many rows this call produces, instead of
      // recomputing `currentPermits()` — and so `elsewhereOf`/
      // `liveLeafPaths()` and its sort — once per row (see `livePermits`'s
      // own comment for the distinction this must not blur: caching within
      // one call is this optimisation, caching across calls is a bug).
      this.permitsForThisCall = this.currentPermits() ?? null;
      // `view` is the PANE this call is running for (bound by the per-view
      // closure `ensureOrderingPatched` passes to `patch`), falling back to
      // pane zero only for a caller — a test, or
      // the recursive call two lines down — that has no pane of its own to
      // name. With two panes open, using pane zero unconditionally handed
      // pane 1 the SAME live tree-item objects (DOM node, `parent` pointer
      // and all) that pane 0 was using, which is not cosmetic sharing.
      const hoisted = this.hoistedRootItems(root, view ?? this.explorerViews()[0] ?? null);
      // Substituted, then filtered and ordered like any other folder's items.
      // Returning here would skip both — `globalIgnore` would stop applying and
      // the saved order for this level would be ignored.
      if (hoisted !== null) return this.filterAndOrderFolder(root, hoisted);
    }

    // Picking a sort sets `view.sortOrder` then calls `sort()`, which
    // calls this. So the gesture is visible here and needs no separate hook.
    // Only RECORD it: this runs synchronously once per folder during a single
    // sort, and a write per folder would be a write per folder.
    this.observeSortOrder();

    // The CONTROLLER owns the snapshot. Which files exist in this space's
    // tree is a domain question; the adapter's copy is the DOM layer's working
    // state, nulled by `unbind()` - a DOM-presence event that says nothing
    // about the active space.
    //
    // A folder space in the missing-root state has no folder left to scope to,
    // and `SpaceController.membersForSnapshot` answers `[]` for exactly that
    // state (a declared-but-unusable root, or one naming a folder gone from
    // the vault) - never the space's stored `members`, which would otherwise
    // leak through for a hand-edited `root: ""`. The root is never
    // auto-repaired to the vault root: honouring "" or "/" would show the
    // entire vault with no folder hidden. Do NOT bypass filtering here on the
    // theory that emptying the tree is the fail-open case - an empty result
    // here is REQUIRED. `reportMissingRootIfNeeded` (below) is what keeps it
    // from being a SILENT empty pane, which is the thing actually forbidden.
    const visible = filterVisibleItems(items, this.controller.currentSnapshot());

    const map = this.orderMapFor();
    if (!map) return visible;
    // Obsidian's root folder path is "/"; storage uses "".
    // Own-property lookup: a folder legitimately named `constructor` or
    // `hasOwnProperty` would otherwise resolve up the prototype chain and hand
    // back a function.
    const key = folderPath === "/" ? "" : folderPath;
    const order = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
    if (!order) return visible;

    const byPath = new Map<string, FolderItemLike>();
    const live: string[] = [];
    for (const item of visible) {
      const p = item.file?.path;
      // An item we cannot key cannot be ordered safely. Leave the folder
      // natively sorted rather than partially ordered — a predictable no-op
      // beats a tree that is subtly missing something — but still FILTERED.
      if (typeof p !== "string" || byPath.has(p)) return visible;
      byPath.set(p, item);
      live.push(p);
    }
    return applyOrder(order, live).map((p) => byPath.get(p) as FolderItemLike);
  };

  /**
   * The active space's USABLE root (`rootOf`), or null when it is curated,
   * All, or the root is one of the two vault-root spellings (`""`/`"/"`).
   * Not "unresolvable": a root naming a folder gone from the vault is NOT
   * null here. `rootOf` does no filesystem check, only
   * `folderSpaceRootUsable` does.
   */
  private activeSpaceRoot(): string | null {
    return rootOf(this.publicApi.activeSpace());
  }







  /**
   * The tree items for a folder space's root children, or null when the root
   * does not resolve to a folder in this vault, or when the lookup FAILED
   * rather than legitimately finding nothing.
   *
   * Reads the explorer's own item for each child rather than constructing one:
   * the items are live tree nodes carrying their own DOM, and Obsidian keeps
   * one for every path whether or not it is currently rendered (measured).
   * Fabricating one would produce a row with no behaviour. That DOM belongs to
   * a specific pane (`el`, `selfEl`, `childrenEl`, a `parent` pointer), which
   * is why `view` is passed in rather than read here: handing pane 1 the items
   * looked up against pane 0 would put the same nodes in two trees.
   */
  private hoistedRootItems(root: string, view: object | null): FolderItemLike[] | null {
    const folder = this.app.vault.getAbstractFileByPath(root);
    if (!(folder instanceof TFolder)) return null;
    // Through the sort seam, NOT `folder.children`. That array is the vault's
    // own, in no particular order, so hoisting from it rendered a folder space
    // identically whatever sort mode was chosen -- and looked right only
    // because the array is usually alphabetical, which made A-Z the one mode
    // that appeared to work. Every other folder already arrives sorted,
    // because Obsidian sorts it before our override ever sees it; the hoist is
    // the one path that builds a folder's children itself and so has to ask.
    //
    // Falls back to `children` when the view is not patched or the call
    // fails: an unsorted tree is the fail-open this transform uses
    // everywhere, and beats rendering nothing.
    const sorted = nativeSortedItems(view, folder);
    const paths = sorted
      ? sorted.flatMap((i) => (typeof i.file?.path === "string" ? [i.file.path] : []))
      : folder.children.map((c) => c.path);
    const items = itemsForPaths(view, paths);
    // A root that genuinely has no children
    // hoists to an empty list, which is correct. But a root WITH children
    // whose lookup came back empty means `itemsForPaths` could not read
    // anything — no `fileItems` map, an unready view — and that is a FAILURE,
    // not an empty folder. Returning `[]` here would render an empty vault
    // root indistinguishable from a legitimately empty folder space; falling
    // through to ordinary filtering of the raw items is the fail-open this
    // transform uses everywhere else.
    if (folder.children.length > 0 && items.length === 0) return null;
    // The elsewhere group: a path open outside the root
    // has no scaffold ancestors in a hoisted tree, and a link must never
    // lead nowhere, so it is appended flat, after the hoisted children,
    // rather than dropped. `itemsForPaths` silently skips a path it cannot
    // resolve, same as it does for the root's own children above.
    const elsewhere = elsewhereOf(root, this.liveLeafPaths());
    const extra = itemsForPaths(view, elsewhere);
    return [...items, ...extra];
  }

  /**
   * The active folder space's permits function, or undefined
   * when none applies — a curated space, All, or a root that does not
   * resolve. Has no caching of its own: every call recomputes from scratch,
   * including the `liveLeafPaths()` walk and sort inside `elsewhereOf`. Its
   * one caller (`filterAndOrderFolder`'s hoist branch) is what bounds how
   * often that happens to once per relevant sort-seam call — see
   * `permitsForThisCall` and `livePermits` for why that boundary is where
   * the resolution belongs, not in here.
   */
  private currentPermits(): Permits | undefined {
    const root = this.activeSpaceRoot();
    // The elsewhere set is the same open-paths-outside-root computation
    // `hoistedRootItems` uses to APPEND those rows; here it is what lets the
    // seam's subset guard ADMIT them, rather than treating them as a
    // fabricated row.
    return root === null
      ? undefined
      : makePermits(root, new Set(elsewhereOf(root, this.liveLeafPaths())));
  }

  /**
   * The FULL BODY of the `apply` callback `onload()` hands `SpaceController`'s
   * host, given a name so a test can call it directly. An inline closure would
   * have no seam of its own: `Plugin.onload()` is stubbed to throw under
   * Vitest, so deleting either call below (the `applyAdapterSnapshot` line, or
   * the final `repaintStep`) would leave the whole suite green.
   * `tests/filterAndOrderFolder.test.ts`'s "SpacesPlugin.onSnapshotApplied"
   * block calls this the way `onload()` does, and pins both halves.
   */
  private onSnapshotApplied(snap: VisibilitySnapshot | null): void {
    // Release the switch mask HERE rather than when the transition
    // promise resolves: this is the moment the new tree becomes
    // correctly filtered, and revealing even a frame earlier would show
    // the unfiltered tree the mask exists to hide. Unconditional, so any
    // apply from any path is also a failsafe against a stuck mask —
    // the mask must never outlive the switch that set it.
    this.setSwitchMask(false);
    this.applyAdapterSnapshot(snap);
    // These two lines are NOT order-coupled. `filterAndOrderFolder` reads
    // `controller.currentSnapshot()`, which the controller assigns before it
    // calls this callback at all. Reading `this.adapter.currentSnapshot()`
    // instead WOULD couple them: `adapter.apply(snap)` would have to land
    // first or the re-sort would filter against the outgoing snapshot, making
    // a domain decision depend on the DOM layer's working copy.
    //
    // This is the ONLY place a re-sort may hang off. `onOutcome` — and so
    // `bindExplorer` — runs BEFORE `runtime.setSelection`, so re-sorting there
    // read the OUTGOING space's order; and with `restoreLayouts` off the
    // outcome is "skipped", `bindExplorer` never runs, and nothing sorts at
    // all. `host.apply` runs after the selection commits, on every path.
    this.applyFilterAndOrdering();
    // The header repaints on the same signal, and for the same
    // reason — this is the one place every switch converges AFTER
    // `runtime.setSelection` commits. Hanging it off the four
    // `switchTo` call sites instead would drift the first time a fifth
    // appeared.
    this.header?.render();
    // The strip belongs here too. Without this call `SwitcherView`
    // repaints on a switch only by accident — either the user clicked the
    // strip itself (`activate()` re-renders in its `finally`), or
    // `restoreLayouts` is on AND the target has a stored layout, so
    // `changeLayout()` fires
    // `layout-change` → `bindExplorer` → `switcher.mount()` → `render()`.
    // Both accidents fail for a JUST-CREATED space, which has no layout
    // to restore: the selection moves and the old space stays lit. With
    // `restoreLayouts` off they fail on every switch. Same shape as the
    // re-sort above — behaviour hung off a layout side effect instead
    // of the point where the selection commits.
    this.switcher?.render();
    // And the declared surface, for the same reason again — this
    // is where the selection has committed and the tree now reflects it,
    // so the body marker and `onSpaceChange` cannot disagree with what
    // is on screen.
    this.syncSpaceSurface();
    // Reported here, not from `filterAndOrderFolder` (which
    // runs once per rendered folder per sort, far too often for a
    // Notice). `apply` is every path's convergence point — switch,
    // refresh, defs change, external change — so a repair landing any
    // of those ways is picked up on the very next one.
    //
    // None of the five steps above this one are isolated from each
    // other — unlike `onExternalSettingsChange`'s three repaints, which
    // each go through `repaintStep` for exactly this reason. An earlier
    // throw in THIS callback skips every step after it, silently,
    // including this one — the empty pane would then have no
    // explanation, for a reason that has nothing to do with the root.
    // `repaintStep` here bounds that risk for this step; the other four
    // remain a known gap.
    this.repaintStep("reportMissingRootIfNeeded", () => this.missingRoot.report());
  }

  /**
   * Extracted out of `onSnapshotApplied` so this line has a name a test can
   * call directly: dropping the second argument back to a bare
   * `this.adapter.apply(snap)` otherwise passes the whole suite, because
   * nothing reaches it. `elsewhereFirstPath()` is read fresh
   * here, same as everywhere else it is read, rather than at whatever
   * earlier moment this method might have been created.
   */
  private applyAdapterSnapshot(snap: VisibilitySnapshot | null): void {
    this.adapter.apply(snap, this.elsewhereFirstPath());
  }

  /**
   * The elsewhere group's first SURVIVING path, for `adapter.apply`'s second
   * argument — or null when no folder space is active, or nothing in its
   * elsewhere group actually renders.
   *
   * Computed here rather than inside `ExplorerAdapter` because a
   * `VisibilitySnapshot` carries no order: `hoistedRootItems` already decides
   * where the elsewhere group sits. Recomputed per call for the same reason
   * `currentPermits`/`livePermits` are — the active space and the live-leaf
   * set both change without this closure being re-created.
   *
   * `elsewhereOf`'s SORTED order is not what actually renders: `itemsForPaths`
   * can fail to resolve a path, and the snapshot can refuse one (a dismissed
   * visitor leaves `revealed.paths()` while the file is still open). Marking a
   * path that never becomes a row would draw no separator at all, so walk the
   * sorted list for the first candidate clearing both gates. `explorerViews()
   * [0]` is the hoist branch's "no pane of its own to name" fallback, safe
   * here because this only asks whether a PATH resolves to *some* item.
   */
  private elsewhereFirstPath(): string | null {
    const root = this.activeSpaceRoot();
    if (root === null) return null;
    const elsewhere = elsewhereOf(root, this.liveLeafPaths());
    if (elsewhere.length === 0) return null;
    const snapshot = this.controller.currentSnapshot();
    const view = this.explorerViews()[0] ?? null;
    for (const p of elsewhere) {
      if (itemsForPaths(view, [p]).length === 0) continue;
      if (snapshot !== null && snapshot.decisionFor(p).visible === false) continue;
      return p;
    }
    return null;
  }

  /**
   * `patch()`'s `permits` argument must NOT be computed once, at whatever
   * moment a view was first patched, and captured in the closure handed to
   * `patch()` — for the same reason `transform` is never captured that way:
   * the explorer VIEW persists across a space switch, and
   * `ensureOrderingPatched` skips a view already in `sortedViews`. Start in
   * All (permits `undefined`), switch into a folder space, sort: the captured
   * closure still answers `undefined`, `isAllowed` rejects every hoisted row
   * as unrecognised, and the seam falls back to the RAW vault-root items —
   * every note the space excludes, rendered.
   *
   * So this is a STABLE closure, passed once at patch time like `transform`,
   * resolving `currentPermits()` fresh per SORT CALL; answering `false` with
   * no folder space active is equivalent to supplying no predicate, so a
   * switch needs no unpatch/re-patch dance. Recomputing `currentPermits()` for
   * each of `isAllowed`'s out-of-input items would be O(rows x leaves) for one
   * vault-root sort, so `permitsForThisCall` resolves it once per call and
   * this reads that. Caching WITHIN one call is the optimisation; caching
   * ACROSS calls is the bug above.
   */
  private readonly livePermits: Permits = (folderPath, itemPath) =>
    this.permitsForThisCall?.(folderPath, itemPath) ?? false;

  /**
   * This call's resolved permits, or `null` when none applies — set exactly
   * once per `filterAndOrderFolder` call, at the hoist branch, and read by
   * `livePermits` for every item `isAllowed` asks about during that call.
   * Never read stale: the per-item check is only ever reached synchronously
   * after `transform` returns, within the SAME sort invocation.
   *
   * Deliberately NOT cleared after the call. Clearing on entry to
   * `filterAndOrderFolder` would wipe it during the hoist branch's own
   * recursive call, and `isAllowed` reads it AFTER `transform` returns, so the
   * value must outlive the function that set it. A leftover is harmless only
   * because of an invariant across the seam: outside the hoist branch every
   * folder's `out` is an identity subset of `items`, so `isAllowed`
   * short-circuits and never consults the predicate. If that changes, this
   * field needs an explicit lifetime.
   */
  private permitsForThisCall: Permits | null = null;

  /**
   * Installs or refreshes the sort-seam patch. Safe
   * to call repeatedly — `patch` refuses an already-patched view — which is
   * why it can simply hang off bindExplorer() and the defs subscription
   * rather than needing a switch-specific hook. Does not itself force a
   * re-sort; callers that need one rely on `host.apply` reaching
   * `applyFilterAndOrdering()` afterwards (see the defs-subscription comment
   * below for the one place that ordering is not free).
   */
  private ensureOrderingPatched(): void {
    // While filtering is paused the seam stays released, and this guard
    // is what makes the pause durable — `bindExplorer` (every `layout-change`)
    // and the definitions subscription both call this, so without it the next
    // sidebar change or settings toggle would silently re-filter the tree under
    // a user who asked to see the whole vault. `setFilteringPaused` has already
    // called `teardownOrdering()`, so returning before the release is safe:
    // there is nothing left patched to release.
    //
    // Above `explorerViews()` deliberately — the pause must cost no leaf
    // lookups, which is what `tests/productCommands.test.ts` pins.
    if (this.filteringPaused) return;
    const views = this.explorerViews();
    const previousPrimary = this.sortedViews[0];

    // The release comes FIRST, above every early return. Sitting below any of
    // them (`isDeferred`, no view, probe not "ok") leaves `sortedViews`
    // pointing at a destroyed view once the Files tab is closed, and
    // `requestResort` logs at most once per session, so nothing surfaces.
    // Releasing whatever is no longer served before deciding anything else is
    // what makes every one of those exits safe.
    //
    // Identity, not index: the set is unordered, and matching by position
    // means that with two panes open, whichever view stops being index 0 is
    // actively unpatched and reverted to the whole vault.
    //
    // The memo is deliberately NOT invalidated here. A release can only leave
    // behind views that were already sorted correctly, and
    // `applyFilterAndOrdering` returns before consulting the memo once the set
    // is empty. Ablated to confirm: an invalidation here can be deleted with
    // the suite green, one at the patch below cannot.
    if (this.sortedViews.length > 0) {
      const kept: object[] = [];
      for (const held of this.sortedViews) {
        if (views.includes(held)) {
          kept.push(held);
          continue;
        }
        unpatchExplorerSort(held);
      }
      this.sortedViews = kept;
    }

    if (views.length === 0) return;
    // The setting governs the ordering GESTURE (the drag) and the
    // ordering HALF of the transform — `orderMapFor` already returns
    // `undefined` when this is off, which is what makes `filterAndOrderFolder`
    // fall back to filtered-but-unordered. It must never govern visibility:
    // filtering rides this same patch, so tearing the patch down
    // here — as this used to do — would silently show the whole vault in
    // every space to a user who only meant to turn off row dragging. Only the
    // gesture is gated; the patch installs unconditionally below.
    const allowReordering = this.defs.get().settings.allowReordering;
    if (!allowReordering) this.dragOrdering?.unbind();

    // The seam is a property of the Obsidian BUILD, not of one pane, so one
    // "ok" is enough to say the build still exposes it. Taking the
    // best answer across the panes stops a single odd view from spending the
    // one-shot Notice below and turning filtering off in every pane.
    this.sortProbe = views.some((v) => probeExplorerSort(v) === "ok") ? "ok" : "unknown";
    if (this.sortProbe !== "ok") {
      // A private-API dependency is the most version-fragile thing
      // here, so a user whose Obsidian dropped the seam is told why spaces
      // stopped filtering instead of being left to wonder. Once per session.
      if (!this.sortProbeWarned) {
        this.sortProbeWarned = true;
        new Notice(
          "Spaces: this Obsidian version does not expose the file explorer's sort, " +
            "so spaces can no longer filter the tree. The whole vault will show until " +
            "Obsidian is updated."
        );
      }
      // The gesture rides the same seam, so a binding from an earlier call
      // has to come off too. Left bound it keeps writing order entries that
      // nothing can render.
      this.dragOrdering?.unbind();
      return;
    }

    if (allowReordering) {
      // The drag binds to the same container the adapter does, and for
      // the same reason — `changeLayout()` replaces it on every switch, so
      // anything bound once at load would be listening to a detached node.
      // Gated the same as the unbind above: only the gesture is governed by
      // the setting.
      // The PRIMARY pane only, and deliberately. A drag is one
      // gesture in one pane; what it writes is an order in `defs`, which the
      // re-sort below then applies to every patched pane, so the RESULT is
      // multi-leaf even though the gesture is not. Binding a second
      // `DragOrdering` would need a second instance to own its listeners and
      // a second teardown in `onunload` to take them off, which is a listener
      // -ownership change rather than part of this seam.
      const container = (views[0] as { containerEl?: HTMLElement }).containerEl?.querySelector<HTMLElement>(
        SEL.container
      );
      if (container) {
        this.dragOrdering ??= new DragOrdering(this.dragDeps());
        this.dragOrdering.bind(container);
      }
    }

    for (const view of views) {
      if (this.sortedViews.includes(view)) continue;
      // A folder space's hoist answers the vault root
      // with another folder's children, which the seam's identity-based
      // subset rule alone cannot tell apart from a transform fabricating
      // rows — hence `livePermits`, the second gate. It is passed
      // as a stable reference and re-resolves the active space on every
      // call; it must NOT be computed here and
      // captured, because this loop only runs for a view's FIRST patch and
      // the view persists across every later space switch.
      //
      // The transform closure below binds THIS view:
      // `hoistedRootItems` reads live tree items off whichever pane asked,
      // and with two panes open the shared `this.filterAndOrderFolder`
      // reference would have no way to tell them apart on its own.
      if (
        patchExplorerSort(
          view,
          (folderPath, items) => this.filterAndOrderFolder(folderPath, items, view),
          this.livePermits
        )
      ) {
        this.sortedViews.push(view);
        // A view that has never been sorted through the transform is
        // showing the unfiltered vault, and the memo — which describes the
        // views we held a moment ago — must not be allowed to skip its first
        // re-sort. This is the one invalidation the memo cannot derive from
        // its own inputs, and the one whose absence would be catastrophic.
        this.lastResort = null;
      }
    }

    // A fresh PRIMARY means a fresh view, so the remembered sort order
    // is stale. Re-seed on the next observation rather than treating the first
    // read of a new view as a gesture. Keyed on the primary because that is
    // the view `observeSortOrder` reads; a second pane arriving or leaving
    // changes nothing about the order the user last picked.
    if (this.sortedViews[0] !== previousPrimary) this.lastSortOrder = null;
  }

  /**
   * Ask Obsidian to rebuild the tree, because what belongs in it may have
   * changed. Called from `host.apply` — the lifecycle-hook site, running after
   * the selection commits — plus `recordSortOverride` and
   * `restoreSavedOrdering`, which ride direct user gestures. The
   * single-convergence rule constrains what a re-sort may HANG OFF, not how
   * many places may call it.
   *
   * Two tempting guards are wrong here. Memoising on `{selection, orders
   * identity}` was sound while a re-sort only served ORDERING; filtering moved
   * into the same seam, and a membership change — or a `file-open` revealing a
   * VISITOR — moves neither key. Returning early when no order is stored
   * anywhere assumed the patch was a pass-through; it filters now, so that
   * leaves the tree unfiltered for every user who never reordered a thing.
   *
   * The memo key is therefore the transform's own inputs, read back:
   * `visiblePaths()` off the controller's snapshot (which IS the filter half
   * of the transform — `filterVisibleItems` asks `decisionFor(p).visible`, and
   * `buildVisibilitySnapshot` answers that with `visible.has(p)` and nothing
   * else); the resolved order map by identity (`DefinitionStore.mutate` clones
   * on every write, so it over-invalidates, never under); and the selection,
   * so two spaces showing the same rows are told apart. Outside the key are
   * only Obsidian's own triggers — a vault mutation re-sorts that folder
   * anyway, a native sort-mode pick calls `sort()` itself — plus a freshly
   * patched view, which `ensureOrderingPatched` invalidates explicitly. If
   * `requestResort` fails the memo is dropped, so the next event retries
   * rather than leaving the previous filter on screen.
   */
  private applyFilterAndOrdering(): void {
    if (this.sortedViews.length === 0) return;
    const signature = this.currentResortSignature();
    if (this.lastResort && sameResortSignature(this.lastResort, signature)) return;
    let every = true;
    for (const view of this.sortedViews) {
      if (!requestResort(view)) every = false;
    }
    this.lastResort = every ? signature : null;
  }

  /** See `applyFilterAndOrdering` for why these three fields and no others. */
  private currentResortSignature(): ResortSignature {
    const selection = this.runtime.getSelection();
    const snapshot = this.controller.currentSnapshot();
    return {
      selection: selection.kind === "all" ? "all" : `space:${selection.id}`,
      order: this.orderMapFor(),
      visible: snapshot ? snapshot.visiblePaths() : null,
    };
  }

  /**
   * Compares Obsidian's sort order against the last value seen. The
   * first observation after a bind SEEDS rather than counting as a gesture —
   * otherwise loading the explorer would override every space.
   */
  private observeSortOrder(): void {
    // The PRIMARY pane's mode. Obsidian keeps `sortOrder` per view, so two
    // panes can disagree; the gesture is one user action in one pane, and
    // attributing it to the primary is the only reading that does not flap
    //. The transform is not told which view invoked it, so there is no
    // better attribution available at this seam.
    const current = readSortOrder(this.sortedViews[0] ?? null);
    const verdict = sortGestureFrom(this.lastSortOrder, current);
    if (verdict === "none") return;
    this.lastSortOrder = current;
    if (verdict === "seed") return;
    if (this.sortGestureTimer !== null) return;
    // Deferred out of the sort callback, and deduped: one write per gesture,
    // not one per folder. The timer id is kept
    // and cancelled on unload; every other listener in this file goes
    // through `registerEvent`/`registerDomEvent`, and this is the one bare
    // `setTimeout` in main.ts. Without cancelling, an unload inside this tick would
    // write runtime state — `setSortOverride` — for a plugin that is no
    // longer loaded.
    this.sortGestureTimer = window.setTimeout(() => {
      this.sortGestureTimer = null;
      this.recordSortOverride();
    }, 0);
  }

  /**
   * Records that the user is now looking at one of Obsidian's own sort
   * modes rather than their saved order.
   *
   * Reached two ways, and both are needed. `observeSortOrder` notices the value
   * CHANGING, which covers a sort chosen anywhere — including Obsidian's own
   * command palette. The menu reports the CLICK, which covers the case the
   * first cannot see at all: choosing the mode already in effect changes no
   * value, so before this existed that click did nothing whatsoever. Whichever
   * arrives first does the work; the other finds the override already set and
   * returns here.
   */
  private recordSortOverride(): void {
    const sel = this.runtime.getSelection();
    const overridden = isOverridden(sel, this.runtime.getSortOverrides());
    const orderingEnabled = orderingEnabledFor(sel, this.defs.get().settings);
    // Extracted to `shouldRecordSortOverride`
    // (src/order/sortOverride.ts) so this pure predicate has a direct test.
    // A sort gesture from a user who cannot reorder here
    // anyway must not persist an override — it would sit latent in runtime
    // state and hijack their saved order the moment `allowReordering` is
    // turned back on. The OBSERVATION in `observeSortOrder` still runs
    // unconditionally so the seed value keeps tracking; only this write is
    // gated.
    if (!shouldRecordSortOverride(overridden, orderingEnabled)) return;
    this.runtime.setSortOverride(sel, true);
    this.applyFilterAndOrdering();
    this.switcher?.render();
  }

  /** Clears the override and re-applies the saved order. */
  private restoreSavedOrdering(): void {
    const sel = this.runtime.getSelection();
    if (!isOverridden(sel, this.runtime.getSortOverrides())) return;
    this.runtime.setSortOverride(sel, false);
    this.applyFilterAndOrdering();
    this.switcher?.render();
  }

  /**
   * Puts "Restore saved ordering" into Obsidian's OWN sort menu, for the
   * single menu the click now in flight is about to open.
   *
   * Gated at ARM time rather than at show time. The two are one tick apart, and
   * arming here buys the property worth having: when the row would not appear,
   * the prototype is never patched at all.
   */
  private armSortMenuRow(button: Element, gesture: MouseEvent): void {
    const defs = this.defs.get();
    const state = sortMenuRowState(
      this.runtime.getSelection(),
      this.runtime.getSortOverrides(),
      defs.settings,
      defs.orders
    );
    if (!state.show) return;
    armMenuInjection({
      proto: Menu.prototype as unknown as MenuPrototype,
      // Identity on ENTRY, not only ownership on
      // exit: the arm is live for a whole macrotask, and without this check
      // ANY menu another plugin opens inside that window is treated as the
      // sort menu — it gets our row, and its own items are unticked. The
      // explorer shows this menu with `showAtMouseEvent(evt)` for the very
      // click being handled here, so the gesture is recognised two ways: the
      // same event object, or — should a future Obsidian re-dispatch — an
      // event that started inside the same button. Neither is true of a menu
      // opened from anywhere else, and `showAtPosition` carries no anchor at
      // all, so it never matches.
      isIntendedMenu: (showArgs) => {
        const first = showArgs[0];
        if (first === (gesture as unknown)) return true;
        const from = (first as { target?: unknown } | null | undefined)?.target;
        return from instanceof Node && button.contains(from);
      },
      buildRow: (menu) => {
        menu.addItem((i) => {
          // "User ordered", not "Restore saved ordering": here it is a MODE
          // sitting among Obsidian's six, and it is shown ticked when it is the
          // one in effect. The command and the switcher row keep the verb —
          // a command palette entry needs one, a mode label does not.
          i.setTitle(SORT_MENU_MODE).setIcon("list-ordered").setChecked(state.checked);
          // A no-op when already checked: `restoreSavedOrdering` returns early
          // unless an override is actually set.
          i.onClick(() => this.restoreSavedOrdering());
        });
      },
      // Only while OUR mode is the one in effect. Obsidian ticks whichever mode
      // `sortOrder` names whether or not it is what renders, and that tick is
      // the whole defect: it says "File name (A to Z)" while a custom order is
      // on screen. When the override IS in effect, its tick is honest and stays.
      decorateHostItem: state.checked ? (i) => void i.setChecked(false) : undefined,
      // Picking a native mode is a sort gesture even when it changes no value,
      // which is the one case `observeSortOrder` is structurally blind to.
      //
      // Conditional for the same reason `decorateHostItem` is, and on the same
      // condition: supplying this is what wraps every host item in a
      // proxy, and a proxy is not identical to the item it wraps. `checked` is
      // `!isOverridden`, which is exactly `shouldRecordSortOverride`'s first
      // gate — with the override already set there is nothing for a report to
      // do, so the identity cost would buy nothing.
      onHostItemClick: state.checked ? () => this.recordSortOverride() : undefined,
      // The canceller comes back so `onunload` can stop it. A pending
      // restore that outlives an unload puts the prototype BACK, which is the
      // safe direction — but the wrapper sitting on `Menu.prototype` until it
      // fires is not, so unload takes it down now instead.
      defer: (fn) => {
        const id = window.setTimeout(fn, 0);
        return () => window.clearTimeout(id);
      },
    });
  }

  /**
   * The PRIMARY explorer view, or null. Every ordering READ goes through this.
   *
   * Deliberately singular where `explorerViews()` is plural: a read
   * asks "what is displayed", and every patched view displays the same thing —
   * `filterAndOrderFolder` is one function over one selection, so any of them
   * answers for all of them. The drag gesture that consumes these reads is
   * also one gesture in one pane, and that pane is the primary.
   */
  private explorerView(): object | null {
    return this.explorerViews()[0] ?? null;
  }

  /**
   * Every file-explorer leaf in the MAIN window, in workspace
   * order, which is the order Obsidian hands them back.
   *
   * Pop-out windows are excluded here rather than anywhere else, so the
   * exclusion is stated once. It is README's documented non-goal ("Pop-out
   * windows are not filtered") and it is decided by the leaf's own document
   * rather than by `WorkspaceWindow` identity: `containerEl.ownerDocument` is
   * public on both sides of the comparison (`View.containerEl`,
   * `Workspace.containerEl`), needs no `instanceof` against a class the seam
   * would then have to import, and a pop-out's leaves genuinely live in
   * another document.
   */
  private explorerLeaves(): WorkspaceLeaf[] {
    const mainDoc = this.app.workspace.containerEl.ownerDocument;
    return this.app.workspace
      .getLeavesOfType("file-explorer")
      .filter((leaf) => leaf.view?.containerEl?.ownerDocument === mainDoc);
  }

  /**
   * The views behind `explorerLeaves()` that are ready to be patched.
   *
   * A DEFERRED leaf — a collapsed sidebar at startup — has none of the seam's
   * methods yet, so it is skipped rather than probed: probing it reports
   * "unknown" for a build that is perfectly capable, and the one-shot
   * Notice would be spent on a false alarm while a genuine seam loss later
   * would go unreported.
   */
  private explorerViews(): object[] {
    const out: object[] = [];
    for (const leaf of this.explorerLeaves()) {
      if ((leaf as { isDeferred?: boolean }).isDeferred) continue;
      const view = leaf.view as object | undefined;
      if (view) out.push(view);
    }
    return out;
  }

  /**
   * The dependencies. Every one of them is a lookup or a write — the drag's
   * decisions live in `dropIntent.ts`, and none of them belong here.
   */
  private dragDeps(): ConstructorParameters<typeof DragOrdering>[0] {
    return {
      describeRow: (path) => {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!f) return null;
        // Obsidian's root folder path is "/"; storage uses "".
        const parent = f.parent?.path ?? "";
        return { parent: parent === "/" ? "" : parent, isFolder: f instanceof TFolder };
      },
      displayedOrder: (folderPath) => {
        const view = this.explorerView();
        const folder = this.folderFor(folderPath);
        if (!view || !folder) return [];
        return displayedPaths(view, folder) ?? [];
      },
      storedOrder: (folderPath) => {
        const map = this.orderMapFor();
        if (!map) return undefined;
        return Object.prototype.hasOwnProperty.call(map, folderPath)
          ? map[folderPath]
          : undefined;
      },
      writeOrder: (folderPath, order) => this.writeOrderFor(folderPath, order),
      // `DragOrdering` declines the drop on its own — this hook only
      // voices it. Without it the user sees Obsidian complete the move (which
      // is the right outcome: the whole selection travels) while the ordering
      // they were arranging silently does not apply, and the only trace is a
      // console line. Wired by the merge arbiter; x3 left it as a
      // cross-boundary note because `dragDeps` sits outside its region.
      onSelectionOutsideWindow: () => {
        new Notice(
          "Spaces: some of that selection was scrolled out of view, so the " +
            "move was left to Obsidian and no new order was saved."
        );
      },
      moveInto: (paths, targetFolder, edge, targetPath) =>
        this.moveAndOrder(paths, targetFolder, edge, targetPath),
      // The same rule the renderer reads, evaluated per event, so a space
      // switch changes the answer with no rebind - gating the gesture
      // alongside the rendering is what stops a drag in All writing an order
      // that nothing would apply.
      //
      // An overridden space is inert here too, for the same coherence reason
      // `orderMapFor` renders it with Obsidian's own sort: a drop names a
      // position against the rows on screen, and while overridden those rows
      // are the native sort, not the saved order a drop would edit.
      // `DragOrdering` re-asks this per `dragstart` (see its `bind()`), so an
      // override that flips without a rebind is still honoured.
      //
      // Mobile has no HTML5 drag: `dragstart` never fires from touch, so the
      // gesture does not exist there rather than merely degrading. Gated here
      // rather than inside `DragOrdering`, which imports nothing from
      // `"obsidian"` on purpose - the platform question belongs in the file
      // that already knows the platform. `manifest` says `isDesktopOnly`
      // today, so this is unreachable in practice; it is here so correctness
      // stops depending on that flag.
      enabled: () =>
        !Platform.isMobile &&
        orderingEnabledFor(this.runtime.getSelection(), this.defs.get().settings) &&
        !isOverridden(this.runtime.getSelection(), this.runtime.getSortOverrides()),
      // Only the override earns an explanation. A drag blocked because
      // `allowReordering`/`allowReorderingAll` is off stays silent —
      // the user turned that off in settings and does not need reminding.
      // The decision itself is `shouldExplainBlockedDrag`
      // (src/order/sortOverride.ts), pure and Layer-1 tested; this closure
      // owns only the side effects.
      //
      // `overridden` alone is not enough.
      // A reachable trap state — override *All*, then turn
      // `allowReorderingAll` off — leaves `overridden` true while ordering is
      // ALSO blocked by the setting, and a two-input check fires the Notice
      // anyway, telling the user to restore saved ordering when doing so
      // changes nothing visible. `orderingEnabled` is `orderingEnabledFor`'s own
      // answer, passed as the third input so the "is this actually the
      // reason" check is real rather than assumed.
      onBlockedDrag: () => {
        const sel = this.runtime.getSelection();
        const overridden = isOverridden(sel, this.runtime.getSortOverrides());
        const orderingEnabled = orderingEnabledFor(sel, this.defs.get().settings);
        if (!shouldExplainBlockedDrag(overridden, orderingEnabled)) return;
        // Every blocked drag is explained, not just the first after an
        // override turns on: the Notice is the only sign the gesture
        // registered at all, and a drag that silently does nothing reads as a
        // bug.
        //
        // Reuse a toast that is still on screen rather than stacking a second
        // identical one — `noticeEl.isConnected` tells a live toast from one
        // Obsidian has already dismissed on its own timer, and `hide()` on an
        // already-dismissed Notice is a no-op, so no bookkeeping is needed.
        // The reused toast keeps its original dismiss time rather than being
        // re-timed: an accepted cost of not doing DOM surgery on host markup.
        const live = this.blockedDragNotice;
        const reusable = live !== null && live.messageEl.isConnected;
        // The sort menu is named unconditionally, and that is now sound.
        // This Notice fires only when `shouldExplainBlockedDrag` holds, which
        // is override AND ordering-enabled, and `sortMenuRowState` shows the
        // row under exactly that pair. It used to ask, because the row was
        // conditional on a saved order existing and an override with nothing
        // ever reordered left it absent — the state that made the two hold
        // each other in place. The row is shown there now, so the branch that
        // sent the user to the command palette instead was unreachable and
        // has gone rather than lingering as a defensive fallback.
        //
        // "Right-click the space" would be unfollowable in *All* — the
        // switcher's contextmenu listener is gated on
        // `entry.key.kind === "space"`, so *All* has no context menu at all.
        // Naming the sort menu works for either surface.
        // The middle sentence is not decoration. Declining a drag does NOT
        // stop it: `DragOrdering` deliberately leaves `dragstart` without
        // `preventDefault`, so Obsidian keeps the gesture and its own handler
        // moves the file when the drop lands on a folder. Reported as a row
        // vanishing from a folder space, which is what a move out of the
        // hoisted root looks like. Saying only that reordering is paused
        // reads as "nothing happened" while a file has quietly moved.
        const message =
          "Spaces: reordering is paused while the tree shows Obsidian's sort order. " +
          "Dropping onto a folder still moves the file. " +
          `Pick "${SORT_MENU_MODE}" in the sort menu to resume.`;
        if (reusable && live) {
          live.setMessage(message);
        } else {
          this.blockedDragNotice = new Notice(message);
        }
      },
    };
  }

  /** "" is the vault root, which Obsidian addresses as "/". */
  private folderFor(folderPath: string): unknown {
    return this.app.vault.getAbstractFileByPath(folderPath === "" ? "/" : folderPath);
  }

  /**
   * Compacted against the folder's live children on write, so a stale
   * entry cannot accumulate. Reads already skip what does not resolve; this is
   * where storage is actually tidied.
   */
  private async writeOrderFor(folderPath: string, order: string[]): Promise<void> {
    const folder = this.folderFor(folderPath) as { children?: { path: string }[] } | null;
    const live = new Set((folder?.children ?? []).map((c) => c.path));
    const tidy = live.size > 0 ? compact(order, live) : order;
    const sel = this.runtime.getSelection();
    try {
      await this.defs.mutate((d) => {
        // Null prototypes and an own-property guard: `sel.id` and
        // `folderPath` both reach here as strings the user controls, and on a
        // plain object `map[id] ??= {}` with an id of `__proto__` reads the
        // inherited accessor — truthy, so nothing is assigned — and the next
        // line writes onto `Object.prototype` for the whole renderer. The
        // schema rejects such an id and hands back null-prototype maps; this
        // is the same guard at the write site, where the draft is built.
        d.orders ??= {};
        if (sel.kind === "all") {
          d.orders.all ??= Object.create(null) as OrderMap;
          d.orders.all[folderPath] = tidy;
        } else {
          const by = (d.orders.bySpaceId ??= Object.create(null) as Record<string, OrderMap>);
          if (!Object.prototype.hasOwnProperty.call(by, sel.id)) {
            by[sel.id] = Object.create(null) as OrderMap;
          }
          by[sel.id][folderPath] = tidy;
        }
      });
    } catch (e) {
      // The stored order is the truth and the render follows it, so
      // there is nothing to roll back — the tree keeps the arrangement it had.
      new Notice(`Spaces: could not save the new order (${String(e)})`);
      throw e;
    }
  }

  /**
   * A cross-folder drop is a filesystem move AND a position in the
   * new parent — and the move must land FIRST. Ordering a file into a folder it
   * never reached would leave a permanent phantom entry.
   *
   * Note what is deliberately NOT done here: nothing touches membership. If the
   * target folder is a member, the moved file becomes an inherited member and
   * stays visible with no help. If it was only on screen as scaffolding, the
   * file is now outside the space and the space stops showing it — which is
   * what a move means. Adding membership behind the user's back, or revealing
   * the file through `RevealedSet`, would both be inventing intent; the reveal
   * would not even survive, since a moved file has no live leaf to back it.
   */
  private async moveAndOrder(
    paths: string[],
    targetFolder: string,
    edge: DropEdge,
    targetPath: string
  ): Promise<void> {
    const moved: string[] = [];
    let failures = 0;
    for (const p of paths) {
      const file = this.app.vault.getAbstractFileByPath(p);
      if (!file) continue;
      const base = p.split("/").pop();
      if (!base) continue;
      const dest = targetFolder === "" ? base : `${targetFolder}/${base}`;
      if (dest === p) continue;
      try {
        await this.app.fileManager.renameFile(file, dest);
        moved.push(dest);
      } catch (e) {
        // A name collision or a permission failure. Keep going: a partial
        // multi-move is still better than abandoning the files that could
        // move. Counted here and reported ONCE below: a Notice per file would
        // mean fifteen notes dragged into a folder holding ten same-named
        // ones produce ten stacked toasts for one
        // gesture. The exception itself goes to the console, matching
        // `reportLayoutOutcome`'s register: plain language to the user, raw
        // detail where a support question can find it.
        failures++;
        console.error(`Spaces: could not move ${p} to ${dest}`, e);
      }
    }
    // One Notice for the batch, as `membership.ts`'s `addAll`/`removeAll` do.
    // It names how much of the gesture happened, not only what threw —
    // listing the failures alone leaves "1 of 3" and "1 of 300"
    // indistinguishable.
    if (failures > 0) {
      new Notice(
        `Spaces: moved ${moved.length} of ${paths.length}. ` +
          `${failures} could not move — see the console for details.`
      );
    }
    if (moved.length === 0) return;

    const view = this.explorerView();
    const folder = this.folderFor(targetFolder);
    const displayed = view && folder ? displayedPaths(view, folder) ?? [] : [];
    const next = computeDrop({
      order: this.dragDeps().storedOrder(targetFolder),
      displayed,
      dragged: moved,
      targetPath,
      edge,
    });
    if (next) await this.writeOrderFor(targetFolder, next);
  }

  /** The override comes off, and `unpatch` forces the re-sort that reverts it. */
  private teardownOrdering(): void {
    if (this.sortedViews.length === 0) return;
    // Every held view, or a second pane would keep spaces's filter
    // after the plugin is disabled — the tree must never show less than the
    // space should, and disabling must be content-safe.
    for (const view of this.sortedViews) unpatchExplorerSort(view);
    this.sortedViews = [];
    this.lastResort = null;
  }

  /**
   * The switch flicker, and what measurement showed it actually is.
   *
   * Across a space switch, `changeLayout()` destroys the explorer and Obsidian
   * rebuilds it. Measured in the fixture vault: the old container is gone by
   * ~2ms, a NEW container appears at ~24ms and holds the COMPLETE UNFILTERED
   * tree by ~35ms, and spaces's first apply does not land until ~78ms — so
   * roughly 43ms, two to four frames, of fully painted wrong content. The
   * adapter cannot prevent it: it does not know the new container exists until
   * `bindExplorer()` runs, which is after the transition resolves.
   *
   * So the tree is hidden for the duration instead. Only while a real restore
   * is happening: with restoration off there is no rebuild, no flicker, and
   * masking would add a blank for nothing.
   */
  private async runMaskedTransition(
    from: ActiveSelection,
    to: ActiveSelection
  ): Promise<SwitchOutcome> {
    const restoring = this.effectiveRestore();
    if (restoring) this.setSwitchMask(true);
    try {
      return await this.layout.transition(from, to, restoring);
    } catch (e) {
      // The mask is released by `apply()` on the normal path. A transition that
      // REJECTS may never reach an apply, so it comes off here too — a stuck
      // mask is an invisible file tree, which is worse than the flicker it
      // replaced.
      this.setSwitchMask(false);
      throw e;
    }
  }

  /* ---------------------------------------------------------------- *
   * The declared extension surface.
   * ---------------------------------------------------------------- */






  /**
   * Publishes which space the tree is filtered to: the body marker, and
   * one `onSpaceChange` event per actual change.
   *
   * Called from `host.apply`, the one point every path converges on AFTER
   * `runtime.setSelection` commits — the same argument the header repaint
   * and the strip repaint are hung off, and for the same reason. That runs
   * on every file open as well as every switch, hence `announcedSpaceId`: the
   * marker is idempotent, the event must not be.
   */
  private syncSpaceSurface(): void {
    const space = this.publicApi.markedSpace();
    const body = this.app.workspace.containerEl.ownerDocument.body;
    if (space) body.setAttribute(ATTR_SPACE, space.id);
    else body.removeAttribute(ATTR_SPACE);
    this.publicApi.announce();
  }

  /**
   * Teardown, and the leak answer for `onSpaceChange`: a consumer that never calls
   * its unsubscribe still leaks nothing of ours, because the set is dropped
   * here. Registered from `start()` via `Component.register`, so it runs on
   * unload beside the rest of the teardown.
   */
  private releaseSpaceSurface(): void {
    this.publicApi.dispose();
    // The marker must not outlive the filtering it describes, exactly as the
    // switch mask must not (see `setSwitchMask`'s call in `onunload`).
    this.app.workspace.containerEl.ownerDocument.body.removeAttribute(ATTR_SPACE);
  }

  /**
   * The mask lives on `document.body` because every element inside the
   * explorate pane is replaced during a switch — measured, twice, while
   * instrumenting this. A class on the body cannot go stale.
   */
  private setSwitchMask(on: boolean): void {
    const body = this.app.workspace.containerEl.ownerDocument.body;
    if (on) body.classList.add(CLS_SWITCHING);
    else body.classList.remove(CLS_SWITCHING);
  }

  /**
   * One teardown step, isolated — the per-step guarding discipline
   * `bindExplorer()` already applies, brought to `onunload`.
   *
   * Teardown steps are INDEPENDENT in a way `start()`'s are not: each takes a
   * different thing back off the app, so a failure to remove the drag binding
   * is no reason to leave the header, the mask and the definitions subscriber
   * behind as well. The worst of those: an early throw skips
   * `unsubscribeDefs()`, and the subscriber it leaves holds this instance and
   * keeps repainting a switcher that is no longer on screen, for the life of
   * the app. Obsidian calls `onunload` once and does not retry.
   *
   * The guard's own `console.error` is wrapped too: a throw from the reporter
   * would reintroduce exactly the skip this method exists to prevent.
   */
  private unloadStep(what: string, step: () => void): void {
    try {
      step();
    } catch (e) {
      try {
        console.error(`Spaces: ${what} failed during unload`, e);
      } catch {
        // Nothing left to report with; the remaining steps still matter.
      }
    }
  }

  override onunload(): void {
    this.loaded = false;
    // FIRST, above every teardown step: a switch already
    // parked on `layout.transition()` resumes after this method returns, and
    // everything downstream of that await re-installs what the steps below are
    // about to remove — the sort-seam patch, the MutationObserver, the applied
    // snapshot. Disposing here makes that resumption inert instead of racing
    // the teardown. Not wrapped in `unloadStep`: it is a field assignment that
    // cannot throw, and it must not be skippable by an earlier failure.
    //
    // Optional-chained despite the field's `!` declaration, and the `!` is why:
    // it asserts assignment in `onload`, so it is a lie for an `onload` that
    // threw before constructing the controller — and `onunload` still runs for
    // that plugin. Obsidian calls teardown on a half-built plugin;
    // `tests/lifecycleGuards.test.ts` builds exactly that shape.
    this.controller?.dispose();
    // Cancel the deferred sort-gesture write
    // so it cannot fire after unload and write runtime state — the
    // override flag — for a plugin that is no longer loaded. Every other
    // listener in this file goes through
    // `registerEvent`/`registerDomEvent`; this is the one bare `setTimeout`.
    this.unloadStep("cancelling the deferred sort-gesture write", () => {
      if (this.sortGestureTimer !== null) {
        window.clearTimeout(this.sortGestureTimer);
        this.sortGestureTimer = null;
      }
    });
    // The arm holds the other bare `setTimeout`,
    // and until it fires a wrapper of ours is on the shared `Menu.prototype`.
    // Cancel it and restore now, rather than leaving a wrapper installed by a
    // plugin that is no longer loaded.
    this.unloadStep("cancelling the sort-menu injection", () =>
      cancelMenuInjection()
    );
    // A mask left on the body would hide the file tree of a vault that no
    // longer has spaces installed, and no later apply would come to clear it.
    this.unloadStep("clearing the switch mask", () => this.setSwitchMask(false));
    this.unloadStep("unbinding drag ordering", () => {
      this.dragOrdering?.unbind();
      this.dragOrdering = null;
    });
    // Before adapter.unbind(): a throw there would otherwise strand the sort
    // override and leave the tree custom-ordered after a disable.
    // The ORDER is still load-bearing: guarding each step means a failure
    // cannot reorder them, only skip one.
    this.unloadStep("restoring the new-file location", () => {
      this.restoreNewFileParent?.();
      this.restoreNewFileParent = null;
    });
    this.unloadStep("restoring the context menu's creation targets", () => {
      this.restoreNativeCreate?.();
      this.restoreNativeCreate = null;
    });
    this.unloadStep("unpatching the sort seam", () => this.teardownOrdering());
    this.unloadStep("unbinding the explorer adapter", () => this.adapter.unbind());
    this.unloadStep("destroying the switcher", () => this.switcher?.destroy());
    // An owned element prepended to the pane must come off on unload, or
    // a disable leaves a dead header above the file tree.
    this.unloadStep("destroying the space header", () => this.header?.destroy());
    // An open panel's `inert` on .nav-files-container must come off on
    // unload, same as the adapter/switcher above.
    this.unloadStep("destroying the create-space panel", () => {
      this.createPanel?.destroy();
      this.createPanel = null;
    });
    // `AnchoredPopover` "does not own its own lifetime"
    // (its own docstring) — its document-level listeners are removed only by
    // `close()`, so the owner (this file) must call it. A persistent Notice
    // is also left showing after unload otherwise: `hide()` starts Obsidian's
    // own dismiss animation rather than leaving a toast that outlives the
    // plugin describing a state spaces is no longer tracking.
    this.unloadStep("closing the missing-root Notice and picker", () =>
      this.missingRoot.clear()
    );
    // Last, and the step that matters most: a subscriber left in the set holds this
    // instance and repaints chrome that is no longer mounted.
    this.unloadStep("unsubscribing from definitions", () => {
      this.unsubscribeDefs?.();
      this.unsubscribeDefs = null;
      // Obsidian removes the tab itself on unload; dropping the reference
      // keeps a disabled plugin from holding the instance alive through it.
      this.settingTab = null;
    });
  }
}
