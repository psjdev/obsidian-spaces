// @vitest-environment jsdom
/**
 * The explorer seam's LEAF ARITHMETIC: which file-explorer leaves are bound,
 * patched and re-sorted, and which held view is released.
 *
 * One active selection applies per app instance, to every file-explorer
 * leaf in the main window. Four independent
 * `getLeavesOfType("file-explorer")[0]` lookups meant one leaf — and
 * `ensureOrderingPatched` actively UNPATCHED whichever view stopped being
 * index 0, so a second explorer pane showed the unfiltered vault and a space
 * switch could swap which pane that was.
 *
 * Two further findings live in the same method and are pinned here:
 *  - the release of a held view sat AFTER three early returns, so
 *    closing the explorer tab stranded a detached patched view that
 *    `applyFilterAndOrdering()` then re-sorted on every event.
 *  - the re-sort is memoised on a signature derived from the visibility
 *    snapshot's own output, so anything that changes what is visible — a
 *    visitor appearing on `file-open` above all — necessarily invalidates it.
 *
 * Layer: unit — it runs against the `obsidian` stub. It is evidence about
 * the seam's bookkeeping, not about the real app. What it buys is that
 * "leaf zero only" can no longer come back in silence.
 */
import { beforeEach, describe, expect, it } from "vitest";
import SpacesPlugin from "../src/main";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { SpaceController } from "../src/controller/SpaceController";
import { isPatched } from "../src/layout/nativeExplorerSort";
import { CLS } from "../src/explorer/selectors";
import { buildFakeVault } from "./helpers/fakeVault";
import type { FolderItemLike } from "../src/layout/nativeExplorerSort";
import type { SpaceDefinition } from "../src/types";
import type { SpaceHeaderView } from "../src/ui/SpaceHeaderView";
import type { SwitcherView } from "../src/ui/SwitcherView";

const RESEARCH: SpaceDefinition = {
  id: "research",
  name: "Research",
  icon: "microscope",
  color: "#4ecdc4",
  members: [{ path: "Papers/Attention.md", kind: "file" }],
};

const VAULT = buildFakeVault({
  Papers: "folder",
  "Papers/Attention.md": "file",
  "Papers/Draft.md": "file",
  "Recipes.md": "file",
});

function row(path: string): string {
  return `<div class="tree-item"><div class="tree-item-self" data-path="${path}"></div></div>`;
}

/**
 * A file-explorer view in the shape the seam actually reads: a `containerEl`
 * holding a `.nav-files-container`, plus the three private-API members
 * `nativeExplorerSort` probes for. `sort()` counts, because "was this view
 * re-sorted?" is the whole question in half these tests.
 */
interface FakeView {
  containerEl: HTMLElement;
  sortOrder: string;
  getSortedFolderItems(folder: unknown): FolderItemLike[];
  sort(): void;
  sorts: number;
}

function makeView(doc: Document = document): FakeView {
  const containerEl = doc.createElement("div");
  containerEl.innerHTML = `<div class="nav-files-container">
    ${row("Papers")}${row("Papers/Attention.md")}${row("Papers/Draft.md")}${row("Recipes.md")}
  </div>`;
  doc.body.appendChild(containerEl);
  const view: FakeView = {
    containerEl,
    sortOrder: "alphabetical",
    getSortedFolderItems: () => [],
    sort() {
      view.sorts++;
    },
    sorts: 0,
  };
  return view;
}

function containerOf(view: FakeView): HTMLElement {
  return view.containerEl.querySelector(".nav-files-container") as HTMLElement;
}

interface Harness {
  plugin: SpacesPlugin;
  leaves: { view: FakeView; isDeferred?: boolean }[];
  /** The leaf walk, made writable so a test can open a file. */
  live: Set<string>;
}

/**
 * A plugin wired with exactly the collaborators the seam reads. `onload()` is
 * never called; the switcher and header are inert stand-ins so the chrome's
 * own `mount()` (which reaches `setIcon`, unmodelled by the stub) stays out of
 * these tests — they are about leaf arithmetic, not about chrome.
 */
