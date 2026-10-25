import { describe, expect, it } from "vitest";
import { checkExportDir, resolveExportDir } from "../src/export/destination";

describe("resolveExportDir", () => {
  it("puts the export in a subfolder named after the space", () => {
    // Never loose notes in the folder the user picked.
    expect(resolveExportDir("C:/Users/x/Desktop", "Kitchen")).toBe("C:/Users/x/Desktop/Kitchen");
  });

  it("sanitises the space name into that subfolder", () => {
    expect(resolveExportDir("C:/Users/x/Desktop", "a/b")).toBe("C:/Users/x/Desktop/a-b");
    expect(resolveExportDir("C:/Users/x/Desktop", "..")).toBe("C:/Users/x/Desktop/Space");
  });

  it("normalises separators so the result is one shape", () => {
    expect(resolveExportDir("C:\\Users\\x\\Desktop", "Kitchen")).toBe("C:/Users/x/Desktop/Kitchen");
  });

  it("tolerates a trailing separator on the chosen folder", () => {
    expect(resolveExportDir("C:/Users/x/Desktop/", "Kitchen")).toBe("C:/Users/x/Desktop/Kitchen");
  });
});

describe("checkExportDir", () => {
  it("refuses when the RESOLVED directory is the vault", () => {
    // The defect this function was rewritten for. Vault at C:/Notes/Vault,
    // the user picks C:/Notes, the space is called Vault: the old check ran
    // on C:/Notes, passed, and the export then deleted the vault.
    const resolved = resolveExportDir("C:/Notes", "Vault");
    expect(resolved).toBe("C:/Notes/Vault");
    expect(checkExportDir(resolved, "C:/Notes/Vault")).toBe("inside-vault");
  });

  it("refuses a directory inside the vault", () => {
    expect(checkExportDir("C:/Notes/Vault/Exports/Kitchen", "C:/Notes/Vault")).toBe("inside-vault");
  });

  it("refuses a directory that CONTAINS the vault", () => {
    // Replacing it would take the vault with it.
    expect(checkExportDir("C:/Notes", "C:/Notes/Vault")).toBe("contains-vault");
  });

  it("refuses when the vault path is unknown", () => {
    // A non-FileSystemAdapter, or an empty base path, must not silently
    // disable the only guard there is.
    expect(checkExportDir("C:/anywhere/Kitchen", null)).toBe("unknown-vault");
    expect(checkExportDir("C:/anywhere/Kitchen", "")).toBe("unknown-vault");
    expect(checkExportDir("C:/anywhere/Kitchen", "   ")).toBe("unknown-vault");
  });

  it("compares case-insensitively and across separators, as Windows does", () => {
    expect(checkExportDir("c:\\notes\\vault\\x", "C:/Notes/Vault")).toBe("inside-vault");
    expect(checkExportDir("C:/NOTES/VAULT", "c:/notes/vault")).toBe("inside-vault");
  });

  it("ignores a trailing separator on either side", () => {
    expect(checkExportDir("C:/Notes/Vault/", "C:/Notes/Vault")).toBe("inside-vault");
    expect(checkExportDir("C:/Notes/Vault", "C:/Notes/Vault/")).toBe("inside-vault");
  });

  it("allows a sibling whose name merely starts the same", () => {
    // The separator is what stops a prefix match being wrong here.
    expect(checkExportDir("C:/VaultExports/Kitchen", "C:/Vault")).toBe(null);
    expect(checkExportDir("C:/Notes/VaultBackup", "C:/Notes/Vault")).toBe(null);
  });

  it("allows an unrelated destination", () => {
    expect(checkExportDir("C:/Users/x/Desktop/Kitchen", "C:/Notes/Vault")).toBe(null);
  });

  it("refuses an empty resolved directory rather than treating it as root", () => {
    expect(checkExportDir("", "C:/Notes/Vault")).toBe("unknown-vault");
  });
});
