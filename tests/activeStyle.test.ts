import { describe, expect, it } from "vitest";
import { ACTIVE_STYLE_CLASS, activeStyleClass } from "../src/ui/activeStyle";

describe("the active space's style", () => {
  it("adds no class for the boxed style", () => {
    // Null, not an empty string or a `spaces-active-box` class: the boxed look
    // is the stylesheet's own rule and must keep applying untouched, so the
    // default path adds nothing for a later rule to have to out-specify.
    expect(activeStyleClass("box")).toBeNull();
  });

  it("names the bold class for the bold style", () => {
    expect(activeStyleClass("bold")).toBe(ACTIVE_STYLE_CLASS);
  });

  it("falls back to the boxed style for a value it does not know", () => {
    // Runtime belt and braces. `schema.ts` already degrades an unrecognised
    // stored value, so this is only reachable from a caller that bypassed it --
    // and the answer is the same either way: never leave the active space
    // unmarked because a string was wrong.
    expect(activeStyleClass("spinning" as never)).toBeNull();
  });
});
