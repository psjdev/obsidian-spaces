import { open } from "node:fs/promises";
import { join } from "node:path";
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
export function createNodeHeadReader(vaultRoot: string): HeadReader {
  return async (path, bytes) => {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(join(vaultRoot, path), "r");
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
