// @vitest-environment jsdom
/**
 * What a drag writes into the DOM, for each indicator style.
 *
 * The rules are tested in `gapLayout.test.ts` against real numbers. This file
 * asks only whether `DragOrdering` writes what it was told to, and whether it
 * takes it all back. The taking back matters more: an indicator that fails to
 * appear is a missing hint the next frame corrects, while a transform left
 * behind is a tree sitting out of position after the drag is over.
 *
 * jsdom computes no layout, so every rect is stubbed. That is a fixture
 * detail rather than a shortcut, and it is the same one `dragOrdering.test.ts`
 * uses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DragOrdering, type DragOrderingDeps } from "../src/order/DragOrdering";
import { CLS_BOX_OPEN, CLS_CLAIMS_DROP, CLS_DROP_BOX, CLS_DROP_LINE, CLS_DROP_PARENT, CLS_GAP_DRAG } from "../src/explorer/selectors";
import type { DropIndicatorStyle } from "../src/types";

const ROW_H = 24;
/** Mirrors `.tree-item-self`'s real `margin-bottom: 2px` (measured). */
const GAP = 2;
const SELF_H = ROW_H - GAP;

function makeTree() {
  // Every test binds a controller and none unbind, so the document-level
  // listeners of earlier tests are still attached. One dragend clears them
  // all, and it is the teardown they are already listening for.
  document.dispatchEvent(new Event("dragend", { bubbles: true }));
  const container = document.createElement("div");
  container.className = "nav-files-container";
  document.body.replaceChildren(container);
  const rows: Record<string, HTMLElement> = {};
  let y = 0;
  function addRow(path: string, isFolder: boolean, indent = 0): HTMLElement {
    const item = document.createElement("div");
    item.className = "tree-item " + (isFolder ? "nav-folder" : "nav-file");
    const self = document.createElement("div");
    self.className = "tree-item-self";
    self.setAttribute("data-path", path);
    item.appendChild(self);
    container.appendChild(item);
    const top = y;
    y += ROW_H;
    // The WRAPPER carries the indent, and it is the box the indicator's width
    // must match. The strip is stretched back to the pane edge by Obsidian.
    item.getBoundingClientRect = () =>
      ({ top, bottom: top + ROW_H, height: ROW_H, left: indent, right: 100,
         width: 100 - indent, x: indent, y: top }) as DOMRect;
    // The strip's rect FOLLOWS ITS OWN TRANSFORM, because a real one does.
    // A CSS transform changes what `getBoundingClientRect` returns and what
    // the browser hit-tests, so a fixture whose rects ignore it cannot see the
    // defect where frame N+1 measures the rows frame N displaced. The first
    // version of this file stubbed a constant `top` and every assertion in it
    // agreed with an implementation that resolved a different drop target on
    // the second frame.
    self.getBoundingClientRect = () => {
      const m = /translateY\((-?[\d.]+)px\)/.exec(self.style.transform || "");
      const shift = m ? parseFloat(m[1]) : 0;
      const t = top + shift;
      return { top: t, bottom: t + SELF_H, height: SELF_H, left: 0, right: 100,
               width: 100, x: 0, y: t } as DOMRect;
    };
    rows[path] = item;
    return item;
  }
  container.getBoundingClientRect = () =>
    ({ top: 0, bottom: 500, height: 500, left: 0, right: 100, width: 100, x: 0, y: 0 }) as DOMRect;
  return { container, rows, addRow };
}

function fire(el: HTMLElement, type: string, clientY: number, clientX = 50): Event {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  el.dispatchEvent(e);
  return e;
}

/** Every row strip, in document order, with whatever transform it carries. */
function transforms(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".nav-files-container [data-path]")
  ).map((el) => el.style.transform);
}

/**
 * The indicator, only while it is actually showing.
 *
 * `:not([hidden])` is load-bearing. `clearIndicator` hides the element and
 * leaves its inline styles alone, so a helper that matched a hidden one let an
 * assertion read coordinates from the frame before and pass against an
 * implementation that had just cleared the indicator entirely.
 */
function indicator(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    ".nav-files-container > ." + CLS_DROP_BOX + ":not([hidden])" +
      ", .nav-files-container > ." + CLS_DROP_LINE + ":not([hidden])"
  );
}

