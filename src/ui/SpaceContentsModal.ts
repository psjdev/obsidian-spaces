import { Modal, Notice, Setting, type App } from "obsidian";
import { TagSuggest } from "./TagSuggest";
import { nativeKnownTags } from "./nativeTagCounts";
import {
  exclusionRows,
  memberRows,
  withoutMember,
  withoutTagMember,
  type PathMemberRow,
  type TagMemberRow,
} from "./memberList";
import { normalizeTag } from "../visibility/tagMatch";
import type { DefinitionStore } from "../definitions/DefinitionStore";
import type { TagIndex } from "../visibility/TagIndex";
import type { SpaceDefinition } from "../types";

/**
 * One space's stored members, listed in a dialog rather than
 * inline on the settings tab.
 *
 * **Why it moved.** The list was rendered under each space on the settings
 * tab, so a vault with a dozen spaces produced a page of member rows a user
 * had to scroll past to reach a toggle. The list itself was never the problem
 * — an entry whose file has gone is kept deliberately, so the path can be
 * reoccupied, and until this list existed there was no way to see or clear
 * one. What was wrong was making every user read it every time.
 *
 * **Deliberately an Obsidian `Modal`, unlike `IconPickerPopover`.** That file
 * records rejecting `Modal` and the reason still stands where it was written:
 * a ~700px dialog centred on the window is a full-screen interruption for
 * picking a 16px glyph anchored to a control. This is the opposite case — a
 * variable-length list of paths, opened from a settings row, with nothing to
 * anchor to. A centred dialog is the right shape here, and reaching for the
 * owned-popover machinery instead would be cargo-culting a decision made
 * about a different problem.
 *
 * It is also the only surface that can add a TAG member: the explorer's
 * "Add to space" menu hangs off a file or a folder, and a tag is neither.
 *
 * It decides nothing: which rows exist and what each one's status is comes
 * from `memberRows`, which is pure and tested in plain node, and both removal
 * filters come from `memberList.ts` for the same reason.
 */
/**
 * What a tag row says about its reach.
 *
 * Three cases, not two. `matchCount: null` means the caller did not count,
 * and this dialog always does — but saying "no notes carry it" for an
 * uncounted tag is precisely the conflation `TagMemberRow.matchCount` warns
 * against, so the unreachable case is written out rather than folded into the
 * zero one. A future caller that cannot afford the walk then degrades to
 * saying less, never to saying something false.
 */
function tagRowDescription(row: TagMemberRow): string {
  if (row.matchCount === null) return "Tag. Nested tags included.";
  if (row.status === "matches-nothing") return "Tag. No notes carry it right now.";
  const notes = row.matchCount === 1 ? "note" : "notes";
  return `Tag. ${row.matchCount} ${notes}, nested tags included.`;
}

export class SpaceContentsModal extends Modal {
  /**
   * The live tag suggester, retained for the same reason
   * `openFolderPickerPopover` retains its `FolderSuggest`: it owns a popover
   * and document-level listeners that are NOT parented under `contentEl`, so
   * emptying the dialog on re-render or on close would strand them. Null when
   * nothing is mounted, and null when construction threw and the field
   * degraded to a plain input.
   */
  private tagSuggest: TagSuggest | null = null;

  constructor(
    app: App,
    private defs: DefinitionStore,
    private spaceId: string,
    /**
     * The one tag index, reached rather than built.
     *
     * This dialog used to construct its own `createObsidianTagIndex`, as did
     * the settings tab behind it and the controller: three walks of every
     * markdown file's metadata cache over identical data, two of them within
     * 30 ms of each other at load. The controller owns the index, replaces it
     * on every flush and on every metadata change, and exposes it precisely
     * so a question asked outside a recompute is answered from the same
     * picture the tree was drawn from.
     *
     * A function rather than the index itself: it is a SNAPSHOT and the one
     * in force is replaced under this dialog, which re-renders after every
     * write.
     */
    private tagIndex: () => TagIndex
  ) {
    super(app);
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.releaseTagSuggest();
    this.contentEl.empty();
  }

  /**
   * Re-read from the store on every render rather than closing over a
   * snapshot: removing a member mutates `defs`, and a stale copy would leave
   * the dialog showing a row that no longer exists.
   */
  private render(): void {
    const { contentEl } = this;
    this.releaseTagSuggest();
    contentEl.empty();

    const space = this.defs.get().spaces.find((s) => s.id === this.spaceId);
    if (!space) {
      // Reachable: the space can be deleted from the settings tab behind this
      // dialog, or by an external edit to data.json.
      contentEl.createEl("p", { text: "This space no longer exists." });
      return;
    }

    this.titleEl.setText(`Contents of ${space.name}`);

    // Taken ONCE per render and closed over, never once per row. The shared
    // index is lazy, so a space holding no tags still pays for no walk at
    // all — this dialog re-renders after every write, and most curated
    // spaces are paths only — and taking it once per render rather than once
    // per row means every count on screen describes one picture of the
    // vault.
    let tags: TagIndex | null = null;
    const matchCount = (tag: string): number => {
      tags ??= this.tagIndex();
      return tags.pathsMatching(tag).length;
    };

    // Shared with the exclusions section below, which asks the same question
    // of a different list of paths.
    const exists = (path: string): boolean =>
      this.app.vault.getAbstractFileByPath(path) !== null;

    const rows = memberRows(space, exists, matchCount);

    // Above the list, so it is still reachable on a space with no members:
    // that is the space most in need of one.
    this.renderTagAdder(contentEl, space);

    if (rows.length === 0) {
      this.renderEmpty(contentEl);
    } else {
      for (const row of rows) {
        if (row.kind === "tag") this.renderTagRow(contentEl, space, row);
        else this.renderMemberRow(contentEl, space, row);
      }
    }

    this.renderExclusions(contentEl, space, exists);
  }

