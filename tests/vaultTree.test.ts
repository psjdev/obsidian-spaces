import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  buildVaultTree,
  isBranchByChildren,
  isBranchByKind,
  visibleRows,
} from "../src/ui/vaultTree";

/**
 * Layer 1: what the folder picker shows, with the drawing left to the panel.
 *
 * Shapes are the fixture vault's (Obsidian 1.13.7): a handful of top-level
 * folders, `Projects/Console 2030/Hardware` three deep.
 */
const folder = (path: string) => ({ path, kind: "folder" as const });
const file = (path: string) => ({ path, kind: "file" as const });

const VAULT = [
  folder("Archive"),
  file("Archive/Bravo.md"),
  folder("Bulk"),
  folder("Projects"),
  folder("Projects/Console 2030"),
  folder("Projects/Console 2030/Hardware"),
  folder("Projects/Hardware"),
  file("Projects/Roadmap.md"),
  folder("Reference"),
  file("Top.md"),
];

const none = {
  expanded: new Set<string>(),
  filter: "",
  selected: new Set<string>(),
};
const paths = (rows: readonly { path: string }[]): string[] => rows.map((r) => r.path);

describe("buildVaultTree", () => {
  it("sorts an EMPTY folder before files, because branch-ness is kind here", () => {
    const entries = [file("a.md"), folder("zz-empty"), file("b.md"), folder("mm-empty")];
    for (const t of [buildVaultTree(entries), buildVaultTree(entries, "folder", isBranchByKind)]) {
      expect(t.map((n) => n.name)).toEqual(["mm-empty", "zz-empty", "a.md", "b.md"]);
    }
    // The same input under the tag rule moves the empty folders: the two
    // rules differ, which is why the sort is a parameter.
    const byChildren = buildVaultTree(entries, "folder", isBranchByChildren);
    expect(byChildren.map((n) => n.name)).toEqual(["a.md", "b.md", "mm-empty", "zz-empty"]);
  });

  it("nests by path segment", () => {
    const tree = buildVaultTree(VAULT);
    expect(tree.map((n) => n.path)).toEqual(["Archive", "Bulk", "Projects", "Reference", "Top.md"]);
    const projects = tree.find((n) => n.path === "Projects")!;
    // Folders first, then files — the explorer's own order.
    expect(projects.children.map((n) => n.name)).toEqual([
      "Console 2030",
      "Hardware",
      "Roadmap.md",
    ]);
  });

  it("sorts each level on its own", () => {
    const tree = buildVaultTree([folder("Zebra"), folder("Apple"), folder("Zebra/b"), folder("Zebra/a")]);
    expect(tree.map((n) => n.name)).toEqual(["Apple", "Zebra"]);
    expect(tree[1].children.map((n) => n.name)).toEqual(["a", "b"]);
  });

  it("invents a missing intermediate rather than dropping its children", () => {
    // Obsidian always has the parent, but a picker that silently loses folders
    // because of one absent path is worse than one that shows a bridge node.
    const tree = buildVaultTree([folder("a/b/c")]);
    expect(tree.map((n) => n.path)).toEqual(["a"]);
    expect(tree[0].children[0].path).toBe("a/b");
    expect(tree[0].children[0].children[0].path).toBe("a/b/c");
  });

  it("survives an empty vault", () => {
    expect(buildVaultTree([])).toEqual([]);
  });

  it("ignores duplicates", () => {
    expect(buildVaultTree([folder("a"), folder("a")]).length).toBe(1);
  });
});

