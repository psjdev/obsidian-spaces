import { describe, expect, it } from "vitest";
import {
  BLOCKED_REASONS,
  blockedMessage,
  outcomeMessage,
  replaceConfirmPrompt,
} from "../src/export/exportCopy";

const PATH = "C:/Users/x/Desktop/Kitchen";
const EXISTING = {
  spaceId: "kitchen",
  spaceName: "Kitchen",
  exportedAt: "2026-10-25T10:00:00.000Z",
};
/** The destination as the command finds it: ours, same space, 3 things in it. */
const OURS = { fullPath: PATH, entries: 3, existing: EXISTING, isThisSpace: true };
/** Another space's export sitting in the folder this space wants. */
const THEIRS = {
  fullPath: PATH,
  entries: 3,
  existing: { spaceId: "garden", spaceName: "Garden", exportedAt: null },
  isThisSpace: false,
};
/** Not an export at all: someone's folder that happens to share the name. */
const STRANGER = { fullPath: PATH, entries: 412, existing: null, isThisSpace: false };

describe("replaceConfirmPrompt", () => {
  it("names the full path, because the folder is outside the vault", () => {
    expect(replaceConfirmPrompt(OURS).body).toContain(PATH);
  });

  it("reports what the folder says it holds, rather than asserting it is ours", () => {
    // Space ids are slugs of the name and are freed on delete, so an export
    // of a DELETED space matches a new space of the same name exactly.
    // Naming what is actually in the folder is what lets someone recognise
    // an old project; "an export of this space" would sometimes be false.
    const body = replaceConfirmPrompt(OURS).body;
    expect(body).toContain('"Kitchen"');
    expect(body).toMatch(/25 October 2026|October 25, 2026/);
    expect(body).not.toMatch(/export of this space/i);
  });

  it("tells the user to check it is the one they mean", () => {
    expect(replaceConfirmPrompt(OURS).body).toMatch(/check it is the one you mean/i);
  });

  it("copes with an export that recorded no name or date", () => {
    const bare = replaceConfirmPrompt({
      ...OURS,
      existing: { spaceId: "x", spaceName: null, exportedAt: null },
    });
    expect(bare.body).toContain(PATH);
    expect(bare.body).not.toContain("null");
    expect(bare.body).not.toContain("Invalid Date");
  });

  it("ignores a date it cannot read", () => {
    const bad = replaceConfirmPrompt({
      ...OURS,
      existing: { ...EXISTING, exportedAt: "not a date" },
    });
    expect(bad.body).not.toContain("Invalid Date");
  });

  it("says a folder that is NOT an export is not one, and how much it holds", () => {
    // The path that can eat someone's Documents folder. The count is what
    // tells them to stop.
    const p = replaceConfirmPrompt(STRANGER);
    expect(p.body).toMatch(/is not an export/i);
    expect(p.body).toContain("412 notes and folders");
    expect(p.confirmLabel).toBe("Delete it and export");
    expect(p.title).toMatch(/already there/i);
  });

  it("says when the folder belongs to ANOTHER space, and names it", () => {
    const p = replaceConfirmPrompt(THEIRS);
    expect(p.body).toContain('"Garden"');
    expect(p.body).toMatch(/not this one/i);
    expect(p.confirmLabel).toBe("Replace anyway");
  });

  it("gives the three cases different titles and different buttons", () => {
    // One shared wording would let the most dangerous case read like the
    // routine one.
    const all = [OURS, THEIRS, STRANGER].map(replaceConfirmPrompt);
    expect(new Set(all.map((p) => p.title)).size).toBe(3);
    expect(new Set(all.map((p) => p.confirmLabel)).size).toBe(3);
  });

  it("counts in whole numbers, and says nothing for an empty folder", () => {
    expect(replaceConfirmPrompt({ ...STRANGER, entries: 0 }).body).toContain("holds nothing");
    expect(replaceConfirmPrompt({ ...STRANGER, entries: 1 }).body).toContain("1 note or folder");
  });

  it("says what replacing destroys, not just that it replaces", () => {
    expect(replaceConfirmPrompt(OURS).body).toMatch(/delet|lost/i);
  });

  it("labels the button with the action, not with yes", () => {
    expect(replaceConfirmPrompt(OURS).confirmLabel).toBe("Replace");
  });
});

describe("blockedMessage", () => {
  it("gives every reason its own wording", () => {
    // One string reused for all of them would keep every other assertion in
    // this file green while telling the user nothing.
    const all = BLOCKED_REASONS.map(blockedMessage);
    expect(new Set(all).size).toBe(BLOCKED_REASONS.length);
  });

  it("never returns an empty string", () => {
    for (const r of BLOCKED_REASONS) expect(blockedMessage(r).length).toBeGreaterThan(10);
  });

  it("tells the user to wait when the vault is still indexing", () => {
    expect(blockedMessage("indexing")).toMatch(/indexing/i);
  });

  it("says why exporting into the vault is refused", () => {
    expect(blockedMessage("inside-vault")).toMatch(/outside your vault/i);
  });
});

describe("outcomeMessage", () => {
  it("names the destination on success", () => {
    expect(outcomeMessage({ copied: 3, failed: null }, PATH)).toContain(PATH);
  });

  it("counts what it copied", () => {
    expect(outcomeMessage({ copied: 3, failed: null }, PATH)).toContain("3");
  });

  it("agrees with itself about one", () => {
    expect(outcomeMessage({ copied: 1, failed: null }, PATH)).toContain("1 note or folder");
  });

  it("says nothing was copied rather than claiming success", () => {
    expect(outcomeMessage({ copied: 0, failed: null }, PATH)).toMatch(/nothing to copy/i);
  });

  it("names the file an export stopped on, and does not read as success", () => {
    const m = outcomeMessage(
      { copied: 1, failed: { path: "Reading/book.md", message: "EACCES" } },
      PATH
    );
    expect(m).toContain("Reading/book.md");
    expect(m).toContain("EACCES");
    expect(m).toMatch(/stopped/i);
    expect(m).not.toMatch(/^Exported/);
  });
});

describe("the project's copy rules", () => {
  const everything = [
    ...[OURS, THEIRS, STRANGER].flatMap((d) => {
      const p = replaceConfirmPrompt(d);
      return [p.title, p.body, p.confirmLabel];
    }),
    ...BLOCKED_REASONS.map(blockedMessage),
    outcomeMessage({ copied: 3, failed: null }, PATH),
    outcomeMessage({ copied: 1, failed: null }, PATH),
    outcomeMessage({ copied: 0, failed: null }, PATH),
    outcomeMessage({ copied: 1, failed: { path: "a.md", message: "EACCES" } }, PATH),
  ];

  it("uses no em dashes", () => {
    for (const s of everything) expect(s).not.toContain("\u2014");
  });

  it("says notes and folders, never items or files", () => {
    for (const s of everything) {
      expect(s.toLowerCase()).not.toMatch(/\bitems\b/);
      expect(s.toLowerCase()).not.toMatch(/\bfiles\b/);
    }
  });

  it("uses American spelling", () => {
    for (const s of everything) {
      expect(s.toLowerCase()).not.toMatch(/capitalisation|cancelled|behaviour/);
    }
  });
});
