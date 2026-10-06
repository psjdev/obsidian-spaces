// @vitest-environment jsdom
/**
 * "Is this note already in the pinned folder?" answered by FOLDER IDENTITY.
 *
 * The question has one honest answer and the old implementation did not give
 * it. It folded both paths to lower case and compared the strings, which is
 * right on Windows and on a default macOS volume and WRONG on a case sensitive
 * filesystem -- Linux, or a case sensitive APFS/exFAT volume -- where `Inbox`
 * and `inbox` are two different folders holding two different sets of notes.
 * There, `inbox/x.md` dropped on a space pinned to `Inbox` was reported
 * "x.md is already in Inbox" while sitting somewhere else entirely, and the
 * move the user asked for never happened.
 *
 * Comparing the parent folder OBJECT to the root folder OBJECT has no such
 * failure mode: two names are the same folder exactly when the vault says they
 * are, and the vault is the only thing that knows its own filesystem.
 *
 * WHAT THIS FILE CAN AND CANNOT SEE. `normalizePath` is deliberately not
 * modelled by the `obsidian` stub (read its docstring), so a move that proceeds
 * cannot complete here. `vi.mock` below substitutes an identity function for
 * that ONE export so the branch under test can run to its Notice. Everything
 * else comes from the real stub, including the `TFolder` identity that the fix
 * turns on.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => {
  const real = await importOriginal<typeof import("obsidian")>();
  return { ...real, normalizePath: (p: string): string => p };
});

import SpacesPlugin from "../src/main";
import { TFile, TFolder, noticeLog } from "./helpers/obsidian-stub";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";

/**
 * A vault with two folders whose names differ only in case, and one note in
 * each. This is the shape that only EXISTS on a case sensitive filesystem, and
 * it is the shape the old comparison could not tell apart.
 */
function makeVault(): {
  plugin: SpacesPlugin;
  files: Map<string, TFolder | TFile>;
  renamed: Array<[string, string]>;
} {
  const files = new Map<string, TFolder | TFile>();
  const folder = (path: string): TFolder => {
    const f = new TFolder();
    f.path = path;
    f.name = path;
    files.set(path, f);
    return f;
  };
  const note = (path: string, parent: TFolder | null): TFile => {
    const f = new TFile();
    f.path = path;
    f.name = path.slice(path.lastIndexOf("/") + 1);
    f.parent = parent;
    files.set(path, f);
    return f;
  };
  const upper = folder("Inbox");
  const lower = folder("inbox");
  note("Inbox/x.md", upper);
  note("inbox/x.md", lower);

  const renamed: Array<[string, string]> = [];
  const app = {
    vault: {
      getAbstractFileByPath: (p: string): TFolder | TFile | null => files.get(p) ?? null,
    },
    fileManager: {
      renameFile: async (f: TFile, dest: string): Promise<void> => {
        renamed.push([f.path, dest]);
      },
    },
    workspace: {
      containerEl: document.createElement("div"),
      getLeavesOfType: (): unknown[] => [],
    },
  };
  const plugin = new SpacesPlugin(
    app as unknown as ConstructorParameters<typeof SpacesPlugin>[0],
    {} as ConstructorParameters<typeof SpacesPlugin>[1]
  );
  plugin["defs"] = new DefinitionStore({
    read: async () => undefined,
    write: async () => undefined,
  });
  const backing = new Map<string, unknown>();
  plugin["runtime"] = new RuntimeStateStore({
    get: (k) => backing.get(k),
    set: (k, v) => void backing.set(k, v),
  });
  return { plugin, files, renamed };
}

function moveIntoRoot(plugin: SpacesPlugin, file: TFile | TFolder, root: string): Promise<void> {
  // The stub's classes satisfy the `instanceof` discriminators `moveIntoRoot`
  // uses, which is all it reads them for; the declared `vault` field is the one
  // place the shapes diverge, and nothing on this path touches it.
  return plugin["moveIntoRoot"](
    [file] as unknown as Parameters<SpacesPlugin["moveIntoRoot"]>[0],
    root,
    "Work"
  );
}

function messages(): string[] {
  return noticeLog.map((n) => (typeof n.message === "string" ? n.message : "<fragment>"));
}

describe("SpacesPlugin.moveIntoRoot — already in the root, by folder identity", () => {
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const n of noticeLog) n.__destroy();
    noticeLog.length = 0;
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errors.mockRestore();
  });

  /**
   * The repro. `inbox/x.md` is NOT in `Inbox`, and must be moved there.
   *
   * The mutation this kills is the one that was shipped: comparing
   * `canonicalPath(parent)` with `canonicalPath(root)`. That version reports
   * "already in" here and performs no rename at all.
   */
  it("moves a note whose folder differs from the root only in case", async () => {
    const { plugin, files, renamed } = makeVault();
    await moveIntoRoot(plugin, files.get("inbox/x.md") as TFile, "Inbox");
    expect(renamed).toEqual([["inbox/x.md", "Inbox/x.md"]]);
    expect(messages().join(" | ")).not.toMatch(/already in/);
  });

  // The other half of the same comparison, and the control for the test above:
  // a note genuinely in the root is still reported as already there and is not
  // renamed onto itself.
  it("leaves a note that is genuinely in the root alone", async () => {
    const { plugin, files, renamed } = makeVault();
    await moveIntoRoot(plugin, files.get("Inbox/x.md") as TFile, "Inbox");
    expect(renamed).toEqual([]);
    expect(messages().join(" | ")).toMatch(/already in/);
  });

  // A file at the vault root has `parent === null`. Nothing may make that look
  // like a match for a root folder, or every such file would be reported as
  // already home and never move.
  it("moves a note from the vault root into the pinned folder", async () => {
    const { plugin, files, renamed } = makeVault();
    const loose = new TFile();
    loose.path = "loose.md";
    loose.name = "loose.md";
    loose.parent = null;
    files.set("loose.md", loose);
    await moveIntoRoot(plugin, loose, "Inbox");
    expect(renamed).toEqual([["loose.md", "Inbox/loose.md"]]);
  });

  /**
   * The root resolved to something that is not a folder any more, between the
   * drop's own check and this call. Refused outright rather than compared
   * against null, because `f.parent` is null for a vault-root file and a null
   * root would make every one of them look already home.
   */
  it("refuses, and says so, when the pinned folder has gone", async () => {
    const { plugin, files, renamed } = makeVault();
    await moveIntoRoot(plugin, files.get("inbox/x.md") as TFile, "Gone");
    expect(renamed).toEqual([]);
    expect(messages().join(" | ")).toMatch(/folder is missing/);
  });

  // The destination, not only the space. A move cannot be undone, so the notice
  // has to say where the note now is: "Moved x.md into Work" does not, when
  // Work is pinned to a folder the user has not looked at in a month.
  it("names the destination folder in the notice, not only the space", async () => {
    const { plugin, files } = makeVault();
    await moveIntoRoot(plugin, files.get("inbox/x.md") as TFile, "Inbox");
    expect(messages()[0]).toMatch(/Work \(Inbox\)/);
  });
});
