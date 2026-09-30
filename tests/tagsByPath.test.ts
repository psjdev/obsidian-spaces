/**
 * What the tag index STORES, as opposed to what it answers.
 *
 * The index kept an entry for every markdown file, including the 6,000 of
 * 10,000 in the measured vault that carry no tags at all. `pathsMatching` can
 * never emit one of those, so every byte and every loop iteration spent on
 * them was spent on a path that cannot be part of any answer.
 *
 * Measured: 41.3 % of the structure's 613 KB at 10,000 notes, and a miss scan
 * 2.1x slower for carrying them. Skipping them takes the scan from 10,000
 * iterations to 4,000 on that vault and changes no answer at all.
 *
 * The builder is pure and injected, for the same reason `createTreeVaultIndex`
 * lives beside its interface: `createObsidianTagIndex` keeps only the part
 * that needs the Obsidian runtime (`getAllTags` and the vault walk), so what
 * goes INTO the map stays testable in plain node.
 */
import { describe, expect, it } from "vitest";
import { createMapTagIndex, tagsByPath } from "../src/visibility/TagIndex";

const FILES = ["a.md", "b.md", "untagged.md", "unparsed.md", "c.md"];

/** `getAllTags`' contract: a list, or null for a note with no usable cache. */
const tagsOf = (path: string): string[] | null => {
  switch (path) {
    case "a.md":
      return ["#Project", "#urgent"];
    case "b.md":
      return ["#project/atlas"];
    case "c.md":
      return [];
    case "unparsed.md":
      return null;
    default:
      return [];
  }
};

describe("tagsByPath", () => {
  it("keeps only the notes that carry a tag", () => {
    expect([...tagsByPath(FILES, (p) => p, tagsOf).keys()]).toEqual(["a.md", "b.md"]);
  });

  it("stores no entry for a note whose tag list is empty", () => {
    expect(tagsByPath(FILES, (p) => p, tagsOf).has("untagged.md")).toBe(false);
  });

  it("stores no entry for a note the metadata cache has not parsed", () => {
    // `getAllTags` returns null for a note with no usable metadata, which is
    // every note at first paint. It is indistinguishable from untagged here
    // and must not become an entry either.
    expect(tagsByPath(FILES, (p) => p, tagsOf).has("unparsed.md")).toBe(false);
  });

  it("normalizes what it does store", () => {
    expect(tagsByPath(FILES, (p) => p, tagsOf).get("a.md")).toEqual(["project", "urgent"]);
  });

  it("answers exactly as it did when it stored every note", () => {
    const index = createMapTagIndex(tagsByPath(FILES, (p) => p, tagsOf));
    expect(index.pathsMatching("project").sort()).toEqual(["a.md", "b.md"]);
    expect(index.pathsMatching("urgent")).toEqual(["a.md"]);
    expect(index.pathsMatching("untagged")).toEqual([]);
  });
});
