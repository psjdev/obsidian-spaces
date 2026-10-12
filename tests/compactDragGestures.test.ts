// @vitest-environment jsdom
/**
 * The whole drag story for a compacted row, at the controller.
 *
 * A compacted row is ONE row standing for a chain of folders. Its `data-path`
 * is the run's TIP, because the tip is the folder the row actually is; it is
 * DRAWN where the run's HEAD was, because that is the level the chain occupied
 * before it was folded up. So every path that crosses `DragOrdering` has two
 * spellings, and the four gestures a user can make with such a row each need a
 * different one:
 *
 *  - REORDER the chain among its visual siblings. The order that is written
 *    names the HEAD, because a stored order lists a folder's own children.
 *  - Drag the chain INTO another folder. Refused, visibly: the chain is drawn
 *    at one level and lives at another, so "move it" has no single answer the
 *    user could have meant.
 *  - Drop a note on the EDGE band beside the row. That is a position among the
 *    folders the user can SEE, so it resolves against the head and the head's
 *    parent.
 *  - Drop a note on the MIDDLE of the row. That is Obsidian's own
 *    drop-into-folder and it means the TIP, which is the folder the row is.
 *
 * Layer: the DOM gesture through the real listeners, with the translation
 * supplied as dependencies. `tests/compactDragCoords.test.ts` holds the other
 * half -- that the plugin's `dragDeps()` really supplies those dependencies
 * from a real chain index -- and `tests/compactCoords.test.ts` holds the
 * translation itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DragOrdering, type DragOrderingDeps } from "../src/order/DragOrdering";

const ROW_H = 24;
/** Mirrors `.tree-item-self`'s real `margin-bottom: 2px` (measured). */
const GAP = 2;

/**
 * The two chains and the two ordinary rows they sit beside.
 *
 * `alpha -> alpha/zeta -> alpha/zeta/theta` and `foo -> foo/bar -> foo/bar/beta`
 * are the user's own example from the decision that produced this behaviour.
 * Both are drawn at the vault root, because that is where their heads are.
 */
const HEAD_OF: Record<string, string> = {
  "alpha/zeta/theta": "alpha",
  "foo/bar/beta": "foo",
};
const TIP_OF: Record<string, string> = {
  alpha: "alpha/zeta/theta",
  foo: "foo/bar/beta",
};

/** Row index in the fixture, so the band helpers below read as positions. */
const ROW_AT = {
  theta: 0,
  beta: 1,
  plain: 2,
  note: 3,
  inner: 4,
} as const;

/** A Y inside the leading edge band of row `i` ("before"). */
const beforeBand = (i: number): number => i * ROW_H + 1;
/** A Y inside the trailing edge band of row `i` ("after"). */
const afterBand = (i: number): number => i * ROW_H + ROW_H - GAP - 2;
/** A Y in the middle of row `i`, which for a folder is Obsidian's drop-into. */
const middle = (i: number): number => i * ROW_H + (ROW_H - GAP) / 2;

function makeTree() {
  // Every test binds a controller and none of them unbind, so the document
  // still carries the listeners of every earlier test. One `dragend` clears
  // the `dragged` of all of them, which is what stops an earlier controller
  // answering this test's drop. Lifted from `dragOrdering.test.ts`, where the
  // defect it prevents is recorded in full.
  document.dispatchEvent(new Event("dragend", { bubbles: true }));
  const container = document.createElement("div");
  container.className = "nav-files-container";
  document.body.replaceChildren(container);
  const rows: Record<string, HTMLElement> = {};
  let y = 0;
  function addRow(path: string, isFolder: boolean): HTMLElement {
    const item = document.createElement("div");
    item.className = `tree-item ${isFolder ? "nav-folder" : "nav-file"}`;
    const self = document.createElement("div");
    self.className = "tree-item-self";
    self.setAttribute("data-path", path);
    item.appendChild(self);
    container.appendChild(item);
    const top = y;
    y += ROW_H;
    item.getBoundingClientRect = () =>
      ({ top, bottom: top + ROW_H, height: ROW_H, left: 0, right: 100, width: 100, x: 0, y: top }) as DOMRect;
    // 2px shorter than the row, mirroring `.tree-item-self`'s real
    // `margin-bottom`. This is the box `intentFor` is measured against.
    const selfH = ROW_H - GAP;
    self.getBoundingClientRect = () =>
      ({ top, bottom: top + selfH, height: selfH, left: 0, right: 100, width: 100, x: 0, y: top }) as DOMRect;
    rows[path] = item;
    return item;
  }
  container.getBoundingClientRect = () =>
    ({ top: 0, bottom: 500, height: 500, left: 0, right: 100, width: 100, x: 0, y: 0 }) as DOMRect;
  addRow("alpha/zeta/theta", true);
  addRow("foo/bar/beta", true);
  addRow("Plain", true);
  addRow("note.md", false);
  addRow("Plain/inner.md", false);
  return { container, rows };
}

