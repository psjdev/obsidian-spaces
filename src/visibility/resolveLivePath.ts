import { canonicalPath } from "./glob";
import type { VaultIndex } from "./VaultIndex";

/**
 * Resolve a stored path to the live path it names, under the plugin's
 * case-insensitive policy, or `null` when the vault holds nothing by that
 * name in any casing.
 *
 * An exact hit short-circuits, so a case-sensitive filesystem holding both
 * `a/Note.md` and `a/note.md` still gives each stored path itself; the fold
 * only ever decides a lookup that would otherwise have failed. That is also
 * what keeps this off the hot path: the walk runs only for a member the
 * verbatim lookup missed, and costs one `childrenOf` per segment rather than
 * an O(vault) rescan.
 *
 * Its own module because two layers ask this question, the visibility engine
 * when it seeds a snapshot and the create panel when it asks which folder
 * covers a row. A second copy of the rule is a second place for the two to
 * disagree about case, which is the defect this was extracted to fix. It reads
 * only `exists` and `childrenOf`, so a caller need not hold the whole index.
 */
export function resolveLivePath(
  vault: Pick<VaultIndex, "exists" | "childrenOf">,
  stored: string
): string | null {
  if (vault.exists(stored)) return stored;
  let at = "";
  for (const seg of stored.split("/")) {
    const want = canonicalPath(seg);
    const offset = at === "" ? 0 : at.length + 1;
    const hit = vault
      .childrenOf(at)
      .find((c) => canonicalPath(c.slice(offset)) === want);
    if (hit === undefined) return null;
    at = hit;
  }
  return at;
}
