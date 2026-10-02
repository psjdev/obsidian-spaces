// @vitest-environment jsdom
/**
 * Where a new note or folder lands.
 *
 * `destinationFolder` is the pure decision inside `newNoteInActiveSpace` /
 * `newFolderInActiveSpace`: resolve the space's root, notice and fall back
 * when it cannot be honoured, or fall back silently when there is no root at
 * all. It is exported for exactly this test — the alternative is asserting it
 * through the two creation commands, which also touch the vault via
 * `app.vault.create`/`createFolder` and would make this a Layer 4 test for a
 * decision that has none of Layer 4's reasons to be one.
 *
 * `jsdom` is required because `new Notice(...)` (via the `obsidian` stub)
 * needs a `document` to attach its toast to.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { TFolder, noticeLog } from "./helpers/obsidian-stub";
import { destinationFolder, spaceDestination } from "../src/actions/creation";
import type { SpaceDefinition } from "../src/types";

/**
 * The small structural slice `destinationFolder` reads: `vault.getAbstractFileByPath`
 * to check the root exists and is a folder, `fileManager.getNewFileParent` for
 * the fallback. Built directly rather than via `new App()` (which the stub
 * deliberately refuses — see obsidian-stub.ts) because this is the "small
 * structural shape your code actually reads" the stub's own guidance asks for.
 */
function fakeApp(o: { folders: string[] }): App {
  const folders = new Map<string, TFolder>();
  for (const p of o.folders) {
    const f = new TFolder();
    f.path = p;
    folders.set(p, f);
  }
  // Obsidian's own default-location fallback (the cited behaviour): a
  // fixed vault-root TFolder, distinct in identity from anything in `folders`
  // so a test can never pass by accident.
  const fallbackParent = new TFolder();
  fallbackParent.path = "";

  // Measured, not modelled: against the fixture vault on
  // Obsidian 1.13.7, `app.vault.getAbstractFileByPath('/')` returns the
  // SAME object as `app.vault.getRoot()` (same constructor as any other
  // folder, path `'/'`) — it does NOT return null the way `''` does. The
  // missing-root state treats `''` and `'/'` as equivalent, but at THIS
  // seam they are not: `''` fails `getAbstractFileByPath` (measured null)
  // while `'/'` resolves to a real, `instanceof TFolder` root. Guessing
  // this behaviour without measuring it would have been exactly the
  // "worse than no fake" failure obsidian-stub.ts warns about, so the fake
  // follows the measurement rather than assuming null.
  const rootFolder = new TFolder();
  rootFolder.path = "/";

  return {
    vault: {
      getAbstractFileByPath: (p: string) => (p === "/" ? rootFolder : (folders.get(p) ?? null)),
    },
    fileManager: {
      getNewFileParent: (_sourcePath: string) => fallbackParent,
    },
  } as unknown as App;
}

