// @vitest-environment jsdom
/**
 * The restore gate: what the modal shows, what it stages, and what it writes.
 *
 * Three things are pinned here that nothing else can pin:
 *
 *  - **One write, not two.** Every staged fix AND the cleared `archived` flag
 *    go through a single `mutate`. Two writes leave a half-restored space
 *    reachable if anything interrupts between them, which is the whole reason
 *    the gate exists.
 *  - **Staged, not live.** Cancel writes nothing at all: no re-pointed member,
 *    no removed member, still archived.
 *  - **A re-pointed member keeps its position**, which is where this departs
 *    from `repairOrderMap` (see `applyRestoreFixes`'s docstring).
 *
 * `RestoreSpaceModal` itself is a `Modal` subclass, and the stub declines to
 * model presentation, so the DECISIONS live in `RestoreGate` and the pure
 * functions beside it, and are tested here directly. Only the
 * button-to-method wiring inside `onOpen` is out of reach, exactly as
 * `ConfirmModal`'s is.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFolderPickerPopover } from "../src/ui/FolderPickerPopover";
import type { VaultSource } from "../src/ui/createSpaceForm";
import {
  RestoreGate,
  actionsFor,
  applyRestoreFixes,
  checkedPaths,
  commitRestore,
  pointProblem,
  restoreFooter,
  restoreLede,
  restoreRows,
  restoreTitle,
  rowProblem,
  stagedText,
  type RestoreRow,
  type StagedFix,
} from "../src/ui/RestoreSpaceModal";
import { restoreProblems } from "../src/ui/restoreCheck";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import {
  SCHEMA_VERSION,
  type MemberEntry,
  type SpaceDefinition,
  type SpacesDefinitions,
} from "../src/types";

function space(extra: Partial<SpaceDefinition> = {}, members: MemberEntry[] = []): SpaceDefinition {
  return { id: "s", name: "Spring", icon: "box", color: "#aabbcc", members, ...extra };
}

const has =
  (...paths: string[]) =>
  (p: string): boolean =>
    paths.includes(p);

const memberRow = (path: string, memberKind: "file" | "folder" = "file"): RestoreRow => ({
  kind: "member",
  path,
  memberKind,
});
const rootRow = (path: string): RestoreRow => ({ kind: "root", path, memberKind: "folder" });

/* ------------------------------------------------------------------ *
 * What the gate shows
 * ------------------------------------------------------------------ */

