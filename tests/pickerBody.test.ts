/**
 * The rule that decides what the create panel's explorer window is showing,
 * now that the window has two doors into tags: the `#` sigil in the filter box
 * and the tag icon in its own corner.
 *
 * Layer 1: pure functions, no DOM, no `obsidian`. Tested apart from the panel
 * because this is the part of the prototype meant to outlive it — the window
 * around it is one of several look-and-feel candidates, the rule is not.
 */

import { describe, expect, it } from "vitest";
import { leaveTagView, readPickerBody, tagToggleLabel } from "../src/ui/pickerBody";

describe("readPickerBody", () => {
  it("leaves an ordinary filter to the tree, byte for byte", () => {
    // The tree is the control across every one of these prototypes. Anything
    // done to the filter on the way past would make each of its behaviours a
    // new behaviour, so this asserts identity rather than equivalence.
    for (const raw of ["", "plan", "  plan  ", "Projects/Work", "a#b", "PLAN"]) {
      expect(readPickerBody(raw, false)).toEqual({ body: "tree", query: raw });
    }
  });

  it("shows what was chosen when the icon is on and the box is empty", () => {
    // The review-and-remove list, and the only place a chosen tag is visible
    // now that the row of chips above the window is gone.
    expect(readPickerBody("", true)).toEqual({ body: "tag-chosen", query: "" });
  });

  it("counts a box holding only whitespace as empty", () => {
    // Whitespace is invisible, so it must not be the difference between the
    // list of what you chose and a search that will match nothing.
    expect(readPickerBody("   ", true)).toEqual({ body: "tag-chosen", query: "" });
  });

  it("searches the vault once the box has text, with no sigil needed", () => {
    // The icon has already said "tags", so the sigil would be a second way of
    // saying it. Typing is just typing.
    expect(readPickerBody("proj", true)).toEqual({ body: "tag-search", query: "proj" });
  });

  it("still enters the search on a leading sigil with the icon off", () => {
    expect(readPickerBody("#proj", false)).toEqual({ body: "tag-search", query: "proj" });
  });

  it("browses the whole tag list on a bare sigil", () => {
    // The sigil is TEXT in the box, and text searches. A bare `#` searches
    // with an empty query, which is the browse the sigil has always been: it
    // is how someone with nothing chosen yet goes looking, and an empty body
    // here would make the sigil look broken the first time it is tried.
    expect(readPickerBody("#", false)).toEqual({ body: "tag-search", query: "" });
    expect(readPickerBody("#", true)).toEqual({ body: "tag-search", query: "" });
  });

  it("lets the sigil overrule an icon that is off", () => {
    // Two doors into one room, so either one opens it. The sigil is checked
    // first, which also means the icon can never shut a door the text is
    // holding open.
    expect(readPickerBody("  #a", false).body).toBe("tag-search");
  });
});

describe("leaveTagView", () => {
  it("drops the sigil so pressing the icon off reaches the tree", () => {
    // Without this the text would hold the window in tag mode against the
    // control that has just said to leave it.
    expect(leaveTagView("#proj")).toBe("proj");
    expect(leaveTagView("#")).toBe("");
  });

  it("leaves a filter with no sigil exactly as it is", () => {
    expect(leaveTagView("plan")).toBe("plan");
    expect(leaveTagView("")).toBe("");
  });

  it("lands where backspacing the sigil away lands", () => {
    // The icon and the keyboard are two ways to do the same thing, so they
    // have to leave the box saying the same thing.
    for (const raw of ["#proj", "#", "  #a b"]) {
      expect(readPickerBody(leaveTagView(raw), false).body).toBe("tree");
    }
  });
});

describe("tagToggleLabel", () => {
  it("offers tags while the vault is on screen", () => {
    expect(tagToggleLabel(false, 0)).toBe("Show tags");
  });

  it("offers the vault back while tags are on screen", () => {
    // The label names what pressing it does, not what is on screen, because
    // that is the question a tooltip is being asked.
    expect(tagToggleLabel(true, 3)).toBe("Show files and folders");
  });

  it("carries the count, because the digits beside the icon are unreadable", () => {
    expect(tagToggleLabel(false, 1)).toBe("Show tags, 1 chosen");
    expect(tagToggleLabel(false, 4)).toBe("Show tags, 4 chosen");
  });

  it("says nothing about a count of none", () => {
    // Nothing is drawn beside the icon either, so a label claiming "0 chosen"
    // would describe something that is not there.
    expect(tagToggleLabel(false, 0)).not.toMatch(/0|chosen/);
  });
});
