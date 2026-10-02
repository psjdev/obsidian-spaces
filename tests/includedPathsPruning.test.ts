import { describe, expect, it } from "vitest";
import { createTreeVaultIndex, type VaultIndex } from "../src/visibility/VaultIndex";
import { compileIgnore, canonicalPath, type IgnoreMatcher } from "../src/visibility/glob";
import { includedPaths } from "../src/visibility/includedPaths";
import type { MemberKind } from "../src/types";

/**
 * Step 3b as it was before it was made fast: a fixpoint that asks every
 * included folder whether any descendant survived.
 *
 * Kept here, and only here, as the oracle. It is obviously correct and too
 * slow to ship; the implementation has to agree with it on every shape.
 */
function referencePrune(vault: VaultIndex, included: Set<string>, seeds: ReadonlySet<string>): Set<string> {
  const out = new Set(included);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of [...out]) {
      if (seeds.has(p)) continue;
      if (vault.kindOf(p) !== "folder") continue;
      if (vault.childrenOf(p).length === 0) continue;
      if (!vault.descendantsOf(p).some((d) => out.has(d))) {
        out.delete(p);
        changed = true;
      }
    }
  }
  return out;
}

/** Steps 1 and 2 only, so the oracle can be applied to the same input. */
function expand(
  vault: VaultIndex,
  seeds: ReadonlySet<string>,
  ignore: IgnoreMatcher,
  excluded: ReadonlySet<string>
): Set<string> {
  const out = new Set<string>(seeds);
  for (const s of seeds) {
    if (vault.kindOf(s) !== "folder") continue;
    for (const d of vault.descendantsOf(s)) {
      if (ignore.matches(d)) continue;
      if (excluded.has(canonicalPath(d))) continue;
      out.add(d);
    }
  }
  return out;
}

/** A deterministic tree: `branching ** depth` leaf folders, `notesPer` notes each. */
function synth(branching: number, depth: number, notesPer: number): Map<string, MemberKind> {
  const kinds = new Map<string, MemberKind>();
  const rec = (prefix: string, level: number): void => {
    for (let i = 0; i < branching; i++) {
      const p = prefix === "" ? `d${level}_${i}` : `${prefix}/d${level}_${i}`;
      kinds.set(p, "folder");
      if (level === depth - 1) for (let n = 0; n < notesPer; n++) kinds.set(`${p}/n${n}.md`, "file");
      else rec(p, level + 1);
    }
  };
  rec("", 0);
  kinds.set("EmptyOnPurpose", "folder");
  return kinds;
}

const SHAPES: [string, number, number, number][] = [
  ["wide and shallow", 12, 2, 6],
  ["square", 4, 3, 3],
  ["narrow and deep", 2, 6, 2],
  ["one note per leaf", 5, 3, 1],
];

const IGNORES = [[], ["**/*.md"], ["**/n0.md"], ["d0_0/**"]];

describe("step 3b agrees with the fixpoint oracle", () => {
  for (const [name, b, d, n] of SHAPES) {
    for (const patterns of IGNORES) {
      it(`${name}, ignore ${JSON.stringify(patterns)}`, () => {
        const kinds = synth(b, d, n);
        const vault = createTreeVaultIndex(kinds);
        const ignore = compileIgnore(patterns);
        const roots = [...kinds.keys()].filter((p) => !p.includes("/") && kinds.get(p) === "folder");
        const seeds = new Set(roots);
        const expected = referencePrune(vault, expand(vault, seeds, ignore, new Set()), seeds);
        const actual = includedPaths(vault, roots, ignore, new Set()).included;
        expect([...actual].sort()).toEqual([...expected].sort());
      });
    }
  }

  it("spares a folder the user left empty", () => {
    const kinds = synth(3, 2, 2);
    const vault = createTreeVaultIndex(kinds);
    const roots = [...kinds.keys()].filter((p) => !p.includes("/") && kinds.get(p) === "folder");
    const r = includedPaths(vault, roots, compileIgnore(["**/*.md"]), new Set());
    expect(r.included.has("EmptyOnPurpose")).toBe(true);
  });

  it("removes nothing at all when no pattern matched and nothing is excluded", () => {
    const kinds = synth(4, 3, 2);
    const vault = createTreeVaultIndex(kinds);
    const roots = [...kinds.keys()].filter((p) => !p.includes("/") && kinds.get(p) === "folder");
    const before = expand(vault, new Set(roots), compileIgnore([]), new Set());
    const after = includedPaths(vault, roots, compileIgnore([]), new Set()).included;
    expect(after.size).toBe(before.size);
  });
});
