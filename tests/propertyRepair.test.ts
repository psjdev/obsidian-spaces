/**
 * The two pure decisions the repair is made of: which files to read, and what
 * to do with what came back.
 *
 * Layer 1 — no Obsidian, no disk, no timers.
 */
import { describe, expect, it } from "vitest";
import {
  PROPERTY_REPAIR_MAX_FILES,
  mergeRepairedWalk,
  planRepair,
} from "../src/visibility/propertyRepair";
import { snapshotFromWalk } from "../src/visibility/ObsidianPropertyIndex";
import type { FrontmatterRead } from "../src/visibility/frontmatterHead";

const paths = (n: number): string[] => Array.from({ length: n }, (_, i) => `n${i}.md`);

describe("planRepair", () => {
  it("has nothing to do when nothing is unparsed", () => {
    expect(planRepair([])).toEqual({ kind: "nothing" });
  });

  it("reads the unparsed files when there are few of them", () => {
    expect(planRepair(["a.md", "b.md"])).toEqual({ kind: "repair", paths: ["a.md", "b.md"] });
  });

  it("REFUSES a vault-sized list, which is what makes a cold start safe", () => {
    // The guard that cannot be wrong about timing. At cold start every file is
    // unparsed; a 5,000-note vault is 25 times over this bound, so no trigger
    // mistake anywhere can cause the vault to be read off disk.
    const many = paths(PROPERTY_REPAIR_MAX_FILES + 1);
    expect(planRepair(many)).toEqual({ kind: "too-many", count: many.length });
  });

  it("reads exactly at the bound and refuses one past it", () => {
    expect(planRepair(paths(PROPERTY_REPAIR_MAX_FILES)).kind).toBe("repair");
    expect(planRepair(paths(PROPERTY_REPAIR_MAX_FILES + 1)).kind).toBe("too-many");
  });
});

describe("mergeRepairedWalk", () => {
  const cached = [{ path: "parsed.md", frontmatter: { status: "done" } }];

  const walk = (unparsed: string[]) => ({ entries: cached, unparsed });
  const reads = (m: Record<string, FrontmatterRead>) => new Map(Object.entries(m));

  it("turns a read frontmatter into an entry and closes the hole", () => {
    const merged = mergeRepairedWalk(
      walk(["a.md"]),
      reads({ "a.md": { kind: "frontmatter", frontmatter: { status: "active" } } })
    );
    expect(merged.unparsed).toEqual([]);
    expect(merged.entries).toEqual([...cached, { path: "a.md", frontmatter: { status: "active" } }]);
    expect(snapshotFromWalk(merged, 1).status).toBe("ready");
  });

  it("closes the hole for a file that genuinely has no frontmatter", () => {
    // "none" is an ANSWER, not a failure: the file contributes nothing and is
    // no longer a reason to withhold the whole snapshot.
    const merged = mergeRepairedWalk(walk(["a.md"]), reads({ "a.md": { kind: "none" } }));
    expect(merged.unparsed).toEqual([]);
    expect(merged.entries).toEqual(cached);
    expect(snapshotFromWalk(merged, 1).status).toBe("ready");
  });

  it("KEEPS a file we could not read unparsed, so the snapshot stays honest", () => {
    // The half of the design that refuses to guess. A file counted as having
    // no properties when nobody managed to look is a count labelled complete
    // that is wrong — worse than a feature that says it is still looking.
    const merged = mergeRepairedWalk(walk(["a.md", "b.md"]), reads({
      "a.md": { kind: "frontmatter", frontmatter: { status: "active" } },
      "b.md": { kind: "unreadable" },
    }));
    expect(merged.unparsed).toEqual(["b.md"]);
    const snap = snapshotFromWalk(merged, 1);
    expect(snap.status).toBe("unavailable");
    if (snap.status !== "unavailable") throw new Error("unreachable");
    expect([...snap.unparsed]).toEqual(["b.md"]);
  });

  it("keeps a path nobody read at all unparsed", () => {
    const merged = mergeRepairedWalk(walk(["a.md"]), reads({}));
    expect(merged.unparsed).toEqual(["a.md"]);
  });

  it("does not mutate the walk it was given", () => {
    const original = { entries: [...cached], unparsed: ["a.md"] };
    mergeRepairedWalk(original, reads({ "a.md": { kind: "none" } }));
    expect(original.entries).toEqual(cached);
    expect(original.unparsed).toEqual(["a.md"]);
  });

  it("produces a COMPLETE walk, which is what lets the install be one step", () => {
    // The async repair must never leave a half-repaired index observable. It
    // cannot, because the merge is a function returning a whole new walk:
    // there is no moment at which a partially merged value exists anywhere a
    // caller could reach.
    const merged = mergeRepairedWalk(
      { entries: cached, unparsed: ["a.md", "b.md", "c.md"] },
      reads({
        "a.md": { kind: "frontmatter", frontmatter: { status: "active" } },
        "b.md": { kind: "none" },
        "c.md": { kind: "frontmatter", frontmatter: { area: "atlas" } },
      })
    );
    const snap = snapshotFromWalk(merged, 3);
    if (snap.status !== "ready") throw new Error("expected ready");
    expect(snap.index.generation).toBe(3);
    expect(snap.index.listKeys().map((k) => k.key).sort()).toEqual(["area", "status"]);
    expect(snap.index.pathsMatching("status", "done")).toEqual(["parsed.md"]);
    expect(snap.index.pathsMatching("status", "active")).toEqual(["a.md"]);
  });
});
