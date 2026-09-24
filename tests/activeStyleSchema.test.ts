/**
 * Reading `activeSpaceStyle` out of a stored document.
 *
 * The three styles were renamed to Shaded, Boxed and Bolded, and the stored
 * values were renamed with them so a document stays readable. Vaults written
 * by 0.4.0 through 0.6.0 hold `box` or `bold`, and those have to keep meaning
 * what they meant, or upgrading would silently reset the setting.
 */
import { describe, expect, it } from "vitest";
import { validateDefinitions } from "../src/definitions/schema";
import { SCHEMA_VERSION } from "../src/types";

function styleOf(stored: unknown): string {
  const result = validateDefinitions({
    schemaVersion: SCHEMA_VERSION,
    settings: { activeSpaceStyle: stored },
    spaces: [],
  });
  if (!result.ok) throw new Error(`document rejected: ${result.error}`);
  return result.value.settings.activeSpaceStyle;
}

describe("reading the active space style", () => {
  it("keeps each of the three current values", () => {
    expect(styleOf("shaded")).toBe("shaded");
    expect(styleOf("boxed")).toBe("boxed");
    expect(styleOf("bolded")).toBe("bolded");
  });

  it("carries a 0.4.0 document's `box` across to shaded", () => {
    // `box` drew the theme's shading and nothing else by 0.6.0, which is what
    // `shaded` draws, so this preserves the look rather than approximating it.
    expect(styleOf("box")).toBe("shaded");
  });

  it("carries a 0.4.0 document's `bold` across to bolded", () => {
    expect(styleOf("bold")).toBe("bolded");
  });

  it("defaults to shaded when the key is absent", () => {
    // Every vault written before 0.4.0.
    expect(styleOf(undefined)).toBe("shaded");
  });

  it("degrades an unrecognised value rather than rejecting the document", () => {
    // Same posture as `stripPlacement`: a hand-edited or future value must
    // never cost someone their spaces, and the wrong highlight is cosmetic.
    expect(styleOf("outline")).toBe("shaded");
    expect(styleOf(42)).toBe("shaded");
    expect(styleOf(null)).toBe("shaded");
  });
});