describe("visibleRows", () => {
  const tree = buildVaultTree(VAULT);

  it("starts collapsed — top level only", () => {
    expect(paths(visibleRows(tree, none))).toEqual(["Archive", "Bulk", "Projects", "Reference", "Top.md"]);
  });

  it("shows a node's children once it is expanded, but not its grandchildren", () => {
    const rows = visibleRows(tree, { ...none, expanded: new Set(["Projects"]) });
    expect(paths(rows)).toEqual([
      "Archive",
      "Bulk",
      "Projects",
      "Projects/Console 2030",
      "Projects/Hardware",
      "Projects/Roadmap.md",
      "Reference",
      "Top.md",
    ]);
  });

  it("carries the depth the panel needs to indent by", () => {
    const rows = visibleRows(tree, { ...none, expanded: new Set(["Projects"]) });
    expect(rows.find((r) => r.path === "Projects")!.depth).toBe(0);
    expect(rows.find((r) => r.path === "Projects/Hardware")!.depth).toBe(1);
  });

  it("marks which rows have children, so only those draw a caret", () => {
    const rows = visibleRows(tree, none);
    expect(rows.find((r) => r.path === "Projects")!.hasChildren).toBe(true);
    // A folder holding only files still has children — in curated mode those
    // files are pickable, so the caret has to be there to reach them.
    expect(rows.find((r) => r.path === "Archive")!.hasChildren).toBe(true);
    expect(rows.find((r) => r.path === "Top.md")!.hasChildren).toBe(false);
  });

  it("marks every selected row — curated mode picks many", () => {
    const rows = visibleRows(tree, {
      ...none,
      expanded: new Set(["Projects"]),
      selected: new Set(["Projects/Hardware", "Projects/Roadmap.md"]),
    });
    expect(rows.filter((r) => r.selected).map((r) => r.path)).toEqual([
      "Projects/Hardware",
      "Projects/Roadmap.md",
    ]);
  });

  describe("filtering", () => {
    it("reveals a deep match with its ancestors, opened to it", () => {
      const rows = visibleRows(tree, { ...none, filter: "hardware" });
      expect(paths(rows)).toEqual([
        "Projects",
        "Projects/Console 2030",
        "Projects/Console 2030/Hardware",
        "Projects/Hardware",
      ]);
    });

    it("expands ancestors of a match whatever the user had collapsed", () => {
      // The point of typing is to be shown the thing; honouring a stale
      // collapsed state would hide the only row that matched.
      const rows = visibleRows(tree, { ...none, filter: "console" });
      const projects = rows.find((r) => r.path === "Projects")!;
      expect(projects.expanded).toBe(true);
    });

    it("is case-insensitive and matches on the name", () => {
      expect(paths(visibleRows(tree, { ...none, filter: "ARCHIVE" }))).toEqual([
        "Archive",
        "Archive/Bravo.md",
      ]);
    });

    it("matches on an ancestor's name too, keeping its subtree available", () => {
      // Typing a parent's name is a way to browse INTO it, so its children
      // stay reachable rather than being filtered out from under it.
      const rows = visibleRows(tree, { ...none, filter: "projects" });
      expect(paths(rows)).toContain("Projects");
      expect(paths(rows)).toContain("Projects/Console 2030");
    });

    it("shows nothing when nothing matches", () => {
      expect(visibleRows(tree, { ...none, filter: "zzz" })).toEqual([]);
    });

    it("ignores surrounding whitespace", () => {
      expect(paths(visibleRows(tree, { ...none, filter: "  archive  " }))).toEqual([
        "Archive",
        "Archive/Bravo.md",
      ]);
    });
  });
});

describe("ancestorsOf", () => {
  // Used to open a pre-filled selection into view: the right-click entry lands
  // with a root already chosen, and a collapsed tree would hide it.
  it("lists every ancestor, nearest last", () => {
    expect(ancestorsOf("Projects/Console 2030/Hardware")).toEqual([
      "Projects",
      "Projects/Console 2030",
    ]);
  });

  it("excludes the node itself — it is opened INTO, not opened", () => {
    expect(ancestorsOf("Projects")).toEqual([]);
  });

  it("has nothing to say about an empty path", () => {
    expect(ancestorsOf("")).toEqual([]);
  });
});

