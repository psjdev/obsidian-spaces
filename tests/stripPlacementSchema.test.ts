import { describe, expect, it } from "vitest";
import { validateDefinitions } from "../src/definitions/schema";

function doc(stripPlacement: unknown) {
  return {
    schemaVersion: 1,
    settings: { stripPlacement },
    spaces: [{ id: "a", name: "Alpha", icon: "box", color: "#5b5bff", members: [] }],
  };
}

describe("stripPlacement", () => {
  it("round-trips every placement it accepts", () => {
    for (const p of ["bottom", "top", "left", "right"] as const) {
      const out = validateDefinitions(doc(p));
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.value.settings.stripPlacement).toBe(p);
    }
  });

  it("degrades an unknown value to bottom rather than rejecting", () => {
    const out = validateDefinitions(doc("diagonal"));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.settings.stripPlacement).toBe("bottom");
  });

  it("keeps the spaces when the value is bad, because a typo must not cost them", () => {
    const out = validateDefinitions(doc(42));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.spaces.map((s) => s.id)).toEqual(["a"]);
  });

  it("defaults to bottom when absent", () => {
    const out = validateDefinitions(doc(undefined));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.settings.stripPlacement).toBe("bottom");
  });
});
