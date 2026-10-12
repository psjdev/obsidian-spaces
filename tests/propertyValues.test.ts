/**
 * The matcher, driven by the spec's boundary table. Every row there is a case
 * here, because the table is the contract and a table nobody tests is prose.
 */
import { describe, expect, it } from "vitest";
import { normalizeValue, valuesOf, hasOwnKey } from "../src/visibility/propertyValues";

describe("normalizeValue", () => {
  it("trims and lowercases", () => {
    expect(normalizeValue("  Active ")).toBe("active");
  });
  it("turns a whitespace-only string into the empty string", () => {
    expect(normalizeValue("   ")).toBe("");
  });
});

describe("valuesOf", () => {
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
    expect(valuesOf(raw)).toEqual(expected);
  });

  it("never stringifies a whole array", () => {
    // `String(["atlas","billing"])` is "atlas,billing", which would match a
    // member asking for exactly that.
    expect(valuesOf(["atlas", "billing"])).not.toContain("atlas,billing");
  });

  it("gives a number 2 and the string 02 different values", () => {
    expect(valuesOf(2)).toEqual(["2"]);
    expect(valuesOf("02")).toEqual(["02"]);
  });

  it("gives null no value, never the text null", () => {
    expect(valuesOf(null)).toEqual([]);
    expect(valuesOf("null")).toEqual(["null"]);
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
