import { describe, expect, it } from "vitest";
import { spaceAddTargets } from "../src/actions/spaceAddTargets";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import type { SpaceDefinition } from "../src/types";

/**
 * A vault where no note carries a tag. Most of these cases are about paths,
 * and a tag index that matches nothing keeps them reading as they did before
 * tag members existed; the tag cases below pass a populated one.
 */
const noTags = createMapTagIndex(new Map());

/** `spaceAddTargets` with the tag-free vault, so each case says only what it is about. */
const targets = (
  spaces: readonly SpaceDefinition[],
  paths: readonly string[]
): ReturnType<typeof spaceAddTargets> => spaceAddTargets(spaces, paths, noTags);

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
    const out = targets([WORK, LAB, EMPTY], ["Loose.md"]);
    expect(out.map((t) => t.id)).toEqual(["work", "lab", "empty"]);
  });

  it("returns nothing when there are no spaces", () => {
    // The caller adds no menu entry at all rather than an empty submenu.
    expect(targets([], ["Loose.md"])).toEqual([]);
  });

  it("enables a space that does not already hold the path", () => {
    const out = targets([EMPTY], ["Loose.md"]);
    expect(out[0]).toMatchObject({ name: "Empty", disabled: false, label: "Empty" });
  });

  it("disables a space where the path is an EXACT member", () => {
    const out = targets([LAB], ["Notes/A.md"]);
    expect(out[0]).toMatchObject({ disabled: true, label: "Lab (already added)" });
  });

  it("disables a space where the path is INHERITED from a member folder", () => {
    // Adding an exact entry for something a folder member already covers
    // would be a second claim on the same path.
    const out = targets([WORK], ["Projects/Deep/Note.md"]);
    expect(out[0]).toMatchObject({ disabled: true, label: "Work (already in Projects)" });
  });

  it("disables only when EVERY selected path is already a member", () => {
    // A mixed selection still has something to add, so the entry must work.
    const out = targets([WORK], ["Projects/In.md", "Loose.md"]);
    expect(out[0].disabled).toBe(false);
  });

  it("counts the paths it would actually add, not the whole selection", () => {
    const out = targets([WORK], ["Projects/In.md", "Loose.md", "Other.md"]);
    expect(out[0]).toMatchObject({ addablePaths: ["Loose.md", "Other.md"], label: "Work (2)" });
  });

  it("carries icon and color so the submenu can look like the switcher", () => {
    const out = targets([WORK], ["Loose.md"]);
    expect(out[0]).toMatchObject({ icon: "box", color: "#5b5bff" });
  });

  it("treats a folder member as covering the folder itself", () => {
    // Right-clicking `Projects` while Work already has it must not offer to
    // add it again.
    const out = targets([WORK], ["Projects"]);
    expect(out[0].disabled).toBe(true);
  });

  it("does not treat a sibling with a shared prefix as inherited", () => {
    // `Projects2` is not under `Projects`; a prefix check without the
    // separator would wrongly call it a member.
    const out = targets([WORK], ["Projects2/Note.md"]);
    expect(out[0].disabled).toBe(false);
  });

  it("returns an empty selection as nothing addable, and disables", () => {
    const out = targets([EMPTY], []);
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

    expect(targets(spaces, ["Inbox/Note.md"]).map((t) => t.id)).toEqual(["research"]);
  });
});

/**
 * *All*'s "Add to space" decided "already held" from the stored path members
 * plus `inheritedFromFolder`, which is blind to tag members: the entry was
 * offered for a note the space already contains, and taking it wrote a
 * second, redundant claim on a path the space had anyway.
 */