async function makeHarness(
  leaves: { view: FakeView; isDeferred?: boolean }[]
): Promise<Harness> {
  const app = {
    workspace: {
      containerEl: document.body,
      getLeavesOfType: (type: string) => (type === "file-explorer" ? leaves : []),
      iterateRootLeaves: () => undefined,
    },
    vault: {},
  };
  const plugin = new SpacesPlugin(
    app as unknown as ConstructorParameters<typeof SpacesPlugin>[0],
    {} as ConstructorParameters<typeof SpacesPlugin>[1]
  );
  plugin["defs"] = new DefinitionStore({
    read: async () => undefined,
    write: async () => undefined,
  });
  // The drag gesture is a separate seam and binding it here would put
  // DOM listeners on the fakes for nothing.
  await plugin["defs"].mutate((d) => {
    d.spaces = [RESEARCH];
    d.settings.allowReordering = false;
  });
  const runtimeBacking = new Map<string, unknown>();
  plugin["runtime"] = new RuntimeStateStore({
    get: (k) => runtimeBacking.get(k),
    set: (k, v) => void runtimeBacking.set(k, v),
  });
  const live = new Set<string>();
  plugin["controller"] = new SpaceController(plugin["defs"], plugin["runtime"], VAULT, {
    apply: (snap) => plugin["adapter"].apply(snap),
    livePaths: () => new Set(live),
  });
  plugin["switcher"] = {
    mount: () => undefined,
    render: () => undefined,
    applyPlacement: () => undefined,
  } as unknown as SwitcherView;
  plugin["header"] = { mount: () => undefined, render: () => undefined } as unknown as SpaceHeaderView;
  return { plugin, leaves, live };
}

function bind(h: Harness): void {
  h.plugin["bindExplorer"]();
}
function ensure(h: Harness): void {
  h.plugin["ensureOrderingPatched"]();
}
function resort(h: Harness): void {
  h.plugin["applyFilterAndOrdering"]();
}

describe("the explorer seam across several main-window leaves", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("patches every main-window file-explorer leaf, not only the first", async () => {
    const a = makeView();
    const b = makeView();
    const h = await makeHarness([{ view: a }, { view: b }]);
    ensure(h);
    expect(isPatched(a)).toBe(true);
    expect(isPatched(b)).toBe(true);
  });

  it("does not unpatch one leaf while taking the other", async () => {
    const a = makeView();
    const b = makeView();
    const h = await makeHarness([{ view: a }, { view: b }]);
    ensure(h);
    // The thrash: array order is not stable across changeLayout(), so the same
    // two leaves arriving reversed must not release either one.
    h.leaves.reverse();
    ensure(h);
    expect(isPatched(a)).toBe(true);
    expect(isPatched(b)).toBe(true);
  });

  it("re-sorts every patched leaf", async () => {
    const a = makeView();
    const b = makeView();
    const h = await makeHarness([{ view: a }, { view: b }]);
    ensure(h);
    h.plugin["controller"].refresh();
    resort(h);
    expect(a.sorts).toBeGreaterThan(0);
    expect(b.sorts).toBeGreaterThan(0);
  });

  it("classes rows in every main-window leaf's container", async () => {
    const a = makeView();
    const b = makeView();
    const h = await makeHarness([{ view: a }, { view: b }]);
    bind(h);
    h.plugin["runtime"].setSelection({ kind: "space", id: "research" });
    h.plugin["controller"].refresh();
    const scaffoldIn = (v: FakeView): boolean =>
      containerOf(v).querySelector('[data-path="Papers"]')!.parentElement!.classList.contains(
        CLS.scaffold
      );
    expect(scaffoldIn(a)).toBe(true);
    expect(scaffoldIn(b)).toBe(true);
  });

  it("leaves a pop-out window's explorer alone (README: main window only)", async () => {
    const main = makeView();
    const popout = makeView(document.implementation.createHTMLDocument("popout"));
    const h = await makeHarness([{ view: main }, { view: popout }]);
    ensure(h);
    expect(isPatched(main)).toBe(true);
    expect(isPatched(popout)).toBe(false);
  });

  it("skips a deferred leaf but still serves the live one beside it", async () => {
    const deferred = makeView();
    const live = makeView();
    const h = await makeHarness([{ view: deferred, isDeferred: true }, { view: live }]);
    ensure(h);
    expect(isPatched(deferred)).toBe(false);
    expect(isPatched(live)).toBe(true);
  });
});

