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
import type { AnchoredPopover } from "../src/ui/AnchoredPopover";
import type { VaultSource } from "../src/ui/createSpaceForm";
import {
  RestoreGate,
  actionsFor,
  applyRestoreFixes,
  checkedPaths,
  commitRestore,
  pointProblem,
  restoreLede,
  restoreRows,
  restoreReport,
  restoreTitle,
  rowProblem,
  rowSource,
  stagedText,
  type RestoreOutcome,
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

/** The vault as the gate asks it: by kind, never by bare existence. */
const has =
  (...paths: string[]) =>
  (p: string): "file" | "folder" | null => {
    if (!paths.includes(p)) return null;
    return p.endsWith(".md") ? "file" : "folder";
  };

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
    // On a MEMBER row an unsafe path fails `validateMembers` and the ENTIRE
    // mutation is rejected: nothing restored, and "invalid mutation: invalid
    // space definition" in a notice. On a ROOT row `validateSpace` drops the
    // key instead, the write succeeds, and the folder space silently becomes
    // a curated one. Refusing here is cheaper than either.
    const unsafe =
      "Not a vault path. Give a path inside the vault, 1000 characters or " +
      "fewer, with forward slashes, no leading slash, no drive letter, and " +
      "no . or .. steps.";
    // One message for five causes, so it has to name all five. It named four
    // and left the length cap out, so a path over the cap got an instruction
    // whose every clause was about something else.
    expect(pointProblem(memberRow("a.md"), "/Notes/a.md", () => "file")).toBe(unsafe);
    expect(pointProblem(memberRow("a.md"), "../a.md", () => "file")).toBe(unsafe);
    expect(pointProblem(memberRow("a.md"), "Notes\\a.md", () => "file")).toBe(unsafe);
    expect(pointProblem(memberRow("a.md"), "./a.md", () => "file")).toBe(unsafe);
    expect(pointProblem(memberRow("Dir", "folder"), "C:/Dir", () => "folder")).toBe(unsafe);
    expect(pointProblem(memberRow("a.md"), "N/" + "a".repeat(1000), () => "file")).toBe(unsafe);
  });

  it("refuses a path the space already holds, which the loader would silently absorb", () => {
    // `validateMembers` keys on `"p:" + path`, so two members naming one path
    // come out as one. Pointing a row at a path already held therefore does
    // not point it, it deletes it, and nothing downstream can say so.
    const kindOf = (): "file" | "folder" | null => "file";
    const held = new Set(["New/a.md"]);
    expect(pointProblem(memberRow("Old/x.md"), "New/a.md", kindOf, "typed", held)).toBe(
      "That is already in this space. Pick a different path, or Remove from space."
    );
    expect(pointProblem(memberRow("Old/x.md"), "New/b.md", kindOf, "typed", held)).toBeNull();
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
  it("names what is missing per row", () => {
    expect(rowProblem(memberRow("a.md"))).toBe("No note at this path");
    expect(rowProblem(memberRow("Dir", "folder"))).toBe("No folder at this path");
    // A root reads the same as any folder row HERE, because `rowSource` is
    // what says it is the pinned folder, on its own line under the path.
    // Saying so twice was two lines of the same sentence.
    expect(rowProblem(rootRow("Projects/X"))).toBe("No folder at this path");
  });

  it("says under the path whether somebody put it there by hand", () => {
    // The gate lists only path members and the root, and `MEMBER_NAMING`
    // marks file and folder as "picked", so every member row IS hand-added.
    expect(rowSource(memberRow("a.md"))).toBe("Note you added to this space");
    expect(rowSource(memberRow("Dir", "folder"))).toBe("Folder you added to this space");
    expect(rowSource(rootRow("Projects/X"))).toBe("Pinned folder");
  });

  it("counts what is missing without narrating it", () => {
    // The old lede read "1 of 3 notes and folders are still there. 2 are not,
    // and nothing has changed yet." The repo owner asked for a count, not a
    // paragraph.
    expect(restoreLede(1, 2)).toBe("2 of 3 missing");
    expect(restoreLede(0, 1)).toBe("1 of 1 missing");
    expect(restoreLede(0, 1, true)).toBe("The folder this space is pinned to is missing.");
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
    expect(stagedText(rootRow("Gone"), { kind: "point-root", from: "Gone", to: "Projects/X" })).toBe(
      "Pointing at Projects/X"
    );
  });

  it("never uses an em dash, and never calls them items or files", () => {
    const strings = [
      restoreLede(5, 2),
      restoreLede(0, 1),
      restoreLede(1, 2),
      rowProblem(memberRow("a.md")),
      rowProblem(memberRow("Dir", "folder")),
      restoreTitle(space({ name: "Spring" })),
      stagedText(memberRow("a.md"), { kind: "remove-member", path: "a.md" }),
      stagedText(memberRow("a.md"), { kind: "point-member", from: "a.md", to: "b.md" }),
      stagedText(rootRow("Gone"), { kind: "point-root", from: "Gone", to: "New" }),
      restoreLede(0, 1, true),
      rowProblem(rootRow("Gone")),
      restoreReport("Spring", { missing: true, skipped: [] }) ?? "",
      restoreReport("Spring", {
        missing: false,
        skipped: [{ kind: "remove-member", path: "Old/a.md" }],
      }) ?? "",
      restoreReport("Spring", {
        missing: false,
        skipped: [
          { kind: "remove-member", path: "Old/a.md" },
          { kind: "point-member", from: "Old/b.md", to: "New/b.md" },
        ],
      }) ?? "",
      pointProblem(memberRow("a.md"), "Held.md", () => "file", "typed", new Set(["Held.md"])) ?? "",
      rowSource(memberRow("a.md")),
      rowSource(memberRow("Dir", "folder")),
      rowSource(rootRow("Gone")),
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
    applyRestoreFixes(draft, "b", [{ kind: "point-root", from: "Gone", to: "Projects/X" }]);
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
    applyRestoreFixes(draft, "b", [{ kind: "point-root", from: "Old/Dir", to: "New/Dir" }]);
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
    const outcome = applyRestoreFixes(draft, "nope", [
      { kind: "remove-member", path: "Old/a.md" },
    ]);
    expect(JSON.stringify(draft)).toBe(before);
    // ...and SAYS so, rather than letting the gate close as though the space
    // had been restored. The space really is gone; the report of it was the
    // thing that was not honest.
    expect(outcome).toEqual({
      missing: true,
      skipped: [{ kind: "remove-member", path: "Old/a.md" }],
    });
  });
});

/* ------------------------------------------------------------------ *
 * The commit re-checks what it was told, against the live document
 * ------------------------------------------------------------------ */

describe("a staged fix whose path has moved under the gate", () => {
  // The gate's rows are built from the SpaceDefinition the settings page was
  // rendered from, `spaceSignature` does not cover member paths, and
  // `repairOnRename` repairs archived spaces on purpose. So the decisions can
  // be about paths the live document no longer holds, and the document is the
  // only copy of the user's curation.

  it("skips a staged removal when the path it was about has gone", () => {
    // The loss shape, exactly: the space held a gated `Old/f.md` and a live
    // `Temp/f.md`; a rename of `Temp` to `Old` collapsed them into the one
    // live member at `Old/f.md`. Applying the Remove by path would delete
    // the survivor and leave the space empty.
    const draft = draftOf([
      { ...archived(), members: [{ kind: "file", path: "Old/f.md" }] },
    ]);
    // The user answered the gate about `Old/f.md` BEFORE the rename, when it
    // named nothing. It names a real note now, so this must not fire.
    const outcome = applyRestoreFixes(draft, "b", [
      { kind: "remove-member", path: "Gone/f.md" },
    ]);
    expect(draft.spaces[0].members).toEqual([{ kind: "file", path: "Old/f.md" }]);
    expect(outcome.skipped).toEqual([{ kind: "remove-member", path: "Gone/f.md" }]);
    // Still a restore: the flag goes whatever happened to the fixes.
    expect("archived" in draft.spaces[0]).toBe(false);
  });

  it("skips a re-point whose source is no longer a member, and touches nothing", () => {
    const draft = draftOf([
      {
        ...archived(),
        members: [{ kind: "folder", path: "Fresh/Dir" }],
        exclude: ["Old/Dir/skip.md"],
      },
    ], { bySpaceId: { b: { Old: ["Old/Dir"] } } });

    const outcome = applyRestoreFixes(draft, "b", [
      { kind: "point-member", from: "Old/Dir", to: "New/Dir" },
    ]);

    expect(draft.spaces[0].members).toEqual([{ kind: "folder", path: "Fresh/Dir" }]);
    // The exclusions and the order map are not rewritten either: a skipped
    // fix is skipped whole.
    expect(draft.spaces[0].exclude).toEqual(["Old/Dir/skip.md"]);
    expect(draft.orders?.bySpaceId?.b).toEqual({ Old: ["Old/Dir"] });
    expect(outcome.skipped).toEqual([{ kind: "point-member", from: "Old/Dir", to: "New/Dir" }]);
  });

  it("skips a root fix when the root is no longer the one the user was shown", () => {
    const draft = draftOf([archived({ root: "Moved" })]);
    const outcome = applyRestoreFixes(draft, "b", [
      { kind: "point-root", from: "Gone", to: "Chosen" },
    ]);
    expect(draft.spaces[0].root).toBe("Moved");
    expect(outcome.skipped).toHaveLength(1);
  });

  it("refuses to CREATE a root on a space whose root a sync cleared", () => {
    // `space.root = fix.to` used to be unconditional, so a curated space
    // acquired a folder and stopped showing any of its members.
    const draft = draftOf([{ ...archived() }]);
    const outcome = applyRestoreFixes(draft, "b", [
      { kind: "point-root", from: "Gone", to: "New/Dir" },
    ]);
    expect("root" in draft.spaces[0]).toBe(false);
    expect(draft.spaces[0].members).toHaveLength(3);
    expect(outcome.skipped).toHaveLength(1);
  });

  it("applies the fixes that still match and reports only the ones that do not", () => {
    const draft = draftOf([archived()]);
    const outcome = applyRestoreFixes(draft, "b", [
      { kind: "point-member", from: "Old/a.md", to: "New/a.md" },
      { kind: "remove-member", path: "Vanished.md" },
    ]);
    expect(draft.spaces[0].members).toEqual([
      { kind: "file", path: "New/a.md" },
      { kind: "file", path: "Old/b.md" },
      { kind: "tag", tag: "work" },
    ]);
    expect(outcome.skipped).toEqual([{ kind: "remove-member", path: "Vanished.md" }]);
  });

  it("reports the skipped fixes in the order they were staged", () => {
    // They are APPLIED longest path first; they are REPORTED in row order,
    // because the rows are what the user will go back and look at.
    const draft = draftOf([{ ...archived(), members: [] }]);
    const outcome = applyRestoreFixes(draft, "b", [
      { kind: "remove-member", path: "a.md" },
      { kind: "remove-member", path: "Deep/Nested/b.md" },
    ]);
    expect(outcome.skipped.map((f) => (f.kind === "remove-member" ? f.path : ""))).toEqual([
      "a.md",
      "Deep/Nested/b.md",
    ]);
  });
});

describe("nested folder re-points", () => {
  it("leaves each exclusion under the folder it actually belongs to", () => {
    // Applied in row order the outer fix claimed `Old/Dir/Sub/deep.md` and
    // carried it to `N1`, while the member it belonged to went to `N2`: the
    // note the user left out comes back under `N2`, and whatever later
    // occupies `N1/Sub/deep.md` is excluded in its place.
    const draft = draftOf([
      {
        ...archived(),
        members: [
          { kind: "folder", path: "Old/Dir" },
          { kind: "folder", path: "Old/Dir/Sub" },
        ],
        exclude: ["Old/Dir/skip.md", "Old/Dir/Sub/deep.md"],
      },
    ]);

    applyRestoreFixes(draft, "b", [
      { kind: "point-member", from: "Old/Dir", to: "N1" },
      { kind: "point-member", from: "Old/Dir/Sub", to: "N2" },
    ]);

    expect(draft.spaces[0].members).toEqual([
      { kind: "folder", path: "N1" },
      { kind: "folder", path: "N2" },
    ]);
    expect(draft.spaces[0].exclude).toEqual(["N1/skip.md", "N2/deep.md"]);
  });
});

/* ------------------------------------------------------------------ *
 * Staging, and cancel
 * ------------------------------------------------------------------ */

const CLEAN: RestoreOutcome = { missing: false, skipped: [] };

function gateOver(
  rows: RestoreRow[],
  apply: (fixes: StagedFix[]) => Promise<RestoreOutcome>
): {
  gate: RestoreGate;
  closed: () => number;
  errors: string[];
  reports: RestoreOutcome[];
} {
  let closed = 0;
  const errors: string[] = [];
  const reports: RestoreOutcome[] = [];
  const gate = new RestoreGate(rows, {
    apply,
    close: () => {
      closed += 1;
    },
    onError: (m) => errors.push(m),
    onReport: (o) => reports.push(o),
  });
  return { gate, closed: () => closed, errors, reports };
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
    const { gate } = gateOver(rows, async () => CLEAN);

    expect(gate.fixes()).toEqual([]);
    gate.remove(0);
    gate.point(0, "New/a.md");
    gate.point(1, "Projects/X");
    expect(gate.fixes()).toEqual([
      { kind: "point-member", from: "Old/a.md", to: "New/a.md" },
      { kind: "point-root", from: "Gone", to: "Projects/X" },
    ]);

    gate.leave(0);
    expect(gate.fixes()).toEqual([{ kind: "point-root", from: "Gone", to: "Projects/X" }]);
  });

  it("reports an outcome that did not do everything, and says nothing when it did", async () => {
    const rows = [memberRow("Old/a.md")];
    const left: RestoreOutcome = {
      missing: false,
      skipped: [{ kind: "remove-member", path: "Old/a.md" }],
    };
    const a = gateOver(rows, async () => left);
    await a.gate.restore();
    expect(a.reports).toEqual([left]);
    expect(restoreReport("Spring", left)).toContain("Old/a.md");

    const b = gateOver(rows, async () => CLEAN);
    await b.gate.restore();
    expect(b.reports).toEqual([CLEAN]);
    expect(restoreReport("Spring", CLEAN)).toBeNull();
  });

  it("applies and closes once on Restore", async () => {
    const seen: StagedFix[][] = [];
    const rows = [memberRow("Old/a.md")];
    const { gate, closed } = gateOver(rows, async (f) => {
      seen.push(f);
      return CLEAN;
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

  // Every popover opened here is closed in `afterEach`, never discarded. An
  // open `AnchoredPopover` holds four document and window listeners and drops
  // them only on `close()`, so one left open outlives the test that made it:
  // clearing the DOM takes its element away and leaves the listeners behind.
  // That is the lifetime failure the popover's own docstring warns about, and
  // a test of the popover is the last place to reproduce it.
  const openPopovers: AnchoredPopover[] = [];

  function openPicker(offerClear?: boolean): HTMLElement {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    // `FolderSuggest` needs a real `App`; the stub refuses to invent one, and
    // the popover's own try/catch degrades to the plain input, which is the
    // path under test here.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    openPopovers.push(
      openFolderPickerPopover({
        anchor,
        app: {} as never,
        folders: source,
        current: "Old",
        apply: () => Promise.resolve(),
        ...(offerClear === undefined ? {} : { offerClear }),
      })
    );
    quiet.mockRestore();
    return document.querySelector(".spaces-folder-picker-popover") as HTMLElement;
  }

  afterEach(() => {
    for (const pop of openPopovers.splice(0)) pop.close();
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
  // Real stub instances, because `vaultSource().kindOf` discriminates with
  // `instanceof`: the gate now asks the vault what KIND is at a path, not
  // merely whether anything is.
  const { TFile, TFolder } = await import("obsidian");
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => {
        if (!vault.has(p)) return null;
        const f = p.endsWith(".md") ? new TFile() : new TFolder();
        f.path = p;
        return f;
      },
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

/**
 * Flush microtasks until `done` answers, or give up.
 *
 * These three used `await Promise.resolve()` exactly twice, which asserts how
 * many ticks `mutate` takes internally rather than what it writes: one more
 * step inside `persist()` and they go red for a reason unrelated to the
 * behaviour under test. One of them also hit the 5 s ceiling in a full
 * parallel run while passing in 716 ms alone, which is why the three carry an
 * explicit timeout: each pays a dynamic `import` of the settings tab, and a
 * suite that goes red under load is a suite people learn to re-run.
 */
async function settled(done: () => boolean, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks && !done(); i += 1) await Promise.resolve();
}

const SLOW = 20_000;

describe("the Restore button", () => {
  it(
    "restores silently when restoreProblems returns nothing",
    async () => {
      opened.calls.length = 0;
      const { buttons, spaces, updates } = await tabOver([{ kind: "file", path: "a.md" }], ["a.md"]);

      buttons.find((b) => b.text === "Restore")!.click();
      // The flag clears inside the mutate; `update()` runs in the `.then`
      // after it, so the later of the two is what settles the click.
      await settled(() => updates() > 0);

      expect(opened.calls).toHaveLength(0);
      expect(spaces[0].archived).toBeUndefined();
      expect(updates()).toBe(1);
    },
    SLOW
  );

  it(
    "opens the modal and does not restore when there is a problem",
    async () => {
      opened.calls.length = 0;
      const { buttons, spaces, updates } = await tabOver([{ kind: "file", path: "a.md" }], []);

      buttons.find((b) => b.text === "Restore")!.click();
      await settled(() => opened.calls.length > 0);

      expect(opened.calls).toHaveLength(1);
      expect(opened.calls[0].open).toBe(true);
      expect(opened.calls[0].deps.rows).toEqual([memberRow("a.md")]);
      expect(spaces[0].archived).toBe(true);
      expect(updates()).toBe(0);
    },
    SLOW
  );

  it(
    "still offers Restore and Delete, in that order",
    async () => {
      const { buttons } = await tabOver([{ kind: "file", path: "a.md" }], []);
      expect(buttons.map((b) => b.text)).toEqual(["Restore", "Delete"]);
    },
    SLOW
  );
});
