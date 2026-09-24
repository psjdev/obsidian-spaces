/**
 * `home` is gone from the persisted schema.
 *
 * The field was validated on load, rewritten by `repairOnRename`, carried
 * through `moveCorrelator` and consumed by both creation commands, and NO UI
 * anywhere could set it: a folder suggester and a repair prompt would be
 * needed, and neither exists, so the only way to give a space a `home` was to
 * hand-edit `data.json`. A persisted, user-editable field that nothing can
 * reach is validated, repaired and migrated forever for a feature nobody has.
 *
 * These tests are about the two things removal changes on disk, which is where
 * the consequence lives now that a failed load is STICKY and
 * write-refusing:
 *
 *  1. a stored `home` is dropped rather than carried; and
 *  2. a MALFORMED `home` no longer rejects the whole document. Removal only
 *     relaxes the validator, so it cannot turn a loadable `data.json` into an
 *     unloadable one — the direction that would now cost the user every write
 *     for the rest of the session.
 *
 * Layer 1: `schema.ts` imports no `"obsidian"`.
 */
import { describe, expect, it } from "vitest";
import { validateDefinitions } from "../src/definitions/schema";

function docWith(home: unknown): unknown {
  return {
    schemaVersion: 1,
    settings: {},
    spaces: [
      {
        id: "research",
        name: "Research",
        icon: "microscope",
        color: "#4ecdc4",
        home,
        members: [{ path: "Papers/Attention.md", kind: "file" }],
      },
    ],
  };
}

describe("`home` is not part of the persisted schema", () => {
  it("drops a stored `home` instead of carrying it into the document", () => {
    const result = validateDefinitions(docWith("Papers"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const space = result.value.spaces[0];
    // `in`, not `=== undefined`: the point is that the key is not emitted at
    // all, so the next write does not put it back into data.json.
    expect("home" in space).toBe(false);
  });

  it("no longer refuses the whole document over a malformed `home`", () => {
    // A malformed `home` must not refuse the whole document: a failed load
    // is sticky, so that refusal would cost the store every write for the
    // session. A field with no UI must not be
    // able to cost a user their curation.
    for (const bad of [42, null, true, "../escape", "C:/x", { path: "Papers" }]) {
      const result = validateDefinitions(docWith(bad));
      expect(result.ok, `home: ${JSON.stringify(bad)}`).toBe(true);
    }
  });

  it("still refuses a document whose space is invalid for a reason that remains", () => {
    // The relaxation above must be specific to `home` — a genuinely broken
    // space is still a refusal, so this test cannot pass by the validator
    // having stopped validating.
    const doc = docWith("Papers") as { spaces: { color: string }[] };
    doc.spaces[0].color = "not-a-color";
    expect(validateDefinitions(doc).ok).toBe(false);
  });
});
