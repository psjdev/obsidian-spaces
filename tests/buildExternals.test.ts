import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** The config with comments removed, so a commented-out line cannot pass. */
async function config(): Promise<string> {
  return (await readFile("esbuild.config.mjs", "utf8"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/**
 * The bundle must leave Obsidian's runtime modules alone.
 *
 * `obsidian` and `electron` were always external. `fs` and `path` became
 * necessary when the space export gained a destination outside the vault:
 * without them esbuild tries to BUNDLE the Node builtins and the build fails
 * with `Could not resolve "fs"`, which is what it did before this was added.
 *
 * The alternative, a `Platform.isDesktop`-guarded dynamic import, is not open
 * to this project: `noNetwork.test.ts` bans `import(` outright.
 */
describe("the bundle's externals", () => {
  it("leaves every module Obsidian's desktop runtime already provides", async () => {
    // Comments are stripped first. Grepping the raw text kept this green
    // when the whole `external:` line was commented out, while the build
    // failed to resolve obsidian, electron and fs.
    const external = /external:\s*\[([^\]]*)\]/.exec(await config())?.[1] ?? "";
    for (const m of ["obsidian", "electron", "fs", "fs/promises", "path"]) {
      expect(external).toContain(`"${m}"`);
    }
  });

  it("bundles everything else, because the plugin ships one file", async () => {
    const src = await config();
    expect(src).toContain("bundle: true");
    // `platform` stays unset. Externalising three builtins is narrower than
    // switching the whole bundle to node, which would change how every other
    // import resolves.
    expect(src).not.toContain("platform:");
  });
});
