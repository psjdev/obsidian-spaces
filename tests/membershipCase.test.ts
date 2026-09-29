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

describe("adding does not duplicate a case-mismatched member", () => {
  it("declines to add a second entry for a path already stored in another casing", async () => {
    const { defs, ctx } = await makeCtx();
    const { menu, rows } = fakeMenu();
    // A mixed selection is what makes the menu offer Add at all: `inbox/today.md`
    // is visible by INHERITANCE from the `Inbox` folder member, so not every row
    // is an exact member and `decorate` falls through to "Add 2 to Research".
    // `notes/a.md` is already stored — as `Notes/A.md` — and must not gain a
    // second entry for the same file.
    decorate(menu, ctx, [file("notes/a.md"), file("inbox/today.md")]);
    await clickRow(rows, "Add ");
    const paths = defs.get().spaces[0].members.flatMap((m) => (m.kind === "tag" ? [] : [m.path]));
    expect(paths.filter((p) => p.toLowerCase() === "notes/a.md")).toHaveLength(1);
    expect(paths).toContain("inbox/today.md");
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