function visibleLines(): number {
  return document.querySelectorAll(".spaces-drop-line:not([hidden])").length;
}

function fire(el: HTMLElement, type: string, clientY: number): Event {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  el.dispatchEvent(e);
  return e;
}

/**
 * The row's own listener only runs if capture-phase `stopPropagation` did not.
 *
 * `reachedTarget` is the DESTINATION assertion for every drop this plugin does
 * not perform itself. Obsidian's explorer hangs its drop handler on the row,
 * so "the event reached the row carrying `data-path=X`" is precisely "Obsidian
 * moves what is being dragged into X". A test that only checked that spaces
 * returned null could not see that, and that is exactly how the defect this
 * file closes stayed hidden.
 */
function withProbe(el: HTMLElement, type: string, clientY: number) {
  let reached = false;
  const probe = (): void => {
    reached = true;
  };
  el.addEventListener(type, probe);
  const e = fire(el, type, clientY);
  el.removeEventListener(type, probe);
  return { reachedTarget: reached, defaultPrevented: e.defaultPrevented };
}

describe("dragging with compacted rows on screen", () => {
  let deps: DragOrderingDeps;
  let writeOrder: ReturnType<typeof vi.fn>;
  let moveInto: ReturnType<typeof vi.fn>;
  let onCompactedRowRefused: ReturnType<typeof vi.fn>;
  let tree: ReturnType<typeof makeTree>;

  beforeEach(() => {
    writeOrder = vi.fn().mockResolvedValue(undefined);
    moveInto = vi.fn().mockResolvedValue(undefined);
    onCompactedRowRefused = vi.fn();
    tree = makeTree();
    deps = {
      // DISPLAY space: a compacted row is drawn under its HEAD's parent, which
      // for both chains here is the vault root.
      describeRow: (path) => {
        if (path in HEAD_OF) return { parent: "", isFolder: true };
        if (path === "Plain") return { parent: "", isFolder: true };
        if (path === "note.md") return { parent: "", isFolder: false };
        if (path === "Plain/inner.md") return { parent: "Plain", isFolder: false };
        return null;
      },
      // STORED space, as `dragDeps()` already maps it: the chains appear as
      // their heads, because a stored order lists the folder's own children.
      displayedOrder: (folder) =>
        folder === "" ? ["alpha", "foo", "Plain", "note.md"] : ["Plain/inner.md"],
      storedOrder: () => undefined,
      writeOrder: writeOrder as unknown as DragOrderingDeps["writeOrder"],
      moveInto: moveInto as unknown as DragOrderingDeps["moveInto"],
      enabled: () => true,
      indicatorStyle: () => "line" as const,
      storedPathFor: (path) => HEAD_OF[path] ?? path,
      displayPathFor: (path) => TIP_OF[path] ?? path,
      isCompactedRow: (path) => path in HEAD_OF,
      onCompactedRowRefused,
    };
  });

  function boundDrag(): DragOrdering {
    const d = new DragOrdering(deps);
    d.bind(tree.container);
    return d;
  }

  describe("the chain reorders among its visual siblings, as a whole chain", () => {
    it("writes the HEAD's path to the stored order, never the tip", () => {
      boundDrag();
      fire(tree.rows["foo/bar/beta"], "dragstart", beforeBand(ROW_AT.beta));
      fire(tree.rows["alpha/zeta/theta"], "drop", beforeBand(ROW_AT.theta));
      expect(writeOrder).toHaveBeenCalledTimes(1);
      // `foo`, not `foo/bar/beta`. The tip is not a child of the vault root,
      // so `writeOrderFor`'s `compact(order, live)` strikes it on the way to
      // disk and the file ends up holding the order the user started with --
      // after a drop line promised them a move.
      expect(writeOrder).toHaveBeenCalledWith("", ["foo", "alpha", "Plain", "note.md"]);
    });

    it("moves the chain past an ordinary sibling without promising more than it does", () => {
      // The measured defect, at its sharpest. Spelled with the TIP the drop
      // computes a real-looking new order, so a line is drawn and the drop is
      // claimed -- and then the tip is struck on write because it is not a
      // child of the vault root, leaving the stored order byte for byte what
      // it was. The user was shown a line promising a move that never
      // happened.
      boundDrag();
      fire(tree.rows["foo/bar/beta"], "dragstart", beforeBand(ROW_AT.beta));
      fire(tree.rows["Plain"], "drop", afterBand(ROW_AT.plain));
      expect(writeOrder).toHaveBeenCalledWith("", ["alpha", "Plain", "foo", "note.md"]);
    });

    it("draws a line for that reorder, because it really happens", () => {
      boundDrag();
      fire(tree.rows["foo/bar/beta"], "dragstart", beforeBand(ROW_AT.beta));
      fire(tree.rows["alpha/zeta/theta"], "dragover", beforeBand(ROW_AT.theta));
      expect(visibleLines()).toBe(1);
    });

    it("claims that drop, so Obsidian does not also act on it", () => {
      boundDrag();
      fire(tree.rows["foo/bar/beta"], "dragstart", beforeBand(ROW_AT.beta));
      const r = withProbe(tree.rows["alpha/zeta/theta"], "drop", beforeBand(ROW_AT.theta));
      expect(r.reachedTarget).toBe(false);
    });
  });

  describe("the chain is refused a move into another folder", () => {
    it("calls neither moveInto nor writeOrder for an edge drop inside that folder", () => {
      boundDrag();
      fire(tree.rows["foo/bar/beta"], "dragstart", beforeBand(ROW_AT.beta));
      fire(tree.rows["Plain/inner.md"], "drop", beforeBand(ROW_AT.inner));
      expect(moveInto).not.toHaveBeenCalled();
      expect(writeOrder).not.toHaveBeenCalled();
      expect(onCompactedRowRefused).toHaveBeenCalledTimes(1);
    });

    it("leaves the event un-cancelled, as every refusal in this file does", () => {
      boundDrag();
      fire(tree.rows["foo/bar/beta"], "dragstart", beforeBand(ROW_AT.beta));
      const r = withProbe(tree.rows["Plain/inner.md"], "drop", beforeBand(ROW_AT.inner));
      expect(r.defaultPrevented).toBe(false);
    });

    it("stops the drop reaching Obsidian, which would otherwise move the tip", () => {
      // The half that makes this a REFUSAL rather than a decline. Returning
      // without touching the event hands the gesture to the core explorer,
      // and the core explorer would move `foo/bar/beta` into `Plain` --
      // a vault mutation chosen by Obsidian, not by the user and not by us.
      boundDrag();
      fire(tree.rows["foo/bar/beta"], "dragstart", beforeBand(ROW_AT.beta));
      const r = withProbe(tree.rows["Plain/inner.md"], "drop", beforeBand(ROW_AT.inner));
      expect(r.reachedTarget).toBe(false);
    });

    it("refuses a drop on the MIDDLE of another folder too", () => {
      // The plainest way to ask for the move, and the one that reaches
      // Obsidian's own drop-into-folder. The destination assertion is
      // `reachedTarget`: `Plain`'s row is where Obsidian's handler lives.
      boundDrag();
      fire(tree.rows["foo/bar/beta"], "dragstart", beforeBand(ROW_AT.beta));
      const r = withProbe(tree.rows["Plain"], "drop", middle(ROW_AT.plain));
      expect(r.reachedTarget).toBe(false);
      expect(r.defaultPrevented).toBe(false);
      expect(moveInto).not.toHaveBeenCalled();
      expect(onCompactedRowRefused).toHaveBeenCalledTimes(1);
    });

    it("draws no line for a cross-folder position it is going to refuse", () => {
      boundDrag();
      fire(tree.rows["foo/bar/beta"], "dragstart", beforeBand(ROW_AT.beta));
      fire(tree.rows["Plain/inner.md"], "dragover", beforeBand(ROW_AT.inner));
      expect(visibleLines()).toBe(0);
    });

    it("leaves an ordinary row free to move into another folder", () => {
      // The control. Without it a guard that refused every cross-folder drop
      // would pass every test above.
      boundDrag();
      fire(tree.rows["note.md"], "dragstart", beforeBand(ROW_AT.note));
      fire(tree.rows["Plain/inner.md"], "drop", beforeBand(ROW_AT.inner));
      expect(moveInto).toHaveBeenCalledTimes(1);
      expect(moveInto).toHaveBeenCalledWith(["note.md"], "Plain", "before", "Plain/inner.md");
      expect(onCompactedRowRefused).not.toHaveBeenCalled();
    });
  });

  describe("a note dropped beside a compacted row", () => {
    it("takes a position against the HEAD when it comes from another folder", () => {
      boundDrag();
      fire(tree.rows["Plain/inner.md"], "dragstart", beforeBand(ROW_AT.inner));
      fire(tree.rows["foo/bar/beta"], "drop", beforeBand(ROW_AT.beta));
      expect(moveInto).toHaveBeenCalledTimes(1);
      // The destination folder is the vault root -- where the row is DRAWN --
      // and the position is named against `foo`, the chain's head. Naming the
      // tip would place the note against a path that is not a child of the
      // destination at all, and the position would be struck on write.
      expect(moveInto).toHaveBeenCalledWith(["Plain/inner.md"], "", "before", "foo");
    });

    it("reorders against the HEAD when it is already in the head's parent", () => {
      boundDrag();
      fire(tree.rows["note.md"], "dragstart", beforeBand(ROW_AT.note));
      fire(tree.rows["foo/bar/beta"], "drop", afterBand(ROW_AT.beta));
      expect(writeOrder).toHaveBeenCalledTimes(1);
      expect(writeOrder).toHaveBeenCalledWith("", ["alpha", "foo", "note.md", "Plain"]);
    });

    it("lands INSIDE the tip when it is dropped on the middle of the row", () => {
      // Unchanged behaviour, pinned. The middle of a folder row is Obsidian's
      // own drop-into and it means the folder the row IS, which for a
      // compacted row is the tip. `reachedTarget` is the destination: the
      // event reaches the row whose `data-path` is `foo/bar/beta`.
      boundDrag();
      fire(tree.rows["note.md"], "dragstart", beforeBand(ROW_AT.note));
      const r = withProbe(tree.rows["foo/bar/beta"], "drop", middle(ROW_AT.beta));
      expect(r.reachedTarget).toBe(true);
      expect(r.defaultPrevented).toBe(false);
      expect(moveInto).not.toHaveBeenCalled();
      expect(writeOrder).not.toHaveBeenCalled();
      expect(onCompactedRowRefused).not.toHaveBeenCalled();
    });
  });

  describe("the destination cue", () => {
    it("marks the row that stands for a destination folder drawn as a chain", () => {
      // `describeRow` answers in STORAGE's spelling, and a row is spelled in
      // display space. The two differ for exactly one kind of path -- a run's
      // HEAD -- so a destination named by its head has to be translated back
      // before the DOM is asked for its row. Here the destination is `alpha`,
      // whose row carries `alpha/zeta/theta`.
      const describeRow = deps.describeRow;
      deps.describeRow = (path) =>
        path === "Plain/inner.md" ? { parent: "alpha", isFolder: false } : describeRow(path);
      boundDrag();
      fire(tree.rows["note.md"], "dragstart", beforeBand(ROW_AT.note));
      fire(tree.rows["Plain/inner.md"], "dragover", beforeBand(ROW_AT.inner));
      const marked = tree.container.querySelector(".spaces-drop-parent");
      expect(marked?.getAttribute("data-path")).toBe("alpha/zeta/theta");
    });

    it("still marks an ordinary destination folder by its own path", () => {
      boundDrag();
      fire(tree.rows["note.md"], "dragstart", beforeBand(ROW_AT.note));
      fire(tree.rows["Plain/inner.md"], "dragover", beforeBand(ROW_AT.inner));
      const marked = tree.container.querySelector(".spaces-drop-parent");
      expect(marked?.getAttribute("data-path")).toBe("Plain");
    });
  });
});
