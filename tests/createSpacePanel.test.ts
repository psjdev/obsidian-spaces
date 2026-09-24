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

interface Harness {
  panel: CreateSpacePanel;
  parent: HTMLElement;
  submitted: Array<{ name: string; opts: CreateSpaceOptions }>;
  closes: number;
  saved: string[][];
}

function makeHarness(over: Partial<CreateSpacePanelDeps> = {}): Harness {
  const submitted: Harness["submitted"] = [];
  const saved: string[][] = [];
  let closes = 0;

  const deps: CreateSpacePanelDeps = {
    folders: {
      allPaths: () => Object.keys(VAULT),
      kindOf: (path) => VAULT[path] ?? null,
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
    get closes() {
      return closes;
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
const rows = (): HTMLElement[] =>
  Array.from(panelEl().querySelectorAll<HTMLElement>("[role='treeitem']"));
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

  it("renders at most 200 rows", () => {
    makeHarness(bigDeps);
    byKey("mode-curate").click();
    (byKey("item-filter") as HTMLInputElement).value = "note";
    byKey("item-filter").dispatchEvent(new Event("input", { bubbles: true }));
    expect(rows().length).toBe(200);
  });

  it("says how many it did not render", () => {
    makeHarness(bigDeps);
    byKey("mode-curate").click();
    (byKey("item-filter") as HTMLInputElement).value = "note";
    byKey("item-filter").dispatchEvent(new Event("input", { bubbles: true }));
    const more = panelEl().querySelector(".spaces-create-tree-more");
    // 500 files + the folder that holds them, less the 200 shown.
    expect(more?.textContent).toContain("301");
    expect(more?.textContent).toMatch(/keep typing/i);
  });

  it("keeps the overflow row out of the tree's own children", () => {
    // A `role="tree"` may only own `treeitem`s; a stray child makes assistive
    // tech miscount the list.
    makeHarness(bigDeps);
    byKey("mode-curate").click();
    (byKey("item-filter") as HTMLInputElement).value = "note";
    byKey("item-filter").dispatchEvent(new Event("input", { bubbles: true }));
    const more = panelEl().querySelector(".spaces-create-tree-more");
    const treeNode = panelEl().querySelector("[role='tree']");
    expect(more).not.toBeNull();
    expect(more?.parentElement).not.toBe(treeNode);
  });

  it("says nothing when everything fits", () => {
    makeHarness();
    byKey("mode-curate").click();
    expect(panelEl().querySelector(".spaces-create-tree-more")).toBeNull();
  });

  it("drops the notice again once the filter narrows", () => {
    makeHarness(bigDeps);
    byKey("mode-curate").click();
    const f = byKey("item-filter") as HTMLInputElement;
    f.value = "note"; f.dispatchEvent(new Event("input", { bubbles: true }));
    expect(panelEl().querySelector(".spaces-create-tree-more")).not.toBeNull();
    f.value = "note-499"; f.dispatchEvent(new Event("input", { bubbles: true }));
    expect(panelEl().querySelector(".spaces-create-tree-more")).toBeNull();
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
