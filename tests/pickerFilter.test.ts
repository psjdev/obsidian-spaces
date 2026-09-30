/**
 * The one rule that decides whether the create panel's picker shows the vault
 * tree or the vault's tags.
 *
 * Layer 1: a pure function, no DOM, no `obsidian`. It is tested apart from the
 * panel because it is the part of the `#` sigil prototype that is meant to
 * outlive it — the panel around it is one of three look-and-feel candidates,
 * this rule is not.
 */

import { describe, expect, it } from "vitest";
import { readPickerFilter, TAG_SIGIL } from "../src/ui/pickerFilter";

describe("readPickerFilter", () => {
  it("leaves an ordinary filter to the tree, byte for byte", () => {
    // The tree is the control in the prototype comparison. Anything this
    // function did to the filter on the way past — a trim, a lowercase —
    // would make every tree behaviour a new behaviour, so the assertion is on
    // identity rather than on equivalence.
    for (const raw of ["", "plan", "  plan  ", "Projects/Work", "a#b", "PLAN"]) {
      expect(readPickerFilter(raw)).toEqual({ mode: "tree", query: raw });
    }
  });

  it("switches to tags on a leading sigil, and hands back the rest", () => {
    expect(readPickerFilter("#proj")).toEqual({ mode: "tag", query: "proj" });
  });

  it("treats a bare sigil as a query, not as a missing one", () => {
    // Typing `#` is how someone who does not know what the vault holds finds
    // out. An empty body here would make the sigil look broken at the very
    // moment it is first tried.
    expect(readPickerFilter("#")).toEqual({ mode: "tag", query: "" });
  });

  it("finds the sigil behind leading whitespace", () => {
    // Invisible, so it cannot be the difference between two modes. A space
    // picked up from a paste would otherwise search the tree for a file
    // called "#project" with nothing on screen to explain why.
    expect(readPickerFilter("  #project")).toEqual({ mode: "tag", query: "project" });
  });

  it("keeps a sigil that is not the first character in the tree", () => {
    // `#` is legal in a file name, and a filter that starts with something
    // else is not asking for tags.
    expect(readPickerFilter("notes #2")).toEqual({ mode: "tree", query: "notes #2" });
  });

  it("strips exactly one sigil, so a second one reaches the query", () => {
    // `normalizeTag` drops the other, deliberately: a doubled `#` is a typo,
    // and the picker should not silently read it as something else here.
    expect(readPickerFilter("##proj")).toEqual({ mode: "tag", query: "#proj" });
  });

  it("keeps the sigil the panel draws and the one it reads in step", () => {
    expect(TAG_SIGIL).toBe("#");
    expect(readPickerFilter(TAG_SIGIL).mode).toBe("tag");
  });
});
