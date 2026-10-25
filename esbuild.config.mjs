import esbuild from "esbuild";

const production = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Modules Obsidian's desktop runtime already provides, left for it to
  // resolve. `fs` and `path` joined the list when the space export gained a
  // destination outside the vault: with no `platform` set esbuild defaults to
  // browser and fails with `Could not resolve "fs"`. A `Platform.isDesktop`
  // guarded dynamic import is not open to this project, because
  // `noNetwork.test.ts` bans `import(`.
  external: ["obsidian", "electron", "fs", "fs/promises", "path"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (production) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