describe("what a drag draws", () => {
  let deps: DragOrderingDeps;
  let style: DropIndicatorStyle;
  let tree: ReturnType<typeof makeTree>;

  beforeEach(() => {
    style = "box";
    tree = makeTree();
    tree.addRow("F/a.md", false);
    tree.addRow("F/b.md", false);
    tree.addRow("G", true);
    deps = {
      describeRow: (path) => {
        if (path === "G") return { parent: "", isFolder: true };
        if (path.startsWith("F/")) return { parent: "F", isFolder: false };
        return null;
      },
      displayedOrder: () => ["F/a.md", "F/b.md"],
      storedOrder: () => undefined,
      writeOrder: vi.fn().mockResolvedValue(undefined) as unknown as DragOrderingDeps["writeOrder"],
      moveInto: vi.fn().mockResolvedValue(undefined) as unknown as DragOrderingDeps["moveInto"],
      enabled: () => true,
      indicatorStyle: () => style,
    };
  });

  function boundDrag(): DragOrdering {
    const d = new DragOrdering(deps);
    d.bind(tree.container);
    return d;
  }

  /**
   * Drags b and hovers the top of a, which is a real reorder.
   * `isNoOpReorder` clears the indicator for a drop that changes nothing, so
   * dragging a onto its own leading edge would draw nothing and every
   * assertion below would pass for the wrong reason.
   */
  function dragBBeforeA(): DragOrdering {
    const d = boundDrag();
    fire(tree.rows["F/b.md"], "dragstart", 25);
    fire(tree.rows["F/a.md"], "dragover", 2);
    return d;
  }

  describe("the box style", () => {
    it("wears the box class and not the line class", () => {
      dragBBeforeA();
      const el = indicator();
      expect(el?.classList.contains(CLS_DROP_BOX)).toBe(true);
      expect(el?.classList.contains(CLS_DROP_LINE)).toBe(false);
    });

    it("is marked open, which is what fades it in", () => {
      // The box is transparent until this lands. Without it the box would be
      // drawn at full strength on a row that has not finished sliding out of
      // its way, which is the state that read as the indicator sitting ON an
      // item rather than between two.
      dragBBeforeA();
      expect(indicator()?.classList.contains(CLS_BOX_OPEN)).toBe(true);
    });

    it("sizes the box to the target row's own height and indent", () => {
      // 22px, the strip's height, not the 24px row pitch. The pitch would
      // overlap the row below by the inter-row gap.
      dragBBeforeA();
      const el = indicator();
      expect(el?.style.height).toBe("22px");
      expect(el?.style.top).toBe("0px");
      expect(el?.style.left).toBe("0px");
      expect(el?.style.width).toBe("100px");
    });

    it("moves the target row and everything below it", () => {
      // Dropping BEFORE a means a moves too, along with b and G under it.
      dragBBeforeA();
      expect(transforms()).toEqual([
        "translateY(22px)",
        "translateY(22px)",
        "translateY(22px)",
      ]);
    });

    it("moves only what follows the target, for a drop after it", () => {
      boundDrag();
      fire(tree.rows["F/a.md"], "dragstart", 2);
      // 40 is 16px into b's 22px strip, past halfway, so the intent is after.
      fire(tree.rows["F/b.md"], "dragover", 40);
      expect(transforms()).toEqual(["", "", "translateY(22px)"]);
    });

    it("puts the box on the boundary between the two rows", () => {
      // b's strip ends at 46 and G's begins at 48. One boundary has one
      // position, so the box sits at the midpoint rather than at either edge.
      boundDrag();
      fire(tree.rows["F/a.md"], "dragstart", 2);
      fire(tree.rows["F/b.md"], "dragover", 40);
      expect(indicator()?.style.top).toBe("47px");
    });

    it("puts the gap class on the container", () => {
      dragBBeforeA();
      expect(tree.container.classList.contains(CLS_GAP_DRAG)).toBe(true);
    });
  });

  describe("Obsidian's own into-the-folder highlight", () => {
    /**
     * `intentFor` gives a folder row a "before" band at the top and an
     * "after" band at the bottom, and treats only the middle as Obsidian's
     * drop-into. Obsidian draws no such bands: it tints the whole row and
     * captions the drag "Move into folder".
     *
     * Measured in a running vault at 2px into a 25px folder row: the box was
     * drawn above the folder and `is-being-dragged-over` was on the folder at
     * the same moment. Spaces claims that drop and reorders, so the caption
     * was describing something that was not going to happen.
     */
    it("is taken off when spaces claims the frame as a reorder", () => {
      const folder = tree.rows["G"];
      folder.classList.add("is-being-dragged-over");
      boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);
      // 2 is inside a's leading band, so this is a "between" and ours.
      fire(tree.rows["F/a.md"], "dragover", 2);
      expect(indicator()).not.toBeNull();
      // Obsidian keeps its class. Spaces marks the body instead, and the
      // stylesheet hides the tint and the caption for as long as it is set.
      // Stripping the class was tried and loses the legitimate highlight for
      // the rest of the drag, because Obsidian only sets it on a transition.
      expect(folder.classList.contains("is-being-dragged-over")).toBe(true);
      expect(document.body.classList.contains(CLS_CLAIMS_DROP)).toBe(true);
    });

    it("is left alone when the drop really is into a folder", () => {
      // The middle of G, which intentFor calls "into". Obsidian owns that
      // drop and its highlight is the correct feedback for it.
      const folder = tree.rows["G"];
      boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);
      folder.classList.add("is-being-dragged-over");
      fire(folder, "dragover", 58);
      expect(indicator()).toBeNull();
      expect(folder.classList.contains("is-being-dragged-over")).toBe(true);
      // Not claiming, so Obsidian's tint and caption show normally.
      expect(document.body.classList.contains(CLS_CLAIMS_DROP)).toBe(false);
    });
  });

  describe("the open gap is sticky", () => {
    /**
     * Once the gap opens, the pointer is inside it and the row that used to
     * be there has slid away. The decision still works from that row's
     * ORIGINAL slot, whose midpoint now sits inside the gap, so without this
     * the answer flips from before to after while the pointer has not left
     * the box it is pointing at. Reported as the box refusing to go below a
     * row until the pointer moved well past it, and as the box appearing on
     * top of that row while the two swapped places.
     */
    it("keeps its answer while the pointer stays inside the box", () => {
      const d = boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);
      fire(tree.rows["F/a.md"], "dragover", 2);
      const opened = indicator()?.style.top;
      expect(opened).toBe("0px");

      // 15 is past a's original midpoint of 11, so the old code called this
      // "after a" and moved the box. It is still inside the gap at 0..22.
      fire(tree.rows["F/a.md"], "dragover", 15);
      expect(indicator()?.style.top).toBe(opened);
      d.unbind();
    });

    it("keeps claiming the drop while it holds", () => {
      // The box being visible and spaces not claiming the drop is the state
      // where Obsidian paints its own answer underneath ours: two tints, and
      // a caption for a move that will not happen. A frame that holds the gap
      // has to re-assert the claim, not just skip the work.
      const d = boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);
      fire(tree.rows["F/a.md"], "dragover", 2);
      document.body.classList.remove(CLS_CLAIMS_DROP);

      fire(tree.rows["F/a.md"], "dragover", 15);
      expect(indicator()).not.toBeNull();
      expect(document.body.classList.contains(CLS_CLAIMS_DROP)).toBe(true);
      d.unbind();
    });

    it("moves the gap without animating, once one is already open", () => {
      // Opening the gap animates: the rows slide apart and the box fades in
      // over them. MOVING it cannot, because the row on the far side of the
      // new boundary has to travel back through the space the box is about to
      // occupy, and an animated swap always has a frame where both are in the
      // same place. Reported as the box appearing on top of a row, and only
      // reachable after a gap was already open.
      const d = boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);
      fire(tree.rows["F/a.md"], "dragover", 2);
      expect(tree.container.classList.contains(CLS_GAP_DRAG)).toBe(true);

      // 68 is inside G's trailing band, so this is another "between" at a
      // different boundary rather than a drop into the folder.
      fire(tree.rows["G"], "dragover", 68);
      expect(indicator()).not.toBeNull();
      expect(tree.container.classList.contains(CLS_GAP_DRAG)).toBe(false);
      d.unbind();
    });

    it("lets go once the pointer leaves the box", () => {
      // Stickiness must not become a trap: past the gap, the answer moves.
      const d = boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);
      fire(tree.rows["F/a.md"], "dragover", 2);
      expect(indicator()?.style.top).toBe("0px");

      fire(tree.rows["G"], "dragover", 58);
      expect(indicator()?.style.top).not.toBe("0px");
      d.unbind();
    });
  });

  describe("the folder a drop will land in", () => {
    /**
     * The space below a folder's last child is also the space above the next
     * row at root level, and the two mean different parents. Measured in a
     * running vault, the boxes for them are drawn 2px apart and differ only
     * by a 17px indent, so approaching the boundary from above lands inside
     * the folder and from below lands beside it, with almost nothing on
     * screen to tell you which you are about to get.
     *
     * Marking the destination folder is the signal that was missing. The
     * indent stays, and the folder lighting up says where the row is going.
     */
    it("marks the folder when the drop lands inside one", () => {
      const folderRow = tree.addRow("F", true);
      const folderStrip = folderRow.querySelector<HTMLElement>("[data-path]");
      if (!folderStrip) throw new Error("fixture built no strip for F");

      const d = boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);
      // Before F/a.md, whose parent is F.
      fire(tree.rows["F/a.md"], "dragover", 2);
      expect(indicator()).not.toBeNull();
      expect(folderStrip.classList.contains(CLS_DROP_PARENT)).toBe(true);
      d.unbind();
    });

    it("leaves it unmarked when the drop lands at the root", () => {
      const folderRow = tree.addRow("F", true);
      const folderStrip = folderRow.querySelector<HTMLElement>("[data-path]");
      if (!folderStrip) throw new Error("fixture built no strip for F");

      const d = boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);
      fire(tree.rows["F/a.md"], "dragover", 2);
      expect(folderStrip.classList.contains(CLS_DROP_PARENT)).toBe(true);

      // G sits at the root, so this drop is not going into F any more.
      fire(tree.rows["G"], "dragover", 68);
      expect(folderStrip.classList.contains(CLS_DROP_PARENT)).toBe(false);
      d.unbind();
    });

    it("takes the mark off when the drag ends", () => {
      const folderRow = tree.addRow("F", true);
      const folderStrip = folderRow.querySelector<HTMLElement>("[data-path]");
      if (!folderStrip) throw new Error("fixture built no strip for F");

      const d = boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);
      fire(tree.rows["F/a.md"], "dragover", 2);
      document.dispatchEvent(new Event("dragend", { bubbles: true }));
      expect(folderStrip.classList.contains(CLS_DROP_PARENT)).toBe(false);
      d.unbind();
    });
  });

  describe("the line style", () => {
    beforeEach(() => {
      style = "line";
    });

    it("wears the line class", () => {
      dragBBeforeA();
      const el = indicator();
      expect(el?.classList.contains(CLS_DROP_LINE)).toBe(true);
      expect(el?.classList.contains(CLS_DROP_BOX)).toBe(false);
    });

    it("moves no rows at all", () => {
      dragBBeforeA();
      expect(transforms()).toEqual(["", "", ""]);
    });

    it("leaves the gap class off the container", () => {
      dragBBeforeA();
      expect(tree.container.classList.contains(CLS_GAP_DRAG)).toBe(false);
    });
  });

  describe("taking it back", () => {
    it("clears every transform on dragend", () => {
      dragBBeforeA();
      document.dispatchEvent(new Event("dragend", { bubbles: true }));
      expect(transforms()).toEqual(["", "", ""]);
      expect(tree.container.classList.contains(CLS_GAP_DRAG)).toBe(false);
    });

    it("clears every transform on drop", () => {
      dragBBeforeA();
      fire(tree.rows["F/a.md"], "drop", 2);
      expect(transforms()).toEqual(["", "", ""]);
    });

    it("clears every transform when the pointer leaves the tree", () => {
      // x 500 is outside the container's 0..100, so the pointer is over the
      // editor or a tab and the gap has to close with it.
      dragBBeforeA();
      fire(tree.rows["F/a.md"], "dragover", 2, 500);
      expect(transforms()).toEqual(["", "", ""]);
    });

    it("clears every transform on unbind", () => {
      // A plugin disabled mid-drag must not leave the pane displaced, and
      // unbind is the only teardown that path runs.
      const d = dragBBeforeA();
      d.unbind();
      expect(transforms()).toEqual(["", "", ""]);
    });

    it("closes the gap when the pointer moves onto a folder's middle", () => {
      // Drop-into-folder belongs to Obsidian, so the rows close up and its
      // tint is the only thing on screen. 58 is 10px into G's 22px strip,
      // inside the band that `intentFor` calls into.
      dragBBeforeA();
      expect(transforms()).not.toEqual(["", "", ""]);
      fire(tree.rows["G"], "dragover", 58);
      expect(transforms()).toEqual(["", "", ""]);
    });
  });

  describe("a pointer that has not moved", () => {
    /**
     * The gesture this feature exists for is a pointer held still while the
     * tree rearranges around it. Every `dragover` that arrives during that
     * hold must resolve the same drop, or the drop the user gets is decided by
     * which frame they happened to release on.
     *
     * The rows this code displaces are the rows it measures. Reproduced in a
     * running vault before this test existed: hovering 3px into the first
     * child of a folder drew the box at `left 29 width 298`, the indented
     * child, and the very next frame drew it at `left 12 width 314`, which is
     * the parent folder at root level. The pointer never moved. A drop on the
     * second frame would have put the note in the vault root instead of in the
     * folder the user was aiming at.
     */
    it("resolves the same indicator on every frame", () => {
      const d = boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);

      fire(tree.rows["F/a.md"], "dragover", 2);
      const first = {
        top: indicator()?.style.top,
        left: indicator()?.style.left,
        width: indicator()?.style.width,
        height: indicator()?.style.height,
      };

      expect(first.top).toBeDefined();

      // The same pointer, again. Nothing about the drop has changed.
      fire(tree.rows["F/a.md"], "dragover", 2);
      expect(indicator()).not.toBeNull();
      expect({
        top: indicator()?.style.top,
        left: indicator()?.style.left,
        width: indicator()?.style.width,
        height: indicator()?.style.height,
      }).toEqual(first);
      d.unbind();
    });

    it("keeps displacing the same rows on every frame", () => {
      const d = boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);
      fire(tree.rows["F/a.md"], "dragover", 2);
      const first = transforms();
      expect(first).not.toEqual(["", "", ""]);

      // Checked after EVERY frame, not after a batch. The defect alternates:
      // the gap opens, the rows move out from under the pointer, the next
      // frame finds nothing there and closes it, the frame after that reopens
      // it. Comparing only after an even number of frames reads as stable.
      for (let frame = 2; frame <= 4; frame += 1) {
        fire(tree.rows["F/a.md"], "dragover", 2);
        expect(transforms(), `frame ${frame}`).toEqual(first);
      }
      d.unbind();
    });
  });

  describe("rows that arrive while the gap is held", () => {
    /**
     * Obsidian expands a folder you hover during a drag, so rows appear
     * mid-gesture. They arrive with no transform while everything around them
     * is displaced, and the row above ends up drawn on top of the first new
     * one: reported as a folder title squashed into one of its children.
     *
     * Reproduced in a running vault, gap held open above the first row and a
     * folder below it expanded:
     *   Travel[translateY(24.9px)] x Travel/Lisbon.md[none] overlapping 23px
     * and it survived the following frame, because holding the gap skipped
     * the write that would have caught the newcomers. Holding the ANSWER is
     * the point; holding the drawing was an accident.
     */
    it("gives a row that appears mid-drag the same displacement as its neighbours", () => {
      const d = boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);
      fire(tree.rows["F/a.md"], "dragover", 2);
      const displaced = transforms().filter((t) => t !== "").length;
      expect(displaced).toBeGreaterThan(0);

      const late = tree.addRow("F/late.md", false);
      const strip = late.querySelector<HTMLElement>("[data-path]");
      if (!strip) throw new Error("fixture built no strip");
      expect(strip.style.transform).toBe("");

      // A frame with the pointer still inside the gap, which is the held path.
      fire(tree.rows["F/a.md"], "dragover", 3);
      expect(strip.style.transform).not.toBe("");
      d.unbind();
    });

    it("catches them without waiting for the pointer to move", async () => {
      // A folder expands under a pointer that is holding still, so no further
      // drag frame arrives to repair the display. Waiting for the next frame
      // means the overlap sits there for as long as the user keeps still.
      const d = boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);
      fire(tree.rows["F/a.md"], "dragover", 2);

      const late = tree.addRow("F/quiet.md", false);
      const strip = late.querySelector<HTMLElement>("[data-path]");
      if (!strip) throw new Error("fixture built no strip");

      // No dragover. Only the DOM changing.
      await new Promise((r) => setTimeout(r, 0));
      expect(strip.style.transform).not.toBe("");
      d.unbind();
    });
  });

  describe("a row that drops out of the visible set", () => {
    /**
     * Each frame writes transforms for the rows it can currently measure. A
     * row that carried one and then stopped being measurable is not in that
     * list, so nothing rewrites it and it keeps a displacement everything
     * around it has moved on from. Its neighbours sit at their real places
     * and it sits one row lower, which is two rows drawn on top of each
     * other: reported as a folder's title squashed into one of its children,
     * while dragging fast.
     *
     * A row measures zero while the explorer is mid-render, which is exactly
     * what a fast drag produces more of.
     */
    it("is put back, not left displaced", () => {
      const d = boundDrag();
      fire(tree.rows["F/b.md"], "dragstart", 25);
      fire(tree.rows["F/a.md"], "dragover", 2);

      const stray = tree.rows["G"].querySelector<HTMLElement>("[data-path]");
      if (!stray) throw new Error("fixture has no strip on G");
      expect(stray.style.transform).not.toBe("");

      // It stops being measurable, the way a row mid-render does.
      stray.getBoundingClientRect = () =>
        ({ top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0 }) as DOMRect;

      fire(tree.rows["F/a.md"], "dragover", 40);
      expect(stray.style.transform).toBe("");
      d.unbind();
    });
  });

  describe("a source row the explorer recycled mid-drag", () => {
    /**
     * The explorer renders its rows in blocks and drops them as the pane
     * scrolls, so autoscrolling far enough during a drag destroys the very row
     * the drag started on. Measured in a running vault with a 240-child folder
     * open: scrolling 3000px mid-drag replaced 48 of the 49 rendered rows, and
     * `document.contains(sourceRow)` came back false.
     *
     * `dragend` is then dispatched at a node that is no longer in the
     * document, and an event dispatched at a detached node never reaches a
     * listener on the document. The teardown simply never ran, and the tree
     * kept 34 rows translated down until the next drag.
     */
    it("still clears the transforms when dragend reaches only the detached row", () => {
      const d = dragBBeforeA();
      expect(transforms()).not.toEqual(["", "", ""]);

      const src = tree.rows["F/b.md"];
      const strip = src.querySelector<HTMLElement>("[data-path]");
      if (!strip) throw new Error("fixture has no strip on b");
      // What `infinityScroll` does to a row that scrolls out of its block.
      src.remove();
      expect(document.contains(strip)).toBe(false);

      // Dispatched AT the detached row, which is where the browser sends it.
      // Nothing propagates to the document from here.
      strip.dispatchEvent(new MouseEvent("dragend", { bubbles: true, cancelable: true }));

      expect(transforms()).toEqual(["", ""]);
      expect(tree.container.classList.contains(CLS_GAP_DRAG)).toBe(false);
      d.unbind();
    });

    it("does not leave a listener behind on a drag that ended normally", () => {
      // The per-row listener is the fix, so it must not accumulate one row per
      // drag on a tree the plugin does not own.
      const d = boundDrag();
      const src = tree.rows["F/b.md"];
      const strip = src.querySelector<HTMLElement>("[data-path]");
      if (!strip) throw new Error("fixture has no strip on b");
      let ends = 0;
      strip.addEventListener("dragend", () => {
        ends += 1;
      });

      fire(src, "dragstart", 25);
      fire(tree.rows["F/a.md"], "dragover", 2);
      document.dispatchEvent(new Event("dragend", { bubbles: true }));
      expect(transforms()).toEqual(["", "", ""]);

      // A second drag on the same row, ended the same way. If the first
      // listener were still attached the teardown would run twice per event.
      fire(src, "dragstart", 25);
      fire(tree.rows["F/a.md"], "dragover", 2);
      strip.dispatchEvent(new MouseEvent("dragend", { bubbles: true }));
      expect(ends).toBe(1);
      expect(transforms()).toEqual(["", "", ""]);
      d.unbind();
    });
  });

  describe("rows that are not laid out", () => {
    it("gives a hidden row no transform", () => {
      // `ExplorerAdapter` hides filtered rows. A zero-height row must take no
      // transform and contribute no height, or the gap opens in the wrong
      // place in a filtered space.
      const strip = tree.rows["F/b.md"].querySelector<HTMLElement>("[data-path]");
      if (!strip) throw new Error("fixture has no strip on b");
      strip.getBoundingClientRect = () =>
        ({ top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0 }) as DOMRect;
      boundDrag();
      fire(tree.rows["G"], "dragstart", 50);
      fire(tree.rows["F/a.md"], "dragover", 2);
      expect(strip.style.transform).toBe("");
    });
  });
});
