/**
 * The two settings that shorten a compacted path, mirroring
 * `tests/compactSetting.test.ts` for the toggle they sit beside.
 *
 * `abbreviateCompactedPaths` DEFAULTS TRUE, unlike every other boolean on the
 * Appearance page, and that asymmetry is the thing these tests pin. Without
 * it, compaction is actively broken on a deep vault: measured at a 246px pane,
 * `Research/2026/Q4/Projects/Atlas/Design/Decisions` overflows and the
 * ellipsis eats the tip, so the one segment identifying the row is the first
 * thing lost. The opt-in a user already made by turning compaction ON should
 * not also require a second opt-in to it working.
 *
 * `compactPathThreshold` is a STRING, because the settings tab supports only
 * `toggle` and `dropdown` and a dropdown's values are strings. An unknown
 * value degrades to the default rather than rejecting the document, like
 * `stripPlacement` and `dropIndicatorStyle`.
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

describe("compactPathThreshold", () => {
  it('defaults to "3", as a string', () => {
    expect(DEFAULT_DEFINITIONS.settings.compactPathThreshold).toBe("3");
    expect(typeof DEFAULT_DEFINITIONS.settings.compactPathThreshold).toBe("string");
  });

  it("defaults when absent", () => {
    expect(withSettings({}).compactPathThreshold).toBe("3");
  });

  it("keeps each value the dropdown offers", () => {
    for (const value of ["3", "4", "5", "6"]) {
      expect(withSettings({ compactPathThreshold: value }).compactPathThreshold).toBe(value);
    }
  });

  it("falls back to the default for a value outside the range", () => {
    expect(withSettings({ compactPathThreshold: "7" }).compactPathThreshold).toBe("3");
    expect(withSettings({ compactPathThreshold: "2" }).compactPathThreshold).toBe("3");
    expect(withSettings({ compactPathThreshold: "" }).compactPathThreshold).toBe("3");
  });

  it("falls back for a NUMBER, which is the shape the dropdown never writes", () => {
    // A hand-edited `compactPathThreshold: 4` is not what the control stores,
    // and silently accepting it would make two spellings of one setting.
    expect(withSettings({ compactPathThreshold: 4 }).compactPathThreshold).toBe("3");
  });

  it("falls back rather than rejecting the document", () => {
    for (const value of [null, {}, [], true]) {
      expect(withSettings({ compactPathThreshold: value }).compactPathThreshold).toBe("3");
    }
  });

  it("does not change the schema version", () => {
    const res = validateDefinitions({ ...base, settings: { compactPathThreshold: "6" } });
    if (!res.ok) throw new Error(res.error);
    expect(res.value.schemaVersion).toBe(1);
  });
});
