// @vitest-environment jsdom
/**
 * Compaction through the sort seam.
 *
 * Three properties, each of which has a way of being wrong that is silent:
 * substituting before ordering drops a saved arrangement; returning a tip the
 * seam does not admit renders the folder UNFILTERED, which leaks the vault
 * into the space; and a run must resolve to the deepest folder, because that
 * is what owns the row's behaviour.
 */
import { describe, expect, it } from "vitest";
// Reuse the harness in tests/filterAndOrderFolder.test.ts rather than a second one.
import { makePluginForSeam, folderItem } from "./helpers/seamHarness";

describe("compaction substitutes a run's tip for its head", () => {
  it("returns the deepest folder in place of the head", () => {
    const h = makePluginForSeam({
      compactFolderChains: true,
      tree: {
        "": ["Work"],
        Work: ["Work/Clients"],
        "Work/Clients": ["Work/Clients/Northwind"],
        "Work/Clients/Northwind": ["Work/Clients/Northwind/a.md"],
      },
      visible: ["Work", "Work/Clients", "Work/Clients/Northwind", "Work/Clients/Northwind/a.md"],
      members: ["Work/Clients/Northwind/a.md"],
    });
    const out = h.filterAndOrderFolder("", [folderItem("Work")]);
    expect(out.map((i) => i.file?.path)).toEqual(["Work/Clients/Northwind"]);
  });

  it("leaves a folder that does not compact alone", () => {
    const h = makePluginForSeam({
      compactFolderChains: true,
      tree: { "": ["Work"], Work: ["Work/a.md", "Work/b.md"] },
      visible: ["Work", "Work/a.md", "Work/b.md"],
      members: ["Work/a.md", "Work/b.md"],
    });
    const out = h.filterAndOrderFolder("", [folderItem("Work")]);
    expect(out.map((i) => i.file?.path)).toEqual(["Work"]);
  });

  it("does nothing at all when the setting is off", () => {
    const h = makePluginForSeam({
      compactFolderChains: false,
      tree: {
        "": ["Work"],
        Work: ["Work/Clients"],
        "Work/Clients": ["Work/Clients/a.md"],
      },
      visible: ["Work", "Work/Clients", "Work/Clients/a.md"],
      members: ["Work/Clients/a.md"],
    });
    const out = h.filterAndOrderFolder("", [folderItem("Work")]);
    expect(out.map((i) => i.file?.path)).toEqual(["Work"]);
  });
});

describe("compaction does not break the two things around it", () => {
  // Review Focus 2.
  it("keeps a saved manual order, which is keyed by the real child path", () => {
    const h = makePluginForSeam({
      compactFolderChains: true,
      tree: {
        "": ["Archive", "Work"],
        Work: ["Work/Clients"],
        "Work/Clients": ["Work/Clients/a.md"],
        Archive: ["Archive/old.md"],
      },
      visible: ["Work", "Work/Clients", "Work/Clients/a.md", "Archive", "Archive/old.md"],
      members: ["Work/Clients/a.md", "Archive/old.md"],
      // The user dragged Work above Archive. The order names `Work`, which is
      // the path that stops being live once its run is substituted.
      order: { "": ["Work", "Archive"] },
    });
    const out = h.filterAndOrderFolder("", [folderItem("Archive"), folderItem("Work")]);
    expect(out.map((i) => i.file?.path)).toEqual(["Work/Clients", "Archive"]);
  });

  // Review Focus 1. The loudest possible failure: the whole vault in the space.
  it("renders no row with compaction on that it hides with compaction off", () => {
    const shape = {
      tree: {
        "": ["Work", "Secret"],
        Work: ["Work/Clients"],
        "Work/Clients": ["Work/Clients/a.md"],
        Secret: ["Secret/private.md"],
      },
      visible: ["Work", "Work/Clients", "Work/Clients/a.md"],
      members: ["Work/Clients/a.md"],
    };
    const items = [folderItem("Work"), folderItem("Secret")];
    const off = makePluginForSeam({ ...shape, compactFolderChains: false });
    const on = makePluginForSeam({ ...shape, compactFolderChains: true });
    const hiddenOff = off.filterAndOrderFolder("", items).map((i) => i.file?.path);
    const hiddenOn = on.filterAndOrderFolder("", items).map((i) => i.file?.path);
    expect(hiddenOff).not.toContain("Secret");
    expect(hiddenOn).not.toContain("Secret");
  });

  // The spec claims compaction is inert in All by construction, because there
  // is no visibility snapshot there and so nothing is scaffold. Asserted
  // rather than assumed: "inert by construction" is a claim about code, and
  // this is the code.
  it("does nothing in All, where there is no snapshot and nothing is scaffold", () => {
    const h = makePluginForSeam({
      compactFolderChains: true,
      tree: {
        "": ["Work"],
        Work: ["Work/Clients"],
        "Work/Clients": ["Work/Clients/a.md"],
      },
      // All: no active space, so the controller has no snapshot to hand over.
      snapshot: null,
    });
    const out = h.filterAndOrderFolder("", [folderItem("Work")]);
    expect(out.map((i) => i.file?.path)).toEqual(["Work"]);
  });

  it("admits the tip it substituted, so the seam does not reject the whole folder", () => {
    const h = makePluginForSeam({
      compactFolderChains: true,
      tree: {
        "": ["Work"],
        Work: ["Work/Clients"],
        "Work/Clients": ["Work/Clients/a.md"],
      },
      visible: ["Work", "Work/Clients", "Work/Clients/a.md"],
      members: ["Work/Clients/a.md"],
    });
    h.filterAndOrderFolder("", [folderItem("Work")]);
    // `isAllowed` asks this for the out-of-input tip. False here means `patch`
    // hands back the raw items and the folder renders unfiltered.
    expect(h.livePermits("", "Work/Clients")).toBe(true);
    expect(h.livePermits("", "Secret")).toBe(false);
  });
});

