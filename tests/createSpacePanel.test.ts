// @vitest-environment jsdom
/**
 * The create panel's state machine — the part of this feature that churned
 * hardest and, until this file, was the only part with no tests at all.
 *
 * Every pure helper it leans on is covered elsewhere (`createSpaceForm`,
 * `vaultTree`, `ribbonAlign`, `panelCoverage`). What was missing is the wiring
 * BETWEEN them: `itemsOpen` against `state.folderMode`, what a mode button's
 * pressed state actually reports, what a collapse keeps, and where focus lands
 * when a Create is refused. Three consecutive rounds of live user reports were
 * about exactly those four things, and none of them could have been caught by
 * the suite as it stood.
 *
 * The rule this file keeps to: assert on STATE the panel is responsible for —
 * `aria-pressed`, `aria-invalid`, `document.activeElement`, and what reaches
 * `onSubmit` — never on icon markup or computed style. jsdom lays nothing out
 * and the `setIcon` stub deliberately models no markup, so anything visual
 * stays Layer 4.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateSpacePanel, type CreateSpacePanelDeps } from "../src/ui/CreateSpacePanel";
import type { CreateSpaceOptions } from "../src/actions/spaceLifecycle";
import type { NodeKind } from "../src/ui/vaultTree";

/** A small vault: two folders, one nested, and two notes. */
const VAULT: Record<string, NodeKind> = {
  Projects: "folder",
  "Projects/Work": "folder",
  "Projects/Work/plan.md": "file",
  Archive: "folder",
  "inbox.md": "file",
};

/** What `nativeKnownTags` would hand over: Obsidian's spelling, `#` and all. */
const VAULT_TAGS = ["#project", "#project/console", "#archive"];

/**
 * What the engine's `TagIndex` would answer for those tags. Ancestors are
 * already expanded in the real one, so `project` holds `project/console`'s
 * note too, and `archive` is a tag Obsidian lists with nothing filed under it
 * yet.
 */
const TAG_PATHS: Record<string, string[]> = {
  project: ["Projects/Work/plan.md", "inbox.md"],
  "project/console": ["inbox.md"],
  archive: [],
};

interface Harness {
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

function makeHarness(over: Partial<CreateSpacePanelDeps> = {}): Harness {
  const submitted: Harness["submitted"] = [];
  const saved: string[][] = [];
  const counted: string[] = [];
  let closes = 0;
  let reached = 0;

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

const panelEl = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>(".spaces-create-panel");
  if (!el) throw new Error("panel is not mounted");
  return el;
};
const byKey = (key: string): HTMLElement => {
  const el = panelEl().querySelector<HTMLElement>(`[data-focus-key="${key}"]`);
  if (!el) throw new Error(`no control with data-focus-key="${key}"`);
  return el;
};
const nameInput = (): HTMLInputElement => byKey("name") as HTMLInputElement;
const tree = (): HTMLElement | null => panelEl().querySelector(".spaces-create-tree");
/**
 * The item tree's rows. Both bodies are trees now, so the role alone no longer
 * tells them apart; the rows that carry a vault path are this one's.
 */
const rows = (): HTMLElement[] =>
  Array.from(panelEl().querySelectorAll<HTMLElement>("[role='treeitem'][data-path]"));
const rowFor = (path: string): HTMLElement => {
  const row = rows().find((r) => r.dataset.path === path);
  if (!row) throw new Error(`no row for ${path}; have ${rows().map((r) => r.dataset.path)}`);
  return row;
};
const pressed = (key: string): string | null => byKey(key).getAttribute("aria-pressed");

function typeName(value: string): void {
  const input = nameInput();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  document.body.replaceChildren();
  // jsdom implements no layout, so it ships no `scrollIntoView`. `showFault`
  // calls it to bring a marked control into view — a real behaviour with
  // nothing to assert here, so it is stubbed rather than skipped.
  Element.prototype.scrollIntoView = (): void => {};
});

describe("mode buttons", () => {
  it("starts with neither mode chosen and no picker", () => {
    makeHarness();
    expect(pressed("mode-curate")).toBe("false");
    expect(pressed("mode-folder")).toBe("false");
    expect(tree()).toBeNull();
  });

  it("opens the picker in the mode clicked", () => {
    makeHarness();
    byKey("mode-folder").click();
    expect(pressed("mode-folder")).toBe("true");
    expect(pressed("mode-curate")).toBe("false");
    expect(tree()).not.toBeNull();
  });

  it("shows folders only in Pin to Folder, and files too in Curate", () => {
    makeHarness();
    byKey("mode-folder").click();
    expect(rows().map((r) => r.dataset.path)).not.toContain("inbox.md");
    byKey("mode-curate").click();
    expect(rows().map((r) => r.dataset.path)).toContain("inbox.md");
  });

  /**
   * The reported bug. Clicking Pin to Folder and clicking it again left the
   * button unpressed but `folderMode` still on, so Create went on refusing a
   * mode the user had visibly abandoned.
   */
  it("abandons an empty mode when its picker is collapsed", async () => {
    const h = makeHarness();
    typeName("Deselected");
    byKey("mode-folder").click();
    byKey("mode-folder").click();

    expect(pressed("mode-folder")).toBe("false");
    expect(tree()).toBeNull();

    byKey("create").click();
    await vi.waitFor(() => expect(h.submitted).toHaveLength(1));
    // An empty curated space — no root, no members — which is what "neither
    // mode chosen" is defined to produce.
    expect(h.submitted[0].opts.root).toBeUndefined();
    expect(h.submitted[0].opts.members).toEqual([]);
  });

  it("keeps a mode that holds a choice when its picker is collapsed", async () => {
    const h = makeHarness();
    typeName("Kept");
    byKey("mode-folder").click();
    rowFor("Archive").click();
    byKey("mode-folder").click();

    // Collapsing is tidying the panel, not undoing the choice — so the button
    // must go on reporting the mode that is still in force.
    expect(pressed("mode-folder")).toBe("true");
    expect(tree()).toBeNull();

    byKey("create").click();
    await vi.waitFor(() => expect(h.submitted).toHaveLength(1));
    expect(h.submitted[0].opts.root).toBe("Archive");
    expect(h.submitted[0].opts.members).toEqual([]);
  });

  it("remembers each side across a switch", () => {
    makeHarness();
    byKey("mode-curate").click();
    rowFor("inbox.md").click();
    byKey("mode-folder").click();
    rowFor("Archive").click();
    byKey("mode-curate").click();
    // The item picked before the detour is still ticked.
    expect(rowFor("inbox.md").getAttribute("aria-selected")).toBe("true");
  });

  it("submits the root alone when both sides hold something", async () => {
    const h = makeHarness();
    typeName("Both");
    byKey("mode-curate").click();
    rowFor("inbox.md").click();
    byKey("mode-folder").click();
    rowFor("Archive").click();

    byKey("create").click();
    await vi.waitFor(() => expect(h.submitted).toHaveLength(1));
    expect(h.submitted[0].opts.root).toBe("Archive");
    expect(h.submitted[0].opts.members).toEqual([]);
  });
});

