/**
 * What `resolveMembers` is allowed to do PER MATCHED PATH.
 *
 * A tag member expands to every note carrying the tag, so anything done once
 * per matched path is done thousands of times per recompute. Two things were:
 * `canonicalPath` ran twice on every match — once for the exclusion test and
 * again inside `add` to key the de-duplication set — and an exclusion `Set`
 * was built and queried even for a space with no `exclude` at all, which is
 * every space until someone removes a note from one.
 *
 * Measured over 3,785 matched paths: 7.59 ms as written, 2.51 ms with one
 * `canonicalPath` call and a fast path for the no-exclusions case. A 67 % cut,
 * and the best ratio the review panel found anywhere.
 *
 * The behaviour must not move, which is what the rest of the suite
 * (`tagResolution.test.ts`) is for. This file pins the cost, because a cost is
 * exactly what an ordinary behavioural test cannot see: the old code and the
 * new one return the same list.
 */
import { describe, expect, it, vi } from "vitest";

// Spied rather than replaced: the real canonicalisation is what the
// de-duplication depends on, so a fake here would pass while the behaviour
// broke. `importActual` keeps the implementation and counts the calls.
vi.mock("../src/visibility/glob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/visibility/glob")>();
  return { ...actual, canonicalPath: vi.fn(actual.canonicalPath) };
});

import { resolveMembers } from "../src/controller/resolveMembers";
import { tagIndexOf } from "./helpers/tagIndex";
import { canonicalPath } from "../src/visibility/glob";
import type { MemberEntry, SpaceDefinition } from "../src/types";

const spy = vi.mocked(canonicalPath);

const tags = tagIndexOf(
  new Map([
    ["Work/a.md", ["project"]],
    ["Work/b.md", ["project"]],
    ["Work/c.md", ["project"]],
    ["Loose.md", ["person"]],
  ])
);

function space(members: MemberEntry[], exclude?: string[]): SpaceDefinition {
  return {
    id: "s",
    name: "S",
    icon: "box",
    color: "#808080",
    members,
    ...(exclude === undefined ? {} : { exclude }),
  };
}

const TAGGED: MemberEntry[] = [{ kind: "tag", tag: "project" }];

describe("resolveMembers, per matched path", () => {
  it("canonicalises a matched path once, not twice", () => {
    spy.mockClear();
    const out = resolveMembers(space(TAGGED), tags);
    expect(out).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("canonicalises it once when the space does have exclusions", () => {
    spy.mockClear();
    // Three matches plus the one stored exclusion the Set is built from.
    const out = resolveMembers(space(TAGGED, ["Work/b.md"]), tags);
    expect(out.map((m) => m.path)).toEqual(["Work/a.md", "Work/c.md"]);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("does not canonicalise an empty exclusion list into a Set to query", () => {
    // `exclude: []` is stored by the schema's own normalisation and reaches
    // here as often as an absent one, so both must take the fast path.
    spy.mockClear();
    resolveMembers(space(TAGGED, []), tags);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("resolveMembers, unchanged behaviour", () => {
  it("still drops an excluded match spelled in another case", () => {
    const out = resolveMembers(space(TAGGED, ["work/B.MD"]), tags);
    expect(out.map((m) => m.path)).toEqual(["Work/a.md", "Work/c.md"]);
  });

  it("still keeps a hand-added member its own space excludes", () => {
    // A hand-added member is a seed and survives its own exclusion; that is
    // the intended precedence and the fast path must not change it.
    const out = resolveMembers(
      space([{ kind: "file", path: "Loose.md" }], ["Loose.md"]),
      tags
    );
    expect(out).toEqual([{ kind: "file", path: "Loose.md" }]);
  });

  it("still seeds one member when a tag match and a hand-added file differ only in case", () => {
    const out = resolveMembers(
      space([...TAGGED, { kind: "file", path: "work/a.md" }]),
      tags
    );
    expect(out).toHaveLength(3);
  });

  it("still returns a space with no tag members unchanged", () => {
    const s = space([{ kind: "folder", path: "Work" }]);
    expect(resolveMembers(s, tags)).toEqual([{ kind: "folder", path: "Work" }]);
  });
});
