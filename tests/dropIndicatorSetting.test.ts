/**
 * Reading `dropIndicatorStyle` out of a stored document.
 *
 * The default is `box`, which is a departure from the other appearance
 * settings. Those default to whatever an existing install already looks like.
 * This one changes the look of every install on upgrade, and that was chosen
 * deliberately rather than inherited.
 */
import { describe, expect, it } from "vitest";
import { validateDefinitions } from "../src/definitions/schema";
import { SCHEMA_VERSION } from "../src/types";

function styleOf(stored: unknown): string {
  const result = validateDefinitions({
    schemaVersion: SCHEMA_VERSION,
    settings: { dropIndicatorStyle: stored },
    spaces: [],
  });
  if (!result.ok) throw new Error(`document rejected: ${result.error}`);
  return result.value.settings.dropIndicatorStyle;
}

describe("reading the drop indicator style", () => {
  it("keeps both values", () => {
    expect(styleOf("box")).toBe("box");
    expect(styleOf("line")).toBe("line");
  });

  it("defaults to box when the key is absent", () => {
    // Every vault written before this setting existed.
    expect(styleOf(undefined)).toBe("box");
  });

  it("degrades an unrecognised value rather than rejecting the document", () => {
    // Same posture as `stripPlacement` and `activeSpaceStyle`: a hand-edited
    // or future value must never cost someone their spaces.
    expect(styleOf("gap")).toBe("box");
    expect(styleOf(7)).toBe("box");
    expect(styleOf(null)).toBe("box");
  });
});
