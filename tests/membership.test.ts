import { describe, expect, it } from "vitest";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import {
  decorate,
  type DecorateContext,
  type FileLike,
  type MenuItemLike,
  type MenuLike,
  type VisibilityDecisionLike,
} from "../src/actions/membershipMenu";
import type { SpaceDefinition } from "../src/types";

/** No note in this fake vault carries a tag; these cases are all about paths. */
const noTags = createMapTagIndex(new Map());

/**
 * Obsidian's own Shift+click range selection walks its
 * internal item list without consulting computed visibility -- the same way
 * arrow-key navigation does -- so a selection that looks like two adjacent
 * visible rows can silently include `display:none` rows in between. Unlike
 * the arrow-key case, nothing else reveals the smuggled-in paths, so
 * `decorate` must filter `files` through the snapshot's visibility before
 * doing anything else with it: computing decisions, deciding the label, or
 * handing the array to add/remove.
 */

function space(): SpaceDefinition {
  return {
    id: "s1",
    name: "Q6 Test",
    icon: "box",
    color: "#000000",
    members: [],
  };
}

function fakeMenu(): { menu: MenuLike; items: Recorder[] } {
  const items: Recorder[] = [];
  const menu: MenuLike = {
    addItem(cb: (item: MenuItemLike) => MenuItemLike) {
      const recorder = new Recorder();
      cb(recorder);
      items.push(recorder);
    },
  };
  return { menu, items };
}

class Recorder implements MenuItemLike {
  title = "";
  icon: string | null = null;
  disabled = false;
  clickHandler: (() => void) | null = null;

  setTitle(title: string): MenuItemLike {
    this.title = title;
    return this;
  }
  setIcon(icon: string): MenuItemLike {
    this.icon = icon;
    return this;
  }
  setDisabled(disabled: boolean): MenuItemLike {
    this.disabled = disabled;
    return this;
  }
  onClick(cb: () => void): MenuItemLike {
    this.clickHandler = cb;
    return this;
  }
}

type Vis =
  | boolean
  | { visible: boolean; reason: string; canRemoveMembership?: boolean };

function ctxWith(
  visibility: Record<string, Vis>,
  s: SpaceDefinition = space()
): DecorateContext {
  // The boolean shorthand still means "visible, not a member, hence
  // addable" -- which in a real snapshot is a visitor. The object form
  // exists so a test can say scaffold or member instead.
  const decisionFor = (path: string): VisibilityDecisionLike => {
    const v = visibility[path] ?? false;
    if (typeof v === "boolean") {
      return { visible: v, reason: "visitor", canRemoveMembership: false };
    }
    return {
      visible: v.visible,
      reason: v.reason,
      // A fixture must not be able to construct a decision the real
      // engine cannot produce. In VisibilityEngine, canRemoveMembership is
      // exact.has(path) -- the same set that drives reason === "exact-member"
      // -- so the two fields move together there. Defaulting to false here
      // (rather than deriving it) would let a test write
      // { reason: "exact-member" } with no flag and silently exercise the
      // "Add" branch instead of "Remove". An explicit override still wins,
      // since a real decision can be both exact and inherited
      // (inheritedFromFolder exists for exactly that case).
      canRemoveMembership: v.canRemoveMembership ?? v.reason === "exact-member",
    };
  };
  return {
    controller: {
      activeSpace: () => s,
      currentSnapshot: () => ({ decisionFor }),
    },
    // Only *All* reads these two; the active-space branches ignore them.
    spaces: () => (s ? [s] : []),
    tags: () => noTags,
  };
}

function fileAt(path: string): FileLike {
  return { path };
}