describe("destinationFolder", () => {
  beforeEach(() => {
    for (const n of noticeLog) n.__destroy();
    noticeLog.length = 0;
  });

  it("creates into a folder space's root", () => {
    const app = fakeApp({ folders: ["Projects/Work"] });
    expect(destinationFolder(app, "Projects/Work")).toBe("Projects/Work");
  });

  it("falls back and notices when the root is missing", () => {
    const app = fakeApp({ folders: [] });
    expect(destinationFolder(app, "Projects/Gone")).toBe(app.fileManager.getNewFileParent("").path);
    expect(noticeLog.map((n) => n.message).join(" ")).toContain("missing");
  });

  it("falls back with no notice when there is no root at all", () => {
    // A curated space is not in an error state; it simply has no write target.
    const app = fakeApp({ folders: [] });
    noticeLog.length = 0;
    expect(destinationFolder(app, undefined)).toBe(app.fileManager.getNewFileParent("").path);
    expect(noticeLog).toEqual([]);
  });

  // `if (root)` is falsy for "", so it never does the vault lookup at all
  // and falls back exactly like `undefined` (previous test) — it never
  // reaches the TFolder check.
  it("falls back with no notice for the missing-root state root=\"\"", () => {
    const app = fakeApp({ folders: [] });
    noticeLog.length = 0;
    // The literal, not `app.fileManager.getNewFileParent("").path` — that
    // re-derives the expectation from the same fake `destinationFolder`
    // itself falls back to, so a bug that broke BOTH identically would still
    // pass. `fakeApp`'s `fallbackParent.path` is `""` (see its own comment);
    // asserting that value directly is what actually pins the fallback.
    expect(destinationFolder(app, "")).toBe("");
    expect(noticeLog).toEqual([]);
  });

  // The missing-root state treats "" and "/" as equivalent, but they reach
  // `destinationFolder` — which does its own raw
  // vault.getAbstractFileByPath(root) lookup rather than going through
  // `isVaultRoot`/`rootOf` — by genuinely different paths. "/" is truthy, so
  // unlike "" it DOES reach the lookup, and (measured against the fixture
  // vault, Obsidian 1.13.7) `getAbstractFileByPath('/')` returns
  // the vault's own root TFolder — the same object `getRoot()` returns, same
  // constructor as any other folder — so it PASSES `instanceof TFolder` and
  // resolves silently to "/" itself, never reaching the Notice branch at all.
  // The two creation commands no longer reach this with "/": both now pass
  // `rootOf(space) ?? undefined`, which reads that spelling as "no root
  // chosen" and arrives here as `undefined` (see the command test below).
  //
  // Kept as a statement about THIS function, which still does its own raw
  // `getAbstractFileByPath(root)` lookup rather than going through
  // `isVaultRoot`/`rootOf`, so the behaviour is worth pinning even though
  // `spaceDestination` is now its only production caller and cannot produce
  // "/". An earlier version of this comment claimed `newFileLocation.ts`
  // calls it with a raw string; it does not, and says in its own comment why
  // it must not (it would recurse through the patched `getNewFileParent`).
  it("resolves the missing-root spelling \"/\" to the vault root, silently", () => {
    const app = fakeApp({ folders: [] });
    expect(destinationFolder(app, "/")).toBe("/");
    expect(noticeLog).toEqual([]);
  });

});

/**
 * The seam the two creation commands ask, for the one input where
 * `space.root` and `rootOf(space)` disagree.
 *
 * A hand-edited `root: "/"` is kept by the schema rather than deleting the
 * space, and `rootOf` reads it as "no root chosen" — so the tree renders the
 * missing-root empty state. Asked with the raw string, `destinationFolder`
 * answers "/" (the test above pins that), and the note was created at the
 * vault root: outside the pinned folder, and outside anything the tree was
 * showing.
 *
 * `spaceDestination` rather than `newNoteInActiveSpace` because the commands
 * cannot be called here at all: they go through `normalizePath`, which the
 * `obsidian` stub refuses to model. The commands hold nothing else of this
 * decision — each is one line reading this function.
 */
describe("spaceDestination", () => {
  function space(root: string | undefined): SpaceDefinition {
    return { id: "s1", name: "Pinned", icon: "box", color: "#000000", members: [], root };
  }

  it("falls back to the default location for the missing-root spelling \"/\"", () => {
    const app = fakeApp({ folders: [] });
    // `fakeApp`'s fallback parent, asserted as the literal for the reason the
    // root="" test above gives.
    expect(spaceDestination(app, space("/"))).toBe("");
  });

  it("still creates into a real root, so the fallback above is not unconditional", () => {
    const app = fakeApp({ folders: ["Projects/Work"] });
    expect(spaceDestination(app, space("Projects/Work"))).toBe("Projects/Work");
  });

  it("still notices a root that is declared but gone", () => {
    const app = fakeApp({ folders: [] });
    noticeLog.length = 0;
    expect(spaceDestination(app, space("Projects/Gone"))).toBe("");
    expect(noticeLog).toHaveLength(1);
  });
});
