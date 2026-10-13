import esbuild from "esbuild";

const production = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // `node:fs/promises` and `node:path` are Electron's, reached by
  // `src/visibility/nodeHeadReader.ts` — the bounded head read a jammed
  // metadata cache is repaired from. The plugin is `isDesktopOnly: true`, so
  // they are always present; marked external so the bundle `require`s them
  // instead of esbuild trying to inline a Node builtin for a browser target.
  external: ["obsidian", "electron", "node:fs/promises", "node:path"],
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
