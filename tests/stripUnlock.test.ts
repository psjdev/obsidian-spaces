// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyUnlockState } from "../src/ui/stripDock";

function strip() {
  const el = document.createElement("div");
  el.className = "spaces-switcher";
  el.appendChild(document.createElement("span")); // stands in for All
  return el;
}

describe("the unlock mode's visible state", () => {
  it("adds nothing while locked", () => {
    const el = strip();
    applyUnlockState(el, false);
    expect(el.querySelector(".spaces-strip-grip")).toBeNull();
    expect(el.classList.contains("is-unlocked")).toBe(false);
  });

  it("puts the grip FIRST, so it pushes All along rather than overlaying it", () => {
    const el = strip();
    applyUnlockState(el, true);
    expect(el.firstElementChild?.className).toContain("spaces-strip-grip");
    expect(el.classList.contains("is-unlocked")).toBe(true);
  });

  it("is idempotent, because a re-render calls it again", () => {
    const el = strip();
    applyUnlockState(el, true);
    applyUnlockState(el, true);
    expect(el.querySelectorAll(".spaces-strip-grip")).toHaveLength(1);
  });

  it("leaves nothing behind when locked again", () => {
    const el = strip();
    applyUnlockState(el, true);
    applyUnlockState(el, false);
    expect(el.querySelector(".spaces-strip-grip")).toBeNull();
    expect(el.classList.contains("is-unlocked")).toBe(false);
  });
});
