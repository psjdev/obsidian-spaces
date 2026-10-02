import { describe, expect, it } from "vitest";
import { validateDefinitions } from "../src/definitions/schema";
import { DEFAULT_DEFINITIONS } from "../src/types";

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

  it("DEFAULT_DEFINITIONS is version 1, not SCHEMA_VERSION", () => {
    expect(DEFAULT_DEFINITIONS.schemaVersion).toBe(1);
  });

  it("validating the defaults comes back as version 1 too", () => {
    const r = validateDefinitions(DEFAULT_DEFINITIONS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schemaVersion).toBe(1);
  });

  it("drops back to 1 once the last exclusion is removed, even though the document arrived marked 2", () => {
    const withExclusion = validateDefinitions(doc({ exclude: ["a.md"] }, 2));
    expect(withExclusion.ok).toBe(true);
    if (!withExclusion.ok) return;
    expect(withExclusion.value.schemaVersion).toBe(2);

    // Same incoming schemaVersion, exclusion gone: the version is recomputed
    // from content, not remembered, so this must come back as 1 rather than
    // staying 2. That recomputation is what lets a user who deletes their
    // last tag or exclusion get a document an older install can read again.
    const withoutExclusion = validateDefinitions(doc({}, 2));
    expect(withoutExclusion.ok).toBe(true);
    if (!withoutExclusion.ok) return;
    expect(withoutExclusion.value.schemaVersion).toBe(1);
  });

  it("becomes 2 when only one of several spaces needs it", () => {
    const r = validateDefinitions({
      schemaVersion: 1,
      settings: {},
      spaces: [
        { id: "a", name: "A", icon: "box", color: "#808080", members: [] },
        {
          id: "b",
          name: "B",
          icon: "box",
          color: "#808080",
          members: [{ kind: "tag", tag: "project" }],
        },
        { id: "c", name: "C", icon: "box", color: "#808080", members: [] },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schemaVersion).toBe(2);
  });

  it("stays 1 when a space's exclude is an empty array", () => {
    // validateSpace collapses `exclude: []` to absent before schemaVersionFor
    // ever sees the space, so this is asserted end to end through
    // validateDefinitions rather than by calling schemaVersionFor directly
    // with a hand-built SpaceDefinition — a directly-built one could carry
    // `exclude: []` in a shape validateSpace would never actually produce,
    // which would not pin the real boundary.
    const r = validateDefinitions(doc({ exclude: [] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schemaVersion).toBe(1);
  });
});
