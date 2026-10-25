/**
 * Turns a space's name into a folder name that every desktop filesystem can
 * store.
 *
 * This is a safety function, not a tidiness one. The result becomes a folder
 * OUTSIDE the vault, and it is the folder the export may later be asked to
 * replace, so a name that escaped its parent would aim a recursive delete
 * somewhere the user never picked.
 */

/**
 * Separators, the characters Windows forbids, and control characters.
 *
 * The control range is deliberate, not the accident `no-control-regex`
 * exists to catch: a vault synced from Linux can hold a name containing one,
 * and Windows refuses to create the file.
 */
// eslint-disable-next-line no-control-regex -- deliberate: a vault synced from Linux can hold a name containing a control character, and Windows refuses to create that file
const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f]/g;

/**
 * Names Windows refuses whatever the extension. Writing to one of these does
 * not create a file: the bytes go to the device and disappear, and an export
 * that did it would report success having written nothing.
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Used when a name has nothing usable left in it. */
const FALLBACK = "Space";

export function safeFolderName(name: string): string {
  const cleaned = name
    .replace(FORBIDDEN, "-")
    // A run of replacements reads better as one dash than as five.
    .replace(/-{2,}/g, "-")
    // Both ends, and dashes among them: "///" becomes "-" after the
    // replacement above, and returning "-" as a folder name would be absurd.
    // Windows additionally cannot store a name ending in a dot or a space.
    .replace(/^[\s.-]+|[\s.-]+$/g, "");

  if (cleaned === "") return FALLBACK;
  // Suffixed rather than replaced, so the folder still says which space it
  // came from. `CONTENTS` and `COM10` are not reserved and are left alone.
  return RESERVED.test(cleaned) ? `${cleaned}-space` : cleaned;
}