  /**
   * A space with no members shows every file in the vault as a visitor and
   * nothing as its own, which looks broken rather than empty. Saying how to
   * fix it costs one sentence and is the only guidance this dialog can give.
   */
  private renderEmpty(containerEl: HTMLElement): void {
    containerEl.createEl("p", {
      text:
        "This space has no members yet, so it shows nothing of its own. " +
        "Right-click a file or folder in the explorer and choose “Add to space”, " +
        "or add a tag above.",
    });
  }

  /**
   * The add-a-tag field, and the only way to add a tag member at all.
   *
   * Construction is wrapped and the throw reported, following
   * `openFolderPickerPopover`: `AbstractInputSuggest` needs a real `App` and
   * builds its own popover, and an uncaught throw here would take the whole
   * dialog down with it. On a failure the field stays a plain text input and
   * Enter still commits, so the feature degrades instead of dying silently.
   *
   * Enter is handled only while the suggester's own dropdown is CLOSED. With
   * it open, Obsidian's keymap is already picking the highlighted suggestion,
   * and committing the raw input text as well would add whatever prefix the
   * user had typed alongside the tag they actually chose. `isPopoverOpen`
   * rather than `defaultPrevented`, for the reason `FolderPickerPopover`
   * records: there is no guarantee the keymap's handling runs first or marks
   * the event.
   *
   * A tag no note carries yet is still a legitimate member, so the typed value
   * is committed as given rather than checked against the vault first. That is
   * the difference from the folder field, which rejects a path that is not a
   * folder.
   */
  private renderTagAdder(containerEl: HTMLElement, space: SpaceDefinition): void {
    new Setting(containerEl)
      .setName("Add a tag")
      .setDesc("Type a tag to add every note carrying it, or a tag nested under it.")
      .addText((t) => {
        t.setPlaceholder("Tag name");
        t.inputEl.setAttribute("aria-label", `Add a tag to ${space.name}`);

        // Told once per mounted field, not once per keystroke: `getSuggestions`
        // runs on every key, so a persistent failure would stack a Notice per
        // character typed. The console keeps every occurrence.
        let told = false;
        const onSuggestError = (e: unknown): void => {
          console.error("Spaces: tag suggester failed, degrading to plain input", e);
          if (told) return;
          told = true;
          new Notice("Spaces: tag suggestions are unavailable. Type the full tag to add it.");
        };

        try {
          this.tagSuggest = new TagSuggest(
            this.app,
            t.inputEl,
            // The private-API call stays behind its quarantine module; the
            // suggester is handed a source the same way FolderSuggest is.
            { knownTags: () => nativeKnownTags(this.app) },
            (tag) => {
              void this.addTag(tag);
            },
            onSuggestError
          );
        } catch (e) {
          onSuggestError(e);
          this.tagSuggest = null;
        }

        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          if (this.tagSuggest?.isPopoverOpen === true) return;
          e.preventDefault();
          void this.addTag(t.getValue());
        });
      });
  }

  /**
   * One row per STORED path member — `members` holds only exact members,
   * inherited ones are computed and never stored, so every row here is
   * something the user added deliberately. The useful question per row is
   * whether it still does anything.
   *
   * Remove is offered on every row, including a healthy one. This is the
   * bulk-management surface, and a list where only broken rows were
   * actionable would be a worse tool than the explorer row's own menu.
   */
  private renderMemberRow(
    containerEl: HTMLElement,
    space: SpaceDefinition,
    row: PathMemberRow
  ): void {
    // No em dashes in anything a user reads: this project's copy rule, and
    // these three sentences were the last of them in this dialog. Recast as
    // separate sentences rather than comma-spliced, which is what the tag row
    // below already does ("Tag. No notes carry it right now.").
    const note =
      row.status === "missing"
        ? "Missing. Nothing at this path. Kept in case it comes back."
        : row.status === "redundant"
          ? `Redundant. Already covered by ${row.coveredBy}.`
          : row.kind === "folder"
            ? "Folder. Its contents are members too."
            : "File.";

    const setting = new Setting(containerEl)
      .setName(row.path)
      .setDesc(note)
      .addButton((b) =>
        b
          .setButtonText("Remove")
          .setTooltip(`Remove ${row.path} from ${space.name}`)
          .onClick(() => {
            void this.write((target) => {
              target.members = withoutMember(target.members, row.path);
            }, `could not remove ${row.path}`);
          })
      );
    setting.settingEl.addClass("spaces-member-row");
    if (row.status === "missing") setting.settingEl.addClass("is-missing");
  }

  /**
   * A tag member's row. Shown with the leading `#` it is stored without, so it
   * reads the way a tag reads everywhere else in Obsidian.
   *
   * The count is the point of the row. A tag member's contents are invisible
   * in the definition, and the number is the only way to see that a tag is
   * bringing in what the user thought it was. A tag reaching nothing says so
   * in words rather than being dimmed like a missing path: nothing has been
   * lost, the entry is fine, and no note carries it yet.
   *
   * Remove is a text button matching the path rows beside it, not an icon: one
   * list with two removal affordances reads as two lists.
   */
  private renderTagRow(
    containerEl: HTMLElement,
    space: SpaceDefinition,
    row: TagMemberRow
  ): void {
    const setting = new Setting(containerEl)
      .setName(`#${row.tag}`)
      .setDesc(tagRowDescription(row))
      .addButton((b) =>
        b
          .setButtonText("Remove")
          .setTooltip(`Remove #${row.tag} from ${space.name}`)
          .onClick(() => {
            void this.write((target) => {
              target.members = withoutTagMember(target.members, row.tag);
            }, `could not remove #${row.tag}`);
          })
      );
    setting.settingEl.addClass("spaces-member-row");
  }

  /**
   * The paths this space leaves out, drawn only when there is at least one.
   *
   * An exclusion is written when a note is removed from a space that no member
   * names directly, because it was there through a folder or a tag. It shows
   * up nowhere in the member list, so this section is the only place it can be
   * seen or undone.
   *
   * A row says something only when something is wrong with it, which is the
   * rule the member rows and `memberSummary` already follow. What can be
   * wrong is that nothing lives at the path any more: the entry is as dead as
   * a missing member and just as impossible to spot from the file tree, so it
   * gets the same word and the same dimmed styling.
   */
  private renderExclusions(
    containerEl: HTMLElement,
    space: SpaceDefinition,
    exists: (path: string) => boolean
  ): void {
    const rows = exclusionRows(space, exists);
    if (rows.length === 0) return;

    new Setting(containerEl).setName("Left out").setHeading();
    for (const { path, status } of rows) {
      const setting = new Setting(containerEl).setName(path).addButton((b) =>
        b
          .setButtonText("Put back")
          .setTooltip(`Put ${path} back in ${space.name}`)
          .onClick(() => {
            void this.write((target) => {
              const kept = (target.exclude ?? []).filter((e) => e !== path);
              // Absent rather than empty, matching what the schema stores: a
              // space that leaves nothing out carries no `exclude` key, and an
              // empty array here would write a shape nothing else produces.
              if (kept.length > 0) target.exclude = kept;
              else delete target.exclude;
            }, `could not put ${path} back`);
          })
      );
      if (status === "missing") {
        setting.setDesc("Missing. Nothing at this path. Put it back to clear the entry.");
        setting.settingEl.addClass("is-missing");
      }
      setting.settingEl.addClass("spaces-member-row");
    }
  }

  /**
   * Adds a tag member in the stored form.
   *
   * An empty value is dropped rather than stored: `tagMatches` would treat a
   * member of `""` as the prefix of every tag and quietly pull in the vault.
   *
   * A tag already held is a no-op rather than a second identical row, which is
   * reachable by typing a tag that is already a member.
   */
  private async addTag(tag: string): Promise<void> {
    const normalized = normalizeTag(tag);
    if (normalized.length === 0) return;
    await this.write((target) => {
      const held = target.members.some((m) => m.kind === "tag" && m.tag === normalized);
      if (!held) target.members.push({ kind: "tag", tag: normalized });
    }, `could not add #${normalized}`);
  }

  /**
   * Every write this dialog makes goes through here.
   *
   * `mutate` can reject, because the store persists to disk, and a rejection
   * that only re-rendered would show the user an unchanged list with no
   * explanation. The space is re-found inside the callback rather than handed
   * in: it can be deleted between the render that drew the button and the
   * click on it, and a missing target is then simply no write.
   *
   * Re-renders in place rather than closing, because clearing several stale
   * entries in one sitting is the whole reason this surface exists.
   */
  private async write(
    change: (target: SpaceDefinition) => void,
    failure: string
  ): Promise<void> {
    try {
      await this.defs.mutate((d) => {
        const target = d.spaces.find((s) => s.id === this.spaceId);
        if (target) change(target);
      });
    } catch (e) {
      new Notice(`Spaces: ${failure} (${String(e)})`);
      return;
    }
    this.render();
  }

  /**
   * Drops the suggester before the input it is attached to is destroyed.
   * `close()` takes down its own popover and its document-level listeners, and
   * nothing else will, because neither lives under `contentEl`.
   */
  private releaseTagSuggest(): void {
    this.tagSuggest?.close();
    this.tagSuggest = null;
  }
}
