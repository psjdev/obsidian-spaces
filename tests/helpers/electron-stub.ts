/**
 * Runtime stand-in for `electron` under Vitest, in the manner of
 * `obsidian-stub.ts`.
 *
 * Obsidian provides `electron` to the renderer and the build externalises
 * it, so the module does not exist in `node_modules` and importing `main.ts`
 * without this throws before a test can run.
 *
 * It deliberately models NOTHING. The one call the plugin makes,
 * `remote.dialog.showOpenDialog`, opens a modal directory picker, and a test
 * that reached it would hang rather than fail. `exportActiveSpace` takes
 * `pickDir` as an injected function precisely so no test has to; a throw
 * here is how that stays true instead of being merely intended.
 *
 * `tsconfig.json` declares no `paths` mapping, so `tsc` still checks against
 * the real declaration in `src/electron.d.ts`.
 */
export const remote = {
  dialog: {
    showOpenDialog(): never {
      throw new Error(
        "electron.remote.dialog.showOpenDialog was called in a test. " +
          "The directory picker is injected as `pickDir`; inject a fake instead."
      );
    },
  },
};