describe("spaceAddTargets and tag members", () => {
  const TAGGED = space({
    id: "tagged",
    name: "Tagged",
    members: [{ kind: "tag", tag: "project" }],
  });
  const index = createMapTagIndex(
    new Map([
      ["Anywhere/Tagged.md", ["project"]],
      ["Anywhere/Nested.md", ["project/atlas"]],
      ["Anywhere/Plain.md", []],
    ])
  );

  it("does not offer a note the space already holds through a tag", () => {
    const out = spaceAddTargets([TAGGED], ["Anywhere/Tagged.md"], index);
    expect(out[0]).toMatchObject({ disabled: true, addablePaths: [] });
    expect(out[0].label).toBe("Tagged (already added)");
  });

  it("counts a nested tag as held too, matching the engine", () => {
    const out = spaceAddTargets([TAGGED], ["Anywhere/Nested.md"], index);
    expect(out[0].disabled).toBe(true);
  });

  it("still offers a note the tag does not reach", () => {
    const out = spaceAddTargets([TAGGED], ["Anywhere/Plain.md"], index);
    expect(out[0]).toMatchObject({ disabled: false, addablePaths: ["Anywhere/Plain.md"] });
  });

  it("offers a tag-matched note the space EXCLUDES", () => {
    // `resolveMembers` drops an excluded tag match, so the space does not
    // show it — and adding it by hand is the one gesture that brings it
    // back, because an exact member is a seed.
    const excluding = space({
      id: "tagged",
      name: "Tagged",
      exclude: ["Anywhere/Tagged.md"],
      members: [{ kind: "tag", tag: "project" }],
    });
    const out = spaceAddTargets([excluding], ["Anywhere/Tagged.md"], index);
    expect(out[0]).toMatchObject({ disabled: false, addablePaths: ["Anywhere/Tagged.md"] });
  });

  it("expands each space's tag members once, not once per selected path", () => {
    // A tag member costs a pass over every note in the vault to expand, and a
    // fifty-file selection must not pay for fifty of them.
    let lookups = 0;
    const counting = {
      pathsMatching: (tag: string): string[] => {
        lookups++;
        return index.pathsMatching(tag);
      },
    };
    spaceAddTargets([TAGGED], ["a.md", "b.md", "c.md", "d.md"], counting);
    expect(lookups).toBe(1);
  });
});

/**
 * The engine's precedence: an exclusion beats everything except an explicit
 * path member, because seeds (exact members, and expanded tag matches) bypass
 * the inherited-descendants step where exclusions are consulted. A folder
 * member's coverage of a descendant is exactly that inherited step, so it
 * must lose to an exclusion the same way the tree and `SpacesApi.isMember`
 * already agree it does.
 */
describe("spaceAddTargets and exclusions", () => {
  it("offers a note a member folder covers but the space excludes", () => {
    // The tree does not show this note (the exclusion wins over the folder's
    // inherited coverage) and `isMember` already answers false for it, so the
    // "Add to space" menu must not call it already held either — that
    // disagreement is the only way back into the note besides hand-editing
    // data.json or removing the exclusion first.
    const excluding = space({
      id: "work",
      name: "Work",
      members: [{ path: "Projects", kind: "folder" }],
      exclude: ["Projects/Deep/Note.md"],
    });
    const out = targets([excluding], ["Projects/Deep/Note.md"]);
    expect(out[0]).toMatchObject({ disabled: false, addablePaths: ["Projects/Deep/Note.md"] });
  });

  it("still treats an explicit file member as held even when also excluded", () => {
    // An exact member is a seed: it survives its own exclusion, and this
    // state is only reachable by hand-editing data.json (removing a
    // hand-added member removes the member, it does not write an exclusion).
    // The menu must keep calling it held, matching `isMember`'s rule 1.
    const excludedMember = space({
      id: "lab",
      name: "Lab",
      members: [{ path: "Notes/A.md", kind: "file" }],
      exclude: ["Notes/A.md"],
    });
    const out = targets([excludedMember], ["Notes/A.md"]);
    expect(out[0]).toMatchObject({ disabled: true, label: "Lab (already added)" });
  });

  it("still treats an explicit folder member as held even when also excluded", () => {
    // Same seed reasoning as the file case above, for a folder member
    // selected as itself (the same case covered by "treats a folder member
    // as covering the folder itself").
    const excludedFolder = space({
      id: "work",
      name: "Work",
      members: [{ path: "Projects", kind: "folder" }],
      exclude: ["Projects"],
    });
    const out = targets([excludedFolder], ["Projects"]);
    expect(out[0].disabled).toBe(true);
  });
});
