import { describe, expect, it } from "vitest";
import { validateDefinitions } from "../src/definitions/schema";

function doc(space: Record<string, unknown>, schemaVersion = 1): unknown {
  return {
    schemaVersion,
    settings: {},
    spaces: [{ id: "s", name: "S", icon: "box", color: "#808080", members: [], ...space }],
  };
}

describe("schemaVersion on the way out", () => {
  it("stays 1 for a document using nothing new", () => {
    const r = validateDefinitions(doc({ members: [{ kind: "file", path: "a.md" }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schemaVersion).toBe(1);
  });

  it("becomes 2 once a space holds a tag member", () => {
    const r = validateDefinitions(doc({ members: [{ kind: "tag", tag: "project" }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schemaVersion).toBe(2);
  });

  it("becomes 2 once a space excludes something", () => {
    const r = validateDefinitions(doc({ exclude: ["a.md"] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schemaVersion).toBe(2);
  });

  it("accepts a document already marked 2", () => {
    const r = validateDefinitions(doc({ members: [{ kind: "tag", tag: "x" }] }, 2));
    expect(r.ok).toBe(true);
  });

  it("refuses a document from a future version", () => {
    const r = validateDefinitions(doc({}, 3));
    expect(r.ok).toBe(false);
  });
});
