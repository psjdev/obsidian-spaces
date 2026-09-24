import { describe, expect, it } from "vitest";
import { ALL_HEADER_ICON, headerModel, type HeaderSpace } from "../src/ui/spaceHeader";

// Icons are stored and compared BARE (`box`, not `lucide-box`) — `normalizeIconId`
// strips the prefix Obsidian reports, so a preset and a search result are the
// same string. The known-set is built the same way in `SwitcherView`.
const KNOWN = new Set(["anchor", "box", "layers", "flask-conical"]);

const spaces: HeaderSpace[] = [
  { id: "s1", name: "Work", icon: "anchor", color: "#5b5bff" },
  { id: "s2", name: "Lab", icon: "flask-conical" },
  { id: "s3", name: "Hardware", icon: "box", root: "Projects/Console 2030/Hardware" },
  { id: "s4", name: "Gone", icon: "box", root: "Projects/Vanished" },
  { id: "s5", name: "Unchosen", icon: "box", root: "" },
  { id: "s6", name: "VaultRoot", icon: "box", root: "/" },
];

/**
 * Which folders exist right now — the same predicate `spaceRowSummary`
 * (memberList.ts) takes, so the two agree about what "missing" means instead
 * of each deciding for itself.
 */
const EXISTS = (path: string): boolean => path === "Projects/Console 2030/Hardware";

describe("headerModel", () => {
  it("shows the space's own icon, name and color", () => {
    expect(headerModel({ kind: "space", id: "s1" }, spaces, KNOWN, EXISTS)).toEqual({
      icon: "anchor",
      label: "Work",
      color: "#5b5bff",
      spaceId: "s1",
      pinnedLabel: null,
    });
  });

  it("leaves color undefined for a space that has none", () => {
    // Rather than inventing one: an uncolored space should inherit the pane's
    // text color, not a color spaces picked on its behalf.
    expect(headerModel({ kind: "space", id: "s2" }, spaces, KNOWN, EXISTS).color).toBeUndefined();
  });

  it("renders All with the same icon and label the switcher uses (21.3)", () => {
    // Not hidden. A header absent on All and present everywhere else shifts the
    // whole tree by its height on every switch to or from All.
    expect(headerModel({ kind: "all" }, spaces, KNOWN, EXISTS)).toEqual({
      icon: ALL_HEADER_ICON,
      label: "All",
      color: undefined,
      spaceId: null,
      pinnedLabel: null,
    });
  });

  it("marks All as not renameable, by having no spaceId", () => {
    // 9.9: All is not a space and has no name to change — the same reason 9.7
    // offers it no context menu.
    expect(headerModel({ kind: "all" }, spaces, KNOWN, EXISTS).spaceId).toBeNull();
  });

  it("falls back to All when the selection names a space that is gone", () => {
    // Reachable while a delete is in flight, and from a hand-edited data.json.
    // Showing a stale name for a space that no longer exists is worse than
    // showing the truth, and a rename must not target a missing space.
    expect(headerModel({ kind: "space", id: "ghost" }, spaces, KNOWN, EXISTS)).toEqual({
      icon: ALL_HEADER_ICON,
      label: "All",
      color: undefined,
      spaceId: null,
      pinnedLabel: null,
    });
  });

  it("substitutes the fallback icon for an id this build cannot draw (9.7)", () => {
    const odd: HeaderSpace[] = [{ id: "s3", name: "Odd", icon: "not-a-real-icon" }];
    expect(headerModel({ kind: "space", id: "s3" }, odd, KNOWN, EXISTS).icon).toBe("box");
  });

  it("substitutes the fallback icon for a space with no icon at all", () => {
    const bare: HeaderSpace[] = [{ id: "s4", name: "Bare", icon: "" }];
    expect(headerModel({ kind: "space", id: "s4" }, bare, KNOWN, EXISTS).icon).toBe("box");
  });

  it("trusts the stored icon when icons could not be enumerated", () => {
    // An empty known-set means `getIconIds()` threw; replacing every icon with
    // the fallback would be a worse guess than trusting what is stored.
    const out = headerModel({ kind: "space", id: "s1" }, spaces, new Set<string>(), EXISTS);
    expect(out.icon).toBe("anchor");
  });

  it("strips a stored lucide- prefix, the way the switcher does", () => {
    const prefixed: HeaderSpace[] = [{ id: "s5", name: "Bare", icon: "lucide-anchor" }];
    expect(headerModel({ kind: "space", id: "s5" }, prefixed, KNOWN, EXISTS).icon).toBe("anchor");
  });
});

describe("headerModel pinnedLabel", () => {
  /**
   * What the header's pin says on hover. A LABEL rather than a pair of fields
   * because composing the sentence is a decision, and this module is where the
   * header's decisions live — `SpaceHeaderView` renders what it is given.
   *
   * The full path, not the folder's own name: the pin is a fixed-width icon,
   * so nothing competes with it for the row and there is no reason to abridge
   * the one piece of information it carries. Inline text would have room for
   * the basename only.
   */
  const label = (id: string): string | null =>
    headerModel({ kind: "space", id }, spaces, KNOWN, EXISTS).pinnedLabel;

  it("names the folder a space is pinned to", () => {
    expect(label("s3")).toBe("Pinned to Projects/Console 2030/Hardware");
  });

  it("says so when the pinned folder has vanished", () => {
    // Printing the name as though all were well would be a small lie told at
    // exactly the moment the tree is mysteriously empty — the missing-root
    // state. Matches `spaceRowSummary`'s existing "(missing)" suffix.
    expect(label("s4")).toBe("Pinned to Projects/Vanished (missing)");
  });

  it("says nothing for a curated space", () => {
    expect(label("s1")).toBeNull();
  });

  it("says nothing for a root that was never chosen", () => {
    // `""` and `"/"` are the unchosen spellings: the space declared a root
    // but there is no folder to name, so the pin has nothing to say and is
    // not drawn at all.
    expect(label("s5")).toBeNull();
    expect(label("s6")).toBeNull();
  });

  it("says nothing for All", () => {
    expect(headerModel({ kind: "all" }, spaces, KNOWN, EXISTS).pinnedLabel).toBeNull();
  });

  it("says nothing for a selection naming a space that is gone", () => {
    // That selection already resolves to All (see above), and All has no pin.
    expect(headerModel({ kind: "space", id: "missing" }, spaces, KNOWN, EXISTS).pinnedLabel)
      .toBeNull();
  });

  it("asks the predicate, rather than assuming the folder is there", () => {
    // The whole point of taking `exists`: a header rendered from a stale
    // definition must not claim a folder that has since been deleted.
    const never = (): boolean => false;
    expect(headerModel({ kind: "space", id: "s3" }, spaces, KNOWN, never).pinnedLabel).toBe(
      "Pinned to Projects/Console 2030/Hardware (missing)"
    );
  });
});
