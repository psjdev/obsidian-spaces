import { describe, expect, it } from "vitest";
import {
  memberRows,
  memberSummary,
  missingCount,
  spaceRowSummary,
  withoutMember,
  withoutTagMember,
  type MemberRow,
  type PathMemberRow,
} from "../src/ui/memberList";
import type { SpaceDefinition } from "../src/types";

const space = (members: SpaceDefinition["members"]): SpaceDefinition => ({
  id: "s",
  name: "S",
  icon: "box",
  color: "#5b5bff",
  members,
});

/** Everything exists except paths beginning `Gone`. */
const exists = (p: string): boolean => !p.startsWith("Gone");

/**
 * The tag lookup `memberRows` now takes. Every fixture in this file holds
 * path members only, so it is never called and the rows these tests assert
 * about are exactly the rows they were before tag members existed. Tag rows
 * have their own file, `memberRowsTags.test.ts`.
 */
const noTags = (): number => 0;

/**
 * Narrows a row to the path variant, so an assertion about a path-only field
 * stays the assertion it always was. A tag row reaching one of these fails
 * loudly instead of reading as `undefined`, which is what a cast would have
 * made it.
 */
const pathRow = (r: MemberRow): PathMemberRow => {
  if (r.kind === "tag") throw new Error(`expected a path row, got #${r.tag}`);
  return r;
};

describe("memberRows", () => {
  it("keeps definition order", () => {
    // The same ordering the switcher, the header dropdown and All's "Add to
    // space" use. A list that re-sorted as entries were fixed would move rows
    // out from under the pointer.
    const rows = memberRows(
      space([
        { path: "b.md", kind: "file" },
        { path: "a.md", kind: "file" },
      ]),
      exists,
      noTags
    );
    expect(rows.map((r) => pathRow(r).path)).toEqual(["b.md", "a.md"]);
  });

  it("marks an entry whose file is gone as missing", () => {
    const rows = memberRows(space([{ path: "Gone/Idea.md", kind: "file" }]), exists, noTags);
    expect(rows[0]).toMatchObject({ status: "missing", coveredBy: null });
  });

  it("marks a plain member present", () => {
    const rows = memberRows(space([{ path: "Notes/Idea.md", kind: "file" }]), exists, noTags);
    expect(rows[0]).toMatchObject({ status: "present", coveredBy: null });
  });

  it("marks a member already covered by a member FOLDER as redundant", () => {
    // An exact member moved under another member subtree is "retained,
    // not silently pruned" — so it is worth telling the user it is doing
    // nothing rather than leaving them to work it out.
    const rows = memberRows(
      space([
        { path: "Projects", kind: "folder" },
        { path: "Projects/Deep/Note.md", kind: "file" },
      ]),
      exists,
      noTags
    );
    expect(rows[1]).toMatchObject({ status: "redundant", coveredBy: "Projects" });
  });

  it("names the INNERMOST covering folder", () => {
    const rows = memberRows(
      space([
        { path: "Projects", kind: "folder" },
        { path: "Projects/Sub", kind: "folder" },
        { path: "Projects/Sub/Note.md", kind: "file" },
      ]),
      exists,
      noTags
    );
    expect(pathRow(rows[2]).coveredBy).toBe("Projects/Sub");
  });

  it("does not call a member folder redundant because of itself", () => {
    const rows = memberRows(space([{ path: "Projects", kind: "folder" }]), exists, noTags);
    expect(rows[0].status).toBe("present");
  });

  it("does not treat a prefix-sharing sibling as covering", () => {
    // `Projects2` is not under `Projects`.
    const rows = memberRows(
      space([
        { path: "Projects", kind: "folder" },
        { path: "Projects2/Note.md", kind: "file" },
      ]),
      exists,
      noTags
    );
    expect(rows[1].status).toBe("present");
  });

  it("prefers missing over redundant when both could apply", () => {
    // A gone file under a member folder: "missing" is the actionable fact, and
    // reporting it as merely redundant would hide that it no longer exists.
    const rows = memberRows(
      space([
        { path: "Gone", kind: "folder" },
        { path: "Gone/Note.md", kind: "file" },
      ]),
      exists,
      noTags
    );
    expect(rows[1].status).toBe("missing");
  });

  it("carries the stored kind through", () => {
    const rows = memberRows(space([{ path: "Projects", kind: "folder" }]), exists, noTags);
    expect(rows[0].kind).toBe("folder");
  });

  it("returns nothing for a space with no members", () => {
    expect(memberRows(space([]), exists, noTags)).toEqual([]);
  });
});

