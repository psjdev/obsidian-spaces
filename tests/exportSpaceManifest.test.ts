import { describe, expect, it } from "vitest";
import type { SpaceDefinition } from "../src/types";
import { MANIFEST_FILENAME, buildSpaceManifest } from "../src/export/spaceManifest";

const NOW = new Date("2026-10-25T10:00:00Z");

const curated: SpaceDefinition = {
  id: "reading",
  name: "Reading",
  icon: "book-open",
  color: "#4ecdc4",
  members: [{ path: "Reading/book.md", kind: "file" }],
};

const folderSpace: SpaceDefinition = {
  id: "kitchen",
  name: "Kitchen",
  icon: "hammer",
  color: "#ff6b6b",
  root: "Projects/Kitchen",
  members: [],
};

const entries = [
  { sourcePath: "Reading/book.md", why: "member" as const },
  { sourcePath: "Attachments/diagram.png", why: "referenced" as const },
];

const base = { space: curated, order: undefined, entries, now: NOW };

describe("buildSpaceManifest", () => {
  it("records a curated space by its members", () => {
    const m = buildSpaceManifest(base);
    expect(m.space.members).toEqual([{ path: "Reading/book.md", kind: "file" }]);
    expect(m.space.root).toBeUndefined();
  });

  it("records a folder space by its root, and omits members entirely", () => {
    // `members: []` would say the space is empty, which is the one thing
    // this file exists to prevent. A folder space's identity IS its root.
    const m = buildSpaceManifest({ ...base, space: folderSpace });
    expect(m.space.root).toBe("Projects/Kitchen");
    expect("members" in m.space).toBe(false);
  });

  it("separates what the space held from what the export contains", () => {
    // One-hop files are in the export but are NOT members. A future importer
    // must not mistake an attachment for something the user chose.
    const m = buildSpaceManifest(base);
    expect(m.contents.members).toEqual(["Reading/book.md"]);
    expect(m.contents.referenced).toEqual(["Attachments/diagram.png"]);
  });

  it("carries the stored order", () => {
    // Required by the design. Orders live at
    // `SpacesDefinitions.orders.bySpaceId`, outside `SpaceDefinition`, so
    // they have to be passed in; an earlier draft could not reach them.
    // OrderMap is Record<folderPath, childPaths[]>, keyed by the FOLDER.
    const order = { Reading: ["Reading/book.md"] };
    const m = buildSpaceManifest({ ...base, order });
    expect(m.space.order).toEqual(order);
  });

  it("omits the order when the space has none", () => {
    expect("order" in buildSpaceManifest(base).space).toBe(false);
  });

  it("never writes the exclude list", () => {
    // Those are paths the user deliberately hid, and this file is designed
    // to be handed to someone else.
    const withExclude: SpaceDefinition = {
      ...curated,
      exclude: ["Projects/Kitchen/budget.md"],
    };
    const json = JSON.stringify(buildSpaceManifest({ ...base, space: withExclude }));
    expect(json).not.toContain("budget.md");
    expect(json).not.toContain("exclude");
  });

  it("never writes the archived flag, which is about the vault it left", () => {
    const archived: SpaceDefinition = { ...curated, archived: true };
    expect(JSON.stringify(buildSpaceManifest({ ...base, space: archived })))
      .not.toContain("archived");
  });

  it("carries a format version and the export time", () => {
    const m = buildSpaceManifest(base);
    expect(m.formatVersion).toBe(1);
    expect(m.exportedAt).toBe("2026-10-25T10:00:00.000Z");
  });

  it("is named so it cannot be mistaken for a note", () => {
    // It sits at the export root beside mirrored vault paths. A vault with
    // `space.json` at its root would collide with an obvious name. The
    // `spaces-` prefix is avoided on purpose: stylesCoupling scans src for
    // it and would read this filename as an unstyled CSS class.
    expect(MANIFEST_FILENAME).toBe(".space-export.json");
  });

  it("serializes to JSON without undefined holes", () => {
    const json = JSON.stringify(buildSpaceManifest({ ...base, space: folderSpace }));
    expect(json).not.toContain("undefined");
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
