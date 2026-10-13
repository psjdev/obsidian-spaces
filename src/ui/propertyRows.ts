/**
 * What the create panel's Properties body offers, and what picking one means.
 *
 * Pure: no DOM, no `"obsidian"`. The panel draws; this decides which keys are
 * offered, what a value row is called, which member a control adds, and
 * whether a space already holds it.
 */

import { isEligiblePropertyKey, memberIdentity } from "../definitions/schema";
import type { MemberEntry, PropertyMember, SpaceDefinition } from "../types";
import { normalizeValue } from "../visibility/propertyValues";

/**
 * Keys the picker never offers although the vault holds them.
 *
 * Obsidian accepts both as frontmatter aliases of the same thing, so a
 * property member on either would find frontmatter tags and miss every inline
 * `#tag`. The Tags mode matches both. This is a PICKER decision only: the
 * matcher still honors a stored member that names either key, because a
 * document can carry one and quietly changing what it matches would be worse.
 * Compared without regard to case, for the reason in `isPickableKey`.
 */
const TAG_ALIAS_KEYS: ReadonlySet<string> = new Set(["tags", "tag"]);

const NAME_ORDER = new Intl.Collator(undefined, { sensitivity: "base" });

/** Whether the picker may draw an add control for this key. */
export function isPickableKey(key: string): boolean {
  // The ONE deliberately case-insensitive key comparison in this feature.
  // Every other key comparison here is exact on purpose, because the matcher
  // matches keys exactly. This one follows Obsidian's own alias rule, which
  // reads frontmatter `Tags:` and `TAG:` as tags too (`/^tags?$/i`); matching
  // exactly would offer such a key as an ordinary property and a member built
  // from it would miss every inline #tag. Do not make it exact.
  return isEligiblePropertyKey(key) && !TAG_ALIAS_KEYS.has(key.toLowerCase());
}

/**
 * The keys to draw, from what the index reports: every pickable key whose
 * name contains the query (case-insensitive, surrounding blanks in the query
 * ignored), in name order.
 *
 * Name order rather than the index's busiest-first: a person scanning for a
 * property they know by name is better served by a stable order than by
 * counts that shift as notes change. The order is the locale's, ignoring case
 * and accents (`Due` beside `due`, `Éa` beside `ea`), with the raw spelling
 * breaking ties so two keys that differ only in case never swap between draws.
 *
 * The query is matched against key NAMES. `keepUnmatched` is the one way a key
 * whose name does not match is still drawn, and it exists for ONE caller: the
 * create panel keeps an OPEN key whose own values match, so that typing a
 * value reaches the value rather than closing the key it is in. It is asked
 * only about keys the name test already rejected, and only while the query is
 * non-empty, so a closed key is never a reason to build value buckets — that
 * work stays deferred until a key is expanded, which is what the caller's
 * predicate tests first.
 */
