import type * as FsPromises from "node:fs/promises";
import type * as NodePath from "node:path";
import type { HeadReader } from "./frontmatterHead";

/**
 * NODE FILESYSTEM — the only place in `src/` that touches it.
 *
 * The plugin is `isDesktopOnly: true` (see `manifest.json`), so `node:fs` is
 * available; `esbuild.config.mjs` marks it external, so the bundle `require`s
 * it from Electron rather than trying to inline it. Nothing else here may
 * import it: this module is a one-line adapter precisely so the rule and the
 * cap in `frontmatterHead.ts` stay testable without a disk.
 *
 * ## Why the require is LAZY
 *
 * A static `import` of an external module becomes a `require` at the top of the
 * bundle, so a failure there is a LOAD failure: the module never evaluates, the
 * plugin never loads, and the `adapter instanceof FileSystemAdapter` guard in
 * `main.ts` — which exists to leave the feature exactly where it was on a vault
 * with no real filesystem — cannot run at all to save it. Pulling the two
 * builtins in on first use makes that degradation real: the guard decides
 * whether a reader is built, and even a build without them loses the repair and
 * nothing else. It costs one `require` on the first head read of a session, and
 * the result is held.
 *
 * ## Why not `vault.cachedRead`
 *
 * Obsidian's reads are whole-file. On the case this exists for — a markdown
 * file somewhat over 32 MB that jams the parse queue — `cachedRead` pulls 33 MB
 * into memory AND into Obsidian's own read cache, to look at the first two
 * hundred bytes. `vault.adapter.read` is the same shape without the caching.
 * Neither offers a byte range. `fs.read` with an offset and a length does.
 *
 * ## Why it never throws
 *
 * Every failure is `null`, which `createFrontmatterSource` turns into
 * `"unreadable"`, which stays counted as a file we could not answer for. A
 * missing file, a lock, a disconnected network share and a permission error
 * are all causes a persistent `null` from `getFileCache` can have in the first
 * place, so this running into them is expected rather than exceptional.
 */

/**
 * Electron's CommonJS `require`, which is what the bundle is loaded with.
 *
 * NOT a dynamic ESM import, which is the other way to make a load lazy and does
 * not work here. Measured over CDP in a real Obsidian: asking the renderer for
 * a Node builtin that way throws
 * `TypeError: Failed to fetch dynamically imported module: node:fs/promises`,
 * from `eval` and from `new Function` alike, while `require` of the same
 * specifier returns the module. So the lazy form has to be this one.
 */
declare const require: (id: string) => unknown;

/**
 * The two surfaces this module uses, taken from the builtins' OWN types.
 *
 * `import type` is erased before anything runs, so this adds no import to the
 * bundle and leaves the lazy `require` below the only way either module is
 * reached. Taking the real types rather than hand-writing two interfaces means
 * a signature cannot quietly drift from Node's.
 */
type NodeBuiltins = { fs: typeof FsPromises; path: typeof NodePath };

/** Resolved on the first head read of a session, then held. */
let builtins: NodeBuiltins | null = null;

function nodeBuiltins(): NodeBuiltins {
  // Held as the MODULES, not as plucked functions, so every call below stays a
  // method call on its own module object.
  builtins ??= {
    fs: require("node:fs/promises") as typeof FsPromises,
    path: require("node:path") as typeof NodePath,
  };
  return builtins;
}

export function createNodeHeadReader(vaultRoot: string): HeadReader {
  return async (path, bytes) => {
    let handle: FsPromises.FileHandle | null = null;
    try {
      const node = nodeBuiltins();
      handle = await node.fs.open(node.path.join(vaultRoot, path), "r");
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      // `complete` only when the read did NOT fill the window, which is the
      // one case where there is certainly nothing after it. A file whose
      // length is exactly the window reads as incomplete and costs one extra
      // read at the next size up, which then answers.
      return { text: buffer.toString("utf8", 0, bytesRead), complete: bytesRead < bytes };
    } catch {
      return null;
    } finally {
      try {
        await handle?.close();
      } catch {
        // A handle that cannot be closed is not a reason to lose the read.
      }
    }
  };
}
