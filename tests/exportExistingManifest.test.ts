import { describe, expect, it } from "vitest";
import { readExistingExport } from "../src/export/spaceManifest";

/**
 * The gate in front of the recursive delete.
 *
 * It parses a file from outside the vault that nothing guarantees anything
 * about, and a wrong answer either refuses a legitimate replace or offers to
 * delete somebody's folder. It had no direct test at all until a review
 * pointed out that an implementation which never calls `JSON.parse` and one
 * with every type guard removed both passed the whole suite.
 */
describe("readExistingExport", () => {
  const ok = JSON.stringify({
    formatVersion: 1,
    exportedAt: "2026-10-25T10:00:00.000Z",
    space: { id: "kitchen", name: "Kitchen", icon: "hammer", color: "#fff" },
  });

  it("reads the id, the name and the date", () => {
    expect(readExistingExport(ok)).toEqual({
      spaceId: "kitchen",
      spaceName: "Kitchen",
      exportedAt: "2026-10-25T10:00:00.000Z",
    });
  });

  it("returns null for an absent file", () => {
    expect(readExistingExport(null)).toBe(null);
  });

  it("returns null for text that is not JSON", () => {
    // A regex scrape of `"id":"…"` would happily find one in here.
    expect(readExistingExport('garbage "id":"kitchen" garbage')).toBe(null);
    expect(readExistingExport("{ not json")).toBe(null);
    expect(readExistingExport("")).toBe(null);
  });

  it("returns null for JSON that is not an object", () => {
    for (const t of ["null", "42", '"kitchen"', "[]", "true"]) {
      expect(readExistingExport(t), t).toBe(null);
    }
  });

  it("returns null when there is no space object", () => {
    expect(readExistingExport("{}")).toBe(null);
    expect(readExistingExport('{"space":null}')).toBe(null);
    expect(readExistingExport('{"space":"kitchen"}')).toBe(null);
    expect(readExistingExport('{"space":[]}')).toBe(null);
  });

  it("returns null when the id is missing, empty or not a string", () => {
    expect(readExistingExport('{"space":{}}')).toBe(null);
    expect(readExistingExport('{"space":{"id":""}}')).toBe(null);
    expect(readExistingExport('{"space":{"id":7}}')).toBe(null);
    expect(readExistingExport('{"space":{"id":null}}')).toBe(null);
    expect(readExistingExport('{"space":{"id":["kitchen"]}}')).toBe(null);
  });

  it("accepts an id while treating a missing name or date as unknown", () => {
    // Both are for the user to read, so neither may block a legitimate
    // replace, and neither may arrive as undefined.
    expect(readExistingExport('{"space":{"id":"kitchen"}}')).toEqual({
      spaceId: "kitchen",
      spaceName: null,
      exportedAt: null,
    });
  });

  it("treats a non-string name or date as unknown rather than passing it on", () => {
    const r = readExistingExport('{"exportedAt":123,"space":{"id":"k","name":{}}}');
    expect(r).toEqual({ spaceId: "k", spaceName: null, exportedAt: null });
  });

  it("is not fooled by a prototype-polluting payload", () => {
    const r = readExistingExport('{"space":{"id":"k"},"__proto__":{"spaceId":"evil"}}');
    expect(r?.spaceId).toBe("k");
    expect(({} as Record<string, unknown>).spaceId).toBeUndefined();
  });
});
