/**
 * The compaction rule, as a question about a tree rather than about the DOM.
 *
 * A run is folders that only lead onward. The tip is where that stops being
 * true, and the tip is what the caller substitutes, because a compacted row IS
 * the deepest folder wearing a longer label.
 */
import { describe, expect, it } from "vitest";
import { buildChainIndex, runFrom, type ChainTree } from "../src/visibility/compactChains";

/** A tree written as a path-to-children map. Any path not listed is a note. */
function treeOf(
  children: Record<string, string[]>,
  opts: { members?: string[] } = {}
): ChainTree {
  const members = new Set(opts.members ?? []);
  const isFolder = (p: string): boolean => Object.prototype.hasOwnProperty.call(children, p);
  return {
    visibleChildrenOf: (p) => children[p] ?? [],
    isFolder,
    // Every folder is scaffold unless the test says it is a member.
    isScaffold: (p) => isFolder(p) && !members.has(p),
    parentOf: (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : null),
    nameOf: (p) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p),
  };
}

describe("runFrom", () => {
  it("collapses a chain of three folders to its deepest", () => {
    const t = treeOf({
      Work: ["Work/Clients"],
      "Work/Clients": ["Work/Clients/Northwind"],
      "Work/Clients/Northwind": ["Work/Clients/Northwind/notes.md"],
    });
    expect(runFrom("Work", t)).toEqual({
      tip: "Work/Clients/Northwind",
      segments: ["Work", "Clients", "Northwind"],
    });
  });

  it("stops where a chain branches, because the branch is the information", () => {
    const t = treeOf({
      Work: ["Work/Clients"],
      "Work/Clients": ["Work/Clients/Northwind", "Work/Clients/Contoso"],
      "Work/Clients/Northwind": ["Work/Clients/Northwind/a.md"],
      "Work/Clients/Contoso": ["Work/Clients/Contoso/b.md"],
    });
    expect(runFrom("Work", t)).toEqual({ tip: "Work/Clients", segments: ["Work", "Clients"] });
  });

  it("stops before a folder the user added as a member", () => {
    // The user picked `Clients`, so it keeps its own row and may be acted on.
    const t = treeOf(
      {
        Work: ["Work/Clients"],
        "Work/Clients": ["Work/Clients/a.md"],
      },
      { members: ["Work/Clients"] }
    );
    expect(runFrom("Work", t)).toBeNull();
  });

  it("does not compact a folder whose only visible child is a note", () => {
    const t = treeOf({ Work: ["Work/a.md"] });
    expect(runFrom("Work", t)).toBeNull();
  });

  it("does not compact a folder that is itself a member", () => {
    const t = treeOf(
      { Work: ["Work/Clients"], "Work/Clients": ["Work/Clients/a.md"] },
      { members: ["Work"] }
    );
    expect(runFrom("Work", t)).toBeNull();
  });

  // Review Focus 3. Run detection reads VISIBILITY, not the vault.
  it("counts only visible children, so hidden siblings do not stop a run", () => {
    const t = treeOf({
      Work: ["Work/Clients"],
      "Work/Clients": ["Work/Clients/Northwind"],
      "Work/Clients/Northwind": ["Work/Clients/Northwind/a.md"],
    });
    expect(runFrom("Work", t)?.tip).toBe("Work/Clients/Northwind");
  });

  it("returns null for a note", () => {
    expect(runFrom("Work/a.md", treeOf({ Work: ["Work/a.md"] }))).toBeNull();
  });
});

describe("buildChainIndex", () => {
  const t = treeOf({
    Work: ["Work/Clients"],
    "Work/Clients": ["Work/Clients/Northwind"],
    "Work/Clients/Northwind": ["Work/Clients/Northwind/a.md"],
    Archive: ["Archive/old.md"],
  });

  it("indexes a run by its head and by its tip", () => {
    const ix = buildChainIndex(["Work", "Work/Clients", "Work/Clients/Northwind", "Archive"], t);
    expect(ix.runByHead.get("Work")?.tip).toBe("Work/Clients/Northwind");
    expect(ix.runByTip.get("Work/Clients/Northwind")?.segments).toEqual([
      "Work",
      "Clients",
      "Northwind",
    ]);
  });

  it("indexes a run once, under its head, never under a folder inside it", () => {
    // `Work/Clients` is mid-run. Indexing it as a head too would substitute it
    // for itself at a level that never renders.
    const ix = buildChainIndex(["Work", "Work/Clients", "Work/Clients/Northwind"], t);
    expect(ix.runByHead.has("Work/Clients")).toBe(false);
    expect(ix.runByHead.size).toBe(1);
  });

  it("indexes nothing for a folder that does not compact", () => {
    const ix = buildChainIndex(["Archive"], t);
    expect(ix.runByHead.size).toBe(0);
    expect(ix.runByTip.size).toBe(0);
  });
});
