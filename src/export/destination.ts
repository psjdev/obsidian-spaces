import { safeFolderName } from "./safeFolderName";

/**
 * Where an export may and may not go.
 *
 * Pure, so it can be tested without a filesystem. A string comparison
 * cannot see through a link, so `exportCommand.ts` resolves BOTH sides
 * before calling in: the export folder itself, not only the folder the user
 * picked, and the vault path too. Resolving one side and not the other made
 * the comparison asymmetric and let a junctioned vault past.
 */

export type DestinationProblem = "inside-vault" | "contains-vault" | "unknown-vault";

/** Separators to `/`, no trailing separator. Case is preserved. */
function normalise(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * The folder an export actually writes into: a subfolder of the chosen
 * directory, named after the space.
 *
 * The subfolder is what stops an export scattering notes and folders across
 * someone's desktop, and it is the only thing a replace ever removes.
 */
export function resolveExportDir(chosenDir: string, spaceName: string): string {
  return `${normalise(chosenDir)}/${safeFolderName(spaceName)}`;
}

/**
 * Whether this export directory is allowed.
 *
 * **Takes the RESOLVED directory**, not the one the user picked. The
 * difference is not cosmetic: with the chosen directory, a vault at
 * `C:/Notes/Vault`, a pick of `C:/Notes` and a space called `Vault` passed
 * the check and then deleted the vault.
 *
 * An unknown vault path is refused rather than allowed. The vault is only
 * reachable through a `FileSystemAdapter`, and failing open there would
 * disable the only guard this feature has.
 */
export function checkExportDir(
  resolvedDir: string,
  vaultBasePath: string | null
): DestinationProblem | null {
  const dir = normalise(resolvedDir).trim();
  const vault = normalise(vaultBasePath ?? "").trim();
  if (dir === "" || vault === "") return "unknown-vault";

  const d = dir.toLowerCase();
  const v = vault.toLowerCase();
  // The separator is what keeps `C:/VaultExports` from matching `C:/Vault`.
  if (d === v || d.startsWith(`${v}/`)) return "inside-vault";
  if (v.startsWith(`${d}/`)) return "contains-vault";
  return null;
}
