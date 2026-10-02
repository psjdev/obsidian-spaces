/**
 * Mount and query helpers for tests that drive the real `CreateSpacePanel`.
 *
 * Extracted from `createSpacePanel.test.ts` so a second file can mount the
 * same panel the same way rather than growing a parallel harness. Callers
 * need the jsdom environment (`// @vitest-environment jsdom`) and must call
 * `resetPanelDom()` in a `beforeEach`.
 */
import { CreateSpacePanel, type CreateSpacePanelDeps } from "../../src/ui/CreateSpacePanel";
import type { CreateSpaceOptions } from "../../src/actions/spaceLifecycle";
import type { NodeKind } from "../../src/ui/vaultTree";
import { buildPreview } from "../../src/ui/previewSeam";
import { createTreeVaultIndex } from "../../src/visibility/VaultIndex";
import { compileIgnore } from "../../src/visibility/glob";

/** A small vault: two folders, one nested, and two notes. */
export const VAULT: Record<string, NodeKind> = {
  Projects: "folder",
  "Projects/Work": "folder",
  "Projects/Work/plan.md": "file",
  Archive: "folder",
  "inbox.md": "file",
};

/** What `nativeKnownTags` would hand over: Obsidian's spelling, `#` and all. */
export const VAULT_TAGS = ["#project", "#project/console", "#archive"];

/**
 * What the engine's `TagIndex` would answer for those tags. Ancestors are
 * already expanded in the real one, so `project` holds `project/console`'s
 * note too, and `archive` is a tag Obsidian lists with nothing filed under it
 * yet.
 */
export const TAG_PATHS: Record<string, string[]> = {
  project: ["Projects/Work/plan.md", "inbox.md"],
  "project/console": ["inbox.md"],
  archive: [],
};

export interface Harness {
  panel: CreateSpacePanel;
  parent: HTMLElement;
  submitted: Array<{ name: string; opts: CreateSpaceOptions }>;
  closes: number;
  saved: string[][];
  /** Every tag the panel asked the index about, in order. */
  counted: string[];
  /** How many times it reached for the index itself. */
  reached: number;
}

export function makeHarness(over: Partial<CreateSpacePanelDeps> = {}): Harness {
  const submitted: Harness["submitted"] = [];
  const saved: string[][] = [];
  const counted: string[] = [];
  let closes = 0;
  let reached = 0;
  let engineIndex: ReturnType<typeof createTreeVaultIndex> | null = null;

  const deps: CreateSpacePanelDeps = {
    folders: {
      allPaths: () => Object.keys(VAULT),
      kindOf: (path) => VAULT[path] ?? null,
    },
    tags: { knownTags: () => [...VAULT_TAGS] },
    tagIndex: () => {
      reached += 1;
      return {
        pathsMatching: (tag) => {
          counted.push(tag);
          return [...(TAG_PATHS[tag] ?? [])];
        },
      };
    },
    // The real seam over the harness vault, so the summary row counts through
    // the engine exactly as it does in the app. The tag index is reached once
    // per tag lookup, so none is reached while no tag member is present, which
    // is what `reached` asserts and what main.ts does. The vault index is
    // derived from `deps.folders`, so a test that overrides the vault gets a
    // preview and coverage over that vault, not over `VAULT`.
    // Built once, on first use, like the engine's index which is one snapshot
    // the panel only reads; rebuilding per draw would also count as a vault
    // read against the "once per session" tests, which are about the panel's
    // own reads of `folders`.
    vaultIndex: () => {
      if (engineIndex === null) {
        const entries = new Map<string, NodeKind>();
        for (const p of deps.folders.allPaths()) {
          const k = deps.folders.kindOf(p);
          if (k !== null) entries.set(p, k);
        }
        engineIndex = createTreeVaultIndex(entries);
      }
      return engineIndex;
    },
    preview: (members) =>
      buildPreview(
        deps.vaultIndex(),
        compileIgnore([]),
        {
          pathsMatching: (tag) => deps.tagIndex().pathsMatching(tag),
        }
      )(members),
    customColors: [],
    useThemeIconColor: () => false,
    saveCustomColors: async (customs) => {
      saved.push([...customs]);
    },
    defaultColor: "#5b5bff",
    onSubmit: async (name, opts) => {
      submitted.push({ name, opts });
    },
    onClose: () => {
      closes += 1;
    },
    ...over,
  };

  // `mount()` asserts the pane shape: it must be handed the view's
  // containerEl, an ancestor of `.nav-files-container`, never the container
  // itself. Anything else is a programming error it throws on by design.
  const parent = document.createElement("div");
  const container = document.createElement("div");
  container.className = "nav-files-container";
  parent.appendChild(container);
  document.body.appendChild(parent);

  const panel = new CreateSpacePanel(deps);
  panel.mount(parent);
  return {
    panel,
    parent,
    submitted,
    saved,
    counted,
    get closes() {
      return closes;
    },
    get reached() {
      return reached;
    },
  } as Harness;
}

export const panelEl = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>(".spaces-create-panel");
  if (!el) throw new Error("panel is not mounted");
  return el;
};
export const byKey = (key: string): HTMLElement => {
  const el = panelEl().querySelector<HTMLElement>(`[data-focus-key="${key}"]`);
  if (!el) throw new Error(`no control with data-focus-key="${key}"`);
  return el;
};
export const nameInput = (): HTMLInputElement => byKey("name") as HTMLInputElement;
export const tree = (): HTMLElement | null => panelEl().querySelector(".spaces-create-tree");
/**
 * The item tree's rows. Both bodies are trees now, so the role alone no longer
 * tells them apart; the rows that carry a vault path are this one's.
 */
export const rows = (): HTMLElement[] =>
  Array.from(panelEl().querySelectorAll<HTMLElement>("[role='treeitem'][data-path]"));
export const rowFor = (path: string): HTMLElement => {
  const row = rows().find((r) => r.dataset.path === path);
  if (!row) throw new Error(`no row for ${path}; have ${rows().map((r) => r.dataset.path)}`);
  return row;
};

export const tagRows = (): HTMLElement[] =>
  Array.from(panelEl().querySelectorAll<HTMLElement>("[role='treeitem'][data-tag]"));
export const tagRowFor = (tag: string): HTMLElement => {
  const row = tagRows().find((r) => r.dataset.tag === tag);
  if (!row) throw new Error(`no tag row for ${tag}; have ${tagRows().map((r) => r.dataset.tag)}`);
  return row;
};

/** Clears the document between tests and stubs what jsdom does not implement. */
export function resetPanelDom(): void {
  document.body.replaceChildren();
  // jsdom implements no layout, so it ships no `scrollIntoView`. `showFault`
  // calls it to bring a marked control into view, a real behaviour with
  // nothing to assert here, so it is stubbed rather than skipped.
  Element.prototype.scrollIntoView = (): void => {};
}
