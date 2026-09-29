import { describe, expect, it } from "vitest";
import { createMapTagIndex } from "../src/visibility/TagIndex";

const index = createMapTagIndex(
  new Map([
    ["a.md", ["project", "urgent"]],
    ["b.md", ["project/atlas"]],
    ["c.md", ["person"]],
    ["d.md", []],
  ])
);

describe("createMapTagIndex", () => {
  it("finds notes carrying the tag", () => {
    expect(index.pathsMatching("urgent")).toEqual(["a.md"]);
  });

  it("finds notes carrying a nested tag under it", () => {
    expect(index.pathsMatching("project").sort()).toEqual(["a.md", "b.md"]);
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
