// @vitest-environment jsdom
/**
 * Folder-space hoisting through the REAL sort seam, mirroring
 * `tests/explorerSeam.test.ts`'s harness rather than calling
 * `filterAndOrderFolder` directly. That distinction is the point: all three
 * cases below live in `ensureOrderingPatched`'s `patch(...)` call, which a
 * test that reaches `plugin["filterAndOrderFolder"]` by hand never exercises
 * — it bypasses `patch()` (and the `permits`/`view` it captures) entirely.
 *
 * `permits` must be re-resolved on every call rather than computed once,
 * when a view is first patched, and captured in the closure handed to
 * `patch()`. The explorer view persists across a space switch and
 * `ensureOrderingPatched` skips a view already in `sortedViews`, so a
 * captured value would never refresh — starting in All (or a curated space)
 * and then switching into a folder space would leave the seam's guard
 * rejecting every hoisted row and falling back to the RAW, unfiltered vault
 * root.
 *
 * `hoistedRootItems` must read the pane whose `getSortedFolderItems` is
 * actually running, not always `explorerViews()[0]` — otherwise a second
 * open pane would render pane zero's live tree-item objects — the same DOM
 * nodes — inside its own tree.
 *
 * `currentPermits()` builds `makePermits(root, elsewhere)` with the REAL
 * elsewhere set, so the seam's `isAllowed` guard needs coverage with that
 * set non-empty — a test against `filterAndOrderFolder` directly proves only
 * the TRANSFORM's output and never touches the guard, the same gap as above.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import SpacesPlugin from "../src/main";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { SpaceController } from "../src/controller/SpaceController";
import { buildFakeVault } from "./helpers/fakeVault";
import type { FolderItemLike } from "../src/layout/nativeExplorerSort";
import type { SpaceDefinition } from "../src/types";
import type { SpaceHeaderView } from "../src/ui/SpaceHeaderView";
import type { SwitcherView } from "../src/ui/SwitcherView";

/** `Projects/Work/{Hardware,Overview.md}`, real `TFolder`/`TFile` instances. */
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
  children: [HARDWARE, OVERVIEW],
});
const PROJECTS_FOLDER = Object.assign(new TFolder(), {
  path: "Projects",
  name: "Projects",
  children: [WORK_FOLDER],
});

const fileTree = new Map<string, TFolder | TFile>([
  [PROJECTS_FOLDER.path, PROJECTS_FOLDER],
  [WORK_FOLDER.path, WORK_FOLDER],
  [HARDWARE.path, HARDWARE],
  [OVERVIEW.path, OVERVIEW],
]);

/** Feeds `buildVisibilitySnapshot` (via the real controller) for the "work" space. */
const VAULT_INDEX = buildFakeVault({
  Papers: "folder",
  "Papers/A.md": "file",
  Projects: "folder",
  "Projects/Work": "folder",
  "Projects/Work/Hardware": "folder",
  "Projects/Work/Overview.md": "file",
  // The elsewhere group's fixture: a live leaf here must resolve through
  // `resolveLivePath` for `buildVisibilitySnapshot` to mark it a visitor, or
  // it never reaches `out` for the seam's guard to be tested against at all.
  Archive: "folder",
  "Archive/Old.md": "file",
});

const CURATED: SpaceDefinition = {
  id: "curated",
  name: "Curated",
  icon: "folder",
  color: "#4ecdc4",
  members: [{ path: "Papers", kind: "folder" }],
};

const WORK_SPACE: SpaceDefinition = {
  id: "work",
  name: "Work",
  icon: "briefcase",
  color: "#5b5bff",
  root: "Projects/Work",
  members: [],
};

function row(path: string): string {
  return `<div class="tree-item"><div class="tree-item-self" data-path="${path}"></div></div>`;
}

interface FakeView {
  containerEl: HTMLElement;
  sortOrder: string;
  fileItems: Record<string, FolderItemLike>;
  getSortedFolderItems(folder: unknown): FolderItemLike[];
  sort(): void;
  sorts: number;
}

/**
 * A file-explorer view exposing the vault root's RAW (unfiltered) children —
 * "Papers" and "Projects" — the way `explorerSeam.test.ts`'s `makeView` does,
 * plus a `fileItems` map so `itemsForPaths` (main.ts's `hoistedRootItems`) has
 * something real to read.
 */
