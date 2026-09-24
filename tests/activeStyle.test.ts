import { describe, expect, it } from "vitest";
import { BOLDED_CLASS, BOXED_CLASS, activeStyleClass } from "../src/ui/activeStyle";

describe("how the strip marks the space you are in", () => {
  it("adds no class for the shaded style", () => {
    // Null, not an empty string or a `spaces-active-shaded` class: shading is
    // the stylesheet's own rule and must keep applying untouched, so the
    // default path adds nothing for a later rule to have to out-specify.
    expect(activeStyleClass("shaded")).toBeNull();
  });

  it("names the boxed class for the boxed style", () => {
    expect(activeStyleClass("boxed")).toBe(BOXED_CLASS);
  });

  it("names the bolded class for the bolded style", () => {
    expect(activeStyleClass("bolded")).toBe(BOLDED_CLASS);
  });

  it("gives the three styles three distinct answers", () => {
    // Two styles sharing a class would make one of them unreachable while the
    // settings dropdown went on offering both.
    const answers = [
      activeStyleClass("shaded"),
      activeStyleClass("boxed"),
      activeStyleClass("bolded"),
    ];
    expect(new Set(answers).size).toBe(3);
  });

  it("falls back to the shaded style for a value it does not know", () => {
    // Runtime belt and braces. `schema.ts` already degrades an unrecognised
    // stored value, so this is only reachable from a caller that bypassed it,
    // and the answer is the same either way: never leave the active space
    // unmarked because a string was wrong.
    expect(activeStyleClass("spinning" as never)).toBeNull();
  });
});
