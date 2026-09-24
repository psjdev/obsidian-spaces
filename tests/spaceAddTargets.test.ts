import { describe, expect, it } from "vitest";
import { spaceAddTargets } from "../src/actions/spaceAddTargets";
import type { SpaceDefinition } from "../src/types";

const space = (over: Partial<SpaceDefinition>): SpaceDefinition => ({
  id: "s",
  name: "S",
  icon: "box",
  color: "#5b5bff",
  members: [],
  ...over,
});

const WORK = space({ id: "work", name: "Work", members: [{ path: "Projects", kind: "folder" }] });
const LAB = space({ id: "lab", name: "Lab", members: [{ path: "Notes/A.md", kind: "file" }] });
const EMPTY = space({ id: "empty", name: "Empty" });

describe("spaceAddTargets", () => {
  it("lists every space in definition order", () => {
    const out = spaceAddTargets([WORK, LAB, EMPTY], ["Loose.md"]);
    expect(out.map((t) => t.id)).toEqual(["work", "lab", "empty"]);
  });

  it("returns nothing when there are no spaces", () => {
    // The caller adds no menu entry at all rather than an empty submenu.
    expect(spaceAddTargets([], ["Loose.md"])).toEqual([]);
  });

  it("enables a space that does not already hold the path", () => {
    const out = spaceAddTargets([EMPTY], ["Loose.md"]);
    expect(out[0]).toMatchObject({ name: "Empty", disabled: false, label: "Empty" });
  });

  it("disables a space where the path is an EXACT member", () => {
    const out = spaceAddTargets([LAB], ["Notes/A.md"]);
    expect(out[0]).toMatchObject({ disabled: true, label: "Lab (already added)" });
  });

  it("disables a space where the path is INHERITED from a member folder", () => {
    // Adding an exact entry for something a folder member already covers
    // would be a second claim on the same path.
    const out = spaceAddTargets([WORK], ["Projects/Deep/Note.md"]);
    expect(out[0]).toMatchObject({ disabled: true, label: "Work (already in Projects)" });
  });

  it("disables only when EVERY selected path is already a member", () => {
    // A mixed selection still has something to add, so the entry must work.
    const out = spaceAddTargets([WORK], ["Projects/In.md", "Loose.md"]);
    expect(out[0].disabled).toBe(false);
  });

  it("counts the paths it would actually add, not the whole selection", () => {
    const out = spaceAddTargets([WORK], ["Projects/In.md", "Loose.md", "Other.md"]);
    expect(out[0]).toMatchObject({ addablePaths: ["Loose.md", "Other.md"], label: "Work (2)" });
  });

  it("carries icon and color so the submenu can look like the switcher", () => {
    const out = spaceAddTargets([WORK], ["Loose.md"]);
    expect(out[0]).toMatchObject({ icon: "box", color: "#5b5bff" });
  });

  it("treats a folder member as covering the folder itself", () => {
    // Right-clicking `Projects` while Work already has it must not offer to
    // add it again.
    const out = spaceAddTargets([WORK], ["Projects"]);
    expect(out[0].disabled).toBe(true);
  });

  it("does not treat a sibling with a shared prefix as inherited", () => {
    // `Projects2` is not under `Projects`; a prefix check without the
    // separator would wrongly call it a member.
    const out = spaceAddTargets([WORK], ["Projects2/Note.md"]);
    expect(out[0].disabled).toBe(false);
  });

  it("returns an empty selection as nothing addable, and disables", () => {
    const out = spaceAddTargets([EMPTY], []);
    expect(out[0]).toMatchObject({ disabled: true, addablePaths: [] });
  });

  it("omits folder spaces entirely", () => {
    // A folder space cannot accept a path from elsewhere without moving the
    // file, which a space operation must never do. Listing it would offer an
    // action that cannot be honoured.
    const spaces = [
      { id: "research", name: "Research", icon: "microscope", color: "#4ecdc4",
        members: [{ path: "Papers", kind: "folder" as const }] },
      { id: "work", name: "Work", icon: "briefcase", color: "#5b5bff",
        root: "Projects/Work", members: [] },
    ] as SpaceDefinition[];

    expect(spaceAddTargets(spaces, ["Inbox/Note.md"]).map((t) => t.id)).toEqual(["research"]);
  });
});
