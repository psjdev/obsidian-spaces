import { describe, expect, it } from "vitest";
import { emptyForm, toggleItem } from "../src/ui/createSpaceForm";
import type { MemberEntry } from "../src/types";

const pick = (entries: MemberEntry[]) =>
  entries.reduce((s, e) => toggleItem(s, e), emptyForm("#000"));

const key = (m: MemberEntry) => (m.kind === "tag" ? `#${m.tag}` : `${m.kind}:${m.path}`);
const sortedKeys = (items: readonly MemberEntry[]) => items.map(key).sort();

/** Every ordering of a small array. */
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([xs[i], ...p]);
  }
  return out;
}

describe("the picked member list is minimal", () => {
  it("a folder absorbs a note picked under it", () => {
    const s = pick([
      { kind: "file", path: "Projects/a.md" },
      { kind: "folder", path: "Projects" },
    ]);
    expect(sortedKeys(s.items)).toEqual(["folder:Projects"]);
  });

  it("a folder absorbs a nested folder picked under it", () => {
    const s = pick([
      { kind: "folder", path: "Projects/Deep" },
      { kind: "folder", path: "Projects" },
    ]);
    expect(sortedKeys(s.items)).toEqual(["folder:Projects"]);
  });

  it("a note already covered by a picked folder adds nothing", () => {
    const s = pick([
      { kind: "folder", path: "Projects" },
      { kind: "file", path: "Projects/a.md" },
    ]);
    expect(sortedKeys(s.items)).toEqual(["folder:Projects"]);
  });

  it("a parent tag absorbs a nested tag", () => {
    const s = pick([{ kind: "tag", tag: "project/console" }, { kind: "tag", tag: "project" }]);
    expect(sortedKeys(s.items)).toEqual(["#project"]);
  });

  it("a nested tag under a picked parent adds nothing", () => {
    const s = pick([{ kind: "tag", tag: "project" }, { kind: "tag", tag: "project/console" }]);
    expect(sortedKeys(s.items)).toEqual(["#project"]);
  });

  it("order never changes the result", () => {
    const entries: MemberEntry[] = [
      { kind: "folder", path: "Projects" },
      { kind: "file", path: "Projects/a.md" },
      { kind: "folder", path: "Projects/Deep" },
      { kind: "tag", tag: "project" },
      { kind: "tag", tag: "project/console" },
      { kind: "file", path: "Top.md" },
    ];
    const results = permutations(entries).map((p) => JSON.stringify(sortedKeys(pick(p).items)));
    expect(new Set(results).size).toBe(1);
  });

  it("a second click on a picked member still removes it", () => {
    let s = toggleItem(emptyForm("#000"), { kind: "folder", path: "Projects" });
    s = toggleItem(s, { kind: "folder", path: "Projects" });
    expect(s.items).toEqual([]);
  });

  it("unrelated siblings all survive", () => {
    const s = pick([
      { kind: "folder", path: "Projects" },
      { kind: "folder", path: "Archive" },
      { kind: "file", path: "Top.md" },
    ]);
    expect(sortedKeys(s.items)).toEqual(["file:Top.md", "folder:Archive", "folder:Projects"]);
  });

  it("Projects does not absorb Projects Archive", () => {
    const s = pick([
      { kind: "folder", path: "Projects Archive" },
      { kind: "folder", path: "Projects" },
    ]);
    expect(sortedKeys(s.items)).toEqual(["folder:Projects", "folder:Projects Archive"]);
  });
});
