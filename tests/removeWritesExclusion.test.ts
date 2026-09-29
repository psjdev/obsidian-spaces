// @vitest-environment jsdom
/**
 * `removeMembers` widened: a path no stored member names — because a tag
 * member matched it, or a member folder covers it — cannot be taken out by
 * filtering `members`, since nothing there names it. The only way to say
 * "not this one" is an `exclude` entry, and the visibility engine already
 * honours `exclude` (see `resolveMembers`); this file pins the write side.
 *
 * The exact-preference logic in `removeMembers` predates this task and is
 * unchanged; the double-casing coverage for it lives in
 * `tests/membershipCase.test.ts`, not here. This file is only the new
 * branch: what happens when nothing matched.
 *
 * Most cases follow the `storeWith` fixture from `tests/definitionWrites.test.ts`
 * (a real `DefinitionStore` over an in-memory fake disk), since that is the
 * existing pattern for this function. One case (below, `rawStore`) cannot use
 * it: `DefinitionStore.mutate` runs `validateDefinitions`, and `schema.ts`
 * normalizes an empty `exclude: []` to absent unconditionally, so a
 * real-store fixture cannot distinguish "`removeMembers` wrote nothing" from
 * "`removeMembers` wrote `exclude: []` and the schema silently repaired it".
 * That case uses a minimal fake — close to the brief's original hand-rolled
 * one — that hands back the draft `removeMembers` mutated, unvalidated.
 *
 * jsdom is inherited from `definitionWrites.test.ts`'s setup; not required by
 * anything here, but keeping it avoids a second environment split in the
 * same suite for no reason.
 */
import { describe, expect, it } from "vitest";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { removeMembers } from "../src/actions/definitionWrites";
import type { SpacesDefinitions } from "../src/types";

async function storeWith(
  patch: (d: SpacesDefinitions) => void
): Promise<DefinitionStore> {
  let disk: unknown = null;
  const defs = new DefinitionStore({
    read: async () => disk,
    write: async (data) => {
      disk = JSON.parse(JSON.stringify(data)) as unknown;
    },
  });
  await defs.load();
  await defs.mutate(patch);
  return defs;
}

const SPACE = {
  id: "s",
  name: "S",
  icon: "box",
  color: "#808080",
};

function excludeOf(defs: DefinitionStore, id: string): string[] | undefined {
  return defs.get().spaces.find((s) => s.id === id)?.exclude;
}

function membersOf(defs: DefinitionStore, id: string) {
  return defs.get().spaces.find((s) => s.id === id)?.members;
}

/**
 * A minimal fake, close to the brief's original hand-rolled one: no
 * `validateDefinitions`, so the draft `removeMembers` mutates is handed back
 * exactly as written, before schema normalization gets a chance to repair
 * `exclude: []` down to absent. See the file header for why `storeWith`
 * cannot be used for this one case.
 */
function rawStore(initial: SpacesDefinitions) {
  let d = initial;
  return {
    get: () => d,
    async mutate(fn: (draft: SpacesDefinitions) => void) {
      const draft = structuredClone(d);
      fn(draft);
      d = draft;
    },
  };
}

describe("removeMembers writes an exclusion when nothing stored names the path", () => {
  it("removes a stored member, as before", async () => {
    const defs = await storeWith((d) => {
      d.spaces = [{ ...SPACE, members: [{ kind: "file", path: "a.md" }] }];
    });
    await removeMembers(defs, "s", ["a.md"]);
    expect(membersOf(defs, "s")).toEqual([]);
    expect(excludeOf(defs, "s")).toBeUndefined();
  });

  it("excludes a path the space does not hold as a member", async () => {
    const defs = await storeWith((d) => {
      d.spaces = [{ ...SPACE, members: [{ kind: "tag", tag: "project" }] }];
    });
    await removeMembers(defs, "s", ["Work/a.md"]);
    expect(excludeOf(defs, "s")).toEqual(["Work/a.md"]);
    expect(membersOf(defs, "s")).toHaveLength(1);
  });

  it("excludes a note inherited from a member folder", async () => {
    const defs = await storeWith((d) => {
      d.spaces = [{ ...SPACE, members: [{ kind: "folder", path: "Work" }] }];
    });
    await removeMembers(defs, "s", ["Work/a.md"]);
    expect(excludeOf(defs, "s")).toEqual(["Work/a.md"]);
    expect(membersOf(defs, "s")).toHaveLength(1);
  });

  it("does not add the same exclusion twice", async () => {
    const defs = await storeWith((d) => {
      d.spaces = [
        {
          ...SPACE,
          members: [{ kind: "tag", tag: "project" }],
          exclude: ["Work/a.md"],
        },
      ];
    });
    await removeMembers(defs, "s", ["Work/a.md"]);
    expect(excludeOf(defs, "s")).toEqual(["Work/a.md"]);
  });

  it("keeps an exclusion sticky across a second removal of the same path", async () => {
    // Repeats the earlier "does not add twice" case DRIVEN THROUGH
    // removeMembers's own prior write, rather than a fixture that starts
    // with `exclude` already populated by hand, so the write path that
    // produces the second call's starting state is exercised too — not only
    // the duplicate check, but that `removeMembers`'s own write is read back
    // correctly as "already excluded" on the next call. This does not pin
    // the sticky-exclusion hazard `tests/tagResolution.test.ts` names (a
    // future "Add back to space" write clearing an exclusion on re-tag);
    // that hazard needs that later write path's own test.
    const defs = await storeWith((d) => {
      d.spaces = [{ ...SPACE, members: [{ kind: "tag", tag: "project" }] }];
    });
    await removeMembers(defs, "s", ["Work/a.md"]);
    expect(excludeOf(defs, "s")).toEqual(["Work/a.md"]);
    await removeMembers(defs, "s", ["Work/a.md"]);
    expect(excludeOf(defs, "s")).toEqual(["Work/a.md"]);
    expect(membersOf(defs, "s")).toHaveLength(1);
  });

  it("prefers removing the member when the space holds one", async () => {
    const defs = await storeWith((d) => {
      d.spaces = [
        {
          ...SPACE,
          members: [
            { kind: "tag", tag: "project" },
            { kind: "file", path: "Work/a.md" },
          ],
        },
      ];
    });
    await removeMembers(defs, "s", ["Work/a.md"]);
    expect(membersOf(defs, "s")).toEqual([{ kind: "tag", tag: "project" }]);
    expect(excludeOf(defs, "s")).toBeUndefined();
  });

  it("writes no exclude key at all when only a stored member was removed, before any schema normalization", async () => {
    // `storeWith`'s real `DefinitionStore` cannot discriminate here: whether
    // this test reads back `exclude: undefined` or asserts against a draft
    // where `removeMembers` wrote `exclude: []`, `validateDefinitions`
    // normalizes the empty array away before either check could see it. This
    // reads the draft `removeMembers` produced directly, unvalidated, so it
    // actually pins the `if (exclude.size > 0)` guard in the source.
    const s = rawStore({
      schemaVersion: 1,
      settings: { globalIgnore: [] },
      spaces: [{ ...SPACE, members: [{ kind: "file", path: "a.md" }] }],
    } as unknown as SpacesDefinitions);
    await removeMembers(s as never, "s", ["a.md"]);
    const space = s.get().spaces[0] as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(space, "exclude")).toBe(false);
  });
});
