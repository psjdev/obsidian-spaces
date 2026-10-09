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
