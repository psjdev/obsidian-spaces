import { describe, expect, it } from "vitest";
import { safeFolderName } from "../src/export/safeFolderName";
import { MAX_SPACE_NAME_LENGTH } from "../src/definitions/schema";

/**
 * A space can be called anything. The name becomes a folder name on the
 * user's disk, outside the vault, and that folder is the one the export may
 * later be asked to replace. An unsanitised name is a path traversal, and a
 * name Windows cannot store is an export that fails halfway.
 */
describe("safeFolderName", () => {
  it("keeps an ordinary name", () => {
    expect(safeFolderName("Kitchen")).toBe("Kitchen");
    expect(safeFolderName("Kitchen Rebuild")).toBe("Kitchen Rebuild");
  });

  it("replaces path separators, so a name cannot escape the destination", () => {
    expect(safeFolderName("a/b")).toBe("a-b");
    expect(safeFolderName("a\\b")).toBe("a-b");
    expect(safeFolderName("..")).toBe("Space");
    expect(safeFolderName("../../etc")).toBe("etc");
  });

  it("replaces the characters Windows forbids", () => {
    expect(safeFolderName('a:b*c?d"e<f>g|h')).toBe("a-b-c-d-e-f-g-h");
  });

  it("replaces control characters", () => {
    expect(safeFolderName("a\u0000b\u001fc")).toBe("a-b-c");
  });

  it("strips trailing dots and spaces, which Windows cannot store", () => {
    expect(safeFolderName("Kitchen.")).toBe("Kitchen");
    expect(safeFolderName("Kitchen ")).toBe("Kitchen");
    expect(safeFolderName("Kitchen . . ")).toBe("Kitchen");
  });

  it("renames Windows reserved device names, whatever their case", () => {
    // Writing to one of these does not create a file. The bytes go to the
    // device and vanish, and the export reports success.
    expect(safeFolderName("CON")).toBe("CON-space");
    expect(safeFolderName("nul")).toBe("nul-space");
    expect(safeFolderName("COM1")).toBe("COM1-space");
    expect(safeFolderName("LPT9")).toBe("LPT9-space");
  });

  it("leaves a name that merely starts like a device name alone", () => {
    expect(safeFolderName("CONTENTS")).toBe("CONTENTS");
    expect(safeFolderName("COM10")).toBe("COM10");
  });

  it("falls back when nothing usable is left", () => {
    // The first draft of this collapsed "///" to "-" and returned it. Dashes
    // have to come off both ends BEFORE the empty check.
    expect(safeFolderName("///")).toBe("Space");
    expect(safeFolderName("")).toBe("Space");
    expect(safeFolderName("   ")).toBe("Space");
    expect(safeFolderName("...")).toBe("Space");
    expect(safeFolderName("<>:|")).toBe("Space");
  });

  it("leaves non-ASCII names alone", () => {
    expect(safeFolderName("Küche 厨房")).toBe("Küche 厨房");
    expect(safeFolderName("Ноутбук")).toBe("Ноутбук");
  });

  it("cannot outgrow what a filesystem will store", () => {
    // Measured: a folder name of 255 characters is accepted and 300 fails
    // with EINVAL. Space names are capped at MAX_SPACE_NAME_LENGTH by the
    // schema, and this only ever ADDS the `-space` suffix, so the two
    // constants have to stay compatible. Nothing else couples them.
    const longest = safeFolderName("C".repeat(MAX_SPACE_NAME_LENGTH));
    expect(longest.length).toBeLessThanOrEqual(255);
    const worst = safeFolderName("CON".padEnd(MAX_SPACE_NAME_LENGTH, "1"));
    expect(worst.length).toBeLessThanOrEqual(255);
  });

  it("is idempotent, so a sanitised name survives a second pass", () => {
    for (const n of ["a/b", "CON", "///", "Kitchen.", "<>:|", "Küche 厨房"]) {
      expect(safeFolderName(safeFolderName(n))).toBe(safeFolderName(n));
    }
  });
});
