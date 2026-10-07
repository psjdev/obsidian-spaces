// @vitest-environment jsdom
/**
 * The WRITE side of the one case policy: member removal and add must match
 * the way visibility matching already does.
 *
 * `buildVisibilitySnapshot` resolves stored member paths to live ones
 * case-insensitively. That is why a member stored as `Notes/A.md` against a
 * live `notes/a.md` is visible, and `decisionFor` reports
 * `canRemoveMembership: true`, so the context menu offers "Remove from
 * <space>".
 *
 * The writes in `src/actions/` must not compare exact strings: doing so
 * would filter on `m.path === "notes/a.md"`, find nothing, and report
 * "Removed 1 from Research" while the entry stayed — the row appears, the
 * user removes it, and nothing happens — even though the settings-tab
 * member list, which removes by the stored path it is displaying, still
 * could. That would leave two surfaces disagreeing about whether a member
 * exists.
 *
 * These tests drive the REAL menu path — `decorate()` builds the item and the
 * test clicks it — against a REAL snapshot from `buildVisibilitySnapshot`, so
 * the case resolution under test is the app's, not the test's. Only
 * Obsidian's `Menu` and the controller are structural fakes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Menu, TAbstractFile } from "obsidian";
import { decorate } from "../src/actions/membership";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { coveringFolderIn, memberFolderSet } from "../src/definitions/membership";
import { createTreeVaultIndex } from "../src/visibility/VaultIndex";
import { buildVisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { compileIgnore } from "../src/visibility/glob";
import type { SpaceController } from "../src/controller/SpaceController";
import type { SpaceDefinition } from "../src/types";
import { buildFakeVault } from "./helpers/fakeVault";

/** The vault as it really is: lower-case on disk. */
const vault = buildFakeVault({
  notes: "folder",
  "notes/a.md": "file",
  "notes/b.md": "file",
  inbox: "folder",
  "inbox/today.md": "file",
});

/** The document as it was stored: a different casing for the same paths. */
const RESEARCH: SpaceDefinition = {
  id: "research",
  name: "Research",
  icon: "microscope",
  color: "#4ecdc4",
  members: [
    { path: "Notes/A.md", kind: "file" },
    { path: "Inbox", kind: "folder" },
  ],
};

interface MenuRow {
  title: string;
  disabled: boolean;
  click: (() => void) | null;
}

/** Records what `decorate` put in the menu, and lets a test click one row. */
function fakeMenu(): { menu: Menu; rows: MenuRow[] } {
  const rows: MenuRow[] = [];
  const menu = {
    addItem(build: (item: unknown) => unknown) {
      const row: MenuRow = { title: "", disabled: false, click: null };
      const item = {
        setTitle(t: string) {
          row.title = t;
          return item;
        },
        setIcon() {
          return item;
        },
        setDisabled(d: boolean) {
          row.disabled = d;
          return item;
        },
        onClick(fn: () => void) {
          row.click = fn;
          return item;
        },
      };
      build(item);
      rows.push(row);
      return menu;
    },
  };
  return { menu: menu as unknown as Menu, rows };
}

function file(path: string): TAbstractFile {
  // `decorate` reads `.path` and passes the object through; `entryFor` asks
  // `instanceof TFolder`, which a plain object is not — so this is a file.
  return { path } as unknown as TAbstractFile;
}

async function makeCtx(): Promise<{
  defs: DefinitionStore;
  ctx: { defs: DefinitionStore; controller: SpaceController };
}> {
  const defs = new DefinitionStore({
    read: async () => undefined,
    write: async () => undefined,
  });
  await defs.mutate((d) => {
    d.spaces = [RESEARCH];
  });
  const space = defs.get().spaces[0];
  const controller = {
    activeSpace: () => space,
    currentSnapshot: () =>
      buildVisibilitySnapshot(vault, space, new Set<string>(), compileIgnore([]),
      new Set()),
    dismissRevealed: () => undefined,
      // The add now asks what the space SHOWS, which means expanding its tag
      // members. No space here holds one, so an empty index is the whole truth.
      tagIndex: () => ({ pathsMatching: () => [] }),
  } as unknown as SpaceController;
  return { defs, ctx: { defs, controller } };
}