describe("decorate (files-menu range selections smuggle hidden rows)", () => {
  it("counts only the visible files in the Add label, not the raw selection", () => {
    const paths = ["a.md", "b.md", "c.md", "d.md", "e.md"];
    // Obsidian's own range selection included all 5 (three hidden between
    // two visible clicked rows); only a and e are actually visible.
    const ctx = ctxWith({ "a.md": true, "b.md": false, "c.md": false, "d.md": false, "e.md": true });
    const { menu, items } = fakeMenu();
    const handlers = { addAll: () => {}, removeAll: () => {}, dismissAll: () => {},
      addToSpace: () => {} };

    decorate(menu, ctx, paths.map(fileAt), handlers);

    // 2: the "Add 2" entry plus "Stop showing here" for the two visitors
    // (ctxWith's boolean shorthand marks every visible path a visitor).
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Add 2 to Q6 Test");
    expect(items[0].title).not.toContain("5");
  });

  it("hands the filtered array, not the raw selection, to addAll", () => {
    const paths = ["a.md", "b.md", "c.md"];
    const ctx = ctxWith({ "a.md": true, "b.md": false, "c.md": true });
    const { menu, items } = fakeMenu();
    let addedPaths: string[] | null = null;
    const handlers = {
      addAll: (files: FileLike[]) => {
        addedPaths = files.map((f) => f.path);
      },
      removeAll: () => {},
      dismissAll: () => {},
      addToSpace: () => {},
    };

    decorate(menu, ctx, paths.map(fileAt), handlers);
    items[0].clickHandler?.();

    expect(addedPaths).toEqual(["a.md", "c.md"]);
  });

  it("adds no menu entries when the entire selection is invisible to the space", () => {
    const paths = ["a.md", "b.md", "c.md"];
    const ctx = ctxWith({ "a.md": false, "b.md": false, "c.md": false });
    const { menu, items } = fakeMenu();
    const handlers = { addAll: () => {}, removeAll: () => {}, dismissAll: () => {},
      addToSpace: () => {} };

    decorate(menu, ctx, paths.map(fileAt), handlers);

    expect(items).toHaveLength(0);
  });

  it("still shows the single-file phrasing when exactly one file survives the filter", () => {
    const paths = ["a.md", "b.md"];
    const ctx = ctxWith({ "a.md": true, "b.md": false });
    const { menu, items } = fakeMenu();
    const handlers = { addAll: () => {}, removeAll: () => {}, dismissAll: () => {},
      addToSpace: () => {} };

    decorate(menu, ctx, paths.map(fileAt), handlers);

    // 2: "Add to Q6 Test" plus "Stop showing here" for the sole visitor.
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Add to Q6 Test");
  });
});

describe("decorate (Stop showing here on visitor rows)", () => {
  const noopHandlers = {
    addAll: () => undefined,
    removeAll: () => undefined,
    dismissAll: () => undefined,
      addToSpace: () => {},
  };

  it("offers Stop showing here on a visitor row, after the Add entry", () => {
    const { menu, items } = fakeMenu();
    decorate(menu, ctxWith({ "a.md": true }), [fileAt("a.md")], noopHandlers);
    expect(items.map((i) => i.title)).toEqual([
      "Add to Q6 Test",
      "Stop showing here",
    ]);
  });

  it("does not offer Stop showing here on a scaffold row", () => {
    const { menu, items } = fakeMenu();
    decorate(
      menu,
      ctxWith({ Reference: { visible: true, reason: "scaffold" } }),
      [fileAt("Reference")],
      noopHandlers
    );
    expect(items.map((i) => i.title)).toEqual(["Add to Q6 Test"]);
  });

  it("does not offer Stop showing here on an exact member row", () => {
    const { menu, items } = fakeMenu();
    decorate(
      menu,
      ctxWith({
        Papers: { visible: true, reason: "exact-member", canRemoveMembership: true },
      }),
      [fileAt("Papers")],
      noopHandlers
    );
    expect(items.map((i) => i.title)).toEqual(["Remove from Q6 Test"]);
  });

  it("derives canRemoveMembership from reason: exact-member when the flag is omitted", () => {
    // No explicit canRemoveMembership here. If ctxWith defaulted the flag to
    // false instead of deriving it from the reason, `allExact` would be
    // false and this would wrongly fall through to "Add to Q6 Test".
    const { menu, items } = fakeMenu();
    decorate(
      menu,
      ctxWith({ Papers: { visible: true, reason: "exact-member" } }),
      [fileAt("Papers")],
      noopHandlers
    );
    expect(items.map((i) => i.title)).toEqual(["Remove from Q6 Test"]);
  });

  it("dismisses only the visitor rows in a mixed selection", () => {
    const { menu, items } = fakeMenu();
    const dismissed: string[][] = [];
    decorate(
      menu,
      ctxWith({
        "a.md": { visible: true, reason: "visitor" },
        Papers: { visible: true, reason: "inherited-member" },
      }),
      [fileAt("a.md"), fileAt("Papers")],
      { ...noopHandlers, dismissAll: (f) => dismissed.push(f.map((x) => x.path)) }
    );
    const entry = items.find((i) => i.title === "Stop showing here");
    expect(entry).toBeDefined();
    entry!.clickHandler!();
    expect(dismissed).toEqual([["a.md"]]);
  });

  it("never dismisses a hidden row smuggled in by a range selection", () => {
    const { menu, items } = fakeMenu();
    const dismissed: string[][] = [];
    decorate(
      menu,
      ctxWith({ "a.md": true, "hidden.md": false }),
      [fileAt("a.md"), fileAt("hidden.md")],
      { ...noopHandlers, dismissAll: (f) => dismissed.push(f.map((x) => x.path)) }
    );
    items.find((i) => i.title === "Stop showing here")!.clickHandler!();
    expect(dismissed).toEqual([["a.md"]]);
  });
});

/**
 * All's "Add to space". `decorate` must NOT return early when there is no
 * active space: All is exactly where the user has to name the space to add to.
 *
 * `Recorder` has no nesting method, so these exercise the FLAT fallback —
 * which is the path a build without the private API takes, and therefore the
 * one that must carry the same information. `NestingRecorder` covers the
 * other branch.
 */