/**
 * The same guard, through the REAL seam.
 *
 * Everything above reaches `plugin["filterAndOrderFolder"]` by hand, which
 * never puts `patch()`'s override, `isAllowed`, or the raw-items fallback at
 * `nativeExplorerSort.ts:214` on the stack — exactly the gap
 * `tests/folderSpaceHoistSeam.test.ts` was written for, now that compaction is
 * the SECOND producer of out-of-input rows.
 *
 * The "renders no row with compaction on" test above cannot close it:
 * `Secret` is dropped by `filterVisibleItems` whatever `livePermits` answers,
 * which is why that test was one of the four that PASSED during the red run,
 * before `livePermits` was touched.
 */
describe("compaction through the real sort seam", () => {
  function patchedHarness(): ReturnType<typeof makePluginForSeam> {
    return makePluginForSeam({
      compactFolderChains: true,
      tree: {
        "": ["Secret", "Work"],
        Work: ["Work/Clients"],
        "Work/Clients": ["Work/Clients/a.md"],
        Secret: ["Secret/private.md"],
      },
      visible: ["Work", "Work/Clients", "Work/Clients/a.md"],
      members: ["Work/Clients/a.md"],
    });
  }

  it("accepts the substituted tip instead of falling back to the raw vault root", () => {
    const h = patchedHarness();
    // The fallback this must not take: every row the space excludes, rendered.
    expect(h.rawRootItems().map((i) => i.file?.path)).toEqual(["Secret", "Work"]);

    const out = h.sortRootThroughSeam();

    // The tip is out-of-input by construction, so `isAllowed`'s identity half
    // cannot have passed it: this array existing at all IS the admission
    // working. Drop the `admittedThisCall` line from `livePermits` and
    // `isAllowed` refuses the whole array, `patch` returns `items`, and this
    // reads ["Secret", "Work"] — the vault inside the space, with the
    // compaction undone as well.
    expect(out.map((i) => i.file?.path)).toEqual(["Work/Clients"]);
    expect(out.map((i) => i.file?.path)).not.toContain("Secret");
  });

  it("hands back its own rows, not the raw items the fallback would return", () => {
    const h = patchedHarness();
    const raw = h.rawRootItems();
    const out = h.sortRootThroughSeam();
    // `patch` returns the INPUT array when it rejects, so "is this the
    // fallback?" is a question about the array, not only about its contents.
    // Both halves are asserted. Identity is the question the sentence above
    // asks — `rawRootItems()` re-runs the native sort, so it is an equal copy
    // of the array the seam was handed rather than that array itself, which
    // makes this the weaker of the two here; the value comparison is what
    // actually catches the fallback, since a rejection would hand back
    // `["Secret", "Work"]`.
    expect(out).not.toBe(raw);
    expect(out).not.toEqual(raw);
    expect(out).toHaveLength(1);
  });
});