describe("releasing a view the seam no longer serves", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("releases the patched view when the explorer tab is closed", async () => {
    const view = makeView();
    const h = await makeHarness([{ view }]);
    ensure(h);
    expect(isPatched(view)).toBe(true);
    h.leaves.length = 0; // the user closed the Files tab
    ensure(h);
    expect(isPatched(view)).toBe(false);
  });

  it("stops re-sorting a view whose leaf is gone", async () => {
    const view = makeView();
    const h = await makeHarness([{ view }]);
    ensure(h);
    h.leaves.length = 0;
    ensure(h);
    const before = view.sorts;
    h.plugin["controller"].refresh();
    resort(h);
    resort(h);
    expect(view.sorts).toBe(before);
  });

  it("releases a view that has become deferred", async () => {
    const view = makeView();
    const h = await makeHarness([{ view }]);
    ensure(h);
    h.leaves[0].isDeferred = true;
    ensure(h);
    expect(isPatched(view)).toBe(false);
  });

  it("releases the old view before the seam probe can decline", async () => {
    // The probe's early return is the third of the three the release used to
    // sit behind. A view that loses `sort` must still not be held.
    const view = makeView();
    const h = await makeHarness([{ view }]);
    ensure(h);
    const broken = makeView();
    (broken as { sort?: unknown }).sort = undefined;
    h.leaves[0] = { view: broken };
    ensure(h);
    expect(isPatched(view)).toBe(false);
  });
});

describe("the re-sort memo", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  async function armed(): Promise<{ h: Harness; view: FakeView }> {
    const view = makeView();
    const h = await makeHarness([{ view }]);
    ensure(h);
    h.plugin["runtime"].setSelection({ kind: "space", id: "research" });
    h.plugin["controller"].refresh();
    resort(h);
    return { h, view };
  }

  it("skips a re-sort when nothing that reaches the transform has changed", async () => {
    const { h, view } = await armed();
    const after = view.sorts;
    // A second `file-open` in the same space, opening a file that is already
    // visible: the controller rebuilds the snapshot object, but its CONTENT is
    // identical, so the tree cannot change.
    h.plugin["controller"].refresh();
    resort(h);
    expect(view.sorts).toBe(after);
  });

  it("re-sorts when a visitor appears, which is why the old memo was removed", async () => {
    const { h, view } = await armed();
    const after = view.sorts;
    // Opening a non-member makes it a visitor, so the visible set grows
    // while the selection and the order map both stand still. The memo the
    // 2026-09-07 change deleted keyed on {selection, orders} and missed
    // exactly this.
    h.live.add("Recipes.md");
    h.plugin["controller"].onActiveFileChanged("Recipes.md");
    resort(h);
    expect(h.plugin["controller"].currentSnapshot()!.decisionFor("Recipes.md").reason).toBe(
      "visitor"
    );
    expect(view.sorts).toBeGreaterThan(after);
  });

  it("re-sorts when the stored order changes", async () => {
    const { h, view } = await armed();
    // The `allowReordering` setting gates the ordering half, so enable it
    // first and let the memo absorb that write. The only delta across the
    // two `resort` calls below is then the order map itself.
    await h.plugin["defs"].mutate((d) => {
      d.settings.allowReordering = true;
    });
    resort(h);
    const after = view.sorts;
    await h.plugin["defs"].mutate((d) => {
      d.orders = { bySpaceId: { research: { Papers: ["Papers/Attention.md"] } } };
    });
    resort(h);
    expect(view.sorts).toBeGreaterThan(after);
  });

  it("re-sorts a freshly patched view rather than inheriting the memo", async () => {
    const { h } = await armed();
    // changeLayout() destroys the explorer and Obsidian rebuilds it: a NEW
    // view object, never sorted through the transform. A memo that survived
    // this would leave the whole vault on screen inside a space.
    const rebuilt = makeView();
    h.leaves[0] = { view: rebuilt };
    ensure(h);
    resort(h);
    expect(rebuilt.sorts).toBeGreaterThan(0);
  });

  it("re-sorts a second pane opened after the memo was armed", async () => {
    // Nothing was released here, so this is the fresh-PATCH invalidation on
    // its own: the new pane has never been through the transform and is
    // showing the whole vault, while every signature field is unchanged. This
    // is the memo's one catastrophic failure mode, so it gets its own test
    // rather than riding on the rebuild case above (where the release of the
    // old view invalidates the memo anyway).
    const { h } = await armed();
    const second = makeView();
    h.leaves.push({ view: second });
    ensure(h);
    resort(h);
    expect(second.sorts).toBeGreaterThan(0);
  });

  it("re-sorts when the selection changes even if the visible set matches", async () => {
    const { h, view } = await armed();
    const after = view.sorts;
    h.plugin["runtime"].setSelection({ kind: "all" });
    h.plugin["controller"].refresh();
    resort(h);
    expect(view.sorts).toBeGreaterThan(after);
  });
});