function allCtx(spaces: SpaceDefinition[]) {
  return {
    controller: {
      activeSpace: () => null,
      currentSnapshot: () => ({ decisionFor: () => ({ visible: true, reason: "exact-member", canRemoveMembership: true }) }),
    },
    spaces: () => spaces,
    tags: () => noTags,
  };
}

const noopHandlers = {
  addAll: () => {},
  removeAll: () => {},
  dismissAll: () => {},
  addToSpace: () => {},
};

function spaceNamed(id: string, name: string, members: SpaceDefinition["members"] = []): SpaceDefinition {
  return { id, name, icon: "box", color: "#000000", members };
}

describe("decorate in All", () => {
  it("offers an entry per space when nesting is unavailable", () => {
    const { menu, items } = fakeMenu();
    decorate(menu, allCtx([spaceNamed("w", "Work"), spaceNamed("l", "Lab")]), [fileAt("x.md")], noopHandlers);
    expect(items.map((i) => i.title)).toEqual(["Add to space", "Add to Work", "Add to Lab"]);
  });

  it("adds NOTHING when there are no spaces", () => {
    // An entry opening onto an empty list is worse than no entry.
    const { menu, items } = fakeMenu();
    decorate(menu, allCtx([]), [fileAt("x.md")], noopHandlers);
    expect(items).toHaveLength(0);
  });

  it("adds NOTHING when every space is a folder space", () => {
    // `spaces.length > 0` is not enough to guarantee a target:
    // `spaceAddTargets` drops every folder space (adding a path from
    // elsewhere would mean moving the file), so a vault whose spaces are all
    // folder spaces reaches this guard with a non-empty `spaces` array and a
    // now-empty `targets` array. Without the guard the parent "Add to space"
    // entry still renders, opening onto nothing.
    const { menu, items } = fakeMenu();
    const folderSpace = { ...spaceNamed("w", "Work"), root: "Projects/Work" };
    decorate(menu, allCtx([folderSpace]), [fileAt("x.md")], noopHandlers);
    expect(items).toHaveLength(0);
  });

  it("adds nothing for an empty selection", () => {
    const { menu, items } = fakeMenu();
    decorate(menu, allCtx([spaceNamed("w", "Work")]), [], noopHandlers);
    expect(items).toHaveLength(0);
  });

  it("renders a space that already holds the path as disabled, saying why", () => {
    // Omitting it would read as a bug; this explains the model instead.
    const { menu, items } = fakeMenu();
    const work = spaceNamed("w", "Work", [{ path: "Projects", kind: "folder" }]);
    decorate(menu, allCtx([work]), [fileAt("Projects/Note.md")], noopHandlers);
    const entry = items[1];
    expect(entry.title).toBe("Add to Work (already in Projects)");
    expect(entry.disabled).toBe(true);
    expect(entry.clickHandler).toBeNull();
  });

  it("hands the handler only the paths that space does not already hold", () => {
    // Clicking must do exactly what the label says.
    const calls: Array<{ id: string; paths: string[] }> = [];
    const { menu, items } = fakeMenu();
    const work = spaceNamed("w", "Work", [{ path: "Projects", kind: "folder" }]);
    decorate(
      menu,
      allCtx([work]),
      [fileAt("Projects/In.md"), fileAt("Loose.md")],
      { ...noopHandlers, addToSpace: (id, fs) => calls.push({ id, paths: fs.map((f) => f.path) }) }
    );
    items[1].clickHandler?.();
    expect(calls).toEqual([{ id: "w", paths: ["Loose.md"] }]);
  });

  it("puts the spaces in a submenu when nesting IS available", () => {
    const children: Recorder[] = [];
    const parents: Recorder[] = [];
    const menu: MenuLike = {
      addItem(cb: (item: MenuItemLike) => MenuItemLike) {
        const r = new NestingRecorder(children);
        cb(r);
        parents.push(r);
      },
    };
    decorate(menu, allCtx([spaceNamed("w", "Work"), spaceNamed("l", "Lab")]), [fileAt("x.md")], noopHandlers);
    // One top-level entry, and the spaces nested under it rather than beside.
    expect(parents.map((p) => p.title)).toEqual(["Add to space"]);
    expect(children.map((c) => c.title)).toEqual(["Work", "Lab"]);
  });
});

/**
 * A Recorder that also exposes the private nesting method, so the nested
 * branch of `addToSpaceEntries` is covered without needing the real Obsidian
 * runtime. It asserts nothing about how Obsidian RENDERS a submenu — that is
 * Layer 4 and needs a human right-click.
 */
class NestingRecorder extends Recorder {
  constructor(private readonly sink: Recorder[]) {
    super();
  }
  setSubmenu(): { addItem(cb: (item: MenuItemLike) => MenuItemLike): void } {
    const sink = this.sink;
    return {
      addItem(cb) {
        const child = new Recorder();
        cb(child);
        sink.push(child);
      },
    };
  }
}
