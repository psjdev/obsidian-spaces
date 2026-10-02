/**
 * The shortcut rule: when a character typed into the create panel's filter box
 * presses one of the two buttons above the window instead of landing in the
 * box.
 *
 * Layer 1: a pure function, no DOM, no `obsidian`. Tested apart from the panel
 * because the panel is one of several look-and-feel candidates and this rule
 * is not. It is also the rule with the sharpest failure mode in the whole
 * prototype: it is the one thing here that can throw a keystroke away.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PICKER_MODE,
  ITEMS_SIGIL,
  readModeSigil,
  TAG_SIGIL,
} from "../src/ui/pickerFilter";

describe("readModeSigil", () => {
  it("switches to items on a slash into an empty box", () => {
    expect(readModeSigil({ box: "", key: ITEMS_SIGIL })).toBe("items");
  });

  it("switches to tags on a hash into an empty box", () => {
    expect(readModeSigil({ box: "", key: TAG_SIGIL })).toBe("tags");
  });

  it("leaves every other character alone", () => {
    // Null is the answer for almost everything, and the caller's job on null
    // is to do nothing and let the character land.
    for (const key of ["a", "Z", "1", " ", "-", "Backspace", "Enter", "ArrowLeft"]) {
      expect(readModeSigil({ box: "", key })).toBeNull();
    }
  });

  it("leaves a sigil alone once the box holds anything", () => {
    // This is the rule's whole point. `/` is in nearly every path a curated
    // space is picked from, so a box that switched modes mid-word would throw
    // away both the keystroke and the view someone was halfway through using.
    for (const box of ["P", "Projects", "Projects/", "#", "/"]) {
      expect(readModeSigil({ box, key: ITEMS_SIGIL })).toBeNull();
      expect(readModeSigil({ box, key: TAG_SIGIL })).toBeNull();
    }
  });

  it("counts a box holding only whitespace as text, not as empty", () => {
    // Everywhere else in this picker a blank box counts as empty. Not here:
    // this rule DELETES the character it claims, and a box with a space in it
    // is one someone is already typing in.
    expect(readModeSigil({ box: " ", key: TAG_SIGIL })).toBeNull();
  });

  it("ignores a sigil reached with ctrl, meta or alt", () => {
    // Those are shortcuts the app or the OS owns, and the character never
    // arrives in the box either.
    expect(readModeSigil({ box: "", key: ITEMS_SIGIL, modified: true })).toBeNull();
    expect(readModeSigil({ box: "", key: TAG_SIGIL, modified: true })).toBeNull();
  });

  it("still fires when shift is what produced the character", () => {
    // `#` is a shifted key on most layouts, so treating shift as a modifier
    // would disable the shortcut on the keyboards it was written for. Shift is
    // simply not reported here.
    expect(readModeSigil({ box: "", key: TAG_SIGIL, modified: false })).toBe("tags");
  });

  it("stays out of the way of an IME mid-composition", () => {
    // The key is not a finished character yet, so nothing has been typed for
    // the rule to be about.
    expect(readModeSigil({ box: "", key: TAG_SIGIL, composing: true })).toBeNull();
  });

  it("answers for no inherited object property", () => {
    // The lookup key is whatever the keyboard produced. An object literal
    // would answer for `constructor` and `toString` as readily as for a sigil.
    for (const key of ["constructor", "toString", "__proto__"]) {
      expect(readModeSigil({ box: "", key })).toBeNull();
    }
  });

  it("opens on items", () => {
    // The window's resting body is the vault tree, which is what every
    // prototype in this comparison has opened on.
    expect(DEFAULT_PICKER_MODE).toBe("items");
  });
});