describe("missingCount", () => {
  it("counts only the entries whose path resolves to nothing", () => {
    // This is what makes the settings count honest: `members.length` alone
    // reports a space as having more members than it can show.
    const rows = memberRows(
      space([
        { path: "a.md", kind: "file" },
        { path: "Gone/b.md", kind: "file" },
        { path: "Gone/c.md", kind: "file" },
      ]),
      exists,
      noTags
    );
    expect(missingCount(rows)).toBe(2);
  });

  it("is zero when everything resolves", () => {
    expect(missingCount(memberRows(space([{ path: "a.md", kind: "file" }]), exists, noTags))).toBe(0);
  });
});

describe("withoutMember", () => {
  // The contents modal's Remove button (`SpaceContentsModal.ts`) is built out
  // of `Setting`, which the obsidian stub deliberately does not model — so
  // this is the only layer this decision can be tested at.
  it("drops the named path", () => {
    const out = withoutMember(
      [
        { path: "a.md", kind: "file" },
        { path: "b.md", kind: "file" },
      ],
      "a.md"
    );
    expect(out).toEqual([{ path: "b.md", kind: "file" }]);
  });

  it("leaves tag members untouched, including one that shares the removed spelling", () => {
    const out = withoutMember(
      [
        { path: "a.md", kind: "file" },
        { kind: "tag", tag: "project" },
        { kind: "tag", tag: "a.md" },
      ],
      "a.md"
    );
    expect(out).toEqual([
      { kind: "tag", tag: "project" },
      { kind: "tag", tag: "a.md" },
    ]);
  });
});

describe("withoutTagMember", () => {
  // The mirror of `withoutMember`, extracted for the same reason: the contents
  // modal's tag Remove button is a `Setting` control, which the stub does not
  // model, so this is the only layer the decision can be tested at.
  it("drops the named tag", () => {
    const out = withoutTagMember(
      [
        { kind: "tag", tag: "project" },
        { kind: "tag", tag: "archive" },
      ],
      "project"
    );
    expect(out).toEqual([{ kind: "tag", tag: "archive" }]);
  });

  it("leaves other tag members alone, including one nested under the removed tag", () => {
    // Removing `#project` must not remove `#project/api`. It is a separate
    // stored member, even though notes carrying it were reached through both.
    const out = withoutTagMember(
      [
        { kind: "tag", tag: "project" },
        { kind: "tag", tag: "project/api" },
      ],
      "project"
    );
    expect(out).toEqual([{ kind: "tag", tag: "project/api" }]);
  });

  it("leaves path members untouched, including one whose path matches the tag", () => {
    const out = withoutTagMember(
      [
        { path: "project", kind: "folder" },
        { path: "project.md", kind: "file" },
        { kind: "tag", tag: "project" },
      ],
      "project"
    );
    expect(out).toEqual([
      { path: "project", kind: "folder" },
      { path: "project.md", kind: "file" },
    ]);
  });
});

describe("memberSummary", () => {
  // The one line a space row shows about its contents, now that the
  // per-member rows live behind a modal. It is also the ONLY thing that makes
  // that modal discoverable, so the attention count has to earn its place.
  const rowsFor = (paths: string[]) =>
    memberRows(
      space(paths.map((p) => ({ path: p, kind: "file" as const }))),
      exists,
      noTags
    );

  it("says a space has no members rather than showing a zero", () => {
    expect(memberSummary(rowsFor([]))).toBe("No members");
  });

  it("uses the singular for exactly one", () => {
    expect(memberSummary(rowsFor(["a.md"]))).toBe("1 member");
  });

  it("uses the plural beyond one", () => {
    expect(memberSummary(rowsFor(["a.md", "b.md"]))).toBe("2 members");
  });

  it("says nothing about attention when every member resolves", () => {
    // A suffix that is always present teaches nothing. Silence here is what
    // makes its appearance meaningful.
    expect(memberSummary(rowsFor(["a.md", "b.md"]))).not.toContain("attention");
  });

  it("counts entries that resolve to nothing as needing attention", () => {
    expect(memberSummary(rowsFor(["a.md", "Gone/b.md"]))).toBe(
      "2 members · 1 needs attention"
    );
  });

  it("counts REDUNDANT entries as needing attention too", () => {
    // Redundant means a member folder already covers it, so the entry does
    // nothing. That is worth surfacing for the same reason missing is: the
    // file tree cannot show you either.
    const rows = memberRows(
      space([
        { path: "Projects", kind: "folder" },
        { path: "Projects/Deep/Note.md", kind: "file" },
      ]),
      exists,
      noTags
    );
    expect(memberSummary(rows)).toBe("2 members · 1 needs attention");
  });

  it("uses the plural for several needing attention", () => {
    expect(memberSummary(rowsFor(["a.md", "Gone/b.md", "Gone/c.md"]))).toBe(
      "3 members · 2 need attention"
    );
  });

  it("can report that every member needs attention", () => {
    expect(memberSummary(rowsFor(["Gone/a.md"]))).toBe("1 member · 1 needs attention");
  });
});

