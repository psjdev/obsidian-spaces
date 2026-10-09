/**
 * The compaction setting defaults OFF and is strict about what counts as on.
 *
 * Off by default because it changes how every curated space draws, and an
 * update must not rearrange an explorer the user was reading.
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

describe("compactFolderChains", () => {
  it("is off in the defaults", () => {
    expect(DEFAULT_DEFINITIONS.settings.compactFolderChains).toBe(false);
  });

  it("is off when absent", () => {
    expect(settingsFrom(base).compactFolderChains).toBe(false);
  });

  it("is on only for a real boolean true", () => {
    expect(settingsFrom({ ...base, settings: { compactFolderChains: true } }).compactFolderChains).toBe(true);
  });

  it("does not read a truthy non-boolean as on", () => {
    // Same strictness as `pinAllSpace` and `showPinnedFolder`: a hand-edited
    // `compactFolderChains: 1` must not turn it on.
    expect(settingsFrom({ ...base, settings: { compactFolderChains: 1 } }).compactFolderChains).toBe(false);
  });

  it("does not change the schema version, because nothing per space is stored", () => {
    const res = validateDefinitions({ ...base, settings: { compactFolderChains: true } });
    if (!res.ok) throw new Error(res.error);
    expect(res.value.schemaVersion).toBe(1);
  });
});
