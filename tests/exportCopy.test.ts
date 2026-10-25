import { describe, expect, it } from "vitest";
import {
  BLOCKED_REASONS,
  blockedMessage,
  outcomeMessage,
  replaceConfirmPrompt,
} from "../src/export/exportCopy";

const PATH = "C:/Users/x/Desktop/Kitchen";

describe("replaceConfirmPrompt", () => {
  it("names the full path, because the folder is outside the vault", () => {
    expect(replaceConfirmPrompt(PATH, "Kitchen").body).toContain(PATH);
  });

  it("names the space in the title", () => {
    expect(replaceConfirmPrompt(PATH, "Kitchen").title).toContain("Kitchen");
  });

  it("says what replacing destroys, not just that it replaces", () => {
    expect(replaceConfirmPrompt(PATH, "Kitchen").body).toMatch(/delet|lost/i);
  });

  it("labels the button with the action, not with yes", () => {
    expect(replaceConfirmPrompt(PATH, "Kitchen").confirmLabel).toBe("Replace");
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

  it("explains that a folder is not ours rather than offering to replace it", () => {
    expect(blockedMessage("not-our-folder")).toMatch(/export of this space/i);
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
    replaceConfirmPrompt(PATH, "Kitchen").title,
    replaceConfirmPrompt(PATH, "Kitchen").body,
    replaceConfirmPrompt(PATH, "Kitchen").confirmLabel,
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