describe("a refused Create", () => {
  it("does not submit, and marks and focuses the name", () => {
    const h = makeHarness();
    byKey("create").click();
    expect(h.submitted).toHaveLength(0);
    expect(nameInput().classList.contains("is-invalid")).toBe(true);
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(nameInput());
  });

  /**
   * The regression this file would have caught on its own: the tree box had
   * no `tabindex`, so `focus()` on it was a silent no-op and a keyboard user
   * refused a Create got a Notice, a red border they could not reach, and
   * focus left on the button.
   */
  it("marks and focuses the tree when Pin to Folder has no folder", () => {
    const h = makeHarness();
    typeName("No folder yet");
    byKey("mode-folder").click();
    byKey("create").click();

    expect(h.submitted).toHaveLength(0);
    const box = tree();
    expect(box?.classList.contains("is-invalid")).toBe(true);
    expect(document.activeElement).toBe(box);
  });

  /**
   * `showFault` opens the picker before marking the tree, because a red border
   * on a box that is not on screen tells the user nothing.
   *
   * That branch is now DEFENSIVE rather than reachable, and this test records
   * why: it would need folder mode on, no folder chosen, and the picker shut —
   * and `collapseMode` abandons a mode collapsed with nothing in it, so
   * shutting the picker in that state turns the mode off instead. The guard
   * stays because it is the cheaper half of the pair; this asserts the
   * reachable half, that a root fault always ends with the picker open.
   */
  it("always marks a tree the user can actually see", () => {
    makeHarness();
    typeName("Collapsed");
    byKey("mode-folder").click();
    byKey("create").click();
    expect(tree()).not.toBeNull();
    expect(tree()?.classList.contains("is-invalid")).toBe(true);

    // And the state the branch guards against cannot be constructed: closing
    // an empty Pin turns the mode off rather than leaving it on and hidden.
    byKey("mode-folder").click();
    expect(pressed("mode-folder")).toBe("false");
  });

  it("clears the name mark as soon as the user types", () => {
    makeHarness();
    byKey("create").click();
    expect(nameInput().classList.contains("is-invalid")).toBe(true);
    typeName("R");
    expect(nameInput().classList.contains("is-invalid")).toBe(false);
    expect(nameInput().hasAttribute("aria-invalid")).toBe(false);
  });

  it("clears the root mark when the mode is switched away from", () => {
    makeHarness();
    typeName("Switcher");
    byKey("mode-folder").click();
    byKey("create").click();
    expect(tree()?.classList.contains("is-invalid")).toBe(true);

    byKey("mode-curate").click();
    // The fault named a mode that is no longer in force.
    expect(tree()?.classList.contains("is-invalid")).toBe(false);
  });

  it("clears the root mark when a folder is chosen", () => {
    makeHarness();
    typeName("Chooser");
    byKey("mode-folder").click();
    byKey("create").click();
    expect(tree()?.classList.contains("is-invalid")).toBe(true);

    rowFor("Archive").click();
    expect(tree()?.classList.contains("is-invalid")).toBe(false);
  });

  it("refuses a name over the schema's cap", () => {
    const h = makeHarness();
    typeName("x".repeat(200));
    byKey("create").click();
    expect(h.submitted).toHaveLength(0);
    expect(nameInput().classList.contains("is-invalid")).toBe(true);
  });

  it("survives the re-render a mode click causes", () => {
    makeHarness();
    byKey("create").click();
    // `render()` replaces the very node the mark was on, so the mark has to be
    // re-applied rather than left to the DOM.
    byKey("mode-curate").click();
    expect(nameInput().classList.contains("is-invalid")).toBe(true);
  });
});

describe("re-mounting", () => {
  /**
   * `mount()` resets `state` and `submitting` precisely so a reused instance
   * does not re-open showing the last attempt. The picker's four fields were
   * seeded in the constructor alone, which made that reset a half-measure.
   */
  it("forgets the picker, the filter and the mark", () => {
    const h = makeHarness();
    byKey("create").click();
    byKey("mode-curate").click();
    rowFor("inbox.md").click();
    const filter = byKey("item-filter") as HTMLInputElement;
    filter.value = "inb";
    filter.dispatchEvent(new Event("input", { bubbles: true }));

    h.panel.mount(h.parent);

    expect(tree()).toBeNull();
    expect(pressed("mode-curate")).toBe("false");
    expect(nameInput().value).toBe("");
    expect(nameInput().classList.contains("is-invalid")).toBe(false);
    byKey("mode-curate").click();
    expect((byKey("item-filter") as HTMLInputElement).value).toBe("");
    expect(rowFor("inbox.md").getAttribute("aria-selected")).toBe("false");
  });
});

describe("scroll position of the picker window", () => {
  // jsdom lays nothing out, so a real scroll offset cannot be read. What can
  // be asserted is the decision to call `scrollIntoView`, which is what moved
  // the box: a stub in `beforeEach` is replaced here by a spy.
  const spyScroll = (): { calls: number } => {
    const seen = { calls: 0 };
    Element.prototype.scrollIntoView = (): void => {
      seen.calls += 1;
    };
    return seen;
  };

  it("brings a pre-chosen root into view when the panel opens", () => {
    const seen = spyScroll();
    makeHarness({ root: "Projects/Work" });
    expect(seen.calls).toBe(1);
  });

  it("does not move the box on a pick, an expand, a collapse or a filter", () => {
    makeHarness();
    typeName("Stay");
    const seen = spyScroll();
    byKey("mode-curate").click();
    const base = seen.calls;
    const caret = (path: string): HTMLElement => {
      const c = rowFor(path).querySelector<HTMLElement>(".spaces-create-tree-caret");
      if (!c) throw new Error(`no caret on ${path}`);
      return c;
    };
    caret("Projects").click();
    rowFor("inbox.md").click();
    // A second selection is what made the first-match lookup drag the box up.
    rowFor("Projects/Work").click();
    rowFor("inbox.md").click();
    caret("Projects").click();
    const filter = byKey("item-filter") as HTMLInputElement;
    filter.value = "inbox";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    expect(seen.calls).toBe(base);
  });

  it("does not move the tag body on a pick either", () => {
    makeHarness();
    typeName("Tags");
    const seen = spyScroll();
    byKey("mode-curate").click();
    byKey("body-tags").click();
    const row = panelEl().querySelector<HTMLElement>("[data-tag='archive']");
    if (!row) throw new Error("no archive tag row");
    row.click();
    expect(seen.calls).toBe(0);
  });
});

describe("arriving from \"Create space from this folder\"", () => {
  it("opens with the mode on, the picker open and the branch expanded", () => {
    makeHarness({ root: "Projects/Work" });
    expect(pressed("mode-folder")).toBe("true");
    expect(tree()).not.toBeNull();
    // The ancestor is expanded, or the selection would be hidden inside a
    // collapsed branch.
    expect(rowFor("Projects/Work").getAttribute("aria-selected")).toBe("true");
  });

  /**
   * `""` and `"/"` are the missing-root state, not a root. Ticking the mode
   * for one of them opens the panel with folder mode on, nothing chosen, and
   * both buttons drawn unpressed — then refuses Create naming a button that
   * looks deselected.
   */
  it("ignores a root that is really the missing-root state", () => {
    for (const root of ["", "/"]) {
      document.body.replaceChildren();
      makeHarness({ root });
      expect(pressed("mode-folder"), root).toBe("false");
      expect(tree(), root).toBeNull();
    }
  });
});

describe("the tree's ARIA", () => {
  it("owns its rows directly", () => {
    makeHarness();
    byKey("mode-curate").click();
    const treeNode = panelEl().querySelector("[role='tree']");
    expect(treeNode).not.toBeNull();
    // Every treeitem must be owned by the tree — an unroled div in between
    // makes assistive tech report a tree of zero items.
    for (const row of rows()) expect(row.parentElement).toBe(treeNode);
  });

  it("says 'not selected' rather than nothing", () => {
    makeHarness();
    byKey("mode-curate").click();
    expect(rowFor("Archive").getAttribute("aria-selected")).toBe("false");
    rowFor("Archive").click();
    expect(rowFor("Archive").getAttribute("aria-selected")).toBe("true");
  });
});

describe("where the chosen color shows", () => {
  const iconBtn = (): HTMLElement => {
    const el = panelEl().querySelector<HTMLElement>(".spaces-create-iconbtn");
    if (!el) throw new Error("no icon button");
    return el;
  };
  const brush = (): HTMLElement => {
    const el = panelEl().querySelector<HTMLElement>(".spaces-create-theme .spaces-create-theme-icon");
    if (!el) throw new Error("no brush");
    return el;
  };

  /**
   * The brush labels the action; it is not the thing being colored. An
   * earlier build tinted it, which made the button read as a second swatch
   * and put the color in the one place it describes nothing.
   */
  it("never tints the color button's brush", () => {
    makeHarness({ defaultColor: "#ff6b6b" });
    expect(brush().style.color).toBe("");
  });

  it("leaves the placeholder untinted, so the stylesheet's grey wins", () => {
    // The dashed plus is a prompt, not a preview: coloring it would claim a
    // choice nobody has made. An inline color here would also out-specify
    // `.is-empty`.
    makeHarness({ defaultColor: "#ff6b6b" });
    expect(iconBtn().classList.contains("is-empty")).toBe(true);
    expect(iconBtn().style.color).toBe("");
  });

  it("tints the icon once one is chosen", () => {
    makeHarness({ defaultColor: "#ff6b6b" });
    iconBtn().click();
    const choice = document.querySelector<HTMLElement>(".spaces-icon-popover .spaces-icon-cell");
    if (!choice) throw new Error("the icon picker offered nothing to click");
    choice.click();

    expect(iconBtn().classList.contains("is-empty")).toBe(false);
    // jsdom normalises an assigned hex to its rgb() form.
    expect(iconBtn().style.color).toBe("rgb(255, 107, 107)");
  });
});

