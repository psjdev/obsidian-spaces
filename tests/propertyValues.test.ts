/**
 * The matcher, driven by the spec's boundary table. Every row there is a case
 * here, because the table is the contract and a table nobody tests is prose.
 *
 * DRIVEN THROUGH `createPropertyIndex`, which is the rule the plugin runs.
 * The table used to drive `valuesOf`, a second copy of the rule with no
 * caller anywhere in `src/`, so eight of these rows — number, the string
 * "02", boolean, nested array, array-with-object, array-with-null, the text
 * "null" and whitespace-only — had no test against live code at all. The copy
 * is gone. A row is asserted two ways, because the live rule answers two
 * questions the dead one could not both answer: which values a key OFFERS, in
 * the spelling a picker row would draw, and which notes a member asking for a
 * value MATCHES.
 */
import { describe, expect, it } from "vitest";
import { normalizeValue, hasOwnKey } from "../src/visibility/propertyValues";
import { createPropertyIndex } from "../src/visibility/PropertyIndex";

/** One note, one key, whatever frontmatter shape the row is about. */
const indexOf = (raw: unknown) =>
  createPropertyIndex([{ path: "a.md", frontmatter: { k: raw } }], 1);

/** The normalized values the key offers, which is what matching is keyed on. */
const offered = (raw: unknown): string[] => indexOf(raw).listValues("k").map((v) => v.normalized);

/** Whether a member asking for `value` matches the note. */
const matches = (raw: unknown, value: string): boolean =>
  indexOf(raw).pathsMatching("k", value).length === 1;

describe("normalizeValue", () => {
  it("trims and lowercases", () => {
    expect(normalizeValue("  Active ")).toBe("active");
  });
  it("turns a whitespace-only string into the empty string", () => {
    expect(normalizeValue("   ")).toBe("");
  });
});

describe("the values a frontmatter entry offers", () => {
  it.each([
    ["a string", "Active", ["active"]],
    ["a number", 2, ["2"]],
    ["a boolean", true, ["true"]],
    ["an empty string", "", [""]],
    ["whitespace", "   ", [""]],
    ["null", null, []],
    ["undefined", undefined, []],
    ["an object", { k: "v" }, []],
    ["an empty array", [], []],
    ["a flat array", ["a", "b"], ["a", "b"]],
    ["a repeated entry", ["a", "A"], ["a"]],
    ["a nested array", ["a", ["b"]], ["a"]],
    ["an array holding an object", ["a", { k: "c" }], ["a"]],
    ["an array holding null", ["a", null], ["a"]],
    ["text with a slash", "a/b", ["a/b"]],
    ["text with an equals", "a=b", ["a=b"]],
    ["text with a comma", "a,b", ["a,b"]],
  ])("handles %s", (_label, raw, expected) => {
    expect(offered(raw)).toEqual(expected);
  });

  it("offers a value under the spelling its author used", () => {
    // The whole reason this rule could not simply become `valuesOf`: the
    // picker draws a row per value, and it draws what the note says.
    expect(indexOf(["Active", "ACTIVE"]).listValues("k")).toEqual([
      { value: "Active", normalized: "active", count: 1 },
    ]);
    expect(indexOf("   ").listValues("k")).toEqual([{ value: "   ", normalized: "", count: 1 }]);
  });

  it("never stringifies a whole array", () => {
    // `String(["atlas","billing"])` is "atlas,billing", which would match a
    // member asking for exactly that.
    expect(offered(["atlas", "billing"])).not.toContain("atlas,billing");
    expect(matches(["atlas", "billing"], "atlas,billing")).toBe(false);
    expect(matches(["atlas", "billing"], "atlas")).toBe(true);
  });

  it("gives a number 2 and the string 02 different values", () => {
    expect(offered(2)).toEqual(["2"]);
    expect(offered("02")).toEqual(["02"]);
    expect(matches(2, "02")).toBe(false);
    expect(matches("02", "2")).toBe(false);
  });

  it("gives null no value, never the text null", () => {
    expect(offered(null)).toEqual([]);
    expect(matches(null, "null")).toBe(false);
    expect(offered("null")).toEqual(["null"]);
    expect(matches("null", "null")).toBe(true);
  });

  it("matches trimmed and case-folded, and only one level deep", () => {
    expect(matches("Active", "  ACTIVE ")).toBe(true);
    expect(matches(["a", ["b"]], "b")).toBe(false);
    expect(matches(["a", { k: "c" }], "c")).toBe(false);
  });

  it("still carries the key for a value that offers nothing", () => {
    // "Has this property" is the primary shape, and it is a different
    // question from "offers a matchable value".
    expect(indexOf(null).pathsWithKey("k")).toEqual(["a.md"]);
    expect(indexOf({ k: "v" }).pathsWithKey("k")).toEqual(["a.md"]);
  });
});

describe("hasOwnKey", () => {
  it("is true for a key the note authored, whatever it holds", () => {
    for (const v of ["x", "", null, 0, false, {}, []]) {
      expect(hasOwnKey({ a: v }, "a"), String(v)).toBe(true);
    }
  });
  it("is false for a key the note does not have", () => {
    expect(hasOwnKey({ a: 1 }, "b")).toBe(false);
  });
  it("is false for an inherited name", () => {
    expect(hasOwnKey({}, "constructor")).toBe(false);
    expect(hasOwnKey({}, "toString")).toBe(false);
    expect(hasOwnKey({}, "__proto__")).toBe(false);
  });
  it("is case-sensitive, because keys match exactly", () => {
    expect(hasOwnKey({ Status: 1 }, "status")).toBe(false);
  });
});
