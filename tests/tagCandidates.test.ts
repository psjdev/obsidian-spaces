/**
 * What the add-a-tag field offers.
 *
 * `TagSuggest` itself cannot be imported here — `AbstractInputSuggest`'s stub
 * constructor throws, because it needs a real `App` — so this is the only
 * layer at which the decision about WHAT to suggest can be tested. That is
 * exactly why the logic was pulled out of the class, mirroring
 * `folderCandidates` beside `FolderSuggest`.
 */

import { describe, expect, it } from "vitest";
import { tagCandidates, type TagSource } from "../src/ui/tagCandidates";

/** A source holding the tags Obsidian would hand over, `#` and all. */
const from = (tags: string[]): TagSource => ({ knownTags: () => tags });

describe("tagCandidates", () => {
  it("normalizes a typed #Project to the stored form before matching", () => {
    // The user types the `#` they see everywhere else in Obsidian, and in
    // whatever case they like. Neither may change what comes back, because
    // `normalizeTag` is what decides the spelling that gets stored.
    const src = from(["#project", "#archive"]);
    expect(tagCandidates(src, "#Project")).toEqual(["project"]);
    expect(tagCandidates(src, "PROJECT")).toEqual(["project"]);
    expect(tagCandidates(src, "project")).toEqual(["project"]);
  });

  it("normalizes the candidates too, so what is offered is what is stored", () => {
    // Tags are stored without a leading `#`. Offering `#project` would put the
    // `#` into the member list, where nothing else expects it.
    expect(tagCandidates(from(["#Project"]), "proj")).toEqual(["project"]);
  });

  it("filters on a substring, not a prefix", () => {
    // A nested tag's useful part is often its last segment, so requiring a
    // prefix would hide `project/console` from someone typing `console`.
    const src = from(["#project/console", "#archive"]);
    expect(tagCandidates(src, "console")).toEqual(["project/console"]);
  });

  it("leaves out what does not match", () => {
    expect(tagCandidates(from(["#project", "#archive"]), "arch")).toEqual(["archive"]);
  });

  it("collapses two spellings of one tag to the single entry that gets stored", () => {
    // `getTags()` can hand back `#Project` and `#project` as separate keys;
    // they normalize to one member, so offering both would be offering the
    // same choice twice.
    expect(tagCandidates(from(["#Project", "#project", "#PROJECT"]), "")).toEqual(["project"]);
  });

  it("lists everything it knows for an empty query, so the field is browsable", () => {
    expect(tagCandidates(from(["#beta", "#alpha"]), "")).toEqual(["alpha", "beta"]);
  });

  it("sorts alphabetically rather than in whatever order the source enumerated", () => {
    expect(tagCandidates(from(["#gamma", "#alpha", "#beta"]), "a")).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("caps the list at 50 by default", () => {
    // A vault with thousands of tags must not build a popover thousands of
    // rows long.
    const many = Array.from({ length: 200 }, (_, i) => `#tag${String(i).padStart(3, "0")}`);
    expect(tagCandidates(from(many), "")).toHaveLength(50);
    expect(tagCandidates(from(many), "tag")).toHaveLength(50);
  });

  it("caps at the limit it is given", () => {
    expect(tagCandidates(from(["#a", "#b", "#c"]), "", 2)).toEqual(["a", "b"]);
  });

  it("offers nothing when the source cannot say", () => {
    // Null is `nativeKnownTags` reporting that the private method was not
    // there to call. It must read as "no candidates", never as "this vault
    // has no tags" — the difference matters because the field still accepts
    // anything typed into it.
    expect(tagCandidates({ knownTags: () => null }, "project")).toEqual([]);
  });

  it("offers nothing when the vault genuinely has no tags", () => {
    expect(tagCandidates(from([]), "")).toEqual([]);
  });

  it("drops a bare # rather than offering a nameless row", () => {
    // `normalizeTag("#")` is `""`, which would render as a `#` with no name
    // and add nothing at all if picked.
    expect(tagCandidates(from(["#", "#project"]), "")).toEqual(["project"]);
  });
});
