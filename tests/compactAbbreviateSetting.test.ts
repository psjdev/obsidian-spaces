/**
 * The setting that shortens a compacted path, mirroring
 * `tests/compactSetting.test.ts` for the toggle it sits beside.
 *
 * `abbreviateCompactedPaths` DEFAULTS TRUE, unlike every other boolean on the
 * Appearance page, and that asymmetry is the thing these tests pin. Without
 * it, compaction is actively broken on a deep vault: measured at a 246px pane,
 * `Research/2026/Q4/Projects/Atlas/Design/Decisions` overflows and the
 * ellipsis eats the tip, so the one segment identifying the row is the first
 * thing lost. The opt-in a user already made by turning compaction ON should
 * not also require a second opt-in to it working.
 *
 * `compactPathThreshold`, the folder count that used to sit beside it, is
 * GONE: shortening now triggers on a measured overflow instead. Removing a key
 * is a read-side change only, so the second block below pins the one thing an
 * existing install cares about -- a document still carrying the key loads, is
 * not rejected, and is not rewritten.
 */
import { describe, expect, it } from "vitest";
import { validateDefinitions } from "../src/definitions/schema";
import { DEFAULT_DEFINITIONS } from "../src/types";

function settingsFrom(raw: unknown): Record<string, unknown> {
  const res = validateDefinitions(raw);
  if (!res.ok) throw new Error(`expected valid, got ${res.error}`);
  return res.value.settings as unknown as Record<string, unknown>;
}

const base = { schemaVersion: 1, settings: {}, spaces: [], orders: {} };
const withSettings = (settings: Record<string, unknown>): Record<string, unknown> =>
  settingsFrom({ ...base, settings });

describe("abbreviateCompactedPaths", () => {
  it("is ON in the defaults, unlike its Appearance neighbours", () => {
    expect(DEFAULT_DEFINITIONS.settings.abbreviateCompactedPaths).toBe(true);
  });

  it("is on when absent, so an existing install gets the fix", () => {
    // A document written before this setting existed carries no key at all,
    // and compaction on a deep vault is broken until this applies.
    expect(withSettings({}).abbreviateCompactedPaths).toBe(true);
  });

  it("keeps an explicit false", () => {
    expect(withSettings({ abbreviateCompactedPaths: false }).abbreviateCompactedPaths).toBe(false);
  });

  it("keeps an explicit true", () => {
    expect(withSettings({ abbreviateCompactedPaths: true }).abbreviateCompactedPaths).toBe(true);
  });

  /**
   * The `!== false` normalisation, stated as a test.
   *
   * Its neighbours use `st.key === undefined ? true : st.key === true`, which
   * reads a hand-edited `0` as OFF. This one is deliberately looser: only the
   * boolean `false` turns it off, so no unrecognised value can leave someone
   * on the broken label.
   */
  it("reads anything but a literal false as on", () => {
    for (const value of [0, 1, "", "no", null, []]) {
      expect(withSettings({ abbreviateCompactedPaths: value }).abbreviateCompactedPaths).toBe(true);
    }
  });

  it("does not change the schema version", () => {
    const res = validateDefinitions({ ...base, settings: { abbreviateCompactedPaths: false } });
    if (!res.ok) throw new Error(res.error);
    expect(res.value.schemaVersion).toBe(1);
  });
});

describe("a stored compactPathThreshold, now that the setting is gone", () => {
  it("is not in the defaults any more", () => {
    expect(DEFAULT_DEFINITIONS.settings).not.toHaveProperty("compactPathThreshold");
  });

  it("is dropped from a document that still carries it", () => {
    // Every existing install has one: the key shipped, so it is in their
    // `data.json`. It is read past, not migrated and not written back.
    expect(withSettings({ compactPathThreshold: "6" })).not.toHaveProperty(
      "compactPathThreshold"
    );
  });

  it("never makes the document invalid, whatever shape the stored value has", () => {
    // Including the shapes the old validation rejected and replaced with a
    // default. An unknown key is simply not read, so none of them can throw.
    for (const value of ["3", "7", "", 4, null, {}, [], true]) {
      const res = validateDefinitions({ ...base, settings: { compactPathThreshold: value } });
      expect(res.ok).toBe(true);
    }
  });

  it("leaves the settings beside it exactly as stored", () => {
    const s = withSettings({
      compactPathThreshold: "4",
      compactFolderChains: true,
      abbreviateCompactedPaths: false,
    });
    expect(s.compactFolderChains).toBe(true);
    expect(s.abbreviateCompactedPaths).toBe(false);
  });

  it("does not change the schema version", () => {
    // Removing a key is not a migration: a document carrying it is still a
    // version 1 document, and must not be bumped into one an older build
    // would refuse.
    const res = validateDefinitions({ ...base, settings: { compactPathThreshold: "6" } });
    if (!res.ok) throw new Error(res.error);
    expect(res.value.schemaVersion).toBe(1);
  });
});