describe("keyboard access to the item tree", () => {
  /**
   * Expanding was mouse-only. The row handles Enter and Space to SELECT, but
   * expand/collapse lived solely on the caret's click handler, and the caret
   * carried `role="button"` with no tabindex and no key handler — so it could
   * not be focused or activated.
   *
   * In Pin to Folder mode that made every nested folder unreachable without a
   * mouse: you could pin `Projects`, but never `Projects/Work`.
   *
   * Arrow keys are the tree pattern's own answer, and cost no extra tab stop.
   */
  const rowFocus = (path: string): HTMLElement => {
    const row = rowFor(path);
    row.focus();
    return row;
  };
  const press = (el: HTMLElement, key: string): void => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  };
  const paths = (): (string | undefined)[] => rows().map((r) => r.dataset.path);

  it("expands a folder with ArrowRight", () => {
    makeHarness();
    byKey("mode-curate").click();
    expect(paths()).not.toContain("Projects/Work");
    press(rowFocus("Projects"), "ArrowRight");
    expect(paths()).toContain("Projects/Work");
    // Re-rendering the tree replaces the focused row, so the handler has to
    // put focus back on the row's replacement. Asserted because the failure
    // mode is silent: focus lands on the document body and the keyboard route
    // ends there, with every other assertion still true.
    expect(document.activeElement).toBe(rowFor("Projects"));
  });

  it("collapses a folder with ArrowLeft", () => {
    makeHarness();
    byKey("mode-curate").click();
    press(rowFocus("Projects"), "ArrowRight");
    expect(paths()).toContain("Projects/Work");
    press(rowFocus("Projects"), "ArrowLeft");
    expect(paths()).not.toContain("Projects/Work");
  });

  it("reaches a nested folder in Pin to Folder mode without a mouse", () => {
    // The gap this closes, end to end.
    const h = makeHarness();
    typeName("Nested");
    byKey("mode-folder").click();
    press(rowFocus("Projects"), "ArrowRight");
    const nested = rowFor("Projects/Work");
    nested.focus();
    press(nested, "Enter");
    byKey("create").click();
    return vi.waitFor(() => expect(h.submitted[0]?.opts.root).toBe("Projects/Work"));
  });

  it("leaves selection alone: arrows browse, they do not pick", () => {
    makeHarness();
    byKey("mode-curate").click();
    press(rowFocus("Projects"), "ArrowRight");
    expect(rowFor("Projects").getAttribute("aria-selected")).toBe("false");
  });

  it("ignores arrows on a row with no children", () => {
    makeHarness();
    byKey("mode-curate").click();
    const before = paths();
    press(rowFocus("inbox.md"), "ArrowRight");
    expect(paths()).toEqual(before);
  });

  it("hides the caret from assistive tech, since the row carries the state", () => {
    // `aria-expanded` on the row is where a tree announces this. A caret that
    // cannot be focused must not also claim to be a button.
    makeHarness();
    byKey("mode-curate").click();
    const caret = rowFor("Projects").querySelector(".spaces-create-tree-caret");
    expect(caret?.getAttribute("aria-hidden")).toBe("true");
    expect(caret?.hasAttribute("role")).toBe(false);
    expect(rowFor("Projects").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the picker's row cap", () => {
  /**
   * Measured on a 20,000-note vault before this existed: typing a single "a"
   * rendered 18,954 rows and cost ~1,260 ms, per keystroke. Cost tracks the row
   * count almost exactly — ~12 rows per millisecond — and `buildVaultTree` was
   * only 25 ms of it, so the rows are the whole problem and the cap is the fix.
   *
   * `visibleRows` still computes every match (1-2 ms); only rendering is
   * capped, so the count reported below is honest rather than an estimate.
   */
  const BIG: Record<string, NodeKind> = {};
  for (let i = 0; i < 500; i++) BIG[`Notes/note-${i}.md`] = "file";
  BIG["Notes"] = "folder";

  const bigDeps = {
    folders: { allPaths: () => Object.keys(BIG), kindOf: (p: string) => BIG[p] ?? null },
  };

  const typeNote = (): HTMLInputElement => {
    const f = byKey("item-filter") as HTMLInputElement;
    f.value = "note";
    f.dispatchEvent(new Event("input", { bubbles: true }));
    return f;
  };
  const overflowRows = (): HTMLElement[] =>
    Array.from(panelEl().querySelectorAll<HTMLElement>(".spaces-create-tree-row.is-overflow"));

  it("renders at most 200 rows, the overflow row among them", () => {
    makeHarness(bigDeps);
    byKey("mode-curate").click();
    typeNote();
    // 199 real rows and the marker that stands in for the rest: the marker
    // spends a slot of the budget like any row.
    expect(rows().length).toBe(199);
    expect(rows().length + overflowRows().length).toBe(200);
  });

  it("says how many it did not render, inside the branch it cut", () => {
    makeHarness(bigDeps);
    byKey("mode-curate").click();
    typeNote();
    const [more] = overflowRows();
    // 500 files + the folder that holds them, less the 198 files drawn under
    // it and the folder itself. The folder is the one root, so every row that
    // was cut was a child of it.
    expect(more?.textContent).toBe("302 more, narrow the filter to see them");
    expect(more?.style.paddingLeft).toBe("14px");
  });

  it("draws the overflow row as a disabled tree item that takes no input", () => {
    // A `role="tree"` may only own `treeitem`s, and the marker stands in for
    // rows rather than being one: not selectable, not focusable.
    makeHarness(bigDeps);
    byKey("mode-curate").click();
    typeNote();
    const [more] = overflowRows();
    const treeNode = panelEl().querySelector("[role='tree']");
    expect(more?.parentElement).toBe(treeNode);
    expect(more?.getAttribute("role")).toBe("treeitem");
    expect(more?.getAttribute("aria-disabled")).toBe("true");
    expect(more?.getAttribute("aria-selected")).toBe("false");
    expect(more?.hasAttribute("tabindex")).toBe(false);
    // A listener would have chosen, expanded or redrawn something. The summary
    // is where a choice shows, and the row set is where an expand would.
    const summaryBefore = panelEl().querySelector(".spaces-create-summary")?.textContent;
    const pathsBefore = rows().map((r) => r.dataset.path);
    more?.click();
    more?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(panelEl().querySelector(".spaces-create-summary")?.textContent).toBe(summaryBefore);
    expect(rows().map((r) => r.dataset.path)).toEqual(pathsBefore);
    expect(overflowRows()[0]).toBe(more);
    expect(panelEl().querySelector(".spaces-create-tree-more")).toBeNull();
  });

  it("draws a parent the budget could not open as a leaf with a reason, not a dead caret", () => {
    // One folder of 199 subfolders, filtered so everything wants to be open:
    // the first two levels use the whole budget, so none of the 199 can show
    // what is inside it. Expanding one adds demand at a deeper level and frees
    // nothing, so a caret there would look clickable and do nothing.
    const WIDE: Record<string, NodeKind> = { Notes: "folder" };
    for (let i = 0; i < 199; i++) {
      WIDE[`Notes/d${i}`] = "folder";
      WIDE[`Notes/d${i}/note.md`] = "file";
    }
    makeHarness({
      folders: { allPaths: () => Object.keys(WIDE), kindOf: (p: string) => WIDE[p] ?? null },
    });
    byKey("mode-curate").click();
    typeNote();
    const closed = rowFor("Notes/d0");
    expect(closed.querySelector(".spaces-create-tree-caret svg")).toBeNull();
    expect(closed.hasAttribute("aria-expanded")).toBe(false);
    // A filter is active, so closing other folders would change nothing and
    // the title must not offer it.
    expect(closed.getAttribute("title")).toBe(
      "There is no room to show what is inside this folder. Narrow the filter to make room."
    );
    expect(closed.getAttribute("title")).not.toMatch(/[—–]|colour|items?|files?/i);
    // The folder above them is open and unaffected.
    expect(rowFor("Notes").getAttribute("aria-expanded")).toBe("true");
  });

  it("offers closing other folders, not filtering, when no filter is active", () => {
    // 198 subfolders leave exactly one slot below the root. Two opened by hand
    // want it and one gets it (the earlier, d0, is the one left closed). With no filter, closing the first
    // is what makes room, and narrowing a filter that is not there is not.
    const WIDE: Record<string, NodeKind> = { Notes: "folder" };
    for (let i = 0; i < 198; i++) {
      WIDE[`Notes/d${i}`] = "folder";
      WIDE[`Notes/d${i}/note.md`] = "file";
    }
    makeHarness({
      folders: { allPaths: () => Object.keys(WIDE), kindOf: (p: string) => WIDE[p] ?? null },
    });
    byKey("mode-curate").click();
    rowFor("Notes").querySelector<HTMLElement>(".spaces-create-tree-caret")?.click();
    rowFor("Notes/d0").querySelector<HTMLElement>(".spaces-create-tree-caret")?.click();
    rowFor("Notes/d1").querySelector<HTMLElement>(".spaces-create-tree-caret")?.click();
    expect(rowFor("Notes/d0").getAttribute("title")).toBe(
      "There is no room to show what is inside this folder. Close other folders to make room."
    );
  });

  it("keeps a working caret on a parent the user closed themselves", () => {
    // The other half of the distinction: a collapsed row is not budget-closed,
    // and its caret does open it.
    makeHarness();
    byKey("mode-curate").click();
    const row = rowFor("Projects");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.hasAttribute("title")).toBe(false);
    row.querySelector<HTMLElement>(".spaces-create-tree-caret")?.click();
    expect(rowFor("Projects").getAttribute("aria-expanded")).toBe("true");
  });

  it("says nothing when everything fits", () => {
    makeHarness();
    byKey("mode-curate").click();
    expect(overflowRows()).toHaveLength(0);
  });

  it("drops the overflow row again once the filter narrows", () => {
    makeHarness(bigDeps);
    byKey("mode-curate").click();
    const f = typeNote();
    expect(overflowRows().length).toBe(1);
    f.value = "note-499"; f.dispatchEvent(new Event("input", { bubbles: true }));
    expect(overflowRows()).toHaveLength(0);
    expect(rows().length).toBeLessThan(200);
  });
});

describe("the picker reads the vault once per session", () => {
  /**
   * Reading and rebuilding the tree costs about 40 ms on a 20,000-note vault,
   * and it used to run on every keystroke, caret and row click. It now runs
   * once per full render, so a filtering session works from one snapshot.
   *
   * The trade is deliberate: a file created while the picker is open appears
   * the next time the picker is opened, not mid-keystroke.
   */
  const counting = (): { deps: Partial<CreateSpacePanelDeps>; reads: () => number } => {
    let reads = 0;
    return {
      deps: {
        folders: {
          allPaths: () => {
            reads += 1;
            return Object.keys(VAULT);
          },
          kindOf: (p) => VAULT[p] ?? null,
        },
      },
      reads: () => reads,
    };
  };

  it("does not re-read the vault on every keystroke", () => {
    const { deps, reads } = counting();
    makeHarness(deps);
    byKey("mode-curate").click();
    const before = reads();
    const f = byKey("item-filter") as HTMLInputElement;
    for (const q of ["P", "Pr", "Pro"]) {
      f.value = q;
      f.dispatchEvent(new Event("input", { bubbles: true }));
    }
    expect(reads()).toBe(before);
  });

  it("re-reads when the picker is reopened", () => {
    // Switching mode rebuilds the panel, which is the point at which a newly
    // created file should appear.
    const { deps, reads } = counting();
    makeHarness(deps);
    byKey("mode-curate").click();
    const after = reads();
    byKey("mode-folder").click();
    expect(reads()).toBeGreaterThan(after);
  });
});

describe("the Items and Tags buttons under the filter box", () => {
  /**
   * Every test that reaches the tag list reaches it with an EMPTY filter box.
   *
   * That is not a narrow case, it is the only one reachable: a non-empty tag
   * query builds an Obsidian fuzzy scorer, and the stub refuses to imitate
   * `prepareFuzzySearch` on purpose (see its docstring) so that no ranking
   * assertion can be written against a fake algorithm. The ranking itself is
   * tested where the scorer is injected, in `fuzzyTagCandidates.test.ts`; what
   * is left for this file is the WIRING, and an empty box now exercises all of
   * it — the two buttons, the sigils that press them, the rows, the pick and
   * the summary row underneath.
   */
  const filterFor = (text: string): void => {
    const f = byKey("item-filter") as HTMLInputElement;
    f.value = text;
    f.dispatchEvent(new Event("input", { bubbles: true }));
  };
  /** One character arriving at the filter box, with the box left to react. */
  const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    byKey("item-filter").dispatchEvent(e);
    return e;
  };
  /**
   * One character arriving at the filter box AS A BROWSER DELIVERS IT: keydown
   * first, then, only if nothing prevented it, the character in the value and
   * the `input` event that follows.
   *
   * jsdom performs no default action of its own, so `press` alone cannot tell
   * a keystroke the panel consumed from one it let land. Everything about the
   * sigil flash is the difference between those two, so it needs this.
   */
  const typeChar = (ch: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const f = byKey("item-filter") as HTMLInputElement;
    const e = new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true, ...init });
    f.dispatchEvent(e);
    if (e.defaultPrevented) return e;
    const at = f.selectionStart ?? f.value.length;
    const to = f.selectionEnd ?? at;
    f.value = f.value.slice(0, at) + ch + f.value.slice(to);
    f.setSelectionRange(at + 1, at + 1);
    f.dispatchEvent(new Event("input", { bubbles: true }));
    return e;
  };
  /** The same, at speed: no timer gets to run between the characters. */
  const typeFast = (text: string): void => {
    for (const ch of text) typeChar(ch);
  };
  const box = (): HTMLInputElement => byKey("item-filter") as HTMLInputElement;
  const tagRows = (): HTMLElement[] =>
    Array.from(panelEl().querySelectorAll<HTMLElement>("[role='treeitem'][data-tag]"));
  const tagRowFor = (tag: string): HTMLElement => {
    const row = tagRows().find((r) => r.dataset.tag === tag);
    if (!row) throw new Error(`no tag row for ${tag}; have ${tagRows().map((r) => r.dataset.tag)}`);
    return row;
  };
  /** Opens a tag's branch the way the pointer does, without choosing it. */
  const expandTag = (tag: string): void => {
    const caret = tagRowFor(tag).querySelector<HTMLElement>(".spaces-create-tree-caret");
    if (!caret) throw new Error(`no caret on ${tag}`);
    caret.click();
  };
  const overflow = (): string | null =>
    panelEl().querySelector(".spaces-create-tree-row.is-overflow")?.textContent ?? null;
  const summary = (): string =>
    panelEl().querySelector(".spaces-create-summary")?.textContent ?? "";

  const openCurated = (): void => {
    byKey("create").click();
    byKey("mode-curate").click();
  };
  const showTags = (): void => byKey("body-tags").click();

  it("sit under the filter box and above the window, not inside it", () => {
    // The relaxation this prototype is built on: the pane gets two more
    // buttons, and in exchange nothing has to be guessed at or typed blind.
    makeHarness();
    openCurated();
    const window_ = panelEl().querySelector(".spaces-create-tree");
    expect(window_?.contains(byKey("body-items"))).toBe(false);
    expect(window_?.contains(byKey("body-tags"))).toBe(false);
    const items = panelEl().querySelector(".spaces-create-items");
    expect(items?.contains(byKey("body-tags"))).toBe(true);
    const group = panelEl().querySelector(".spaces-create-bodies");
    expect(group?.previousElementSibling).toBe(byKey("item-filter"));
    expect(group?.nextElementSibling).toBe(window_);
  });

  it("opens on Items", () => {
    makeHarness();
    openCurated();
    expect(pressed("body-items")).toBe("true");
    expect(pressed("body-tags")).toBe("false");
    expect(rows().length).toBeGreaterThan(0);
  });

  it("swaps the tree for the vault's tags, and back", () => {
    makeHarness();
    openCurated();
    showTags();
    // The item tree is gone, not merely filtered to nothing.
    expect(rows()).toEqual([]);
    // Collapsed to its roots, like the other body: `project/console` is behind
    // `project`'s caret rather than sitting beside it.
    expect(tagRows().map((r) => r.dataset.tag)).toEqual(["project", "archive"]);
    byKey("body-items").click();
    expect(tagRows()).toEqual([]);
    expect(rows().length).toBeGreaterThan(0);
  });

  it("says which of the two is showing", () => {
    makeHarness();
    openCurated();
    showTags();
    expect(pressed("body-tags")).toBe("true");
    expect(pressed("body-items")).toBe("false");
  });

  it("stays a tree in both bodies, and relabels itself across the switch", () => {
    // Tags nest on `/` exactly as paths do, so the tag body is a tree too and
    // the old `listbox` is gone. The box is the SAME element in both modes, so
    // every attribute that differs has to be set on every draw rather than
    // left behind by the body before it.
    makeHarness();
    openCurated();
    const treeBox = (): HTMLElement => {
      const el = panelEl().querySelector<HTMLElement>("[role='tree']");
      if (!el) throw new Error("the window is not a tree");
      return el;
    };
    expect(treeBox().getAttribute("aria-label")).toBe("Choose items");
    expect(treeBox().hasAttribute("aria-multiselectable")).toBe(false);
    showTags();
    expect(panelEl().querySelector("[role='listbox']")).toBeNull();
    expect(treeBox().getAttribute("aria-label")).toBe("Choose tags");
    expect(treeBox().getAttribute("aria-multiselectable")).toBe("true");
    byKey("body-items").click();
    expect(treeBox().getAttribute("aria-label")).toBe("Choose items");
    expect(treeBox().hasAttribute("aria-multiselectable")).toBe(false);
  });

  it("shows every tag with the chosen ones marked, which is what the tree does", () => {
    // The symmetry the two buttons promise: both bodies show everything the
    // vault holds of their kind and mark what this space has taken. Neither
    // body is a review list.
    makeHarness();
    openCurated();
    showTags();
    expandTag("project");
    expect(tagRows().map((r) => r.dataset.tag)).toEqual(["project", "project/console", "archive"]);
    tagRowFor("archive").click();
    expect(tagRows().map((r) => r.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
    ]);
  });

  it("keeps the filter text across a switch, and filters with it either side", () => {
    // The box narrows whichever body is on screen, so its text is a query the
    // user wrote rather than something the old body owned. A button that threw
    // it away would be a button that loses work.
    makeHarness({ tags: { knownTags: () => [] } });
    openCurated();
    filterFor("inbox");
    showTags();
    expect(panelEl().querySelector(".spaces-create-tree-empty")?.textContent).toBe(
      "No matching tag"
    );
    byKey("body-items").click();
    expect((byKey("item-filter") as HTMLInputElement).value).toBe("inbox");
    expect(rows().map((r) => r.dataset.path)).toEqual(["inbox.md"]);
  });

  it("adds a tag member, not a path member", () => {
    const h = makeHarness();
    openCurated();
    typeName("Work");
    showTags();
    tagRowFor("project").click();
    byKey("create").click();
    expect(h.submitted[0]?.opts.members).toEqual([{ kind: "tag", tag: "project" }]);
  });

  it("puts no count on the Curated button, wherever the member came from", () => {
    // The count moved to the summary row, which can say what a number on a
    // half-width button never could: what the selection comes to.
    makeHarness();
    openCurated();
    rowFor("inbox.md").click();
    showTags();
    tagRowFor("project").click();
    expect(byKey("mode-curate").textContent).toBe("Curated");
    expect(byKey("mode-folder").textContent).toBe("Folder pinned");
  });

  it("removes a chosen tag when its row is clicked", () => {
    // One gesture: in a multi-select listbox, activating a selected option
    // deselects it, so the list needs no second verb and the row's tooltip is
    // a label for the click rather than a control.
    const h = makeHarness();
    openCurated();
    typeName("Work");
    showTags();
    tagRowFor("project").click();
    expect(tagRowFor("project").title).toBe("Remove #project");
    tagRowFor("project").click();
    expect(tagRowFor("project").getAttribute("aria-selected")).toBe("false");
    expect(tagRowFor("project").title).toBe("");
    byKey("create").click();
    expect(h.submitted[0]?.opts.members).toEqual([]);
  });

  it("picks and removes with the keyboard", () => {
    makeHarness();
    openCurated();
    showTags();
    const enter = (): void => {
      tagRowFor("archive").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    };
    enter();
    expect(tagRowFor("archive").getAttribute("aria-selected")).toBe("true");
    enter();
    expect(tagRowFor("archive").getAttribute("aria-selected")).toBe("false");
  });

  it("says so when the vault's tags cannot be listed", () => {
    // `nativeKnownTags` reports a missing private `getTags` by RETURNING null.
    // An empty box would be read as "this vault has no tags", which is a
    // different thing with a different remedy.
    makeHarness({ tags: { knownTags: () => null } });
    openCurated();
    showTags();
    const empty = panelEl().querySelector(".spaces-create-tree-empty");
    expect(empty?.textContent).toMatch(/Settings, Contents/);
  });

  it("says so when the vault genuinely has no tags", () => {
    makeHarness({ tags: { knownTags: () => [] } });
    openCurated();
    showTags();
    const empty = panelEl().querySelector(".spaces-create-tree-empty");
    expect(empty?.textContent).toMatch(/No tags/);
  });

  it("says how many notes each tag brings in", () => {
    // The row's whole confidence signal: the picker offers a selector, so
    // there is no list of notes to click through, and a bare tag name says
    // nothing about whether it is the one meant. `project` reports its own
    // note and `project/console`'s, because that is what the member resolves
    // to.
    const count = (tag: string): string | null =>
      tagRowFor(tag).querySelector(".spaces-create-tag-count")?.textContent ?? null;
    makeHarness();
    openCurated();
    showTags();
    expandTag("project");
    expect(count("project")).toBe("2 notes");
    expect(count("project/console")).toBe("1 note");
    expect(count("archive")).toBe("no notes");
  });

  it("asks the index only about the tags it is drawing", () => {
    // The tag tree caps at the same 200 rows the item tree does. Counting
    // before the cap would put one lookup per vault tag behind every
    // keystroke, which is the cost this body lives under.
    const many = Array.from({ length: 250 }, (_, i) => `#t${String(i).padStart(3, "0")}`);
    const h = makeHarness({ tags: { knownTags: () => many } });
    openCurated();
    showTags();
    // 199 tags and the overflow row that spends the 200th slot.
    expect(tagRows().length).toBe(199);
    expect(h.counted.length).toBe(199);
    expect(h.counted).toEqual(tagRows().map((r) => r.dataset.tag));
  });

  it("says how many rows the cap kept back, in an overflow row like the item tree's", () => {
    // The cap is a safety net for an expanded branch, not something the
    // collapsed view should ever meet, so the user is told when it bites.
    const many = Array.from({ length: 250 }, (_, i) => `#t${String(i).padStart(3, "0")}`);
    makeHarness({ tags: { knownTags: () => many } });
    openCurated();
    showTags();
    expect(overflow()).toBe("51 more, narrow the filter to see them");
  });

  it("reaches for the index once per draw, not once per row", () => {
    const h = makeHarness();
    openCurated();
    showTags();
    expect(h.reached).toBe(1);
    // Two roots while `project` is collapsed, so the nested tag costs nothing
    // until it is on screen.
    expect(h.counted.length).toBe(2);
  });

  it("re-reads the index rather than counting against the vault as it opened", () => {
    // The index is a snapshot the coalescer's flush replaces. A captured one
    // would go on reporting the vault as it was when the panel opened.
    const h = makeHarness();
    openCurated();
    showTags();
    const first = h.reached;
    tagRowFor("project").click();
    expect(h.reached).toBeGreaterThan(first);
  });

  it("asks the index nothing while the tree is on screen", () => {
    const h = makeHarness();
    openCurated();
    expect(h.reached).toBe(0);
    expect(h.counted).toEqual([]);
  });

  it("is not offered in folder mode", () => {
    // A folder space is a window onto one root, and a tag is not one.
    makeHarness();
    byKey("create").click();
    byKey("mode-folder").click();
    expect(panelEl().querySelector("[data-focus-key='body-tags']")).toBeNull();
    expect(panelEl().querySelector("[data-focus-key='body-items']")).toBeNull();
  });

  it("reopens on Items when a mode button is pressed", () => {
    // Folder mode has no tags at all, so the window reopens on the vault
    // rather than on whatever the last curated session left it showing.
    makeHarness();
    openCurated();
    showTags();
    byKey("mode-folder").click();
    byKey("mode-curate").click();
    expect(pressed("body-items")).toBe("true");
    expect(panelEl().querySelector("[role='tree']")).not.toBeNull();
  });

  it("names the body in the filter box's placeholder", () => {
    makeHarness();
    openCurated();
    const placeholder = (): string => (byKey("item-filter") as HTMLInputElement).placeholder;
    expect(placeholder()).toBe("Filter notes and folders…");
    showTags();
    expect(placeholder()).toBe("Filter tags…");
  });

  describe("the tag tree", () => {
    /**
     * A tag vault with real nesting and two intermediates nobody ever used:
     * `area` and `area/health` exist only because `area/health/active` and
     * `area/health/paused` do. That is the ordinary case for tags and the
     * defensive one for paths, which is why the tree has to invent them.
     */
    const NESTED_TAGS = ["#area/health/active", "#area/health/paused", "#project"];
    /**
     * What the engine's index answers for them. Ancestors are already expanded
     * in the real one, so `area` holds both notes without anything carrying
     * that tag on its own.
     */
    const NESTED_PATHS: Record<string, string[]> = {
      area: ["a.md", "b.md"],
      "area/health": ["a.md", "b.md"],
      "area/health/active": ["a.md"],
      "area/health/paused": ["b.md"],
      project: ["c.md"],
    };
    const nested = (): Harness =>
      makeHarness({
        tags: { knownTags: () => [...NESTED_TAGS] },
        tagIndex: () => ({ pathsMatching: (tag) => [...(NESTED_PATHS[tag] ?? [])] }),
      });
    const countOn = (tag: string): string | null =>
      tagRowFor(tag).querySelector(".spaces-create-tag-count")?.textContent ?? null;
    const enterOn = (tag: string): void => {
      tagRowFor(tag).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    };

    it("nests tags on their slashes, inventing a parent nobody ever used", () => {
      nested();
      openCurated();
      showTags();
      expect(tagRows().map((r) => r.dataset.tag)).toEqual(["area", "project"]);
      expandTag("area");
      expect(tagRows().map((r) => r.dataset.tag)).toEqual(["area", "area/health", "project"]);
      expandTag("area/health");
      expect(tagRows().map((r) => r.dataset.tag)).toEqual([
        "area",
        "area/health",
        "area/health/active",
        "area/health/paused",
        "project",
      ]);
    });

    it("shows the last segment, which is the part that differs", () => {
      nested();
      openCurated();
      showTags();
      expandTag("area");
      const name = (tag: string): string | undefined =>
        tagRowFor(tag).querySelector(".spaces-create-tree-name")?.textContent ?? undefined;
      expect(name("area")).toBe("area");
      expect(name("area/health")).toBe("health");
    });

    it("gives an invented parent a count, and lets it be picked", async () => {
      const h = nested();
      openCurated();
      typeName("Health");
      showTags();
      // Nobody tagged a note `area`. Picking it is still meaningful, because it
      // matches everything beneath it, and the count says how much that is.
      expect(countOn("area")).toBe("2 notes");
      tagRowFor("area").click();
      byKey("create").click();
      await vi.waitFor(() => expect(h.submitted).toHaveLength(1));
      expect(h.submitted[0].opts.members).toEqual([{ kind: "tag", tag: "area" }]);
    });

    it("counts a parent's nested notes in the parent's own total", () => {
      // The sum people will try to verify by hand. `area` reads 2 although
      // nothing carries it, because both leaves beneath it are in its figure.
      nested();
      openCurated();
      showTags();
      expandTag("area");
      expandTag("area/health");
      expect(countOn("area")).toBe("2 notes");
      expect(countOn("area/health")).toBe("2 notes");
      expect(countOn("area/health/active")).toBe("1 note");
      expect(countOn("area/health/paused")).toBe("1 note");
    });

    it("marks the children a selected parent already covers, at any depth", () => {
      nested();
      openCurated();
      showTags();
      tagRowFor("area").click();
      expandTag("area");
      const child = tagRowFor("area/health");
      expect(child.classList.contains("is-inherited")).toBe(true);
      expect(child.getAttribute("aria-disabled")).toBe("true");
      expect(child.getAttribute("title")).toBe(
        "Already included by the selected tag #area. " +
          "Deselect that tag to pick tags under it one at a time."
      );
      expandTag("area/health");
      // Depth is not special-cased: a grandchild names the same parent.
      expect(tagRowFor("area/health/active").getAttribute("aria-disabled")).toBe("true");
      expect(tagRowFor("area/health/active").getAttribute("title")).toMatch(/selected tag #area\./);
      // And nothing outside the branch is touched.
      expect(tagRowFor("project").classList.contains("is-inherited")).toBe(false);
      expect(tagRowFor("project").hasAttribute("aria-disabled")).toBe(false);
    });

    it("does nothing at all when a covered child is clicked, or Entered", async () => {
      const h = nested();
      openCurated();
      typeName("Health");
      showTags();
      tagRowFor("area").click();
      expandTag("area");
      tagRowFor("area/health").click();
      expect(tagRowFor("area/health").getAttribute("aria-selected")).toBe("false");
      enterOn("area/health");
      expect(tagRowFor("area/health").getAttribute("aria-selected")).toBe("false");
      byKey("create").click();
      await vi.waitFor(() => expect(h.submitted).toHaveLength(1));
      expect(h.submitted[0].opts.members).toEqual([{ kind: "tag", tag: "area" }]);
    });

    it("leaves a child picked on its own alone when an unrelated tag is selected", () => {
      nested();
      openCurated();
      showTags();
      expandTag("area");
      tagRowFor("area/health").click();
      tagRowFor("project").click();
      const child = tagRowFor("area/health");
      expect(child.getAttribute("aria-selected")).toBe("true");
      expect(child.classList.contains("is-inherited")).toBe(false);
      expect(child.hasAttribute("aria-disabled")).toBe(false);
      expect(child.title).toBe("Remove #area/health");
    });

    it("reads as covered, not picked, when the child was picked before its parent", () => {
      // This case used to assert that both stayed stored and the child read as
      // picked. That was the click-order defect: toggleItem now absorbs a child
      // into a parent picked after it, so the child is only ever covered.
      nested();
      openCurated();
      showTags();
      expandTag("area");
      tagRowFor("area/health").click();
      tagRowFor("area").click();
      const child = tagRowFor("area/health");
      expect(child.classList.contains("is-selected")).toBe(false);
      expect(child.classList.contains("is-inherited")).toBe(true);
      expect(child.getAttribute("aria-disabled")).toBe("true");
    });

    it("brings a deep match's ancestors with it, opened to it", () => {
      nested();
      openCurated();
      showTags();
      // `paused` is only ever a last segment, so this is the case that says
      // the match is on the name rather than on the whole tag.
      filterFor("paused");
      expect(tagRows().map((r) => r.dataset.tag)).toEqual([
        "area",
        "area/health",
        "area/health/paused",
      ]);
    });

    it("keeps its expansion apart from the item tree's", () => {
      makeHarness();
      openCurated();
      const caret = rowFor("Projects").querySelector<HTMLElement>(".spaces-create-tree-caret");
      if (!caret) throw new Error("no caret on Projects");
      caret.click();
      expect(rows().map((r) => r.dataset.path)).toContain("Projects/Work");
      showTags();
      expandTag("project");
      expect(tagRows().map((r) => r.dataset.tag)).toContain("project/console");
      byKey("body-items").click();
      // Switching bodies does not collapse what was opened in the other one.
      expect(rows().map((r) => r.dataset.path)).toContain("Projects/Work");
      showTags();
      expect(tagRows().map((r) => r.dataset.tag)).toContain("project/console");
    });
  });

  describe("the / and # shortcuts", () => {
    it("switches to tags on a # into an empty box", () => {
      vi.useFakeTimers();
      try {
        makeHarness();
        openCurated();
        typeChar("#");
        expect(pressed("body-tags")).toBe("true");
        expect(tagRows().length).toBe(2);
        // Taken rather than consumed outright: the box shows the character and
        // then gives it up, and the query never holds it either way.
        vi.runAllTimers();
        expect(box().value).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });

    it("switches back to items on a / into an empty box", () => {
      vi.useFakeTimers();
      try {
        makeHarness();
        openCurated();
        typeChar("#");
        vi.runAllTimers();
        typeChar("/");
        expect(pressed("body-items")).toBe("true");
        expect(rows().length).toBeGreaterThan(0);
        vi.runAllTimers();
        expect(box().value).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves both characters alone once the box holds anything", () => {
      // `/` is in nearly every path this picker is used on. A mode switch
      // mid-path would take the keystroke AND the view.
      makeHarness();
      openCurated();
      filterFor("Projects");
      const slash = press("/");
      const hash = press("#");
      expect(slash.defaultPrevented).toBe(false);
      expect(hash.defaultPrevented).toBe(false);
      expect(pressed("body-items")).toBe("true");
    });

    it("leaves them alone in folder mode", () => {
      // Nothing to switch to: that mode draws neither button.
      makeHarness();
      byKey("create").click();
      byKey("mode-folder").click();
      expect(press("#").defaultPrevented).toBe(false);
      expect(panelEl().querySelector("[role='tree']")).not.toBeNull();
    });

    it("leaves a sigil reached with a modifier to the app", () => {
      makeHarness();
      openCurated();
      const e = press("#", { ctrlKey: true });
      expect(e.defaultPrevented).toBe(false);
      expect(pressed("body-items")).toBe("true");
    });

    it("shows the sigil for a moment rather than swallowing the keystroke", () => {
      vi.useFakeTimers();
      try {
        // An empty tag source: the stub refuses to imitate `prepareFuzzySearch`
        // on purpose, so a non-empty query against real tags throws rather than
        // ranks. What is under test here is the box, not the ranking.
        makeHarness({ tags: { knownTags: () => [] } });
        openCurated();
        const e = typeChar("#");
        // Not prevented: a character has to land to be seen at all.
        expect(e.defaultPrevented).toBe(false);
        expect(box().value).toBe("#");
        expect(pressed("body-tags")).toBe("true");
        vi.runAllTimers();
        expect(box().value).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps every character typed during the flash, in order", () => {
      // The hazard the whole flash is built around. `#project` typed at speed
      // must come out as mode Tags with `project` in the box: not `#project`,
      // not `roject`, not `project` with the `p` lost to a timer.
      vi.useFakeTimers();
      try {
        makeHarness({ tags: { knownTags: () => [] } });
        openCurated();
        typeFast("#project");
        expect(pressed("body-tags")).toBe("true");
        expect(box().value).toBe("#project");
        vi.runAllTimers();
        expect(box().value).toBe("project");
        // And the caret stays after what was typed, not back where the sigil
        // used to be.
        expect(box().selectionStart).toBe("project".length);
      } finally {
        vi.useRealTimers();
      }
    });

    it("filters by the query without the sigil while the sigil is still showing", () => {
      // The flash is how the box LOOKS, not what it asks for. A list narrowed
      // by `/Pro` would match nothing in this vault at all.
      vi.useFakeTimers();
      try {
        makeHarness();
        openCurated();
        typeFast("/Pro");
        expect(box().value).toBe("/Pro");
        expect(rows().map((r) => r.dataset.path)).toContain("Projects");
        expect(rows().map((r) => r.dataset.path)).not.toContain("inbox.md");
        vi.runAllTimers();
        expect(box().value).toBe("Pro");
        expect(rows().map((r) => r.dataset.path)).toContain("Projects");
      } finally {
        vi.useRealTimers();
      }
    });

    it("takes nothing back when the sigil is deleted before the flash ends", () => {
      vi.useFakeTimers();
      try {
        makeHarness({ tags: { knownTags: () => [] } });
        openCurated();
        typeChar("#");
        box().value = "";
        box().setSelectionRange(0, 0);
        box().dispatchEvent(new Event("input", { bubbles: true }));
        typeFast("ab");
        vi.runAllTimers();
        // There is no sigil left to take, and taking a character anyway would
        // eat the `a`.
        expect(box().value).toBe("ab");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not let a pending flash outlive the panel", () => {
      vi.useFakeTimers();
      try {
        const h = makeHarness({ tags: { knownTags: () => [] } });
        openCurated();
        typeChar("#");
        // A delta, not an absolute count: jsdom and the panel's own wiring arm
        // timers of their own, and asserting a total would be asserting
        // somebody else's. Exactly one comes off, and it is ours.
        const armed = vi.getTimerCount();
        h.panel.destroy();
        expect(vi.getTimerCount()).toBe(armed - 1);
        // And what is left cannot reach a box that is no longer in a document.
        expect(() => vi.runAllTimers()).not.toThrow();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("the summary row under the window", () => {
    it("sits inside the window, below the list, and does not scroll with it", () => {
      // Inside the window rather than above it, which is where the row of
      // chips that used to report this sat before it was taken out for
      // crowding the pane.
      makeHarness();
      openCurated();
      const window_ = panelEl().querySelector(".spaces-create-tree");
      const row = panelEl().querySelector(".spaces-create-summary");
      const scroll = panelEl().querySelector(".spaces-create-tree-scroll");
      expect(row?.parentElement).toBe(window_);
      expect(scroll?.parentElement).toBe(window_);
      // The list is what scrolls, so the row cannot be inside it.
      expect(scroll?.contains(row ?? null)).toBe(false);
      expect(row?.getAttribute("role")).toBe("status");
    });

    it("says nothing is selected before anything is picked", () => {
      // An empty row would read as a row that failed to draw, and this is the
      // state the window opens in.
      makeHarness();
      openCurated();
      expect(summary()).toBe("Nothing selected");
    });

    it("counts notes and folders as they are picked", () => {
      makeHarness();
      openCurated();
      rowFor("inbox.md").click();
      expect(summary()).toBe("1 note");
      // `Archive` is empty, so the folder adds a selector and no notes. The
      // figure stays at the one note picked by hand.
      rowFor("Archive").click();
      expect(summary()).toBe("1 note, 1 folder");
      rowFor("inbox.md").click();
      expect(summary()).toBe("no notes, 1 folder");
    });

    it("counts tags alongside them, which is how a tag stays visible from the tree", () => {
      // A tag has no row in the tree to mark, so without this the window could
      // report only half of what was picked.
      makeHarness();
      openCurated();
      rowFor("inbox.md").click();
      showTags();
      tagRowFor("project").click();
      tagRowFor("archive").click();
      // `inbox.md` by hand, and `#project` carrying it and `plan.md`. Two
      // notes: the hand-picked one is not counted again for the tag.
      expect(summary()).toBe("2 notes, 2 tags");
      byKey("body-items").click();
      expect(summary()).toBe("2 notes, 2 tags");
    });

    it("counts the union of what is selected, not the parts added up", () => {
      // The assertion the whole figure rests on. `Projects` brings `plan.md`;
      // `#project` brings `plan.md` and `inbox.md`. Two notes, not three: a
      // note inside a selected folder that also carries a selected tag is one
      // note.
      makeHarness();
      openCurated();
      rowFor("Projects").click();
      showTags();
      tagRowFor("project").click();
      expect(summary()).toBe("2 notes, 1 folder, 1 tag");
    });

    it("counts a note picked by hand once when a selected tag carries it too", () => {
      makeHarness();
      openCurated();
      rowFor("inbox.md").click();
      showTags();
      tagRowFor("project").click();
      expect(summary()).toBe("2 notes, 1 tag");
    });

    it("counts the notes under a selected folder, and not its subfolders", () => {
      // `Projects` resolves to three paths: `Projects/Work`, `Projects/Work/plan.md`
      // and itself. Only `plan.md` is a note.
      makeHarness();
      openCurated();
      rowFor("Projects").click();
      expect(summary()).toBe("1 note, 1 folder");
    });

    it("counts the notes a nested tag brings in with its parent", () => {
      // The index already expands `project/console` into `project`, which is
      // exactly what the member will resolve to.
      makeHarness();
      openCurated();
      showTags();
      tagRowFor("project").click();
      expect(summary()).toBe("2 notes, 1 tag");
    });

    it("says so when what is selected comes to no notes", () => {
      makeHarness();
      openCurated();
      showTags();
      tagRowFor("archive").click();
      expect(summary()).toBe("no notes, 1 tag");
    });

    it("asks the index nothing while no tag is selected", () => {
      // Only a tag needs the snapshot, and the row must not reach for it to
      // count a note.
      const h = makeHarness();
      openCurated();
      rowFor("inbox.md").click();
      expect(h.reached).toBe(0);
      expect(summary()).toBe("1 note");
    });

    it("reports a folder space's root, and nothing it is still carrying", () => {
      // `toCreateOptions` submits the root alone, so counting the curated
      // items the form keeps would advertise members the space will not have.
      makeHarness();
      byKey("create").click();
      byKey("mode-curate").click();
      rowFor("inbox.md").click();
      byKey("mode-folder").click();
      expect(summary()).toBe("Nothing selected");
      rowFor("Archive").click();
      expect(summary()).toBe("no notes, 1 folder");
    });
  });
});

/**
 * Selecting a folder selects everything under it, and until now the tree did
 * not say so: the folder got `.is-selected` and its children looked untouched
 * while being just as much in the space. Clicking one of those children stored
 * a second member the folder already covered — the state `memberRows` calls
 * `redundant` — with nothing on screen to say the click had been pointless.
 *
 * Nothing about what gets STORED changes here. These tests pin the marking,
 * the guard and the counts that must not move with them.
 */
describe("rows a selected folder already covers", () => {
  const covered = (path: string): boolean => rowFor(path).classList.contains("is-inherited");
  /** The caret, not the row: expanding is browsing, and a covered row still opens. */
  const expand = (path: string): void => {
    const caret = rowFor(path).querySelector<HTMLElement>(".spaces-create-tree-caret");
    if (!caret) throw new Error(`no caret on ${path}`);
    caret.click();
  };
  const summaryText = (): string =>
    panelEl().querySelector(".spaces-create-summary")?.textContent ?? "";

  it("marks a direct child and a descendant three levels down alike", () => {
    makeHarness();
    byKey("mode-curate").click();
    rowFor("Projects").click();
    expand("Projects");
    expect(covered("Projects/Work")).toBe(true);
    // The covered folder still opens, which is the whole reason the marking
    // has to reach past the first level.
    expand("Projects/Work");
    expect(covered("Projects/Work/plan.md")).toBe(true);
  });

  it("leaves everything outside the selected folder alone", () => {
    makeHarness();
    byKey("mode-curate").click();
    rowFor("Projects").click();
    expect(covered("Archive")).toBe(false);
    expect(covered("inbox.md")).toBe(false);
    // Nor the folder itself: it is picked, not covered.
    expect(covered("Projects")).toBe(false);
    expect(rowFor("Projects").classList.contains("is-selected")).toBe(true);
  });

  it("says so to assistive tech, and names the folder responsible", () => {
    // Colour alone does not distinguish a covered row from an ordinary one,
    // and `aria-selected="false"` says the opposite of what is true.
    makeHarness();
    byKey("mode-curate").click();
    rowFor("Projects").click();
    expand("Projects");
    const row = rowFor("Projects/Work");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("title")).toContain("Projects");
    expect(rowFor("Archive").hasAttribute("aria-disabled")).toBe(false);
    expect(rowFor("Archive").hasAttribute("title")).toBe(false);
  });

  it("does nothing at all when a covered row is clicked", async () => {
    const h = makeHarness();
    typeName("Covered");
    byKey("mode-curate").click();
    rowFor("Projects").click();
    expand("Projects");
    expand("Projects/Work");
    const before = summaryText();

    rowFor("Projects/Work/plan.md").click();
    rowFor("Projects/Work").click();

    // The row is still only covered, the count has not moved, and the member
    // list is the one folder it was.
    expect(covered("Projects/Work/plan.md")).toBe(true);
    expect(rowFor("Projects/Work/plan.md").getAttribute("aria-selected")).toBe("false");
    expect(summaryText()).toBe(before);

    byKey("create").click();
    await vi.waitFor(() => expect(h.submitted).toHaveLength(1));
    expect(h.submitted[0].opts.members).toEqual([{ path: "Projects", kind: "folder" }]);
  });

  it("keeps the keyboard from storing one either", () => {
    makeHarness();
    byKey("mode-curate").click();
    rowFor("Projects").click();
    expand("Projects");
    const row = rowFor("Projects/Work");
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(rowFor("Projects/Work").getAttribute("aria-selected")).toBe("false");
    expect(summaryText()).toBe("1 note, 1 folder");
  });

  it("reads as covered, not picked, when the note was picked before its folder", async () => {
    // This case used to assert that both stayed stored and the note read as
    // picked, which was the click-order defect. toggleItem now absorbs the
    // note into a folder picked after it, so the stored space is the same as
    // if the folder had been clicked first.
    const h = makeHarness();
    typeName("Both");
    byKey("mode-curate").click();
    expand("Projects");
    expand("Projects/Work");
    rowFor("Projects/Work/plan.md").click();
    rowFor("Projects").click();

    const row = rowFor("Projects/Work/plan.md");
    expect(row.classList.contains("is-selected")).toBe(false);
    expect(covered("Projects/Work/plan.md")).toBe(true);
    expect(row.getAttribute("aria-disabled")).toBe("true");

    byKey("create").click();
    await vi.waitFor(() => expect(h.submitted).toHaveLength(1));
    expect(h.submitted[0].opts.members).toEqual([{ path: "Projects", kind: "folder" }]);
  });

  it("marks nothing in folder mode, which holds one root and no members", () => {
    makeHarness();
    byKey("mode-folder").click();
    rowFor("Projects").click();
    expand("Projects");
    expect(covered("Projects/Work")).toBe(false);
    // Still pickable: choosing a nested folder REPLACES the root.
    rowFor("Projects/Work").click();
    expect(rowFor("Projects/Work").getAttribute("aria-selected")).toBe("true");
  });

  it("leaves the summary row's counts where they were", () => {
    // A covered row is not a picked member, and the resolved total already
    // counted it through the folder. Marking it must not move either figure.
    makeHarness();
    byKey("mode-curate").click();
    rowFor("Projects").click();
    expect(summaryText()).toBe("1 note, 1 folder");
    expand("Projects");
    expand("Projects/Work");
    expect(summaryText()).toBe("1 note, 1 folder");
  });
});

/**
 * A note only a selected tag covers is an ordinary row. A folder's coverage is
 * a fact about the tree on screen; a tag's is a rule matching notes scattered
 * anywhere, and tinting them marked a scattered majority of a broad tag's
 * folders and left no way to tell why a row was marked. Tags mode and the
 * summary row report it instead.
 */
describe("rows a selected tag covers", () => {
  const summaryText = (): string =>
    panelEl().querySelector(".spaces-create-summary")?.textContent ?? "";
  const pickTag = (tag: string): void => {
    byKey("body-tags").click();
    const row = Array.from(
      panelEl().querySelectorAll<HTMLElement>("[role='treeitem'][data-tag]")
    ).find((r) => r.dataset.tag === tag);
    if (!row) throw new Error(`no tag row for ${tag}`);
    row.click();
    byKey("body-items").click();
  };

  it("are clickable, and clicking one adds the note as its own member", async () => {
    // Clicking is redundant with the tag and harmless. What would be wrong is
    // a row that looks interactive and silently does nothing, which is what a
    // partial revert of the click guard would leave.
    const h = makeHarness();
    typeName("Tag and note");
    byKey("mode-curate").click();
    pickTag("project");
    const before = summaryText();

    rowFor("inbox.md").click();

    expect(rowFor("inbox.md").getAttribute("aria-selected")).toBe("true");
    expect(rowFor("inbox.md").classList.contains("is-selected")).toBe(true);
    expect(summaryText()).toBe(before);

    byKey("create").click();
    await vi.waitFor(() => expect(h.submitted).toHaveLength(1));
    expect(h.submitted[0].opts.members).toEqual([
      { kind: "tag", tag: "project" },
      { kind: "file", path: "inbox.md" },
    ]);
  });

  it("look like any other row, and drawing the tree never resolves a tag", () => {
    // The structure scales with the vault only if a draw does per-tag work.
    // It must not: the folder set is the only thing built per draw.
    const h = makeHarness();
    byKey("mode-curate").click();
    pickTag("project");
    h.counted.length = 0;
    const caret = rowFor("Projects").querySelector<HTMLElement>(".spaces-create-tree-caret");
    if (!caret) throw new Error("no caret on Projects");
    caret.click();
    expect(h.counted).toEqual([]);
    const row = rowFor("inbox.md");
    expect(row.classList.contains("is-inherited")).toBe(false);
    expect(row.hasAttribute("aria-disabled")).toBe(false);
    expect(row.hasAttribute("title")).toBe(false);
  });

  it("do not move the summary row, which counts them through the tag", () => {
    makeHarness();
    byKey("mode-curate").click();
    pickTag("project");
    expect(summaryText()).toBe("2 notes, 1 tag");
  });
});
