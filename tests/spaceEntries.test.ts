import { describe, expect, it } from "vitest";
import {
  ALL_ICON,
  ALL_LABEL,
  spaceEntries,
  splitPinnedEntry,
} from "../src/ui/spaceEntries";
import type { HeaderSpace } from "../src/ui/spaceHeader";

const KNOWN = new Set(["anchor", "box", "layers", "flask-conical"]);
const spaces: HeaderSpace[] = [
  { id: "work", name: "Work", icon: "anchor", color: "#5b5bff" },
  { id: "lab", name: "Lab", icon: "flask-conical" },
];

describe("spaceEntries", () => {
  it("puts All first, then the spaces in definition order", () => {
    // The strip and the dropdown must agree; definition order is the one
    // ordering both can read (ordering rules elsewhere order rows inside
    // folders, not spaces).
    const out = spaceEntries(spaces, { kind: "all" }, KNOWN);
    expect(out.map((e) => e.label)).toEqual([ALL_LABEL, "Work", "Lab"]);
  });

  it("gives All its own icon and no color", () => {
    const all = spaceEntries(spaces, { kind: "all" }, KNOWN)[0];
    expect(all).toMatchObject({ icon: ALL_ICON, label: ALL_LABEL, color: undefined });
    expect(all.key).toEqual({ kind: "all" });
  });

  it("marks exactly one entry active", () => {
    const out = spaceEntries(spaces, { kind: "space", id: "lab" }, KNOWN);
    expect(out.filter((e) => e.active).map((e) => e.label)).toEqual(["Lab"]);
  });

  it("marks All active in All", () => {
    const out = spaceEntries(spaces, { kind: "all" }, KNOWN);
    expect(out.filter((e) => e.active).map((e) => e.label)).toEqual([ALL_LABEL]);
  });

  it("marks NOTHING active when the selection names a space that is gone", () => {
    // Reachable while a delete is in flight. The header turns this into All
    // (spaceHeader.ts); the dropdown just shows no tick, which is honest.
    const out = spaceEntries(spaces, { kind: "space", id: "ghost" }, KNOWN);
    expect(out.some((e) => e.active)).toBe(false);
  });

  it("carries each space's own color through", () => {
    const out = spaceEntries(spaces, { kind: "all" }, KNOWN);
    expect(out[1].color).toBe("#5b5bff");
    expect(out[2].color).toBeUndefined();
  });

  it("substitutes the fallback icon for an id this build cannot draw", () => {
    const odd: HeaderSpace[] = [{ id: "x", name: "Odd", icon: "not-real" }];
    expect(spaceEntries(odd, { kind: "all" }, KNOWN)[1].icon).toBe("box");
  });

  it("trusts the stored icon when icons could not be enumerated", () => {
    const out = spaceEntries(spaces, { kind: "all" }, new Set<string>());
    expect(out[1].icon).toBe("anchor");
  });

  it("carries a switchable key per entry", () => {
    const out = spaceEntries(spaces, { kind: "all" }, KNOWN);
    expect(out[1].key).toEqual({ kind: "space", id: "work" });
  });

  it("returns just All for a vault with no spaces", () => {
    // All is never absent, so the dropdown is never empty.
    expect(spaceEntries([], { kind: "all" }, KNOWN).map((e) => e.label)).toEqual([ALL_LABEL]);
  });
});

describe("splitPinnedEntry", () => {
  const entries = () => spaceEntries(spaces, { kind: "all" }, KNOWN);

  it("pins nothing and rails everything when the setting is off", () => {
    // Off must be byte-identical to the strip before this feature existed.
    const out = splitPinnedEntry(entries(), false);
    expect(out.pinned).toBeNull();
    expect(out.railed.map((e) => e.label)).toEqual([ALL_LABEL, "Work", "Lab"]);
  });

  it("pins All and rails the spaces when the setting is on", () => {
    const out = splitPinnedEntry(entries(), true);
    expect(out.pinned?.label).toBe(ALL_LABEL);
    expect(out.railed.map((e) => e.label)).toEqual(["Work", "Lab"]);
  });

  it("pins All by KIND, not by position", () => {
    // `spaceEntries` puts All first, but relying on index 0 would couple this
    // split to that ordering silently. Searching by kind means a future
    // reordering cannot pin the wrong space.
    const reordered = [...entries()].reverse();
    const out = splitPinnedEntry(reordered, true);
    expect(out.pinned?.key).toEqual({ kind: "all" });
    expect(out.railed.map((e) => e.label)).toEqual(["Lab", "Work"]);
  });

  it("leaves an empty rail when All is the only entry", () => {
    const out = splitPinnedEntry(spaceEntries([], { kind: "all" }, KNOWN), true);
    expect(out.pinned?.label).toBe(ALL_LABEL);
    expect(out.railed).toEqual([]);
  });

  it("rails the lone All entry when the setting is off", () => {
    const out = splitPinnedEntry(spaceEntries([], { kind: "all" }, KNOWN), false);
    expect(out.pinned).toBeNull();
    expect(out.railed.map((e) => e.label)).toEqual([ALL_LABEL]);
  });

  it("carries the entry through untouched, active flag included", () => {
    // The pinned control is built by the same code as a rail item, so it has
    // to receive the same entry — losing `active` here would light up nothing.
    const out = splitPinnedEntry(spaceEntries(spaces, { kind: "all" }, KNOWN), true);
    expect(out.pinned).toMatchObject({ icon: ALL_ICON, active: true, color: undefined });
  });

  it("pins nothing when the list contains no All entry", () => {
    const out = splitPinnedEntry(
      spaceEntries(spaces, { kind: "all" }, KNOWN).filter((e) => e.key.kind !== "all"),
      true
    );
    expect(out.pinned).toBeNull();
    expect(out.railed.map((e) => e.label)).toEqual(["Work", "Lab"]);
  });
});
