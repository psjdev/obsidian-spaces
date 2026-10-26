/**
 * Everything the export is allowed to do outside the vault.
 *
 * A port, in the manner of `VaultIndex`: deliberately narrow so the parts
 * that decide things stay pure and testable without a filesystem. The
 * implementation that touches `fs` is `nodeExportSink.ts`, which is tested
 * against a real temp directory rather than through a fake, because a fake
 * of a filesystem is exactly where this feature's worst bug hid.
 *
 * Every path is RELATIVE to the export root, and the implementation is
 * responsible for refusing one that climbs out of it.
 */
export interface ExportSink {
  ensureDir(rel: string): Promise<void>;
  writeFile(rel: string, data: Uint8Array): Promise<void>;
  writeText(rel: string, text: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
  /** The file's text, or null when it is absent or unreadable. */
  readText(rel: string): Promise<string | null>;
  /**
   * How many entries a directory holds, dotfiles included.
   *
   * The confirmation in front of the recursive delete says this out loud:
   * "holds 412 notes and folders" is what tells someone they are about to
   * replace their Documents folder rather than a stale export.
   */
  countEntries(rel: string): Promise<number>;
  /**
   * Only ever called on the export root itself, after the user has confirmed
   * a replace. Kept out of `runExport` on purpose, so no code path can reach
   * a recursive delete without passing the confirmation that authorises it.
   */
  removeDir(rel: string): Promise<void>;
}