function makeView(doc: Document = document): FakeView {
  const containerEl = doc.createElement("div");
  containerEl.innerHTML = `<div class="nav-files-container">
    ${row("Papers")}${row("Projects")}
  </div>`;
  doc.body.appendChild(containerEl);
  const view: FakeView = {
    containerEl,
    sortOrder: "alphabetical",
    fileItems: {
      [HARDWARE.path]: { file: { path: HARDWARE.path } },
      [OVERVIEW.path]: { file: { path: OVERVIEW.path } },
    },
    // Answers PER FOLDER, the way Obsidian's does. The hoist asks it for the
    // space's root, so a fake that ignored its argument would hand the root
    // the vault root's children and hide whether the hoist sorts at all.
    getSortedFolderItems: (folder: unknown): FolderItemLike[] => {
      const children = (folder as { children?: { path: string }[] } | null)?.children;
      if (Array.isArray(children)) return children.map((c) => ({ file: { path: c.path } }));
      return [{ file: { path: "Papers" } }, { file: { path: "Projects" } }];
    },
    sort() {
      view.sorts++;
    },
    sorts: 0,
  };
  return view;
}

interface Harness {
  plugin: SpacesPlugin;
  leaves: { view: FakeView }[];
}

async function makeHarness(leaves: { view: FakeView }[]): Promise<Harness> {
  const app = {
    workspace: {
      containerEl: document.body,
      getLeavesOfType: (type: string) => (type === "file-explorer" ? leaves : []),
      iterateRootLeaves: () => undefined,
    },
    vault: {
      getAbstractFileByPath: (p: string) => fileTree.get(p) ?? null,
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
  await plugin["defs"].mutate((d) => {
    d.spaces = [CURATED, WORK_SPACE];
    d.settings.allowReordering = false;
  });
  const runtimeBacking = new Map<string, unknown>();
  plugin["runtime"] = new RuntimeStateStore({
    get: (k) => runtimeBacking.get(k),
    set: (k, v) => void runtimeBacking.set(k, v),
  });
  plugin["controller"] = new SpaceController(plugin["defs"], plugin["runtime"], VAULT_INDEX, {
    // Delegates to the plugin's own `liveLeafPaths()`, mirroring `main.ts`'s
    // real wiring (`livePaths: () => this.liveLeafPaths()`) exactly. Every
    // existing test here sees the same empty set as before, because the
    // fake `app.workspace.iterateRootLeaves` above calls no callback; the
    // elsewhere-group tests below override `liveLeafPaths` once and get it
    // threaded to BOTH the hoist (`hoistedRootItems`/`currentPermits`) and
    // the controller's revealed-set sync, which is what actually decides
    // whether an elsewhere row survives `filterVisibleItems`.
    apply: (snap) => plugin["adapter"].apply(snap, plugin["elsewhereFirstPath"]()),
    livePaths: () => plugin["liveLeafPaths"](),
  });
  plugin["switcher"] = { mount: () => undefined, render: () => undefined } as unknown as SwitcherView;
  plugin["header"] = { mount: () => undefined, render: () => undefined } as unknown as SpaceHeaderView;
  return { plugin, leaves };
}

function ensure(h: Harness): void {
  h.plugin["ensureOrderingPatched"]();
}

function pathsOf(items: FolderItemLike[]): (string | undefined)[] {
  return items.map((i) => i.file?.path);
}

describe("folder-space hoisting through the real sort seam", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("honours Obsidian's own sort for a folder space's hoisted children", async () => {
    const view = makeView();
    // Native sort answering PER FOLDER, Z-A for the space's root. Installed
    // before `ensure`, because `patch()` captures the original at patch time.
    view.getSortedFolderItems = (folder: unknown): FolderItemLike[] => {
      const path = (folder as { path?: string } | null)?.path;
      if (path === "Projects/Work") {
        return [{ file: { path: OVERVIEW.path } }, { file: { path: HARDWARE.path } }];
      }
      return [{ file: { path: "Papers" } }, { file: { path: "Projects" } }];
    };
    const h = await makeHarness([{ view }]);
    h.plugin["runtime"].setSelection({ kind: "space", id: "work" });
    h.plugin["controller"].refresh();
    ensure(h);

    const out = view.getSortedFolderItems({ path: "/" });
    // The hoisted root must render in whatever order Obsidian sorted the root
    // folder into. `WORK_FOLDER.children` happens to be [Hardware, Overview],
    // so a hoist built from that array rather than from the sort passes the
    // A-Z case by luck and fails every other mode.
    expect(pathsOf(out)).toEqual([OVERVIEW.path, HARDWARE.path]);
  });

  it("re-resolves permits after a space switch instead of keeping what patch time captured", async () => {
    const view = makeView();
    const h = await makeHarness([{ view }]);
    // Patched while All is active, so a naive captured `permits` would be
    // `undefined` right here, for the lifetime of this patched view.
    h.plugin["runtime"].setSelection({ kind: "all" });
    h.plugin["controller"].refresh();
    ensure(h);

    // Now switch into the folder space. `patch()` refuses an already-patched
    // view, so `ensureOrderingPatched` cannot re-capture anything here —
    // `permits` must never be a captured value in the first place.
    h.plugin["runtime"].setSelection({ kind: "space", id: "work" });
    h.plugin["controller"].refresh();
    ensure(h);

    const out = view.getSortedFolderItems({ path: "/" });
    // Without re-resolving permits, the seam's guard would reject the
    // hoisted rows (permits still answering `undefined`/false for
    // everything) and fall back to the RAW vault-root items — "Papers" and
    // "Projects" rendering unfiltered.
    expect(pathsOf(out)).toEqual(["Projects/Work/Hardware", "Projects/Work/Overview.md"]);
  });

  it("re-resolves permits switching from one folder space to another with a different root", async () => {
    const ELSEWHERE = Object.assign(new TFolder(), { path: "Elsewhere", name: "Elsewhere" });
    const ELSEWHERE_FILE = Object.assign(new TFile(), {
      path: "Elsewhere/Note.md",
      name: "Note.md",
    });
    ELSEWHERE.children = [ELSEWHERE_FILE];
    // `fileTree` is a MODULE-LEVEL map shared by every test in this file
    // (`makeHarness`'s `app.vault.getAbstractFileByPath` reads it directly).
    // This is the only test that adds to it, and without
    // the `finally` below the two entries would silently outlive this test —
    // an unrelated later test's `getAbstractFileByPath("Elsewhere")` would
    // then resolve real, having found this test's leftover state rather than
    // its own fixture.
    fileTree.set(ELSEWHERE.path, ELSEWHERE);
    fileTree.set(ELSEWHERE_FILE.path, ELSEWHERE_FILE);

    try {
      const OTHER_SPACE: SpaceDefinition = {
        id: "other",
        name: "Other",
        icon: "briefcase",
        color: "#ff5b5b",
        root: "Elsewhere",
        members: [],
      };

      const view = makeView();
      view.fileItems[ELSEWHERE_FILE.path] = { file: { path: ELSEWHERE_FILE.path } };
      const h = await makeHarness([{ view }]);
      await h.plugin["defs"].mutate((d) => {
        d.spaces.push(OTHER_SPACE);
      });
      const elsewhereVault = buildFakeVault({
        Elsewhere: "folder",
        "Elsewhere/Note.md": "file",
        Projects: "folder",
        "Projects/Work": "folder",
        "Projects/Work/Hardware": "folder",
        "Projects/Work/Overview.md": "file",
      });
      h.plugin["controller"].setVaultIndex(elsewhereVault);

      h.plugin["runtime"].setSelection({ kind: "space", id: "work" });
      h.plugin["controller"].refresh();
      ensure(h);

      h.plugin["runtime"].setSelection({ kind: "space", id: "other" });
      h.plugin["controller"].refresh();
      ensure(h);

      const out = view.getSortedFolderItems({ path: "/" });
      // A STALE root ("Projects/Work") would either reject the "Elsewhere" rows
      // outright (root mismatch inside `makePermits`) or, if the closure being
      // tested were something looser, hoist the wrong folder's children.
      expect(pathsOf(out)).toEqual(["Elsewhere/Note.md"]);
    } finally {
      fileTree.delete(ELSEWHERE.path);
      fileTree.delete(ELSEWHERE_FILE.path);
    }
  });

  it("hoists each pane's OWN tree items, not pane zero's", async () => {
    const a = makeView();
    const b = makeView();
    // Distinct objects per pane, standing in for distinct live DOM-bearing
    // tree items — the same path, but never the same reference.
    a.fileItems = {
      [HARDWARE.path]: { file: { path: HARDWARE.path } },
      [OVERVIEW.path]: { file: { path: OVERVIEW.path } },
    };
    b.fileItems = {
      [HARDWARE.path]: { file: { path: HARDWARE.path } },
      [OVERVIEW.path]: { file: { path: OVERVIEW.path } },
    };
    const h = await makeHarness([{ view: a }, { view: b }]);
    h.plugin["runtime"].setSelection({ kind: "space", id: "work" });
    h.plugin["controller"].refresh();
    ensure(h);

    const outA = a.getSortedFolderItems({ path: "/" });
    const outB = b.getSortedFolderItems({ path: "/" });

    expect(outA[0]).toBe(a.fileItems[HARDWARE.path]);
    expect(outB[0]).toBe(b.fileItems[HARDWARE.path]);
    // If both panes read `explorerViews()[0]` (pane `a`), `outB` would carry
    // `a`'s objects — this is the assertion that catches it.
    expect(outB[0]).not.toBe(outA[0]);
    expect(outB[0]).not.toBe(a.fileItems[HARDWARE.path]);
  });

  // `currentPermits()` (main.ts) needs a test that actually reaches the
  // SEAM's `isAllowed` guard with a non-empty elsewhere set. A test that
  // calls `filterAndOrderFolder` directly (as `filterAndOrderFolder.test.ts`
  // does) never exercises this at all — the guard lives in `patch()`'s
  // override, not in the transform.
  it("does not fall back to the raw vault root when the elsewhere set is non-empty (currentPermits())", async () => {
    const view = makeView();
    view.fileItems["Archive/Old.md"] = { file: { path: "Archive/Old.md" } };
    const h = await makeHarness([{ view }]);
    // Feeds BOTH `hoistedRootItems`/`currentPermits` (main.ts reads
    // `liveLeafPaths()` directly) and, via the harness's `livePaths` wiring
    // above, the controller's own revealed-set sync — which is what makes
    // `buildVisibilitySnapshot` mark "Archive/Old.md" a visitor so it
    // survives `filterVisibleItems` and actually reaches the seam's `out`.
    (h.plugin as unknown as { liveLeafPaths: () => Set<string> }).liveLeafPaths = () =>
      new Set(["Archive/Old.md"]);

    h.plugin["runtime"].setSelection({ kind: "space", id: "work" });
    h.plugin["controller"].refresh();
    ensure(h);

    const out = view.getSortedFolderItems({ path: "/" });
    // Reverting `currentPermits()` to `makePermits(root, new Set())` makes
    // the seam's guard refuse "Archive/Old.md" (its parent is not the root,
    // and the set that would separately admit it is empty). `isAllowed`
    // requires EVERY row in `out` to pass, so the WHOLE substitution —
    // including the root's OWN children — is rejected, and the seam falls
    // back to "Papers"/"Projects", the raw unfiltered vault root. That is the
    // exact Task-4 Critical shape: worse than showing nothing extra, it
    // undoes the hoist too.
    expect(pathsOf(out)).toEqual([
      "Projects/Work/Hardware",
      "Projects/Work/Overview.md",
      "Archive/Old.md",
    ]);
  });

  // Final review, Perf: `isAllowed` (nativeExplorerSort.ts) calls `permits`
  // once per OUT-OF-INPUT row, and before this fix `livePermits` recomputed
  // `currentPermits()` — a full `liveLeafPaths()` walk plus `elsewhereOf`'s
  // sort — on every one of those calls, O(rows) per vault-root sort rather
  // than O(1). This drives the real seam (three out-of-input rows: the
  // root's two children plus one elsewhere row) and counts `currentPermits`
  // invocations directly, so a regression back to per-item resolution
  // reddens this without needing to measure wall-clock time.
  it("resolves currentPermits() once per sort call, not once per row (perf)", async () => {
    const view = makeView();
    view.fileItems["Archive/Old.md"] = { file: { path: "Archive/Old.md" } };
    const h = await makeHarness([{ view }]);
    (h.plugin as unknown as { liveLeafPaths: () => Set<string> }).liveLeafPaths = () =>
      new Set(["Archive/Old.md"]);

    h.plugin["runtime"].setSelection({ kind: "space", id: "work" });
    h.plugin["controller"].refresh();
    ensure(h);

    const spy = vi.spyOn(h.plugin as unknown as { currentPermits: () => unknown }, "currentPermits");

    const out = view.getSortedFolderItems({ path: "/" });
    // Three rows reach the guard (two hoisted children, one elsewhere row) —
    // if `currentPermits()` were still called per row, this would be 3.
    expect(pathsOf(out)).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