/** Clicks the row whose title starts with `prefix`. */
async function clickRow(rows: MenuRow[], prefix: string): Promise<void> {
  const row = rows.find((r) => r.title.startsWith(prefix) && !r.disabled);
  if (!row?.click) {
    throw new Error(
      `no enabled menu row starting with "${prefix}"; got ${JSON.stringify(
        rows.map((r) => r.title)
      )}`
    );
  }
  row.click();
  // `removeAll`/`addAll` are fire-and-forget from the menu handler. Drain the
  // store's own queue rather than sleeping.
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("removal matches the way visibility matches", () => {
  let defs: DefinitionStore;
  let ctx: { defs: DefinitionStore; controller: SpaceController };

  beforeEach(async () => {
    ({ defs, ctx } = await makeCtx());
  });

  it("offers Remove for a case-mismatched member, matching what visibility already shows", () => {
    const { menu, rows } = fakeMenu();
    decorate(menu, ctx, [file("notes/a.md")]);
    expect(rows.map((r) => r.title)).toContain("Remove from Research");
  });

  it("actually removes it when the row is clicked", async () => {
    const { menu, rows } = fakeMenu();
    decorate(menu, ctx, [file("notes/a.md")]);
    await clickRow(rows, "Remove from Research");
    expect(defs.get().spaces[0].members.flatMap((m) => (m.kind === "tag" ? [] : [m.path]))).toEqual(["Inbox"]);
  });

  it("removes a case-mismatched FOLDER member too", async () => {
    const { menu, rows } = fakeMenu();
    decorate(menu, ctx, [file("inbox")]);
    await clickRow(rows, "Remove from Research");
    expect(defs.get().spaces[0].members.flatMap((m) => (m.kind === "tag" ? [] : [m.path]))).toEqual(["Notes/A.md"]);
  });

  it("prefers the exact stored entry when the vault holds both casings", async () => {
    // The write side mirrors the same safety property: in
    // `buildVisibilitySnapshot` an exact hit short-circuits before any folding,
    // so no stored member can be lost. A case-sensitive filesystem can hold
    // `Notes/A.md` and `notes/a.md` as two different files; removing the one
    // the user clicked must not take the other with it.
    const defs2 = new DefinitionStore({
      read: async () => undefined,
      write: async () => undefined,
    });
    await defs2.mutate((d) => {
      d.spaces = [
        {
          ...RESEARCH,
          members: [
            { path: "Notes/A.md", kind: "file" },
            { path: "notes/a.md", kind: "file" },
          ],
        },
      ];
    });
    const space2 = defs2.get().spaces[0];
    const bothVault = buildFakeVault({
      Notes: "folder",
      "Notes/A.md": "file",
      notes: "folder",
      "notes/a.md": "file",
    });
    const ctx2 = {
      defs: defs2,
      controller: {
        activeSpace: () => space2,
        currentSnapshot: () =>
          buildVisibilitySnapshot(bothVault, space2, new Set<string>(), compileIgnore([]),
      new Set()),
        dismissRevealed: () => undefined,
        // The add now asks what the space SHOWS, which means expanding its tag
        // members. No space here holds one, so an empty index is the whole truth.
        tagIndex: () => ({ pathsMatching: () => [] }),
      } as unknown as SpaceController,
    };
    const { menu, rows } = fakeMenu();
    decorate(menu, ctx2, [file("notes/a.md")]);
    await clickRow(rows, "Remove from Research");
    expect(defs2.get().spaces[0].members.flatMap((m) => (m.kind === "tag" ? [] : [m.path]))).toEqual(["Notes/A.md"]);
  });

  it("does not remove an unrelated member", async () => {
    const { menu, rows } = fakeMenu();
    decorate(menu, ctx, [file("notes/a.md")]);
    await clickRow(rows, "Remove from Research");
    expect(defs.get().spaces[0].members.flatMap((m) => (m.kind === "tag" ? [] : [m.path]))).toContain("Inbox");
  });
});

describe("adding does not duplicate a member the space already holds", () => {
  /**
   * This describe used to drive `addAll`'s own case-insensitive dedupe through
   * the menu: the selection below produced "Add 2 to Research", and the
   * assertion was that clicking it left `Notes/A.md` with one entry rather
   * than two.
   *
   * That route is gone, and deliberately. The menu now builds its add list
   * from the rows an add would actually CHANGE, so neither of these two rows
   * reaches `addAll` at all: `notes/a.md` resolves to the stored `Notes/A.md`
   * and is therefore an exact member whatever the casing, and `inbox/today.md`
   * is in the space through the `Inbox` folder member. The guarantee the old
   * test was protecting is now made one layer earlier and is asserted as such.
   *
   * `addAll`'s `samePath` comparison still stands behind it as the write-side
   * gate, and `tests/membership.test.ts` covers which rows the menu offers.
   */
  it("offers no Add at all when every selected row is already in the space", async () => {
    const { defs, ctx } = await makeCtx();
    const { menu, rows } = fakeMenu();
    decorate(menu, ctx, [file("notes/a.md"), file("inbox/today.md")]);
    expect(rows.filter((r) => r.title.startsWith("Add ")).map((r) => r.title)).toEqual([]);
    // And nothing was written, which is the point: the old behaviour added a
    // redundant exact member for the inherited row.
    const paths = defs.get().spaces[0].members.flatMap((m) => (m.kind === "tag" ? [] : [m.path]));
    expect(paths).toEqual(["Notes/A.md", "Inbox"]);
  });

  it("adds the one row that is not, and leaves the case-mismatched member alone", async () => {
    // The discriminator for the assertion above: with a visitor in the
    // selection there IS something to add, so "no Add entry" is a statement
    // about these rows rather than about the menu never offering one.
    const defs = new DefinitionStore({
      read: async () => undefined,
      write: async () => undefined,
    });
    await defs.mutate((d) => {
      d.spaces = [RESEARCH];
    });
    const space = defs.get().spaces[0];
    const ctx = {
      defs,
      controller: {
        activeSpace: () => space,
        // `notes/b.md` is open, so it renders as a visitor: visible, in the
        // space in no other way, and the only addable row here.
        currentSnapshot: () =>
          buildVisibilitySnapshot(
            vault,
            space,
            new Set(["notes/b.md"]),
            compileIgnore([]),
            new Set()
          ),
        dismissRevealed: () => undefined,
        // The add now asks what the space SHOWS, which means expanding its tag
        // members. No space here holds one, so an empty index is the whole truth.
        tagIndex: () => ({ pathsMatching: () => [] }),
      } as unknown as SpaceController,
    };
    const { menu, rows } = fakeMenu();
    decorate(menu, ctx, [file("notes/a.md"), file("notes/b.md"), file("inbox/today.md")]);
    // Singular, because one of the three rows is addable.
    await clickRow(rows, "Add to Research");
    const paths = defs.get().spaces[0].members.flatMap((m) => (m.kind === "tag" ? [] : [m.path]));
    // The exact list is the assertion. A `filter(...).toHaveLength(1)` on the
    // casing used to sit here as well, carried over from when this test drove
    // `addAll` directly; once the menu stopped offering the already-held row
    // it could only ever pass, because that path is no longer submitted at
    // all. A check that cannot fail reads like coverage and is not.
    expect(paths).toEqual(["Notes/A.md", "Inbox", "notes/b.md"]);
  });
});

/**
 * `src/actions/creation.ts`'s `ensureMember` carries the same comparison and is
 * canonicalised with the rest, but it has NO test here and that is deliberate
 * rather than an oversight: its only entry points, `newNoteInActiveSpace` and
 * `newFolderInActiveSpace`, call `normalizePath`, which the `obsidian` stub
 * refuses to model (a plausible-looking reimplementation would become the
 * reference the tests agree with). It is also already unreachable here:
 * `ensureMember` short-circuits on `snap.decisionFor(path).visible`, and the
 * case-insensitive matching in `buildVisibilitySnapshot` already makes a
 * case-mismatched member visible — so the change there is consistency, not a
 * second live defect.
 */

describe("coverage across a case difference", () => {
  // Both spellings of one folder exist, as on a case-sensitive filesystem,
  // beside a folder that exists in one spelling only.
  const tree = createTreeVaultIndex(
    new Map<string, "file" | "folder">([
      ["Docs", "folder"],
      ["Docs/a.md", "file"],
      ["docs", "folder"],
      ["docs/b.md", "file"],
      ["Inbox", "folder"],
      ["Inbox/x.md", "file"],
    ])
  );

  it("Docs does not cover docs/b.md when both folders exist", () => {
    const set = memberFolderSet([{ kind: "folder", path: "Docs" }], tree);
    expect(coveringFolderIn(set, "docs/b.md")).toBeNull();
    expect(coveringFolderIn(set, "Docs/a.md")).toBe("Docs");
  });

  it("docs does not cover Docs/a.md either, so the answer is not one-sided", () => {
    const set = memberFolderSet([{ kind: "folder", path: "docs" }], tree);
    expect(coveringFolderIn(set, "Docs/a.md")).toBeNull();
    expect(coveringFolderIn(set, "docs/b.md")).toBe("docs");
  });

  it("a stored spelling that has drifted still covers its children", () => {
    const set = memberFolderSet([{ kind: "folder", path: "inbox" }], tree);
    expect(coveringFolderIn(set, "Inbox/x.md")).toBe("Inbox");
  });

  it("a member whose folder is gone claims nothing and does not throw", () => {
    const set = memberFolderSet([{ kind: "folder", path: "Deleted" }], tree);
    expect(() => coveringFolderIn(set, "Docs/a.md")).not.toThrow();
    expect(coveringFolderIn(set, "Deleted/old.md")).toBeNull();
  });

  it("without a vault it still folds, as callers holding only a stored document need", () => {
    const set = memberFolderSet([{ kind: "folder", path: "Inbox" }]);
    expect(coveringFolderIn(set, "inbox/today.md")).toBe("inbox");
  });
});
