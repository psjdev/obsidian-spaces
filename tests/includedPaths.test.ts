import { describe, expect, it } from "vitest";
import { createTreeVaultIndex } from "../src/visibility/VaultIndex";
import { compileIgnore } from "../src/visibility/glob";
import { includedPaths } from "../src/visibility/includedPaths";
import type { MemberKind } from "../src/types";

const vaultOf = (entries: [string, MemberKind][]) =>
  createTreeVaultIndex(new Map(entries));

const VAULT = vaultOf([
  ["Projects", "folder"],
  ["Projects/Roadmap.md", "file"],
  ["Projects/Secret.md", "file"],
  ["Projects/Empty", "folder"],
  ["Top.md", "file"],
]);

describe("includedPaths", () => {
  it("expands a folder seed to its descendants", () => {
    const r = includedPaths(VAULT, ["Projects"], compileIgnore([]), new Set());
    expect([...r.included].sort()).toEqual([
      "Projects",
      "Projects/Empty",
      "Projects/Roadmap.md",
      "Projects/Secret.md",
    ]);
  });

  it("keeps a file seed without expanding anything", () => {
    const r = includedPaths(VAULT, ["Top.md"], compileIgnore([]), new Set());
    expect([...r.included]).toEqual(["Top.md"]);
  });

  it("applies ignore to inherited descendants but never to seeds", () => {
    const ignore = compileIgnore(["**/Secret.md"]);
    const r = includedPaths(VAULT, ["Projects"], ignore, new Set());
    expect(r.included.has("Projects/Secret.md")).toBe(false);
    const seeded = includedPaths(VAULT, ["Projects/Secret.md"], ignore, new Set());
    expect(seeded.included.has("Projects/Secret.md")).toBe(true);
  });

  it("applies the exclusion set to inherited descendants", () => {
    const r = includedPaths(VAULT, ["Projects"], compileIgnore([]), new Set(["projects/roadmap.md"]));
    expect(r.included.has("Projects/Roadmap.md")).toBe(false);
  });

  it("spares a folder the user left empty, prunes one emptied by filtering", () => {
    const ignore = compileIgnore(["**/*.md"]);
    const r = includedPaths(VAULT, ["Projects"], ignore, new Set());
    // Empty in the vault, so spared.
    expect(r.included.has("Projects/Empty")).toBe(true);
    // Emptied by the ignore rule, so pruned... except it is the seed itself.
    expect(r.included.has("Projects")).toBe(true);
  });

  it("re-syncs inherited when pruning removed a folder from included", () => {
    const ignore = compileIgnore(["Projects/Nested/**"]);
    const nested = vaultOf([
      ["Projects", "folder"],
      ["Projects/Nested", "folder"],
      ["Projects/Nested/a.md", "file"],
    ]);
    const r = includedPaths(nested, ["Projects"], ignore, new Set());
    for (const p of r.inherited) expect(r.included.has(p)).toBe(true);
  });
});
