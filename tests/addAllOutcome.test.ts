// @vitest-environment jsdom
/**
 * `addAll`, the right-click add on the active space, reports through
 * `addOutcomeMessage` like `addToSpace` does.
 *
 * The menu never offers Add for a row the space already holds, so the
 * already-held case reaches `addAll` only when the space changes between the
 * menu being built and the row being clicked. This test reproduces exactly
 * that: build the menu with a visitor, add the same path to the space, then
 * click. The notice must say it was already there, not claim an add.
 */
import { describe, expect, it } from "vitest";
import type { Menu, TAbstractFile } from "obsidian";
import { decorate } from "../src/actions/membership";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { buildVisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { compileIgnore } from "../src/visibility/glob";
import type { SpaceController } from "../src/controller/SpaceController";
import { buildFakeVault } from "./helpers/fakeVault";

const vault = buildFakeVault({ notes: "folder", "notes/b.md": "file" });

function notices(): string[] {
  return Array.from(document.querySelectorAll(".notice-message")).map((n) => n.textContent ?? "");
}

describe("addAll reports what it changed", () => {
  it("says the file is already in the space when it got there after the menu was built", async () => {
    const defs = new DefinitionStore({ read: async () => undefined, write: async () => undefined });
    await defs.mutate((d) => {
      d.spaces = [{ id: "research", name: "Research", icon: "microscope", color: "#4ecdc4", members: [] }];
    });
    const controller = {
      activeSpace: () => defs.get().spaces[0],
      currentSnapshot: () =>
        buildVisibilitySnapshot(vault, defs.get().spaces[0], new Set(["notes/b.md"]), compileIgnore([]), new Set()),
      dismissRevealed: () => undefined,
      // The add now asks what the space SHOWS, which means expanding its tag
      // members. No space here holds one, so an empty index is the whole truth.
      tagIndex: () => ({ pathsMatching: () => [] }),
    } as unknown as SpaceController;

    let click: (() => void) | null = null;
    const menu = {
      addItem(build: (item: unknown) => unknown) {
        let title = "";
        const item = {
          setTitle: (t: string) => ((title = t), item),
          setIcon: () => item,
          setDisabled: () => item,
          onClick: (fn: () => void) => {
            if (title.startsWith("Add ")) click = fn;
            return item;
          },
        };
        build(item);
        return menu;
      },
    } as unknown as Menu;
    decorate(menu, { defs, controller }, [{ path: "notes/b.md", name: "b.md" } as unknown as TAbstractFile]);
    expect(click).not.toBeNull();

    await defs.mutate((d) => {
      d.spaces[0].members.push({ path: "notes/b.md", kind: "file" });
    });
    const before = notices().length;
    (click as unknown as () => void)();
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => queueMicrotask(r));

    const fresh = notices().slice(before);
    expect(fresh).toEqual(["b.md is already in Research"]);
  });
});
