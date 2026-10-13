/**
 * Which body the create panel's explorer window draws, and what the row pinned
 * under it says.
 *
 * Layer 1: pure functions, no DOM, no `obsidian`. Tested apart from the panel
 * because this is the part of the prototype meant to outlive it — the window
 * around it is one of several look-and-feel candidates, the rules are not.
 */

import { describe, expect, it } from "vitest";
import { countPicked, pickedSummary, readPickerBody } from "../src/ui/pickerBody";
import type { MemberEntry } from "../src/types";

describe("readPickerBody", () => {
  it("draws whichever body the buttons hold", () => {
    expect(readPickerBody("items", false)).toBe("items");
    expect(readPickerBody("tags", false)).toBe("tags");
  });

  it("overrules the buttons in folder mode", () => {
    // A folder space is a window onto one root, and a tag is not one. The
    // Tags button is not drawn there at all, so a press that happened before
    // the switch must not leave the window showing tags it cannot submit.
    expect(readPickerBody("tags", true)).toBe("items");
    expect(readPickerBody("items", true)).toBe("items");
  });
});

describe("countPicked", () => {
  const file = (path: string): MemberEntry => ({ kind: "file", path });
  const folder = (path: string): MemberEntry => ({ kind: "folder", path });
  const tag = (name: string): MemberEntry => ({ kind: "tag", tag: name });

  it("counts nothing for a space with no members yet", () => {
    expect(countPicked([])).toEqual({ notes: 0, folders: 0, tags: 0, properties: 0 });
  });

  it("sorts the three kinds apart", () => {
    expect(
      countPicked([file("a.md"), tag("project"), folder("Archive"), file("b.md"), tag("inbox")])
    ).toEqual({ notes: 2, folders: 1, tags: 2, properties: 0 });
  });

  it("counts a property member as a property, not as a note", () => {
    const members: MemberEntry[] = [
      file("a.md"),
      { kind: "property", key: "status" },
      { kind: "property", key: "status", value: "done" },
    ];
    expect(countPicked(members)).toEqual({ notes: 1, folders: 0, tags: 0, properties: 2 });
  });
});

describe("pickedSummary", () => {
  it("names properties as selectors, and counts a lone property as something chosen", () => {
    expect(pickedSummary({ notes: 0, folders: 0, tags: 0, properties: 1 }, 7)).toBe(
      "7 notes • 1 property"
    );
    expect(pickedSummary({ notes: 0, folders: 1, tags: 1, properties: 2 }, 7)).toBe(
      "7 notes • 1 folder • 1 tag • 2 properties"
    );
  });

  it("says so when nothing has been chosen", () => {
    // The state the window opens in, so an empty row here would read as a row
    // that failed to draw.
    expect(pickedSummary({ notes: 0, folders: 0, tags: 0, properties: 0 }, 0)).toBe("Nothing selected");
  });

  it("leads with the notes the selection comes to, then names the selectors", () => {
    expect(pickedSummary({ notes: 3, folders: 1, tags: 2, properties: 0 }, 253)).toBe(
      "253 notes • 1 folder • 2 tags"
    );
  });

  it("leaves out a kind of selector with nothing in it", () => {
    // The row is one line tall, and "0 folders" spends it on something that is
    // not there.
    expect(pickedSummary({ notes: 0, folders: 0, tags: 1, properties: 0 }, 253)).toBe("253 notes • 1 tag");
    expect(pickedSummary({ notes: 0, folders: 1, tags: 0, properties: 0 }, 50)).toBe("50 notes • 1 folder");
    expect(pickedSummary({ notes: 0, folders: 2, tags: 4, properties: 0 }, 9)).toBe("9 notes • 2 folders • 4 tags");
  });

  it("reads naturally for one of each kind", () => {
    expect(pickedSummary({ notes: 1, folders: 1, tags: 1, properties: 0 }, 1)).toBe("1 note • 1 folder • 1 tag");
  });

  it("says just the notes when notes alone were picked", () => {
    expect(pickedSummary({ notes: 3, folders: 0, tags: 0, properties: 0 }, 3)).toBe("3 notes");
  });

  it("prints the resolved total, not how many notes were picked by hand", () => {
    // Three by hand, but a folder and a tag overlap them: the figure is what
    // the caller resolved, and the hand-picked count appears nowhere.
    const text = pickedSummary({ notes: 3, folders: 1, tags: 2, properties: 0 }, 41);
    expect(text).toBe("41 notes • 1 folder • 2 tags");
    expect(text).not.toMatch(/3 notes/);
  });

  it("words a selection that comes to nothing", () => {
    // A tag nothing carries yet, or an empty folder. A bare `0` reads as a
    // count that failed to arrive rather than as an answer.
    expect(pickedSummary({ notes: 0, folders: 0, tags: 1, properties: 0 }, 0)).toBe("no notes • 1 tag");
    expect(pickedSummary({ notes: 0, folders: 1, tags: 0, properties: 0 }, 0)).toBe("no notes • 1 folder");
  });

  it("still reports a selection whose notes have all gone", () => {
    expect(pickedSummary({ notes: 1, folders: 0, tags: 0, properties: 0 }, 0)).toBe("no notes");
  });

  it("prints no second figure", () => {
    expect(pickedSummary({ notes: 3, folders: 1, tags: 2, properties: 0 }, 253)).not.toContain("·");
  });

  it("uses the plugin's own words for what a space holds", () => {
    // "notes and folders" is what the README, the settings tab and the tag
    // rows' own counts say. A picker with a third vocabulary for the same two
    // things would make the reader check whether a third thing was meant.
    const text = pickedSummary({ notes: 2, folders: 2, tags: 2, properties: 0 }, 20);
    expect(text).not.toMatch(/file|item/i);
  });

  it("writes no em dash", () => {
    expect(pickedSummary({ notes: 1, folders: 1, tags: 1, properties: 0 }, 5)).not.toMatch(/—/);
  });

  it("groups a large count by locale, like every other number here", () => {
    // A vault where this matters is exactly the vault where unseparated digits
    // are hard to read.
    expect(pickedSummary({ notes: 1234, folders: 0, tags: 0, properties: 0 }, 1234)).toBe(
      `${(1234).toLocaleString()} notes`
    );
    expect(pickedSummary({ notes: 0, folders: 1, tags: 0, properties: 0 }, 1234)).toBe(
      `${(1234).toLocaleString()} notes • 1 folder`
    );
  });
});