export function pickableKeys(
  all: ReadonlyArray<{ key: string; count: number }>,
  query: string,
  keepUnmatched: (key: string) => boolean = () => false
): Array<{ key: string; count: number }> {
  const q = query.trim().toLowerCase();
  return all
    .filter(
      (k) =>
        isPickableKey(k.key) &&
        (q === "" || k.key.toLowerCase().includes(q) || keepUnmatched(k.key))
    )
    .sort(
      (a, b) =>
        NAME_ORDER.compare(a.key, b.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    );
}

/**
 * The filter box's text in the terms a VALUE is matched on.
 *
 * `normalizeValue`, not the key filter's `trim().toLowerCase()`: a value row
 * is matched against the `normalized` field the index already computed, so the
 * query has to be put through exactly the rule that produced it or an accented
 * value typed in one Unicode form would miss the row drawn from the other.
 * Keys are left alone; this is the value side only.
 *
 * Computed once per draw and handed to `valueMatches`, because the filter runs
 * per keystroke against a list that can hold thousands of values.
 */
export function valueQuery(query: string): string {
  return normalizeValue(query);
}

/**
 * Whether a value row survives the filter, given `valueQuery`'s answer.
 *
 * Substring, case- and blank-insensitive, which is the key filter's rule so
 * that one box means one thing in both halves of the list. An empty query
 * keeps everything, which is the common case and is tested first.
 *
 * Reads `normalized` rather than `value`, so no per-keystroke lowercasing of
 * the authored spelling happens: the index computed that field once, when the
 * key's buckets were built.
 */
export function valueMatches(value: { readonly normalized: string }, query: string): boolean {
  return query === "" || value.normalized.includes(query);
}

/**
 * What a value row reads.
 *
 * A value that is empty, or only blanks, would draw a row with nothing on it,
 * which cannot be told from a drawing bug or from the key's own existence
 * row. Matching trims, so the two share one bucket and one label.
 */
export function valueLabel(value: string): string {
  return value.trim() === "" ? "Empty string" : value;
}

/** The member the key row's select control adds: the key exists. */
export function existsMember(key: string): PropertyMember {
  return { kind: "property", key };
}

/** The member a value row adds, in the spelling the vault showed. */
export function equalsMember(key: string, value: string): PropertyMember {
  return { kind: "property", key, value };
}

/**
 * Whether the space already holds this property member, by `memberIdentity`,
 * so `" Active "` and `"active"` are the one member the loader would keep.
 * `items` is the whole mixed list and `member` is a `PropertyMember`, so the
 * kind check is the compiler's: a file, folder or tag cannot be passed as the
 * question, and one in `items` can never be the answer because
 * `memberIdentity` namespaces every identity by kind, so a path spelled like
 * the key cannot share one. `addPropertyMember` carried a runtime
 * `member.kind !== "property"` guard for this that no caller could reach.
 */
export function holdsProperty(items: readonly MemberEntry[], member: PropertyMember): boolean {
  const id = memberIdentity(member);
  return items.some((m) => memberIdentity(m) === id);
}

/**
 * The space with `member` appended, and nothing else about it changed.
 *
 * Returns a new object that shares every other field with `space` (name, icon,
 * color, exclusions, existing members and their order), so the one thing that
 * differs is the end of `members`. Appending rather than sorting is what keeps
 * the order the person arranged.
 *
 * A property member the space already holds, by `memberIdentity`, returns the
 * space unchanged, so a caller that raced a second add cannot store two rows
 * the loader would collapse into one.
 */
export function addPropertyMember(space: SpaceDefinition, member: PropertyMember): SpaceDefinition {
  if (holdsProperty(space.members, member)) return space;
  return { ...space, members: [...space.members, member] };
}

/** What typing a property into the contents dialog's adder amounts to. */
export type PropertyAdd =
  | { outcome: "add"; member: PropertyMember }
  | { outcome: "held"; label: string }
  | { outcome: "blank" }
  | { outcome: "tags" }
  | { outcome: "spaced" }
  | { outcome: "unknown-keys" };

/**
 * Reads the adder's two fields.
 *
 * The KEY is used exactly as typed, because keys match exactly and the key
 * field suggests vault keys that can carry surrounding blanks: trimming would
 * turn a suggested `" status "` into a different member that matches nothing.
 * `knownKeys` is the vault's own spelling of every key it holds. A key with
 * surrounding blanks that the vault does not hold is refused as "spaced"
 * rather than stored, since it would match nothing and the person most likely
 * typed a stray blank. A key that is empty after trimming is "blank", the
 * schema's rule.
 *
 * `knownKeys` IS NULL WHEN THE VAULT HAS NOT BEEN READ, and that is not the
 * empty set. An empty set says the vault holds no key of that spelling;
 * `null` says nobody has looked. Only a padded key needs the difference, and
 * it is the whole difference there: refusing one as "spaced" while the index
 * is unavailable told the person "no property in the vault is spelled with
 * spaces at the ends" about a vault nothing had read, and the key could
 * perfectly well exist. "unknown-keys" is that case, for a caller to report
 * as the wait it is.
 *
 * The VALUE is trimmed, and an empty one means "has this property" while text
 * means "equals it". "Equals the empty string" is therefore not addable here;
 * the create panel's picker lists the vault's real empty-string value and adds
 * it from there.
 *
 * Eligibility is `isPickableKey`, the picker's own rule, so a key the schema
 * would reject and the tag keys are refused the same way in both places.
 * Tags are told apart because that is the one a person might type on purpose
 * and who has somewhere else to go.
 */
export function readPropertyAdd(
  members: readonly MemberEntry[],
  keyText: string,
  valueText: string,
  knownKeys: ReadonlySet<string> | null
): PropertyAdd {
  const key = keyText;
  const value = valueText.trim();
  if (!isEligiblePropertyKey(key)) return { outcome: "blank" };
  if (!isPickableKey(key)) return { outcome: "tags" };
  if (key !== key.trim()) {
    if (knownKeys === null) return { outcome: "unknown-keys" };
    if (!knownKeys.has(key)) return { outcome: "spaced" };
  }
  const member = value === "" ? existsMember(key) : equalsMember(key, value);
  if (holdsProperty(members, member)) {
    return { outcome: "held", label: value === "" ? key : `${key}: ${value}` };
  }
  return { outcome: "add", member };
}
