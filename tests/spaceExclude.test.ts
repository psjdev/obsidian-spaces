import { describe, expect, it } from "vitest";
import { validateDefinitions } from "../src/definitions/schema";

function doc(exclude: unknown): unknown {
  return {
    schemaVersion: 1,
    settings: {},
    spaces: [
      { id: "s", name: "S", icon: "box", color: "#808080", members: [], exclude },
    ],
  };
}

describe("a space's exclusions", () => {
  it("keeps a list of paths", () => {
    const r = validateDefinitions(doc(["a/b.md"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spaces[0].exclude).toEqual(["a/b.md"]);
  });

  it("is absent, not empty, when the space excludes nothing", () => {
    const r = validateDefinitions(doc([]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spaces[0].exclude).toBeUndefined();
  });

  // The rule validateSpace already applies to `root`: a bad field must never
  // cost the user a space.
  it("drops an unusable entry and keeps the space", () => {
    const r = validateDefinitions(doc(["a/b.md", 7, "../escape.md", ""]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spaces[0].exclude).toEqual(["a/b.md"]);
    expect(r.value.spaces[0].name).toBe("S");
  });

  it("drops a non-array outright and keeps the space", () => {
    const r = validateDefinitions(doc("a/b.md"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spaces[0].exclude).toBeUndefined();
  });

  it("de-duplicates paths differing only in case", () => {
    const r = validateDefinitions(doc(["A/B.md", "a/b.md"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spaces[0].exclude).toHaveLength(1);
  });

  // Review Focus item 4. A dangling exclusion is kept, like a dangling
  // member, because the file may come back.
  it("keeps an exclusion naming a path nothing lives at", () => {
    const r = validateDefinitions(doc(["gone/forever.md"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spaces[0].exclude).toEqual(["gone/forever.md"]);
  });
});
