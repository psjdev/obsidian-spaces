import { describe, expect, it } from "vitest";
import { createTreeVaultIndex } from "../src/visibility/VaultIndex";
import { compileIgnore } from "../src/visibility/glob";
import { includedPaths } from "../src/visibility/includedPaths";
import { buildPreview } from "../src/ui/previewSeam";
import type { MemberEntry, MemberKind } from "../src/types";

const vaultOf = (e: [string, MemberKind][]) => createTreeVaultIndex(new Map(e));

const tagIndex = (hits: Record<string, string[]>) => ({
  pathsMatching: (t: string): readonly string[] => hits[t] ?? [],
});

describe("the create panel's preview runs the engine's own resolution", () => {
  it("counts notes under a folder member", () => {
    const vault = vaultOf([
      ["Projects", "folder"],
      ["Projects/a.md", "file"],
      ["Projects/b.md", "file"],
    ]);
    const p = buildPreview(vault, compileIgnore([]), tagIndex({}));
    expect(p([{ kind: "folder", path: "Projects" }]).notes).toBe(2);
  });

  it("honours globalIgnore, which the old preview did not", () => {
    const vault = vaultOf([
      ["Projects", "folder"],
      ["Projects/a.md", "file"],
      ["Projects/secret.md", "file"],
    ]);
    const p = buildPreview(vault, compileIgnore(["**/secret.md"]), tagIndex({}));
    expect(p([{ kind: "folder", path: "Projects" }]).notes).toBe(1);
  });

  it("does not treat Docs as covering docs, which the old preview did", () => {
    const vault = vaultOf([
      ["Docs", "folder"],
      ["Docs/a.md", "file"],
      ["docs", "folder"],
      ["docs/b.md", "file"],
    ]);
    const p = buildPreview(vault, compileIgnore([]), tagIndex({}));
    expect(p([{ kind: "folder", path: "Docs" }]).notes).toBe(1);
  });

  it("counts a note carried by two members once", () => {
    const vault = vaultOf([
      ["Projects", "folder"],
      ["Projects/a.md", "file"],
    ]);
    const p = buildPreview(vault, compileIgnore([]), tagIndex({ work: ["Projects/a.md"] }));
    const members: MemberEntry[] = [
      { kind: "folder", path: "Projects" },
      { kind: "tag", tag: "work" },
    ];
    expect(p(members).notes).toBe(1);
  });

  it("promises nothing for a folder whose every note is ignored", () => {
    const vault = vaultOf([
      ["Archive", "folder"],
      ["Archive/a.md", "file"],
    ]);
    const p = buildPreview(vault, compileIgnore(["Archive/**"]), tagIndex({}));
    expect(p([{ kind: "folder", path: "Archive" }]).notes).toBe(0);
  });

  it("agrees with includedPaths exactly", () => {
    const vault = vaultOf([
      ["Projects", "folder"],
      ["Projects/a.md", "file"],
      ["Projects/Deep", "folder"],
      ["Projects/Deep/c.md", "file"],
      ["Top.md", "file"],
    ]);
    const ignore = compileIgnore(["**/c.md"]);
    const p = buildPreview(vault, ignore, tagIndex({}));
    const got = p([{ kind: "folder", path: "Projects" }, { kind: "file", path: "Top.md" }]);
    const want = includedPaths(vault, ["Projects", "Top.md"], ignore, new Set()).included;
    expect([...got.paths].sort()).toEqual([...want].sort());
  });
});
