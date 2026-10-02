/**
 * Release guard for `manifest.json` and `versions.json`.
 *
 * These are the Obsidian community-plugin submission rules. They are trivial
 * to satisfy and trivial to break silently months later — a version bumped in
 * one file and not the other, a description that drifts into marketing copy —
 * and the failure surfaces as a rejected submission rather than a broken
 * build. Cheap to assert, so asserted.
 *
 * The version-consistency check is the load-bearing one: `manifest.json`,
 * `package.json` and `versions.json` all carry the version, and this repo has
 * already had them disagree once (a 1.0.0 tag reverted by hand, and a
 * `package-lock.json` left stale at 0.1.0). `version-bump.mjs` exists to keep
 * them in step; this proves it worked.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

interface Manifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  authorUrl?: string;
  /** Obsidian accepts a single URL or a labelled set; this manifest uses the set. */
  fundingUrl?: string | Record<string, string>;
  isDesktopOnly: boolean;
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as Manifest;
const versions = JSON.parse(readFileSync("versions.json", "utf8")) as Record<string, string>;
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

const SEMVER = /^\d+\.\d+\.\d+$/;

/** Flattens either `fundingUrl` shape to the list of addresses it offers. */
function fundingUrls(): string[] {
  const f = manifest.fundingUrl;
  if (f === undefined) return [];
  return typeof f === "string" ? [f] : Object.values(f);
}

describe("manifest.json", () => {
  it("has every required field", () => {
    for (const key of [
      "id",
      "name",
      "version",
      "minAppVersion",
      "description",
      "author",
      "isDesktopOnly",
    ] as const) {
      expect(manifest[key], `missing ${key}`).toBeDefined();
    }
  });

  it("uses a semver version", () => {
    expect(manifest.version).toMatch(SEMVER);
  });

  it("uses a semver minAppVersion", () => {
    expect(manifest.minAppVersion).toMatch(SEMVER);
  });

  it("keeps 'obsidian' out of the id and name", () => {
    // Obsidian's guidelines: the directory is all Obsidian plugins, so saying
    // so is noise. Rejected at submission.
    expect(manifest.id.toLowerCase()).not.toContain("obsidian");
    expect(manifest.name.toLowerCase()).not.toContain("obsidian");
  });

  it("keeps 'obsidian' and 'plugin' out of the description", () => {
    const d = manifest.description.toLowerCase();
    expect(d).not.toContain("obsidian");
    expect(d).not.toContain("plugin");
  });

  it("keeps the description to one sentence a directory listing can show", () => {
    expect(manifest.description.length).toBeGreaterThan(20);
    expect(manifest.description.length).toBeLessThanOrEqual(250);
  });

  it("uses https for any author or funding URL", () => {
    for (const url of [manifest.authorUrl, ...fundingUrls()]) {
      if (url !== undefined) expect(url.startsWith("https://")).toBe(true);
    }
  });

  it("gives every funding entry a non-empty label", () => {
    // The labelled form is what puts more than one option on the community
    // listing; an empty key renders as a nameless button.
    if (typeof manifest.fundingUrl === "object") {
      for (const label of Object.keys(manifest.fundingUrl)) {
        expect(label.trim()).not.toBe("");
      }
    }
  });
});

describe("versions.json", () => {
  it("maps the current manifest version to its minAppVersion", () => {
    expect(versions[manifest.version]).toBe(manifest.minAppVersion);
  });

  it("uses semver for every key and value", () => {
    for (const [plugin, app] of Object.entries(versions)) {
      expect(plugin, `plugin version ${plugin}`).toMatch(SEMVER);
      expect(app, `app version for ${plugin}`).toMatch(SEMVER);
    }
  });
});


describe("package.json", () => {
  it("carries the same version as the manifest", () => {
    // `version-bump.mjs` runs off `npm version`, which writes package.json
    // first; a mismatch means the hook did not run.
    expect(pkg.version).toBe(manifest.version);
  });
});
