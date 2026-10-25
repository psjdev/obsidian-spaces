/**
 * Everything the export is allowed to do outside the vault.
 *
 * A port, in the manner of `VaultIndex`: deliberately narrow so the parts
 * that decide things stay pure and testable without a filesystem. The only
 * implementation that touches `fs` is `nodeExportSink.ts`, which is
 * therefore the only file in this feature the unit tests cannot reach.
 *
 * Every path is RELATIVE to the export root, and the implementation is
 * responsible for refusing one that climbs out of it.
 */
export interface ExportSink {
  ensureDir(rel: string): Promise<void>;
  writeFile(rel: string, data: Uint8Array): Promise<void>;
  writeText(rel: string, text: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
  /** Anything at all counts, including a lone dotfile. */
  isEmptyDir(rel: string): Promise<boolean>;
  /**
   * Only ever called on the export root itself, after the user has confirmed
   * a replace. Kept out of `runExport` on purpose, so no code path can reach
   * a recursive delete without passing the confirmation that authorises it.
   */
  removeDir(rel: string): Promise<void>;
}
