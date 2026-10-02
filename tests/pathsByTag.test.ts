/**
 * What the tag index STORES, as opposed to what it answers.
 *
 * It is keyed by tag, not by path, and the ancestors of every tag are expanded
 * as it is built, so a note tagged `project/atlas` is filed under `project`
 * too and answering `project` is a lookup rather than a scan. Measured at
 * 0.00008 ms against 0.514 ms for the scan it replaces, with the build
 * unchanged at 12.0 ms against 12.1 ms because the ancestor chain is memoised
 * per distinct tag spelling rather than recomputed per tag instance.
 *
 * An untagged note contributes to no bucket, so it cannot have an entry at
 * all: 6,000 of the 10,000 notes in the measured vault, and 60 % of the map
 * this replaces.
 *
 * The builder is pure and injected, for the same reason `createTreeVaultIndex`
 * lives beside its interface: `createObsidianTagIndex` keeps only the part
 * that needs the Obsidian runtime (`getAllTags` and the vault walk), so what
 * goes INTO the map stays testable in plain node.
 */
import { describe, expect, it } from "vitest";
import { createMapTagIndex, pathsByTag } from "../src/visibility/TagIndex";
import { tagMatches } from "../src/visibility/tagMatch";
import { tagIndexOf } from "./helpers/tagIndex";

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

const built = () => pathsByTag(FILES, (p) => p, tagsOf);
const everyPathStored = (): string[] => [...new Set([...built().values()].flat())].sort();

describe("pathsByTag", () => {
  it("keys the map by tag, not by path", () => {
    expect([...built().keys()].sort()).toEqual(["project", "project/atlas", "urgent"]);
  });

  it("files a nested tag under its ancestors as well as itself", () => {
    // This is the whole reason the lookup can be a lookup. `b.md` carries only
    // `project/atlas`, and a space whose member is `project` must still find
    // it, which used to be `tagMatches` running per note per query.
    const map = built();
    expect(map.get("project/atlas")).toEqual(["b.md"]);
    expect(map.get("project")).toEqual(["a.md", "b.md"]);
  });

  it("keeps only the notes that carry a tag", () => {
    expect(everyPathStored()).toEqual(["a.md", "b.md"]);
  });

  it("stores no entry for a note whose tag list is empty", () => {
    expect(everyPathStored()).not.toContain("untagged.md");
  });

  it("stores no entry for a note the metadata cache has not parsed", () => {
    // `getAllTags` returns null for a note with no usable metadata, which is
    // every note at first paint. It is indistinguishable from untagged here
    // and must not become an entry either.
    expect(everyPathStored()).not.toContain("unparsed.md");
  });

  it("normalizes the tags it keys by", () => {
    expect([...built().keys()]).toContain("project");
    expect([...built().keys()]).not.toContain("#Project");
  });

  it("answers exactly as it did when it was keyed by path", () => {
    const index = createMapTagIndex(built());
    expect(index.pathsMatching("project").sort()).toEqual(["a.md", "b.md"]);
    expect(index.pathsMatching("urgent")).toEqual(["a.md"]);
    expect(index.pathsMatching("untagged")).toEqual([]);
  });

  it("hands out a copy, so a caller that sorts it cannot reorder the index", () => {
    // Tests above and below sort what they get back. Handing over the live
    // bucket would make one caller's `.sort()` the next caller's input.
    const index = createMapTagIndex(built());
    index.pathsMatching("project").reverse();
    expect(index.pathsMatching("project")).toEqual(["a.md", "b.md"]);
  });
});

/**
 * Nesting is still defined by `tagMatches` and by nothing else. The expansion
 * above is an inversion of it, not a second opinion about it, so this pins the
 * two against each other over a corpus rather than restating the rule in the
 * assertion and testing the restatement.
 *
 * `projector` and `proj` are in here because a bare prefix match, with no
 * segment boundary, is the way to get this wrong that reads as correct.
 */
describe("the expansion agrees with tagMatches", () => {
  const CORPUS = new Map<string, string[]>([
    ["a.md", ["project", "urgent"]],
    ["b.md", ["project/atlas"]],
    ["c.md", ["project/atlas/v1"]],
    ["d.md", ["projector"]],
    ["e.md", ["area/home/garden", "project"]],
    ["f.md", []],
    // Parent and child on one note: the scan cannot emit it twice, so the
    // expanded index must not either, and this property test says so as well
    // as the dedicated block below.
    ["g.md", ["project", "project/atlas"]],
  ]);

  const CANDIDATES = [
    "project",
    "project/atlas",
    "project/atlas/v1",
    "projector",
    "proj",
    "urgent",
    "area",
    "area/home",
    "area/home/garden",
    "atlas",
    "nobody",
  ];

  it("files each note under exactly the tags tagMatches accepts for it", () => {
    const index = tagIndexOf(CORPUS);
    for (const member of CANDIDATES) {
      const byScan = [...CORPUS]
        .filter(([, tags]) => tags.some((t) => tagMatches(member, t)))
        .map(([path]) => path);
      // Keyed by the tag so a failure names it rather than just an index.
      expect({ [member]: index.pathsMatching(member) }).toEqual({ [member]: byScan });
    }
  });

  it("returns nothing for a tag nobody uses", () => {
    expect(tagIndexOf(CORPUS).pathsMatching("nobody")).toEqual([]);
  });
});

/**
 * The one case ancestor expansion introduces, and the one least likely to be
 * caught by anything else.
 *
 * A note carrying BOTH `project` and `project/atlas` is filed under `project`
 * twice unless something stops it. `resolveMembers` dedupes, so the tree looks
 * right and no snapshot test notices; but `SettingsTab` and
 * `SpaceContentsModal` call `pathsMatching(tag).length` directly to show the
 * user how many notes a tag member covers, and that number would be wrong.
 *
 * `pathsByTag` guards by comparing against the last element only. That is
 * sound because all of ONE file's tags are pushed before any other file's, so
 * two entries for the same path in one bucket can only ever be adjacent. These
 * tests cover both orders, three levels, and the case that proves the guard
 * does not also swallow a genuine second note.
 */
describe("a note carrying both a tag and its parent", () => {
  const under = (tags: string[]): string[] =>
    tagIndexOf(new Map([["note.md", tags]])).pathsMatching("project");

  it("appears once under the parent, child tag last", () => {
    expect(under(["project", "project/atlas"])).toEqual(["note.md"]);
  });

  it("appears once under the parent, child tag first", () => {
    expect(under(["project/atlas", "project"])).toEqual(["note.md"]);
  });

  it("appears once under the parent with all three levels on it", () => {
    expect(under(["project", "project/atlas", "project/atlas/v1"])).toEqual(["note.md"]);
  });

  it("counts once, which is the number the settings tab shows", () => {
    expect(under(["project", "project/atlas"]).length).toBe(1);
  });

  it("does not swallow a different note that carries the same pair", () => {
    // The guard compares against the last element, not the whole bucket. A
    // guard that skipped any path already in the bucket would also pass this;
    // one that skipped any repeat of the previous FILE would not.
    const index = tagIndexOf(
      new Map([
        ["one.md", ["project", "project/atlas"]],
        ["two.md", ["project", "project/atlas"]],
      ])
    );
    expect(index.pathsMatching("project")).toEqual(["one.md", "two.md"]);
    expect(index.pathsMatching("project/atlas")).toEqual(["one.md", "two.md"]);
  });
});
