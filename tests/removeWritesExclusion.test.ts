// @vitest-environment jsdom
/**
 * `removeMembers` widened: a path no stored member names — because a tag
 * member matched it, or a member folder covers it — cannot be taken out by
 * filtering `members`, since nothing there names it. The only way to say
 * "not this one" is an `exclude` entry, and the visibility engine already
 * honours `exclude` (see `resolveMembers`); this file pins the write side.
 *
 * The exact-preference logic in `removeMembers` predates this task and is
 * unchanged; `tests/definitionWrites.test.ts` already covers it. This file
 * is only the new branch: what happens when nothing matched.
 *
 * Follows the `storeWith` fixture from `tests/definitionWrites.test.ts` (a
 * real `DefinitionStore` over an in-memory fake disk) rather than a
 * hand-rolled store, so the schema's absent-not-empty rule for `exclude` is
 * enforced by `validateDefinitions` on every mutate, not merely asserted by
 * the test. jsdom is inherited from that file's setup; not required by
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
    // The hazard this pins: a reviewer re-running "remove" on a path already
    // excluded (e.g. a stale menu click, or a second note landing on the
    // same path after a rename) must not grow a duplicate entry, and the
    // exclusion set here is what `resolveMembers`'s tag re-expansion reads
    // as sticky — see the comment in `tests/tagResolution.test.ts` pointing
    // at this file. Repeats the earlier "does not add twice" case DRIVEN
    // THROUGH removeMembers's own prior write, rather than a fixture that
    // starts with `exclude` already populated by hand, so the write path
    // that produces the second call's starting state is exercised too.
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
});
