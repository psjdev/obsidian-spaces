import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The installed `obsidian` package is types-only (`"main": ""`), so
      // importing it under Vitest throws before a test can run — which left
      // `main.ts` and 44 % of `src/` unreachable by any test, and let the
      // headline filtering feature be deleted with the suite green (SJ-05).
      // This is a RUNTIME substitution only: `tsconfig.json` declares no
      // `paths` mapping, so `tsc` still checks against the real `obsidian.d.ts`.
      // The stub models verified behaviour and throws for everything else —
      // read its docstring before widening it.
      obsidian: fileURLToPath(new URL("./tests/helpers/obsidian-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Fills in browser globals jsdom lacks. Without it a handler that uses one
    // throws inside an event listener, which Vitest reports as an unhandled
    // error while the test still passes.
    // `obsidianDom` adds the methods Obsidian installs on the DOM prototypes
    // (`instanceOf`), which no test environment provides.
    setupFiles: ["./tests/helpers/jsdomGaps.ts", "./tests/helpers/obsidianDom.ts"],
    include: ["tests/**/*.test.ts"],
    environmentMatchGlobs: [
      ["tests/explorerAdapter.test.ts", "jsdom"],
      ["tests/panelMount.test.ts", "jsdom"],
      ["tests/dragOrdering.test.ts", "jsdom"],
      ["tests/anchoredPopover.test.ts", "jsdom"],
      ["tests/filterAndOrderFolder.test.ts", "jsdom"],
      ["tests/createSpacePanel.test.ts", "jsdom"],
      ["tests/newFileLocation.test.ts", "jsdom"],
      ["tests/nativeNewFileParent.test.ts", "jsdom"],
    ],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // main.js is build output (gitignored); tests/** would otherwise
      // inflate the denominator with the harness's own code.
      exclude: ["tests/**", "main.js"],
      reporter: ["text", "html"],
      // No threshold: SJ-22's remediation explicitly warns against a global
      // number set from a single measurement — see FIX-REPORT.md for the
      // suggested starting point and why it's left to the maintainer.
      // thresholds: { lines: 60, branches: 55, functions: 60, statements: 60 },
    },
  },
});
