import { describe, expect, it } from "vitest";
import { createLazyTagIndex, createMapTagIndex } from "../src/visibility/TagIndex";

const index = createMapTagIndex(
  new Map([
    ["a.md", ["project", "urgent"]],
    ["b.md", ["project/atlas"]],
    ["c.md", ["person"]],
    ["d.md", []],
    // A tag that shares a prefix with "project" but does not nest under it on a
    // "/" boundary. This ensures the test catches a naive prefix match bug.
    ["e.md", ["projector"]],
  ])
);

describe("createMapTagIndex", () => {
  it("finds notes carrying the tag", () => {
    expect(index.pathsMatching("urgent")).toEqual(["a.md"]);
  });

  it("finds notes carrying a nested tag under it", () => {
    expect(index.pathsMatching("project").sort()).toEqual(["a.md", "b.md"]);
    expect(index.pathsMatching("project")).not.toContain("e.md");
  });

  it("returns nothing for a tag nobody uses", () => {
    expect(index.pathsMatching("missing")).toEqual([]);
  });

  it("normalizes the tag it is asked for", () => {
    expect(index.pathsMatching("#Project/Atlas")).toEqual(["b.md"]);
  });

  // Review Focus item 2: a note whose metadata gave no usable tags.
  it("ignores a note with no tags", () => {
    expect(index.pathsMatching("project")).not.toContain("d.md");
  });
});

/**
 * The flush replaces the tag index on every burst of vault events. Building
 * it there cost every user a walk of every markdown file and its metadata
 * cache per burst, whether or not any space held a tag.
 */
describe("createLazyTagIndex", () => {
  it("does not build the index until something asks it a question", () => {
    let builds = 0;
    createLazyTagIndex(() => {
      builds++;
      return createMapTagIndex(new Map());
    });
    expect(builds).toBe(0);
  });

  it("builds once and answers every later question from that one snapshot", () => {
    // One recompute must see ONE picture: a wrapper that rebuilt per lookup
    // would let two tag members in the same space disagree about the vault.
    let builds = 0;
    const lazy = createLazyTagIndex(() => {
      builds++;
      return createMapTagIndex(new Map([["a.md", ["project"]]]));
    });
    expect(lazy.pathsMatching("project")).toEqual(["a.md"]);
    expect(lazy.pathsMatching("project")).toEqual(["a.md"]);
    expect(lazy.pathsMatching("other")).toEqual([]);
    expect(builds).toBe(1);
  });
});