describe("which problems the gate shows", () => {
  it("shows one row per missing member of a curated space, in stored order", () => {
    const s = space({}, [
      { kind: "file", path: "a.md" },
      { kind: "folder", path: "Dir" },
      { kind: "tag", tag: "work" },
    ]);
    expect(restoreRows(s, restoreProblems(s, has()))).toEqual([
      memberRow("a.md", "file"),
      memberRow("Dir", "folder"),
    ]);
  });

  it("shows one row per PATH, so a path reported twice is decided once", () => {
    // `restoreProblems` does not de-duplicate: a file member and a folder
    // member can name one path (the loader's own key is `p:` + path, so only
    // a hand-edited document gets there). Two identical rows would let one
    // path be given two contradictory answers, and the fix applies to every
    // member naming it anyway.
    const s = space({}, [
      { kind: "file", path: "a.md" },
      { kind: "folder", path: "a.md" },
    ]);
    expect(restoreProblems(s, has())).toHaveLength(2);
    expect(restoreRows(s, restoreProblems(s, has()))).toEqual([memberRow("a.md", "file")]);
  });

  it("shows the missing root of a folder space", () => {
    const s = space({ root: "Projects/X" });
    expect(restoreRows(s, restoreProblems(s, has()))).toEqual([rootRow("Projects/X")]);
  });

  it("leaves a folder space's members out, because the tree never draws them", () => {
    // `SpaceController.membersForSnapshot` answers `[{ path: root }]` for any
    // space that DECLARES a root, usable or not, so such a space's members
    // are not what a restore puts back on screen. They are still listed by
    // `memberRows` for the row summary and the Contents dialog, which is the
    // reason to leave them alone HERE: the place to remove a member is where
    // members are managed, and Remove in this dialog would discard curation
    // that matters again the moment the root is cleared.
    const s = space({ root: "Projects/X" }, [
      { kind: "file", path: "a.md" },
      { kind: "folder", path: "Dir" },
    ]);
    expect(restoreProblems(s, has())).toHaveLength(3);
    expect(restoreRows(s, restoreProblems(s, has()))).toEqual([rootRow("Projects/X")]);
  });

  it("shows nothing for a folder space whose root resolves, however broken its members", () => {
    const s = space({ root: "Projects/X" }, [{ kind: "file", path: "a.md" }]);
    expect(restoreRows(s, restoreProblems(s, has("Projects/X")))).toEqual([]);
  });

  it("counts what it checked: the member paths, or the one root", () => {
    expect(
      checkedPaths(
        space({}, [
          { kind: "file", path: "a.md" },
          { kind: "file", path: "a.md" },
          { kind: "tag", tag: "work" },
          { kind: "folder", path: "Dir" },
        ])
      )
    ).toEqual(["a.md", "Dir"]);
    expect(checkedPaths(space({ root: "Projects/X" }, [{ kind: "file", path: "a.md" }]))).toEqual([
      "Projects/X",
    ]);
    // `""` and `"/"` both mean no folder chosen, so there is nothing to check.
    expect(checkedPaths(space({ root: "" }))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * What it offers
 * ------------------------------------------------------------------ */

describe("what the gate offers", () => {
  it("offers point, remove and leave for a member", () => {
    expect(actionsFor(memberRow("a.md"))).toEqual(["point", "remove", "leave"]);
    expect(actionsFor(memberRow("Dir", "folder"))).toEqual(["point", "remove", "leave"]);
  });

  it("offers point and leave for a root, never remove", () => {
    // Leaving it restores the space into the missing-root state
    // `MissingRootNotice` already announces and repairs, so declining to
    // decide costs nothing. There is nothing a root could be removed FROM.
    expect(actionsFor(rootRow("Projects/X"))).toEqual(["point", "leave"]);
  });

  it("refuses a path that is empty, unchanged, missing, or the wrong kind", () => {
    const kindOf = (p: string): "file" | "folder" | null =>
      p === "Notes/a.md" ? "file" : p === "Dir" ? "folder" : null;
    expect(pointProblem(memberRow("a.md"), "Notes/a.md", kindOf)).toBeNull();
    expect(pointProblem(memberRow("a.md"), "   ", kindOf)).toBe("Type a path first.");
    expect(pointProblem(memberRow("a.md"), "a.md", kindOf)).toBe(
      "That is the path that is missing. Pick a different one."
    );
    expect(pointProblem(memberRow("a.md"), "Nope.md", kindOf)).toBe(
      "No note or folder at that path. Check the spelling."
    );
    expect(pointProblem(memberRow("a.md"), "Dir", kindOf)).toBe("That is a folder. Pick a note.");
    expect(pointProblem(memberRow("Dir", "folder"), "Notes/a.md", kindOf)).toBe(
      "That is a note. Pick a folder."
    );
    expect(pointProblem(rootRow("Gone"), "Dir", kindOf)).toBeNull();
  });

  it("refuses the vault root, which is the state a missing root is already in", () => {
    const kindOf = (): "file" | "folder" | null => "folder";
    expect(pointProblem(rootRow("Gone"), "/", kindOf)).toBe(
      "A space cannot show the whole vault. Pick a folder inside it."
    );
    expect(pointProblem(memberRow("Dir", "folder"), "/", kindOf)).toBe(
      "The vault root is not a note or a folder a space can hold. Pick one inside it."
    );
  });

  it("refuses a path the schema would reject, rather than failing the whole write", () => {
    // `validateMembers` rejects a leading slash, a backslash and a `..`
    // segment, and one rejected member fails the ENTIRE mutation: nothing
    // restored, and "invalid mutation: invalid space definition" in a notice.
    const unsafe = "Not a vault path. Give a path inside the vault, with no leading slash.";
    expect(pointProblem(memberRow("a.md"), "/Notes/a.md", () => "file")).toBe(unsafe);
    expect(pointProblem(memberRow("a.md"), "../a.md", () => "file")).toBe(unsafe);
    expect(pointProblem(memberRow("Dir", "folder"), "C:/Dir", () => "folder")).toBe(unsafe);
  });

  it("says the folder is fine and the name is not, when the folder was just chosen", () => {
    // `Choose…` composed the path, so "check the spelling" would be about a
    // path the user never typed. Only the name at the end is theirs.
    expect(pointProblem(memberRow("Old/a.md"), "New/a.md", () => null, "folder-pick")).toBe(
      "Nothing by that name in that folder. Edit the name, or choose another folder."
    );
    expect(pointProblem(memberRow("Old/a.md"), "New/a.md", () => null)).toBe(
      "No note or folder at that path. Check the spelling."
    );
  });
});

/* ------------------------------------------------------------------ *
 * The copy
 * ------------------------------------------------------------------ */

describe("the gate's copy", () => {
  it("counts the notes and folders, and says nothing has changed", () => {
    expect(restoreLede(5, 2)).toBe(
      "5 of 7 notes and folders are still there. 2 are not, and nothing has changed yet."
    );
    expect(restoreLede(1, 1)).toBe(
      "1 of 2 notes and folders are still there. 1 is not, and nothing has changed yet."
    );
    expect(restoreLede(0, 1)).toBe(
      "0 of 1 note or folder is still there. 1 is not, and nothing has changed yet."
    );
  });

  it("names what is missing per row", () => {
    expect(rowProblem(memberRow("a.md"))).toBe("No note at this path");
    expect(rowProblem(memberRow("Dir", "folder"))).toBe("No folder at this path");
    expect(rowProblem(rootRow("Projects/X"))).toBe("No folder at this path");
  });

  it("says leaving them is safe, and agrees with how many there are", () => {
    expect(restoreFooter([memberRow("a.md"), memberRow("Dir", "folder")])).toBe(
      "Leaving them is safe. They come back if the notes and folders do."
    );
    expect(restoreFooter([memberRow("a.md")])).toBe(
      "Leaving it is safe. It comes back if the note does."
    );
    expect(restoreFooter([rootRow("Projects/X")])).toBe(
      "Leaving it is safe. It comes back if the folder does."
    );
  });

  it("says what a staged row will do, and goes back to the problem when left", () => {
    const row = memberRow("Old/a.md");
    expect(stagedText(row, undefined)).toBe("No note at this path");
    expect(stagedText(row, { kind: "point-member", from: "Old/a.md", to: "New/a.md" })).toBe(
      "Pointing at New/a.md"
    );
    expect(stagedText(row, { kind: "remove-member", path: "Old/a.md" })).toBe(
      "Taking it out of the space"
    );
    expect(stagedText(rootRow("Gone"), { kind: "point-root", to: "Projects/X" })).toBe(
      "Pointing at Projects/X"
    );
  });

  it("never uses an em dash, and never calls them items or files", () => {
    const strings = [
      restoreLede(5, 2),
      restoreLede(0, 1),
      rowProblem(memberRow("a.md")),
      rowProblem(memberRow("Dir", "folder")),
      restoreTitle(space({ name: "Spring" })),
      stagedText(memberRow("a.md"), { kind: "remove-member", path: "a.md" }),
      stagedText(memberRow("a.md"), { kind: "point-member", from: "a.md", to: "b.md" }),
      restoreFooter([memberRow("a.md")]),
      restoreFooter([memberRow("a.md"), rootRow("X")]),
      pointProblem(memberRow("a.md"), "", () => null) ?? "",
      pointProblem(memberRow("a.md"), "Nope.md", () => null) ?? "",
      pointProblem(memberRow("a.md"), "Nope.md", () => null, "folder-pick") ?? "",
      pointProblem(memberRow("a.md"), "a.md", () => null) ?? "",
      pointProblem(memberRow("a.md"), "/a.md", () => "file") ?? "",
      pointProblem(memberRow("a.md"), "Dir", () => "folder") ?? "",
      pointProblem(memberRow("Dir", "folder"), "a.md", () => "file") ?? "",
      pointProblem(rootRow("Gone"), "/", () => "folder") ?? "",
      pointProblem(memberRow("Dir", "folder"), "/", () => "folder") ?? "",
    ];
    for (const s of strings) {
      expect(s).not.toMatch(/—/);
      expect(s).not.toMatch(/\bitems?\b/i);
      expect(s).not.toMatch(/\bfiles?\b/i);
    }
  });
});

/* ------------------------------------------------------------------ *
 * What it writes
 * ------------------------------------------------------------------ */

function docWith(spaces: unknown[], orders?: unknown): unknown {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { globalIgnore: [], restoreLayouts: true, revealVisitors: true },
    spaces,
    ...(orders ? { orders } : {}),
  };
}

async function storeOf(doc: unknown): Promise<{ store: DefinitionStore; writes: () => number }> {
  let writes = 0;
  const store = new DefinitionStore({
    read: async () => doc,
    write: async () => {
      writes += 1;
    },
  });
  await store.load();
  return { store, writes: () => writes };
}

const archived = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "b",
  name: "Spring",
  icon: "box",
  color: "#aabbcc",
  archived: true,
  members: [
    { kind: "file", path: "Old/a.md" },
    { kind: "file", path: "Old/b.md" },
    { kind: "tag", tag: "work" },
  ],
  ...extra,
});

/** A draft to mutate, the way `DefinitionStore.mutate` hands one over. */
function draftOf(spaces: unknown[], orders?: unknown): SpacesDefinitions {
  return JSON.parse(JSON.stringify(docWith(spaces, orders))) as SpacesDefinitions;
}

describe("committing the staged fixes", () => {
  it("commits every fix and the flag clear in one mutate", async () => {
    const { store } = await storeOf(docWith([archived()]));
    let mutations = 0;
    const counted = {
      mutate: (fn: (d: SpacesDefinitions) => void) => {
        mutations += 1;
        return store.mutate(fn);
      },
    } as unknown as DefinitionStore;

    await commitRestore(counted, "b", [
      { kind: "point-member", from: "Old/a.md", to: "New/a.md" },
      { kind: "remove-member", path: "Old/b.md" },
    ]);

    expect(mutations).toBe(1);
    const s = store.get().spaces[0];
    expect(s.members).toEqual([
      { kind: "file", path: "New/a.md" },
      { kind: "tag", tag: "work" },
    ]);
    expect("archived" in s).toBe(false);
  });

  it("points a root without touching the members", () => {
    const draft = draftOf([archived({ root: "Gone" })]);
    applyRestoreFixes(draft, "b", [{ kind: "point-root", to: "Projects/X" }]);
    expect(draft.spaces[0].root).toBe("Projects/X");
    expect(draft.spaces[0].members).toHaveLength(3);
    expect("archived" in draft.spaces[0]).toBe(false);
  });

  it("clears the flag even when nothing was staged, so Leave still restores", () => {
    const draft = draftOf([archived()]);
    applyRestoreFixes(draft, "b", []);
    expect("archived" in draft.spaces[0]).toBe(false);
    expect(draft.spaces[0].members).toHaveLength(3);
  });

  it("re-points every member naming the path, since the gate showed one row", () => {
    const draft = draftOf([
      {
        ...archived(),
        members: [
          { kind: "file", path: "Old/a.md" },
          { kind: "folder", path: "Old/a.md" },
        ],
      },
    ]);
    applyRestoreFixes(draft, "b", [{ kind: "point-member", from: "Old/a.md", to: "New/a.md" }]);
    expect(draft.spaces[0].members).toEqual([
      { kind: "file", path: "New/a.md" },
      { kind: "folder", path: "New/a.md" },
    ]);
  });

  it("follows the exclusions under a re-pointed member folder", () => {
    // `exclude` holds LITERAL paths and `archiveSpace` preserves them, so a
    // re-point that left them spelled the old way would silently put the
    // notes the user took out of this space back into it.
    const draft = draftOf([
      {
        ...archived(),
        members: [{ kind: "folder", path: "Old/Dir" }],
        exclude: ["Old/Dir/skip.md", "Old/Dir/Deep/also.md", "Elsewhere/keep-out.md"],
      },
    ]);

    applyRestoreFixes(draft, "b", [{ kind: "point-member", from: "Old/Dir", to: "New/Dir" }]);

    expect(draft.spaces[0].exclude).toEqual([
      "New/Dir/skip.md",
      "New/Dir/Deep/also.md",
      // Not under the re-pointed member, so not this re-point's business.
      "Elsewhere/keep-out.md",
    ]);
  });

  it("follows the exclusions under a re-pointed root", () => {
    const draft = draftOf([
      { ...archived(), root: "Old/Dir", exclude: ["Old/Dir/skip.md", "Other/x.md"] },
    ]);
    applyRestoreFixes(draft, "b", [{ kind: "point-root", to: "New/Dir" }]);
    expect(draft.spaces[0].root).toBe("New/Dir");
    expect(draft.spaces[0].exclude).toEqual(["New/Dir/skip.md", "Other/x.md"]);
  });

  it("leaves a removed member's exclusions alone", () => {
    // `exclude` leaves a path out whatever pulled it in, so it is not owned
    // by the member it sits under: a tag member of the same space can still
    // reach that note, and dropping the exclusion would put it back on
    // screen as a side effect of removing something else. A kept entry
    // excludes nothing and is one click to clear in the Contents dialog.
    const draft = draftOf([
      {
        ...archived(),
        members: [
          { kind: "folder", path: "Old/Dir" },
          { kind: "tag", tag: "work" },
        ],
        exclude: ["Old/Dir/skip.md"],
      },
    ]);
    applyRestoreFixes(draft, "b", [{ kind: "remove-member", path: "Old/Dir" }]);
    expect(draft.spaces[0].exclude).toEqual(["Old/Dir/skip.md"]);
    expect(draft.spaces[0].members).toEqual([{ kind: "tag", tag: "work" }]);
  });

  it("would fail the whole write on a path the schema rejects, which pointProblem catches", () => {
    // The hazard the unsafe-path refusal exists for, stated where it can be
    // seen: nothing is partially applied, and the user gets a schema error.
    return storeOf(docWith([archived()])).then(async ({ store, writes }) => {
      await expect(
        commitRestore(store, "b", [
          { kind: "point-member", from: "Old/a.md", to: "/Notes/a.md" },
        ])
      ).rejects.toThrow(/invalid mutation/);
      expect(writes()).toBe(0);
      expect(store.get().spaces[0].archived).toBe(true);
    });
  });

  it("keeps a re-pointed member's position in orders.bySpaceId", () => {
    // The design's call: `repairOrderMap` drops the entry when the parent
    // folder changes, because an EXTERNAL move's intent is unknown. Here the
    // user has just said, explicitly, that this note is that member, so the
    // position carries to the new parent's list rather than the note falling
    // to the bottom of the restored space.
    const draft = draftOf([archived()], {
      bySpaceId: {
        b: { Old: ["Old/z.md", "Old/a.md", "Old/b.md"], New: ["New/q.md", "New/r.md"] },
      },
    });

    applyRestoreFixes(draft, "b", [{ kind: "point-member", from: "Old/a.md", to: "New/a.md" }]);

    const map = draft.orders?.bySpaceId?.b;
    expect(map?.Old).toEqual(["Old/z.md", "Old/b.md"]);
    // Index 1 in the old list, index 1 in the new one. The destination has a
    // row after it, so this fails if the entry is merely appended.
    expect(map?.New).toEqual(["New/q.md", "New/a.md", "New/r.md"]);
  });

  it("keeps the position when the folder does not change either", () => {
    const draft = draftOf([archived()], { bySpaceId: { b: { Old: ["Old/z.md", "Old/a.md"] } } });
    applyRestoreFixes(draft, "b", [{ kind: "point-member", from: "Old/a.md", to: "Old/c.md" }]);
    expect(draft.orders?.bySpaceId?.b?.Old).toEqual(["Old/z.md", "Old/c.md"]);
  });

  it("drops a removed member's entry from orders.bySpaceId", () => {
    // What `deleteSpace` does for a deleted space, at the scale of one member.
    const draft = draftOf([archived()], {
      bySpaceId: { b: { Old: ["Old/z.md", "Old/a.md"] }, other: { Old: ["Old/a.md"] } },
    });

    applyRestoreFixes(draft, "b", [{ kind: "remove-member", path: "Old/a.md" }]);

    expect(draft.orders?.bySpaceId?.b?.Old).toEqual(["Old/z.md"]);
    // Another space's order is another space's business.
    expect(draft.orders?.bySpaceId?.other?.Old).toEqual(["Old/a.md"]);
  });

  it("leaves an unordered member unordered when it is re-pointed", () => {
    const draft = draftOf([archived()], { bySpaceId: { b: { Old: ["Old/b.md"] } } });
    applyRestoreFixes(draft, "b", [{ kind: "point-member", from: "Old/a.md", to: "New/a.md" }]);
    expect(draft.orders?.bySpaceId?.b).toEqual({ Old: ["Old/b.md"] });
  });

  it("does nothing at all for an id that is not there", () => {
    const draft = draftOf([archived()]);
    const before = JSON.stringify(draft);
    applyRestoreFixes(draft, "nope", [{ kind: "remove-member", path: "Old/a.md" }]);
    expect(JSON.stringify(draft)).toBe(before);
  });
});

/* ------------------------------------------------------------------ *
 * Staging, and cancel
 * ------------------------------------------------------------------ */

function gateOver(
  rows: RestoreRow[],
  apply: (fixes: StagedFix[]) => Promise<void>
): { gate: RestoreGate; closed: () => number; errors: string[] } {
  let closed = 0;
  const errors: string[] = [];
  const gate = new RestoreGate(rows, {
    apply,
    close: () => {
      closed += 1;
    },
    onError: (m) => errors.push(m),
  });
  return { gate, closed: () => closed, errors };
}

describe("staging", () => {
  it("writes nothing and leaves the space archived on cancel", async () => {
    const { store, writes } = await storeOf(docWith([archived()]));
    const rows = [memberRow("Old/a.md"), memberRow("Old/b.md")];
    const { gate, closed } = gateOver(rows, (fixes) => commitRestore(store, "b", fixes));

    gate.point(0, "New/a.md");
    gate.remove(1);
    gate.cancel();
    await Promise.resolve();

    expect(writes()).toBe(0);
    const s = store.get().spaces[0];
    expect(s.archived).toBe(true);
    expect(s.members).toEqual([
      { kind: "file", path: "Old/a.md" },
      { kind: "file", path: "Old/b.md" },
      { kind: "tag", tag: "work" },
    ]);
    expect(closed()).toBe(1);
  });

  it("holds each row's decision, and lets the last one win", () => {
    const rows = [memberRow("Old/a.md"), rootRow("Gone")];
    const { gate } = gateOver(rows, async () => undefined);

    expect(gate.fixes()).toEqual([]);
    gate.remove(0);
    gate.point(0, "New/a.md");
    gate.point(1, "Projects/X");
    expect(gate.fixes()).toEqual([
      { kind: "point-member", from: "Old/a.md", to: "New/a.md" },
      { kind: "point-root", to: "Projects/X" },
    ]);

    gate.leave(0);
    expect(gate.fixes()).toEqual([{ kind: "point-root", to: "Projects/X" }]);
  });

  it("applies and closes once on Restore", async () => {
    const seen: StagedFix[][] = [];
    const rows = [memberRow("Old/a.md")];
    const { gate, closed } = gateOver(rows, async (f) => {
      seen.push(f);
    });
    gate.remove(0);
    await gate.restore();
    expect(seen).toEqual([[{ kind: "remove-member", path: "Old/a.md" }]]);
    expect(closed()).toBe(1);
  });

  it("keeps the staged work and stays open when the write fails", async () => {
    const rows = [memberRow("Old/a.md")];
    const { gate, closed, errors } = gateOver(rows, () => Promise.reject(new Error("disk full")));
    gate.point(0, "New/a.md");
    await gate.restore();
    expect(closed()).toBe(0);
    expect(errors[0]).toContain("disk full");
    expect(gate.fixes()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * The folder picker, as the gate opens it
 * ------------------------------------------------------------------ */

describe("the folder picker the gate reuses", () => {
  const source: VaultSource = { allPaths: () => [], kindOf: () => null };

  function openPicker(offerClear?: boolean): HTMLElement {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    // `FolderSuggest` needs a real `App`; the stub refuses to invent one, and
    // the popover's own try/catch degrades to the plain input, which is the
    // path under test here.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    openFolderPickerPopover({
      anchor,
      app: {} as never,
      folders: source,
      current: "Old",
      apply: () => Promise.resolve(),
      ...(offerClear === undefined ? {} : { offerClear }),
    });
    quiet.mockRestore();
    return document.querySelector(".spaces-folder-picker-popover") as HTMLElement;
  }

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("offers Clear to the missing-root caller it was written for", () => {
    const root = openPicker();
    expect(Array.from(root.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      "Clear",
    ]);
  });

  it("offers no Clear to the gate, where its wording would be untrue", () => {
    // "The space stays folder pinned, with no folder chosen" describes the
    // missing-root dialog. Here clearing is not one of the three answers:
    // on a note row `""` composes a path at the vault root, on a folder or
    // root row it is refused, and "not deciding now" is "Leave as is".
    const root = openPicker(false);
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelector("input")).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The Restore button in Settings
 * ------------------------------------------------------------------ */

const opened = vi.hoisted(() => ({
  calls: [] as Array<{ deps: Record<string, unknown>; open: boolean }>,
}));

vi.mock("../src/ui/RestoreSpaceModal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/RestoreSpaceModal")>();
  return {
    ...actual,
    RestoreSpaceModal: class {
      private readonly record: { deps: Record<string, unknown>; open: boolean };
      constructor(_app: unknown, deps: Record<string, unknown>) {
        this.record = { deps, open: false };
        opened.calls.push(this.record);
      }
      open(): void {
        this.record.open = true;
      }
    },
  };
});

interface RecordedButton {
  text: string;
  click: () => unknown;
}

/** The archived row's buttons, recorded the way `settingsSpaceListRefresh` does. */
function archivedButtons(tab: { getSettingDefinitions: () => unknown[] }): RecordedButton[] {
  const page = tab.getSettingDefinitions().find((i) => (i as { name?: string }).name === "Spaces") as {
    items: Array<Record<string, unknown>>;
  };
  const section = page.items.find((i) => i.heading === "Archived") as { items: unknown[] };
  const def = section.items[0] as { render: (s: unknown) => void };
  const buttons: RecordedButton[] = [];
  const setting = {
    addButton: (cb: (b: unknown) => void) => {
      const b: RecordedButton = { text: "", click: () => undefined };
      const api = {
        setButtonText: (t: string) => ((b.text = t), api),
        setTooltip: () => api,
        setDestructive: () => api,
        onClick: (f: () => unknown) => ((b.click = f), api),
      };
      cb(api);
      buttons.push(b);
      return setting;
    },
  };
  def.render(setting);
  return buttons;
}

async function tabOver(
  members: MemberEntry[],
  present: string[]
): Promise<{ buttons: RecordedButton[]; spaces: SpaceDefinition[]; updates: () => number }> {
  const { SpacesSettingTab } = await import("../src/ui/SettingsTab");
  const { createMapTagIndex } = await import("../src/visibility/TagIndex");
  const spaces: SpaceDefinition[] = [
    { id: "b", name: "Spring", icon: "box", color: "#aabbcc", archived: true, members },
  ];
  const store = {
    get: (): SpacesDefinitions =>
      ({
        spaces,
        settings: { globalIgnore: [], restoreLayouts: false, revealVisitors: true },
        orders: {},
      }) as unknown as SpacesDefinitions,
    mutate: async (fn: (d: SpacesDefinitions) => void): Promise<void> => {
      fn({ spaces } as unknown as SpacesDefinitions);
    },
  } as unknown as DefinitionStore;
  const vault = new Set(present);
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => (vault.has(p) ? { path: p } : null),
      getAllLoadedFiles: () => [],
    },
  };
  const tab = new SpacesSettingTab(app as never, {} as never, store, () =>
    createMapTagIndex(new Map())
  );
  let updates = 0;
  (tab as unknown as { update: () => void }).update = () => {
    updates += 1;
  };
  return { buttons: archivedButtons(tab), spaces, updates: () => updates };
}

describe("the Restore button", () => {
  it("restores silently when restoreProblems returns nothing", async () => {
    opened.calls.length = 0;
    const { buttons, spaces, updates } = await tabOver([{ kind: "file", path: "a.md" }], ["a.md"]);

    buttons.find((b) => b.text === "Restore")!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(opened.calls).toHaveLength(0);
    expect(spaces[0].archived).toBeUndefined();
    expect(updates()).toBe(1);
  });

  it("opens the modal and does not restore when there is a problem", async () => {
    opened.calls.length = 0;
    const { buttons, spaces, updates } = await tabOver([{ kind: "file", path: "a.md" }], []);

    buttons.find((b) => b.text === "Restore")!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(opened.calls).toHaveLength(1);
    expect(opened.calls[0].open).toBe(true);
    expect(opened.calls[0].deps.rows).toEqual([memberRow("a.md")]);
    expect(spaces[0].archived).toBe(true);
    expect(updates()).toBe(0);
  });

  it("still offers Restore and Delete, in that order", async () => {
    const { buttons } = await tabOver([{ kind: "file", path: "a.md" }], []);
    expect(buttons.map((b) => b.text)).toEqual(["Restore", "Delete"]);
  });
});
