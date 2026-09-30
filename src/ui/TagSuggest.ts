import { AbstractInputSuggest, type App } from "obsidian";
import { normalizeTag } from "../visibility/tagMatch";

/** How many candidates the popover offers at once. */
const MAX_SUGGESTIONS = 50;

/**
 * `MetadataCache.getTags()`, which `obsidian.d.ts` 1.13.1 does not declare
 * even though Obsidian ships it. Declared as the one method this file calls
 * and nothing else, so the cast below stays narrow and checked rather than
 * becoming an `any`.
 *
 * Not the private-API quarantine's business: nothing here is patched, no
 * `app` internal is reached through, and the call site is wrapped, so a build
 * of Obsidian without this method throws into `getSuggestions`'s own catch and
 * the field falls back to a plain input. It costs a suggestion list, never a
 * membership decision.
 */
interface TagCounts {
  getTags(): Record<string, number>;
}

/**
 * Backs the add-a-tag field's autocomplete.
 *
 * Written against `AbstractInputSuggest` the same way `FolderSuggest` is, and
 * for the same reasons recorded there: `renderSuggestion`/`getSuggestions` are
 * abstract on the base class, and `selectSuggestion` is overridden rather than
 * using the `onSelect` callback so a pick both notifies the caller AND clears
 * the input in one place. `getSuggestions` runs on every keystroke, long after
 * construction succeeded, so a throw there reports outward rather than leaving
 * the field silently dead.
 *
 * Candidates come from `metadataCache.getTags()`, which returns a record of
 * tag to count. Whether it merges frontmatter and inline tags has NOT been
 * verified. A miss here costs a suggestion, not a wrong result: membership
 * itself is decided later by `getAllTags` (`ObsidianTagIndex.ts`), which does
 * read both.
 *
 * Candidates are normalized before matching so the list holds one spelling of
 * each tag, matching the stored form; the leading `#` is added back only for
 * display.
 */
export class TagSuggest extends AbstractInputSuggest<string> {
  /**
   * Tracked exactly as `FolderSuggest` tracks it, and for the same class of
   * question: the caller's own Enter handler has to tell "the dropdown is
   * open, Obsidian's keymap is picking a suggestion" from "nothing is open,
   * commit what was typed". `PopoverSuggest` exposes no public getter for
   * this, only `open()`/`close()`, which are its documented, overridable
   * entry and exit points, so tracking a flag through them stays inside the
   * public surface.
   */
  private popoverOpen = false;

  constructor(
    app: App,
    textInputEl: HTMLInputElement,
    private readonly onPick: (tag: string) => void,
    private readonly onError: (e: unknown) => void
  ) {
    super(app, textInputEl);
  }

  get isPopoverOpen(): boolean {
    return this.popoverOpen;
  }

  override open(): void {
    this.popoverOpen = true;
    super.open();
  }

  override close(): void {
    this.popoverOpen = false;
    super.close();
  }

  protected override getSuggestions(query: string): string[] {
    try {
      const want = normalizeTag(query);
      const cache = this.app.metadataCache as unknown as TagCounts;
      const all = Object.keys(cache.getTags()).map(normalizeTag);
      const unique = [...new Set(all)].sort();
      if (want.length === 0) return unique.slice(0, MAX_SUGGESTIONS);
      return unique.filter((t) => t.includes(want)).slice(0, MAX_SUGGESTIONS);
    } catch (e) {
      this.onError(e);
      return [];
    }
  }

  override renderSuggestion(value: string, el: HTMLElement): void {
    el.setText("#" + value);
  }

  override selectSuggestion(value: string): void {
    this.onPick(value);
    this.setValue("");
    this.close();
  }
}
