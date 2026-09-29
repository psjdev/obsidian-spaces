import { Modal, Notice, Setting, type App } from "obsidian";
import { memberRows, type MemberRow } from "./memberList";
import type { DefinitionStore } from "../definitions/DefinitionStore";
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
 * It decides nothing: which rows exist and what each one's status is comes
 * from `memberRows`, which is pure and tested in plain node.
 */
export class SpaceContentsModal extends Modal {
  constructor(
    app: App,
    private defs: DefinitionStore,
    private spaceId: string
  ) {
    super(app);
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  /**
   * Re-read from the store on every render rather than closing over a
   * snapshot: removing a member mutates `defs`, and a stale copy would leave
   * the dialog showing a row that no longer exists.
   */
  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const space = this.defs.get().spaces.find((s) => s.id === this.spaceId);
    if (!space) {
      // Reachable: the space can be deleted from the settings tab behind this
      // dialog, or by an external edit to data.json.
      contentEl.createEl("p", { text: "This space no longer exists." });
      return;
    }

    this.titleEl.setText(`Contents of ${space.name}`);

    const rows = memberRows(space, (path) =>
      this.app.vault.getAbstractFileByPath(path) !== null
    );

    if (rows.length === 0) {
      this.renderEmpty(contentEl);
      return;
    }

    for (const row of rows) this.renderMemberRow(contentEl, space, row);
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
        "Right-click a file or folder in the explorer and choose “Add to space”.",
    });
  }

  /**
   * One row per STORED member — `members` holds only exact members,
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
    row: MemberRow
  ): void {
    const note =
      row.status === "missing"
        ? "Missing — nothing at this path. Kept in case it comes back."
        : row.status === "redundant"
          ? `Redundant — already covered by ${row.coveredBy}.`
          : row.kind === "folder"
            ? "Folder — its contents are members too."
            : "File.";

    const setting = new Setting(containerEl)
      .setName(row.path)
      .setDesc(note)
      .addButton((b) =>
        b
          .setButtonText("Remove")
          .setTooltip(`Remove ${row.path} from ${space.name}`)
          .onClick(async () => {
            try {
              await this.defs.mutate((d) => {
                const target = d.spaces.find((x) => x.id === this.spaceId);
                if (target) {
                  target.members = target.members.filter(
                    (m) => m.kind === "tag" || m.path !== row.path
                  );
                }
              });
            } catch (e) {
              new Notice(`Spaces: could not remove ${row.path} (${String(e)})`);
              return;
            }
            // Re-render in place rather than closing: removing several stale
            // entries in one sitting is the whole reason this surface exists.
            this.render();
          })
      );
    setting.settingEl.addClass("spaces-member-row");
    if (row.status === "missing") setting.settingEl.addClass("is-missing");
  }
}
