// @vitest-environment jsdom
/**
 * `removeMembers`.
 *
 * The finding: `actions/` is not a write boundary. Of 23 `defs.mutate` call
 * sites, 10 are in `src/ui/`, and member removal is implemented TWICE —
 * `actions/membership.ts`'s `removeAll` and `SettingsTab.ts`'s per-row Remove
 * button, with different code that agrees today by coincidence rather than by
 * construction. The named failure is a rule added to one of them: "removing a
 * member must also drop its entry from that space's `orders` map" lands on
 * `removeAll`, the suite goes green, and Settings → Spaces → Remove keeps
 * leaving the orphan behind.
 *
 * So the tests that matter are not only "the helper works" but "the call site
 * that used to hold its own copy now goes THROUGH the helper" — otherwise the
 * helper is a third implementation rather than a convergence.
 *
 * jsdom because `actions/membership.ts` constructs a `Notice`.
 */
import { describe, expect, it, vi } from "vitest";
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

const RESEARCH = {
  id: "research",
  name: "Research",
  icon: "microscope",
  color: "#4ecdc4",
};

function membersOf(defs: DefinitionStore, id: string): string[] {
  return (defs.get().spaces.find((s) => s.id === id)?.members ?? []).flatMap((m) =>
    m.kind === "tag" ? [] : [m.path]
  );
}

describe("removeMembers", () => {
  it("removes exactly the named paths from exactly the named space", async () => {
    const defs = await storeWith((d) => {
      d.spaces = [
        {
          ...RESEARCH,
          members: [
            { path: "Papers/A.md", kind: "file" },
            { path: "Papers/B.md", kind: "file" },
            { path: "Papers/C.md", kind: "file" },
          ],
        },
        { ...RESEARCH, id: "lab", name: "Lab", members: [{ path: "Papers/A.md", kind: "file" }] },
      ];
    });
    await removeMembers(defs, "research", ["Papers/A.md", "Papers/C.md"]);
    expect(membersOf(defs, "research")).toEqual(["Papers/B.md"]);
    // Membership is per space (the central model): the same path in
    // another space is a different membership and must survive.
    expect(membersOf(defs, "lab")).toEqual(["Papers/A.md"]);
  });

  it("removes a folder member without touching the paths under it", async () => {
    // A folder member confers membership on its contents by inheritance,
    // not by stored entries — so there is nothing under it to remove, and a
    // prefix sweep here would delete exact members the user added separately.
    const defs = await storeWith((d) => {
      d.spaces = [
        {
          ...RESEARCH,
          members: [
            { path: "Papers", kind: "folder" },
            { path: "Papers/Pinned.md", kind: "file" },
          ],
        },
      ];
    });
    await removeMembers(defs, "research", ["Papers"]);
    expect(membersOf(defs, "research")).toEqual(["Papers/Pinned.md"]);
  });

  it("leaves tag members untouched", async () => {
    const defs = await storeWith((d) => {
      d.spaces = [
        {
          ...RESEARCH,
          members: [
            { path: "Papers/A.md", kind: "file" },
            { kind: "tag", tag: "project" },
          ],
        },
      ];
    });
    await removeMembers(defs, "research", ["Papers/A.md"]);
    expect(defs.get().spaces[0].members).toEqual([{ kind: "tag", tag: "project" }]);
  });

  it("excludes rather than touching members, for a path that is not a member", async () => {
    // Since Task 8, a path nothing stored names is not a no-op: it becomes
    // an exclusion (see `tests/removeWritesExclusion.test.ts` for the full
    // behaviour). This is still the right file for "members are untouched",
    // it just cannot also claim nothing happened.
    const defs = await storeWith((d) => {
      d.spaces = [{ ...RESEARCH, members: [{ path: "Papers/A.md", kind: "file" }] }];
    });
    await removeMembers(defs, "research", ["Papers/Ghost.md"]);
    expect(membersOf(defs, "research")).toEqual(["Papers/A.md"]);
    expect(defs.get().spaces[0].exclude).toEqual(["Papers/Ghost.md"]);
  });

  it("is a no-op for a space id that does not exist", async () => {
    const defs = await storeWith((d) => {
      d.spaces = [{ ...RESEARCH, members: [{ path: "Papers/A.md", kind: "file" }] }];
    });
    await expect(removeMembers(defs, "ghost", ["Papers/A.md"])).resolves.toBeUndefined();
    expect(membersOf(defs, "research")).toEqual(["Papers/A.md"]);
  });

  it("rejects rather than reporting success when the store refuses to write", async () => {
    // Makes `mutate` throw while a load failure is sticky. Both call
    // sites show a Notice on that, so the helper must not swallow it.
    const defs = new DefinitionStore({
      read: async () => undefined, // unparseable — writes stay refused
      write: async () => undefined,
    });
    await defs.load();
    await expect(removeMembers(defs, "research", ["Papers/A.md"])).rejects.toThrow(
      /not saving/
    );
  });
});


/**
 * The convergence itself. `vi.mock` with `importOriginal` keeps the real
 * behaviour and only records the call, so this asserts delegation without
 * weakening what the removal does.
 */
vi.mock("../src/actions/definitionWrites", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/actions/definitionWrites")>();
  return { ...actual, removeMembers: vi.fn(actual.removeMembers) };
});

describe("the membership menu's Remove routes through removeMembers", () => {
  it("calls the shared helper instead of filtering members itself", async () => {
    const { decorate } = await import("../src/actions/membership");
    const defs = await storeWith((d) => {
      d.spaces = [
        {
          ...RESEARCH,
          members: [
            { path: "Papers/A.md", kind: "file" },
            { path: "Papers/B.md", kind: "file" },
          ],
        },
      ];
    });
    const space = defs.get().spaces[0];
    const controller = {
      activeSpace: () => space,
      currentSnapshot: () => ({
        decisionFor: () => ({
          visible: true,
          reason: "exact-member",
          canRemoveMembership: true,
        }),
      }),
      dismissRevealed: () => undefined,
    };

    // The smallest Menu that `decorate` uses: it calls `addItem` with a
    // builder and never reads the item back.
    const clicks: (() => void)[] = [];
    const menu = {
      addItem(build: (item: Record<string, unknown>) => unknown) {
        const item: Record<string, unknown> = {};
        for (const name of ["setTitle", "setIcon", "setDisabled"]) {
          item[name] = () => item;
        }
        item.onClick = (cb: () => void) => {
          clicks.push(cb);
          return item;
        };
        build(item);
      },
    };

    const files = [{ path: "Papers/A.md" }, { path: "Papers/B.md" }];
    decorate(
      menu as unknown as Parameters<typeof decorate>[0],
      { defs, controller } as unknown as Parameters<typeof decorate>[1],
      files as unknown as Parameters<typeof decorate>[2]
    );
    expect(clicks).toHaveLength(1); // "Remove from Research"
    clicks[0]();
    // `removeAll` is fire-and-forget (`void`), so let its microtasks drain.
    await vi.waitFor(() => expect(membersOf(defs, "research")).toEqual([]));

    expect(removeMembers).toHaveBeenCalledWith(defs, "research", [
      "Papers/A.md",
      "Papers/B.md",
    ]);
  });
});