describe("onlyKind (the folder-space mode)", () => {
  const tree = buildVaultTree(VAULT);

  it("hides files, so only a folder can become a root", () => {
    const rows = visibleRows(tree, { ...none, onlyKind: "folder" as const });
    expect(paths(rows)).toEqual(["Archive", "Bulk", "Projects", "Reference"]);
  });

  it("hides files nested inside an expanded folder too", () => {
    const rows = visibleRows(tree, {
      ...none,
      onlyKind: "folder" as const,
      expanded: new Set(["Projects"]),
    });
    expect(paths(rows)).toEqual([
      "Archive",
      "Bulk",
      "Projects",
      "Projects/Console 2030",
      "Projects/Hardware",
      "Reference",
    ]);
  });

  it("drops a folder that only survived because a FILE beneath it matched", () => {
    // "bravo" is a file. With files hidden there is nothing left to show, so
    // `Archive` must not linger as an empty branch.
    const rows = visibleRows(tree, { ...none, onlyKind: "folder" as const, filter: "bravo" });
    expect(rows).toEqual([]);
  });

  it("still matches folders while filtering", () => {
    const rows = visibleRows(tree, { ...none, onlyKind: "folder" as const, filter: "hardware" });
    expect(paths(rows)).toEqual([
      "Projects",
      "Projects/Console 2030",
      "Projects/Console 2030/Hardware",
      "Projects/Hardware",
    ]);
  });

  it("carries the kind, so the panel can draw a file differently", () => {
    const rows = visibleRows(tree, none);
    expect(rows.find((r) => r.path === "Top.md")!.kind).toBe("file");
    expect(rows.find((r) => r.path === "Archive")!.kind).toBe("folder");
  });

  it("never lets a file claim children", () => {
    const rows = visibleRows(tree, none);
    expect(rows.find((r) => r.path === "Top.md")!.hasChildren).toBe(false);
  });
});

/**
 * The same two functions over the tag picker's vocabulary.
 *
 * Generalised rather than forked: `NodeKind` is still the file picker's and
 * still the default, and a second caller brings its own kind instead of being
 * made to call a leaf tag a file. These assert the parts of that generalisation
 * a vault tree cannot reach — a one-kind tree, and an invented intermediate
 * that must not come back as a folder.
 */
describe("a tree of another kind (the tag picker's)", () => {
  const tag = (path: string) => ({ path, kind: "tag" as const });
  // Nothing is tagged `area` or `area/health`; both exist only as prefixes.
  const TAGS = [tag("project"), tag("area/health/active"), tag("area/health/paused")];
  const tree = buildVaultTree(TAGS, "tag");

  it("invents the intermediates a tag list leaves out, as tags", () => {
    expect(tree.map((n) => n.path)).toEqual(["area", "project"]);
    const area = tree[0];
    expect(area.kind).toBe("tag");
    expect(area.children.map((n) => n.path)).toEqual(["area/health"]);
    expect(area.children[0].kind).toBe("tag");
    expect(area.children[0].children.map((n) => n.path)).toEqual([
      "area/health/active",
      "area/health/paused",
    ]);
  });

  it("names a node by its last segment, which is what a row shows", () => {
    expect(tree[0].children[0].name).toBe("health");
  });

  it("sorts a parent tag before a childless one, alphabetically within each group", () => {
    const t = buildVaultTree(
      [
        tag("zeta"),
        tag("alpha"),
        tag("mid/b"),
        tag("mid/a"),
        tag("mid/deep/x"),
        tag("mid/zed"),
        tag("mid/alone"),
        tag("top/q"),
      ],
      "tag",
      isBranchByChildren
    );
    // Root: mid and top have children; alpha and zeta do not.
    expect(t.map((n) => n.name)).toEqual(["mid", "top", "alpha", "zeta"]);
    // Nested: deep has a child, so it leads a, alone, b, zed.
    expect(t[0].children.map((n) => n.name)).toEqual(["deep", "a", "alone", "b", "zed"]);
  });

  it("draws every row when no kind is singled out", () => {
    const rows = visibleRows(tree, { ...none, expanded: new Set(["area"]) });
    expect(rows.map((r) => r.path)).toEqual(["area", "area/health", "project"]);
  });

  it("brings a deep match's ancestors with it, matching on the last segment", () => {
    const rows = visibleRows(tree, { ...none, filter: "paused" });
    expect(rows.map((r) => r.path)).toEqual(["area", "area/health", "area/health/paused"]);
  });
});