describe("spaceRowSummary", () => {
  const curated = { id: "r", name: "R", icon: "i", color: "#4ecdc4",
    members: [{ path: "Papers", kind: "folder" as const }] } as SpaceDefinition;
  const folder = { id: "w", name: "W", icon: "i", color: "#5b5bff",
    root: "Projects/Work", members: [] } as SpaceDefinition;

  it("counts members for a curated space", () => {
    expect(spaceRowSummary(curated, () => true, noTags)).toContain("1 member");
  });

  // Reuses `memberSummary` rather than re-deriving a
  // plainer count. Pinned directly here (not only through `memberSummary`'s
  // own describe block above) so a future edit that swaps it back for an
  // inline count fails at THIS call site.
  it("names the kind and says 'No members' rather than a zero count", () => {
    const empty = { ...curated, members: [] } as SpaceDefinition;
    expect(spaceRowSummary(empty, () => true, noTags)).toBe("Curated · No members");
  });

  it("counts a REDUNDANT member as needing attention, not just a missing one", () => {
    // The plainer re-derivation this replaced only ever counted `missing`;
    // `memberSummary` also counts `redundant` (a member folder already
    // covering it) as needing attention, which is a fact the tree cannot
    // show on its own either.
    const covered = {
      ...curated,
      members: [
        { path: "Papers", kind: "folder" as const },
        { path: "Papers/Deep/Note.md", kind: "file" as const },
      ],
    } as SpaceDefinition;
    expect(spaceRowSummary(covered, () => true, noTags)).toBe("Curated · 2 members · 1 needs attention");
  });

  it("names the root for a folder space", () => {
    expect(spaceRowSummary(folder, () => true, noTags)).toContain("Projects/Work");
  });

  it("says so when a folder space's root is missing", () => {
    expect(spaceRowSummary(folder, () => false, noTags)).toContain("missing");
  });

  // A root of "" or "/" is the missing-root state, never a usable
  // root — and must never be told apart from a genuinely resolved one by
  // calling `exists` on it. Measured against Obsidian 1.13.7,
  // `getAbstractFileByPath('/')` returns the vault's own root TFolder
  // (truthy) while `getAbstractFileByPath('')` returns null, so an `exists`
  // that merely wraps that lookup answers `true` for "/" and `false` for "" —
  // two different verdicts for the same missing-root state. `spaceRowSummary`
  // must not let that leak into the row's wording.
  it("does not call exists() for a root of \"\" — the pre-choice state, not a fault", () => {
    let called = false;
    const neverChosen = { ...folder, root: "" } as SpaceDefinition;
    const summary = spaceRowSummary(
      neverChosen,
      () => {
        called = true;
        return false;
      },
      noTags
    );
    expect(called).toBe(false);
    expect(summary).not.toContain("missing");
    expect(summary).toContain("Folder pinned");
  });

  it('reads a root of "/" as missing-root too, even though exists("/") is true', () => {
    // The trap this task's brief names explicitly: if this fell through to an
    // exists() check, "/" would read as a healthy resolved root because
    // Obsidian's own getAbstractFileByPath('/') returns the vault root.
    const vaultRootChosen = { ...folder, root: "/" } as SpaceDefinition;
    const summary = spaceRowSummary(vaultRootChosen, () => true, noTags);
    expect(summary).not.toBe("Folder pinned · /");
    expect(summary).toContain("Folder pinned");
  });

  it("does not collapse the missing-root state into the curated 'no members' wording", () => {
    // A space that DECLARED a root is still a folder space even when that
    // root cannot be honoured — it must never render as an empty curated
    // space, which is indistinguishable from "there was never anything here".
    const neverChosen = { ...folder, root: "" } as SpaceDefinition;
    const summary = spaceRowSummary(neverChosen, () => false, noTags);
    expect(summary).not.toContain("member");
  });
});
