import { describe, expect, it } from "vitest";
import { validateDefinitions, schemaVersionFor, memberIdentity } from "../src/definitions/schema";
import { SCHEMA_VERSION } from "../src/types";
import type { SpaceDefinition } from "../src/types";

const doc = (members: unknown[]): unknown => ({
  schemaVersion: 3,
  spaces: [{ id: "s", name: "S", icon: "box", color: "#808080", members }],
  settings: {},
});

const space = (members: SpaceDefinition["members"]): SpaceDefinition => ({
  id: "s", name: "S", icon: "box", color: "#808080", members,
});

describe("the property member's stored shape", () => {
  it("round-trips both shapes", () => {
    const r = validateDefinitions(doc([
      { kind: "property", key: "status", value: "Active" },
      { kind: "property", key: "due" },
    ]));
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.spaces[0].members).toEqual([
      { kind: "property", key: "status", value: "Active" },
      { kind: "property", key: "due" },
    ]);
  });

  it("keeps a key spelled with surrounding whitespace exactly", () => {
    // Keys match exactly, so rewriting one on the way in produces a member
    // that matches a different property or nothing at all.
    const r = validateDefinitions(doc([{ kind: "property", key: " status " }]));
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.spaces[0].members[0]).toEqual({ kind: "property", key: " status " });
  });

  it("rejects the document for a key that is empty after trimming", () => {
    expect(validateDefinitions(doc([{ kind: "property", key: "   " }])).ok).toBe(false);
    expect(validateDefinitions(doc([{ kind: "property", key: "" }])).ok).toBe(false);
  });

  it("rejects an explicit null value", () => {
    // Absent means "has the key". `null` is not a string and is not that.
    expect(validateDefinitions(doc([{ kind: "property", key: "a", value: null }])).ok).toBe(false);
  });

  it("keeps all four colliding members, which a concatenated key would not", () => {
    const r = validateDefinitions(doc([
      { kind: "property", key: "a=b" },
      { kind: "property", key: "a", value: "b" },
      { kind: "property", key: "a=b", value: "c" },
      { kind: "property", key: "a", value: "b=c" },
    ]));
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.spaces[0].members).toHaveLength(4);
  });

  it("collapses two members equal under value normalization", () => {
    const r = validateDefinitions(doc([
      { kind: "property", key: "status", value: "Active" },
      { kind: "property", key: "status", value: " active " },
    ]));
    expect(r.ok && r.value.spaces[0].members).toEqual([
      { kind: "property", key: "status", value: "Active" },
    ]);
  });

  it("keeps existence and equality-to-empty apart", () => {
    const r = validateDefinitions(doc([
      { kind: "property", key: "a" },
      { kind: "property", key: "a", value: "" },
    ]));
    expect(r.ok && r.value.spaces[0].members).toHaveLength(2);
  });
});

describe("the schema version", () => {
  it("is 3, so a document written as 3 can be read back", () => {
    expect(SCHEMA_VERSION).toBe(3);
  });

  it("writes 3 only when a property member is present", () => {
    expect(schemaVersionFor([space([{ kind: "property", key: "a" }])])).toBe(3);
    expect(schemaVersionFor([space([{ kind: "tag", tag: "t" }])])).toBe(2);
    expect(schemaVersionFor([space([{ kind: "file", path: "a.md" }])])).toBe(1);
  });

  it("still reads documents at 1 and 2", () => {
    for (const v of [1, 2]) {
      const r = validateDefinitions({ schemaVersion: v, spaces: [], settings: {} });
      expect(r.ok, `version ${v}`).toBe(true);
    }
  });
});

describe("memberIdentity", () => {
  it("separates the four colliding members", () => {
    const ids = [
      memberIdentity({ kind: "property", key: "a=b" }),
      memberIdentity({ kind: "property", key: "a", value: "b" }),
      memberIdentity({ kind: "property", key: "a=b", value: "c" }),
      memberIdentity({ kind: "property", key: "a", value: "b=c" }),
    ];
    expect(new Set(ids).size).toBe(4);
  });

  it("is stable across value spellings that match", () => {
    expect(memberIdentity({ kind: "property", key: "a", value: "Active" })).toBe(
      memberIdentity({ kind: "property", key: "a", value: " active " })
    );
  });
});
