import { beforeEach, describe, expect, it, vi } from "vitest";
import { DragOrdering, type DragOrderingDeps } from "../src/order/DragOrdering";
import { SEL } from "../src/explorer/selectors";

/**
 * jsdom computes no layout, so `getBoundingClientRect` returns zeros and
 * `intentFor` would answer "none" for every row. Each row therefore gets a
 * stubbed rect. That is a fixture detail, not a shortcut: the geometry rules
 * themselves are tested in `dropIntent.test.ts` against real numbers, and what
 * these tests pin is the CONTROLLER's dispatch — which listeners fire, what is
 * claimed, and what is called.
 */
const ROW_H = 24;
/** Mirrors `.tree-item-self`'s real `margin-bottom: 2px` (measured). */
const GAP = 2;

function makeTree() {
  // Every test binds a controller to a fresh container and none of them
  // unbind, so the DOCUMENT-level dragover/drop/dragend listeners of every
  // earlier test are still attached to the one jsdom document. A controller
  // whose drag was started but never ended still holds a populated `dragged`
  // and a container with stubbed rects, so it answers the NEXT test's drop as
  // though it were its own — which is how the first decline test came back
  // `defaultPrevented` with its own controller having declined. One `dragend`
  // clears every one of them, and it is precisely the teardown they are all
  // already listening for.
  document.dispatchEvent(new Event("dragend", { bubbles: true }));
  const container = document.createElement("div");
  container.className = "nav-files-container";
  document.body.replaceChildren(container);
  const rows: Record<string, HTMLElement> = {};
  let y = 0;
  function addRow(path: string, isFolder: boolean, indent = 0): HTMLElement {
    const item = document.createElement("div");
    item.className = `tree-item ${isFolder ? "nav-folder" : "nav-file"}`;
    const self = document.createElement("div");
    self.className = "tree-item-self";
    self.setAttribute("data-path", path);
    item.appendChild(self);
    container.appendChild(item);
    const top = y;
    y += ROW_H;
    // The WRAPPER carries the indent. Measured against Obsidian 1.13.7: a
    // depth-0 row reads l=12 w=305 and a depth-1 row l=29 w=288, stepping ~17px
    // per level. This is the box the line has to match, and it is what
    // Obsidian's own `.nav-folder.is-being-dragged-over` bubble paints.
    //
    // This fixture used to have it exactly backwards — indent on the self,
    // wrapper pane-wide — which is why a test named "sizes the line to the
    // target row's own box, not the pane" passed for years while the app drew a
    // pane-wide line at every depth. The assertion was right; the world it
    // described was invented.
    item.getBoundingClientRect = () =>
      ({ top, bottom: top + ROW_H, height: ROW_H, left: indent, right: 100, width: 100 - indent, x: indent, y: top }) as DOMRect;
    // `.tree-item-self` is stretched back to the PANE EDGE by Obsidian
    // (`margin-inline-start: 0`, the indent applied as `padding-inline-start`)
    // so hover and selection backgrounds run full width. Measured: l=12 w=305
    // at every depth. Horizontally it is therefore useless; vertically it is
    // the only correct box, because a folder's wrapper spans its whole subtree.
    //
    // It is 2px SHORTER than the row, mirroring `.tree-item-self`'s real
    // `margin-bottom: 2px`. That gap is what created two snap positions per
    // boundary, so a fixture without it could not catch a regression.
    const selfH = ROW_H - GAP;
    self.getBoundingClientRect = () =>
      ({ top, bottom: top + selfH, height: selfH, left: 0, right: 100, width: 100, x: 0, y: top }) as DOMRect;
    rows[path] = item;
    return item;
  }
  container.getBoundingClientRect = () =>
    ({ top: 0, bottom: 500, height: 500, left: 0, right: 100, width: 100, x: 0, y: 0 }) as DOMRect;
  return { container, rows, addRow };
}

/**
 * The line element lives in the DOM for the whole binding and is toggled with
 * `hidden`, because inserting and removing it mid-drag provoked
 * dragenter/dragleave churn that made Obsidian's own highlight flicker. So
 * "is the line showing" is a visibility question, not a presence one.
 */
function visibleLines(): number {
  return document.querySelectorAll(".spaces-drop-line:not([hidden])").length;
}

function fire(el: HTMLElement, type: string, clientY: number): Event {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  el.dispatchEvent(e);
  return e;
}

/** Same, with an explicit X — the container spans x 0..100 in the fixture. */
function fireAt(el: HTMLElement, type: string, clientX: number, clientY: number): Event {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  el.dispatchEvent(e);
  return e;
}

/** The row's own listener only runs if capture-phase stopPropagation did NOT. */
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

describe("DragOrdering", () => {
  let deps: DragOrderingDeps;
  let writeOrder: ReturnType<typeof vi.fn>;
  let moveInto: ReturnType<typeof vi.fn>;
  let enabled: boolean;
  let tree: ReturnType<typeof makeTree>;

  beforeEach(() => {
    enabled = true;
    writeOrder = vi.fn().mockResolvedValue(undefined);
    moveInto = vi.fn().mockResolvedValue(undefined);
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
      writeOrder: writeOrder as unknown as DragOrderingDeps["writeOrder"],
      moveInto: moveInto as unknown as DragOrderingDeps["moveInto"],
      enabled: () => enabled,
      indicatorStyle: () => "line" as const,
    };
  });

  function boundDrag(): DragOrdering {
    const d = new DragOrdering(deps);
    d.bind(tree.container);
    return d;
  }

  it("NEVER preventDefaults a dragstart", () => {
    // The constraint with the widest blast radius: suppressing dragstart breaks
    // dragging a note into the editor to make a link, onto a tab, and out of
    // the app entirely.
    boundDrag();
    const r = withProbe(tree.rows["F/a.md"], "dragstart", 4);
    expect(r.defaultPrevented).toBe(false);
    expect(r.reachedTarget).toBe(true);
  });

  it("does not claim a dragover over a folder's middle, and draws no line", () => {
    // This is what preserves Obsidian's own drop-into-folder.
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    const r = withProbe(tree.rows["G"], "dragover", 48 + ROW_H / 2);
    expect(r.reachedTarget).toBe(true);
    expect(r.defaultPrevented).toBe(false);
    expect(visibleLines()).toBe(0);
  });

  it("draws a line at a row edge while LETTING the event through", () => {
    // The line is additive: Obsidian's own folder tint and "Move into <folder>"
    // label must keep working underneath it. Stopping propagation here would
    // suppress the tint — and doing so only at the edges would make the tint
    // flash on and off as the pointer crosses bands inside one row.
    // `reachedTarget` true is what pins that propagation stays open.
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    // b's BOTTOM band, i.e. "after b" — a real move. "before b" is where a.md
    // already sits, and the drag-line rule draws no line at a no-op
    // position.
    const r = withProbe(tree.rows["F/b.md"], "dragover", ROW_H * 2 - GAP - 2);
    // We touch the event not at all: Obsidian's own handler already
    // preventDefaults, so the drop is permitted without us, and leaving the
    // event pristine is what lets the tint survive.
    expect(r.defaultPrevented).toBe(false);
    expect(r.reachedTarget).toBe(true);
    expect(visibleLines()).toBe(1);
  });

  it("STOPS propagation on the drop, so Obsidian does not also move the file", () => {
    // Different reason from dragover: both handlers acting on one drop would
    // move the file twice, the second failing on its own collision.
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    const r = withProbe(tree.rows["F/b.md"], "drop", ROW_H * 2 - 2);
    expect(r.reachedTarget).toBe(false);
    expect(writeOrder).toHaveBeenCalledTimes(1);
  });

  it("gives ONE position to one boundary, from either side", () => {
    // Rows are separated by a real 2px gap, so "after a" and "before b" are
    // different y values for what the user sees as a single line between two
    // rows. Crossing the boundary alternated between two adjacent 2px bands —
    // a 4px flicker that read as the line thickening, with one of the two
    // rendering dim from subpixel straddling.
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);

    // Bottom edge of row a → "after a".
    fire(tree.rows["F/a.md"], "dragover", ROW_H - GAP - 1);
    const fromAbove = (document.querySelector(".spaces-drop-line") as HTMLElement).style.top;

    // Top edge of row b → "before b". Same boundary.
    fire(tree.rows["F/b.md"], "dragover", ROW_H + 1);
    const fromBelow = (document.querySelector(".spaces-drop-line") as HTMLElement).style.top;

    expect(fromAbove).toBe(fromBelow);
  });

  it("ignores a sibling whose rect is nowhere near the row", () => {
    // In a windowed container a `.tree-item` sibling can be in the DOM while
    // scrolled far out of view. Averaging against its rect threw the line
    // hundreds of pixels away during a real drag — a boundary computed at
    // clientY -167 where ~1220 was correct. Simulated here by giving row a's
    // predecessor an absurd rect.
    const stray = tree.rows["F/a.md"];
    const strayInner = stray.querySelector(".tree-item-self") as HTMLElement;
    strayInner.getBoundingClientRect = () =>
      ({ top: -900, bottom: -876, height: 24, left: 0, right: 100, width: 100, x: 0, y: -900 }) as DOMRect;

    boundDrag();
    // Dragging G, whose parent differs, so this is a cross-folder drop: it can
    // never be a no-op, and the boundary assertion below is not masked by
    // The no-op suppression. (Dragging b and hovering b is now suppressed,
    // since a row's own edge moves it nowhere.)
    fire(tree.rows["G"], "dragstart", ROW_H * 2 + 4);
    // "before b" would average b.top with a's bogus bottom without the guard.
    fire(tree.rows["F/b.md"], "dragover", ROW_H + 1);
    const top = parseFloat((document.querySelector(".spaces-drop-line") as HTMLElement).style.top);
    // Must land on b's own top edge, not halfway to -876.
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(ROW_H * 2);
  });

  it("rounds the line to a whole pixel", () => {
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["F/b.md"], "dragover", ROW_H * 2 - GAP - 2);
    const top = (document.querySelector(".spaces-drop-line") as HTMLElement).style.top;
    expect(top).toMatch(/^-?\d+px$/);
  });

  it("resolves the row from the pointer's Y, not the event's ancestors", () => {
    // The gap between rows belongs to the parent's `.tree-item-children`, so
    // `closest('.tree-item')` from there used to walk up to the enclosing
    // FOLDER — whose rect spans its whole subtree — and the line jumped to the
    // folder heading above. Dispatching on the container with a clientY inside
    // row b is exactly that situation.
    const seen: string[] = [];
    const base = deps.describeRow;
    deps.describeRow = (p) => {
      seen.push(p);
      return base(p);
    };
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.container, "dragover", ROW_H + ROW_H / 2);
    expect(seen).toContain("F/b.md");
    expect(seen).not.toContain("G");
    expect(visibleLines()).toBe(1);
  });

  it("draws no line when the pointer is outside every row", () => {
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.container, "dragover", 9999);
    expect(visibleLines()).toBe(0);
  });

  it("sizes the line to the target row's INDENTED box, not the pane", () => {
    // A full-width line reads as belonging to the pane rather than to the row
    // it describes, and it does not line up with the bubble being aimed at.
    //
    // The horizontal box comes from the `.tree-item` WRAPPER. Taking
    // `.tree-item-self` — which Obsidian stretches to the pane edge at every
    // depth — is the bug this pins.
    tree.addRow("F/deep.md", false, 40);
    deps.displayedOrder = () => ["F/a.md", "F/b.md", "F/deep.md"];
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["F/deep.md"], "dragover", ROW_H * 3 + 2);
    const line = document.querySelector(".spaces-drop-line") as HTMLElement;
    expect(line.style.left).toBe("40px");
    expect(line.style.width).toBe("60px");
  });

  it("moves the same line element rather than adding another", () => {
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["F/b.md"], "dragover", ROW_H + 2);
    const first = document.querySelector(".spaces-drop-line");
    fire(tree.rows["F/b.md"], "dragover", ROW_H * 2 - 2);
    expect(visibleLines()).toBe(1);
    expect(document.querySelector(".spaces-drop-line")).toBe(first);
  });

  it("writes an order on a same-parent drop and does not move any file", () => {
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["F/b.md"], "drop", ROW_H * 2 - 2);
    expect(moveInto).not.toHaveBeenCalled();
    expect(writeOrder).toHaveBeenCalledTimes(1);
    expect(writeOrder.mock.calls[0][0]).toBe("F");
    expect(writeOrder.mock.calls[0][1]).toEqual(["F/b.md", "F/a.md"]);
  });

  it("moves the file on a cross-parent drop and writes no order itself", () => {
    // The move has to land before anything is ordered, so the controller
    // hands the whole operation over rather than doing both.
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["G"], "drop", 48 + 1);
    expect(writeOrder).not.toHaveBeenCalled();
    expect(moveInto).toHaveBeenCalledTimes(1);
    expect(moveInto.mock.calls[0][0]).toEqual(["F/a.md"]);
    expect(moveInto.mock.calls[0][1]).toBe("");
  });

  it("ends Obsidian's drag after claiming a drop", () => {
    // Claiming the drop stops Obsidian's own drop handler, which is where it
    // tears its drag state down — so without this the body kept `is-grabbing`
    // (a stuck grab cursor), the target stayed tinted, the source row stayed
    // marked and the ghost stayed attached until the next drag.
    let dragendOnSource = 0;
    tree.rows["F/a.md"].addEventListener("dragend", () => {
      dragendOnSource++;
    });
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["F/b.md"], "drop", ROW_H * 2 - 4);
    expect(writeOrder).toHaveBeenCalledTimes(1);
    expect(dragendOnSource).toBe(1);
  });

  it("does not fire a teardown for a drop it did not claim", () => {
    // Over a folder's middle Obsidian handles the drop itself, so its own
    // teardown runs and ours would be a duplicate.
    let dragendOnSource = 0;
    tree.rows["F/a.md"].addEventListener("dragend", () => {
      dragendOnSource++;
    });
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["G"], "drop", 48 + ROW_H / 2);
    expect(dragendOnSource).toBe(0);
  });

  it("writes nothing when the drop changes nothing", () => {
    deps.storedOrder = () => ["F/a.md", "F/b.md"];
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    // Dropping a.md just before b.md is where it already is.
    fire(tree.rows["F/b.md"], "drop", ROW_H + 2);
    expect(writeOrder).not.toHaveBeenCalled();
    expect(moveInto).not.toHaveBeenCalled();
  });

  it("attaches nothing when reordering is disabled", () => {
    enabled = false;
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    const r = withProbe(tree.rows["F/b.md"], "dragover", ROW_H + 2);
    expect(r.defaultPrevented).toBe(false);
    expect(visibleLines()).toBe(0);
    fire(tree.rows["F/b.md"], "drop", ROW_H + 2);
    expect(writeOrder).not.toHaveBeenCalled();
  });

  it("removes the line and every listener on unbind, and is safe twice", () => {
    const d = boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["F/b.md"], "dragover", ROW_H * 2 - GAP - 2);
    expect(visibleLines()).toBe(1);
    d.unbind();
    d.unbind();
    expect(visibleLines()).toBe(0);
    const r = withProbe(tree.rows["F/b.md"], "dragover", ROW_H + 2);
    expect(r.defaultPrevented).toBe(false);
  });

  it("keeps updating when the event target is OUTSIDE the tree (the drag ghost)", () => {
    // Obsidian's floating "Move into <folder>" ghost is position:fixed with no
    // pointer-events:none and lives on <body>, so it steals dragover from the
    // container whenever it is under the cursor. A container-scoped listener
    // then stopped firing and the line froze rows away from the pointer. The
    // listeners are on the document for this reason, and the row comes from the
    // pointer's Y — so an event dispatched from outside the tree still works.
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    document.body.appendChild(ghost);
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    // b's bottom band: "before b" is where a.md already is, and the
    // drag-line rule draws no line at a no-op position.
    fire(ghost, "dragover", ROW_H * 2 - GAP - 2);
    expect(visibleLines()).toBe(1);
    ghost.remove();
  });

  it("clears the line when the pointer leaves the tree's bounds", () => {
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["F/b.md"], "dragover", ROW_H * 2 - GAP - 2);
    expect(visibleLines()).toBe(1);
    // Below the container entirely.
    fire(document.body, "dragover", 9999);
    expect(visibleLines()).toBe(0);
  });

  it("ignores a pointer beside the tree at a y that lines up with a row", () => {
    // The guard that matters, and the one my first attempt failed to test: a
    // y of 9999 is rejected by the row hit test anyway, so it proved nothing.
    // Here the y is squarely inside row b and only the X is outside — which is
    // a drag over the editor at the same height as a tree row. Without the
    // bounds guard the document-wide listener resolves row b and draws a line
    // in a pane the pointer is not even over.
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fireAt(document.body, "dragover", 500, ROW_H + 2);
    expect(visibleLines()).toBe(0);
  });

  it("ignores a DROP beside the tree at a row-aligned y", () => {
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fireAt(document.body, "drop", 500, ROW_H * 2 - 4);
    expect(writeOrder).not.toHaveBeenCalled();
    expect(moveInto).not.toHaveBeenCalled();
  });

  it("ignores a drop outside the tree, so a document listener stays harmless", () => {
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(document.body, "drop", 9999);
    expect(writeOrder).not.toHaveBeenCalled();
    expect(moveInto).not.toHaveBeenCalled();
  });

  it("clears the line on dragend", () => {
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["F/b.md"], "dragover", ROW_H + 2);
    fire(tree.rows["F/b.md"], "dragend", 0);
    expect(visibleLines()).toBe(0);
  });

  it("survives a throwing dep, logs once, and leaves no line behind", () => {
    deps.displayedOrder = () => {
      throw new Error("boom");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["F/b.md"], "dragover", ROW_H + 2);
    fire(tree.rows["F/b.md"], "drop", ROW_H * 2 - 2);
    expect(visibleLines()).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("ignores a drag that started outside a row", () => {
    boundDrag();
    fire(tree.container, "dragstart", 0);
    fire(tree.rows["F/b.md"], "drop", ROW_H + 2);
    expect(writeOrder).not.toHaveBeenCalled();
  });

  it("collects a multi-selection only when the dragged row is itself selected", () => {
    const aSelf = tree.rows["F/a.md"].querySelector(".tree-item-self") as HTMLElement;
    const bSelf = tree.rows["F/b.md"].querySelector(".tree-item-self") as HTMLElement;
    // The class is Obsidian's, so the string lives in selectors.ts.
    aSelf.classList.add(SEL.selectedRow.slice(1));
    bSelf.classList.add(SEL.selectedRow.slice(1));
    deps.storedOrder = () => ["F/a.md", "F/b.md", "F/c.md"];
    deps.displayedOrder = () => ["F/a.md", "F/b.md", "F/c.md"];
    tree.addRow("F/c.md", false);
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["F/c.md"], "drop", ROW_H * 4 - 2);
    expect(writeOrder.mock.calls[0][1]).toEqual(["F/c.md", "F/a.md", "F/b.md"]);
  });

  it("drags only the one row when it is not selected", () => {
    const bSelf = tree.rows["F/b.md"].querySelector(".tree-item-self") as HTMLElement;
    bSelf.classList.add(SEL.selectedRow.slice(1)); // some OTHER row is selected
    boundDrag();
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["F/b.md"], "drop", ROW_H * 2 - 2);
    expect(writeOrder.mock.calls[0][1]).toEqual(["F/b.md", "F/a.md"]);
  });
});

/**
 * Dragging a folder over its own row opens it, and the rows inside then
 * look like ordinary between-row targets. Without a guard the drop was claimed
 * and `Archive` was moved to `Archive/Archive` — EINVAL, surfaced as a Notice
 * (reproduced and captured during development).
 *
 * These pin the CONTROLLER's wiring, not the rule: `movesIntoOwnSubtree` has
 * its own tests in dropIntent.test.ts, and removing either call site here
 * leaves those green.
 */
describe("DragOrdering: a folder may not be dropped inside itself (spec 20.4)", () => {
  let deps: DragOrderingDeps;
  let moveInto: ReturnType<typeof vi.fn>;
  let tree: ReturnType<typeof makeTree>;

  beforeEach(() => {
    moveInto = vi.fn().mockResolvedValue(undefined);
    tree = makeTree();
    // Archive, expanded, with two children — the shape the drag produces.
    tree.addRow("Archive", true);
    tree.addRow("Archive/Bravo.md", false, 16);
    tree.addRow("Archive/Charlie.md", false, 16);
    tree.addRow("Archive/Delta.md", false, 16);
    tree.addRow("Other", true);
    deps = {
      describeRow: (path) => {
        if (path === "Archive" || path === "Other") return { parent: "", isFolder: true };
        if (path.startsWith("Archive/")) return { parent: "Archive", isFolder: false };
        return null;
      },
      displayedOrder: () => ["Archive/Bravo.md", "Archive/Charlie.md", "Archive/Delta.md"],
      storedOrder: () => undefined,
      writeOrder: vi.fn().mockResolvedValue(undefined) as unknown as DragOrderingDeps["writeOrder"],
      moveInto: moveInto as unknown as DragOrderingDeps["moveInto"],
      enabled: () => true,
      indicatorStyle: () => "line" as const,
    };
    const d = new DragOrdering(deps);
    d.bind(tree.container);
  });

  /**
   * Charlie's top band — the boundary between Bravo and Charlie, which is
   * INSIDE the dragged folder. In a row's band, not the 2px gap between rows:
   * the gap is a deliberate dead zone and a pointer there would be
   * rejected before the guard was ever consulted, so the test would pass for
   * the wrong reason.
   *
   * It is also NOT adjacent to Bravo, which the positive control drags. The
   * boundary immediately below a row is where that row already sits, so a
   * drag there is a no-op and draws no line — a positive control placed
   * there would fail for a reason having nothing to do with this guard.
   */
  const insideY = ROW_H * 3 + 2;

  it("draws NO line for a boundary inside the dragged folder", () => {
    fire(tree.rows["Archive"], "dragstart", 4);
    fire(tree.rows["Archive/Delta.md"], "dragover", insideY);
    expect(visibleLines()).toBe(0);
  });

  it("does not claim the drop, leaving the gesture to the core explorer", () => {
    fire(tree.rows["Archive"], "dragstart", 4);
    const r = withProbe(tree.rows["Archive/Delta.md"], "drop", insideY);
    // Untouched event and no move: the gesture passes to the host.
    expect(r.defaultPrevented).toBe(false);
    expect(r.reachedTarget).toBe(true);
    expect(moveInto).not.toHaveBeenCalled();
  });

  it("still draws a line for a legal drag at the SAME boundary", () => {
    // The positive control, and it shares the boundary with the two tests
    // above so the only difference is WHAT is being dragged. Without it, a
    // guard that rejected every drop would pass both of them.
    //
    // `ROW_H + 4`, not 4: `rowAt` resolves the dragged row by POINTER Y, not
    // by the event target, so a dragstart at y=4 grabs whatever row occupies
    // 0..24 — here `Archive` itself. An earlier version of this test fired at
    // y=4 on Bravo's element and was therefore re-testing the illegal case
    // while claiming to be the control.
    fire(tree.rows["Archive/Bravo.md"], "dragstart", ROW_H + 4);
    fire(tree.rows["Archive/Delta.md"], "dragover", insideY);
    expect(visibleLines()).toBe(1);
  });
});

/**
 * No line where a drop would change nothing.
 *
 * Reported after the folder-into-itself guard landed: dragging `Reference`
 * over itself expanded it, and a line still appeared between `Reference` and
 * its first child. That boundary is the dragged row's OWN trailing edge, so
 * `computeDrop` already declined it — its `at === -1` branch covers "the
 * target was itself being dragged" — but only at drop time. Dragover never
 * asked, so the line promised a move that the drop then silently refused.
 */
describe("DragOrdering: no line for a no-op position (spec 20.4)", () => {
  let deps: DragOrderingDeps;
  let tree: ReturnType<typeof makeTree>;
  const ROOT = ["Reference", "Other"];
  const KIDS = ["Reference/Alpha.md", "Reference/Daily.md"];

  beforeEach(() => {
    tree = makeTree();
    tree.addRow("Reference", true);
    tree.addRow("Reference/Alpha.md", false, 16);
    tree.addRow("Reference/Daily.md", false, 16);
    tree.addRow("Other", true);
    deps = {
      describeRow: (path) => {
        if (path === "Reference" || path === "Other") return { parent: "", isFolder: true };
        if (path.startsWith("Reference/")) return { parent: "Reference", isFolder: false };
        return null;
      },
      displayedOrder: (folder) => (folder === "" ? [...ROOT] : [...KIDS]),
      storedOrder: () => undefined,
      writeOrder: vi.fn().mockResolvedValue(undefined) as unknown as DragOrderingDeps["writeOrder"],
      moveInto: vi.fn().mockResolvedValue(undefined) as unknown as DragOrderingDeps["moveInto"],
      enabled: () => true,
      indicatorStyle: () => "line" as const,
    };
    const d = new DragOrdering(deps);
    d.bind(tree.container);
  });

  it("draws no line at the dragged row's own trailing edge", () => {
    // Visually this is "between Reference and Alpha", which reads as inside
    // the folder — the exact position the report named.
    fire(tree.rows["Reference"], "dragstart", 4);
    fire(tree.rows["Reference"], "dragover", ROW_H - GAP - 2);
    expect(visibleLines()).toBe(0);
  });

  it("draws no line at the dragged row's own leading edge either", () => {
    fire(tree.rows["Reference"], "dragstart", 4);
    fire(tree.rows["Reference"], "dragover", 2);
    expect(visibleLines()).toBe(0);
  });

  it("still draws a line for a position that WOULD move the row", () => {
    // Positive control: dragging Reference to below Other is a real reorder.
    fire(tree.rows["Reference"], "dragstart", 4);
    fire(tree.rows["Other"], "dragover", ROW_H * 3 + ROW_H - GAP - 2);
    expect(visibleLines()).toBe(1);
  });
});

describe("DragOrdering: a blocked drag reports itself once (spec 22.5)", () => {
  function setup(enabled: boolean) {
    const onBlockedDrag = vi.fn();
    const tree = makeTree();
    tree.addRow("F/a.md", false);
    tree.addRow("F/b.md", false);
    const deps: DragOrderingDeps = {
      describeRow: (path) => (path.startsWith("F/") ? { parent: "F", isFolder: false } : null),
      displayedOrder: () => ["F/a.md", "F/b.md"],
      storedOrder: () => undefined,
      writeOrder: vi.fn().mockResolvedValue(undefined) as unknown as DragOrderingDeps["writeOrder"],
      moveInto: vi.fn().mockResolvedValue(undefined) as unknown as DragOrderingDeps["moveInto"],
      enabled: () => enabled,
      indicatorStyle: () => "line" as const,
      onBlockedDrag,
    };
    const d = new DragOrdering(deps);
    d.bind(tree.container);
    return { tree, onBlockedDrag };
  }

  it("calls onBlockedDrag once per dragstart while disabled", () => {
    const { tree, onBlockedDrag } = setup(false);
    fire(tree.rows["F/a.md"], "dragstart", 4);
    expect(onBlockedDrag).toHaveBeenCalledTimes(1);
  });

  it("does NOT call it on every dragover — one gesture, one report", () => {
    // dragover fires hundreds of times per drag; reporting per event would be
    // a Notice storm.
    const { tree, onBlockedDrag } = setup(false);
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["F/b.md"], "dragover", ROW_H + 2);
    fire(tree.rows["F/b.md"], "dragover", ROW_H + 4);
    expect(onBlockedDrag).toHaveBeenCalledTimes(1);
  });

  it("does not call it when ordering is enabled", () => {
    const { tree, onBlockedDrag } = setup(true);
    fire(tree.rows["F/a.md"], "dragstart", 4);
    expect(onBlockedDrag).not.toHaveBeenCalled();
  });

  it("still draws no line while disabled", () => {
    const { tree } = setup(false);
    fire(tree.rows["F/a.md"], "dragstart", 4);
    fire(tree.rows["F/b.md"], "dragover", ROW_H * 2 - GAP - 2);
    expect(visibleLines()).toBe(0);
  });
});

/**
 * A multi-selection larger than the render window.
 *
 * It is a directly measured fact that the explorer detaches rows when they
 * scroll out of view: a 400-row tree rendered **6 of one folder's 153
 * children** behind a virtual spacer. `collectDragged` reads the DOM, so it
 * cannot see a selected row that is not rendered — and because spaces claims
 * the drop, the rows it never saw are simply not moved, with nothing said.
 *
 * There is no public source of truth for the whole selection (the explorer
 * keeps it in a private field the quarantine forbids), so the fix is not to
 * collect more: it is to notice that the collected set may be short and decline
 * the drop, leaving the gesture to Obsidian, which does know the full selection.
 *
 * The tell is purely geometric and needs no private API: a selection that
 * reaches the FIRST or LAST rendered row may continue past it, unless the
 * scroller is already at that end of its range.
 */
describe("DragOrdering — a selection that may extend past the render window", () => {
  /**
   * jsdom computes no layout, so the scroller's own metrics are zero and every
   * selection would read as "the whole tree is on screen". These are the three
   * numbers the truncation check reads.
   */
  function setScroll(
    el: HTMLElement,
    o: { scrollTop: number; clientHeight: number; scrollHeight: number }
  ): void {
    Object.defineProperty(el, "scrollTop", { value: o.scrollTop, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: o.clientHeight, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: o.scrollHeight, configurable: true });
  }

  function select(tree: ReturnType<typeof makeTree>, ...paths: string[]): void {
    for (const p of paths) {
      const self = tree.rows[p]!.querySelector(SEL.titleWithPath) as HTMLElement;
      self.classList.add(SEL.selectedRow.slice(1));
    }
  }

  function setup() {
    const tree = makeTree();
    tree.addRow("F/a.md", false);
    tree.addRow("F/b.md", false);
    tree.addRow("F/c.md", false);
    tree.addRow("F/d.md", false);
    const writeOrder = vi.fn().mockResolvedValue(undefined);
    const onSelectionOutsideWindow = vi.fn();
    const deps: DragOrderingDeps = {
      describeRow: (path) =>
        path.startsWith("F/") ? { parent: "F", isFolder: false } : null,
      displayedOrder: () => ["F/a.md", "F/b.md", "F/c.md", "F/d.md"],
      storedOrder: () => undefined,
      writeOrder: writeOrder as unknown as DragOrderingDeps["writeOrder"],
      moveInto: vi.fn().mockResolvedValue(undefined) as unknown as DragOrderingDeps["moveInto"],
      enabled: () => true,
      indicatorStyle: () => "line" as const,
      onSelectionOutsideWindow,
    };
    const d = new DragOrdering(deps);
    d.bind(tree.container);
    return { tree, writeOrder, onSelectionOutsideWindow };
  }

  it("declines a drop whose selection reaches the first rendered row of a scrolled tree", () => {
    const s = setup();
    // Scrolled into the middle of a long tree: rows above the window are
    // detached, so a selection touching the top row may continue above it.
    setScroll(s.tree.container, { scrollTop: 400, clientHeight: 200, scrollHeight: 2000 });
    select(s.tree, "F/a.md", "F/b.md");
    fire(s.tree.rows["F/a.md"]!, "dragstart", 4);
    const r = withProbe(s.tree.rows["F/d.md"]!, "drop", ROW_H * 4 - 2);
    expect(s.writeOrder).not.toHaveBeenCalled();
    // Declining means NOT claiming: Obsidian's own handler, which knows the
    // whole selection, gets the gesture.
    expect(r.defaultPrevented).toBe(false);
    expect(r.reachedTarget).toBe(true);
    expect(s.onSelectionOutsideWindow).toHaveBeenCalledTimes(1);
  });

  it("declines when the selection reaches the last rendered row of a tree scrolled short of the end", () => {
    const s = setup();
    setScroll(s.tree.container, { scrollTop: 0, clientHeight: 200, scrollHeight: 2000 });
    select(s.tree, "F/c.md", "F/d.md");
    fire(s.tree.rows["F/d.md"]!, "dragstart", ROW_H * 3 + 4);
    const r = withProbe(s.tree.rows["F/a.md"]!, "drop", 2);
    expect(s.writeOrder).not.toHaveBeenCalled();
    expect(r.defaultPrevented).toBe(false);
    expect(s.onSelectionOutsideWindow).toHaveBeenCalledTimes(1);
  });

  it("trusts a selection bounded by unselected rendered rows on both sides", () => {
    const s = setup();
    setScroll(s.tree.container, { scrollTop: 400, clientHeight: 200, scrollHeight: 2000 });
    select(s.tree, "F/b.md", "F/c.md");
    fire(s.tree.rows["F/b.md"]!, "dragstart", ROW_H + 4);
    fire(s.tree.rows["F/d.md"]!, "drop", ROW_H * 4 - 2);
    expect(s.writeOrder).toHaveBeenCalledTimes(1);
    expect(s.writeOrder.mock.calls[0]![1]).toEqual(["F/a.md", "F/d.md", "F/b.md", "F/c.md"]);
    expect(s.onSelectionOutsideWindow).not.toHaveBeenCalled();
  });

  it("trusts a selection touching the top row when the tree is scrolled to the top", () => {
    const s = setup();
    // Nothing is detached above a scroller at offset 0, so the first rendered
    // row IS the first row.
    setScroll(s.tree.container, { scrollTop: 0, clientHeight: 2000, scrollHeight: 2000 });
    select(s.tree, "F/a.md", "F/b.md");
    fire(s.tree.rows["F/a.md"]!, "dragstart", 4);
    fire(s.tree.rows["F/d.md"]!, "drop", ROW_H * 4 - 2);
    expect(s.writeOrder).toHaveBeenCalledTimes(1);
    expect(s.onSelectionOutsideWindow).not.toHaveBeenCalled();
  });

  it("draws no line for a drop it is going to decline", () => {
    // No line for a drop that cannot happen. Promising a position and
    // then refusing it is the silent-partial-move defect wearing a hint.
    const s = setup();
    setScroll(s.tree.container, { scrollTop: 400, clientHeight: 200, scrollHeight: 2000 });
    select(s.tree, "F/a.md", "F/b.md");
    fire(s.tree.rows["F/a.md"]!, "dragstart", 4);
    fire(s.tree.rows["F/d.md"]!, "dragover", ROW_H * 4 - 2);
    expect(visibleLines()).toBe(0);
  });

  it("leaves a single-row drag alone however the tree is scrolled", () => {
    // Truncation is a property of a MULTI-selection. One unselected row is
    // whole by construction.
    const s = setup();
    setScroll(s.tree.container, { scrollTop: 400, clientHeight: 200, scrollHeight: 2000 });
    fire(s.tree.rows["F/a.md"]!, "dragstart", 4);
    fire(s.tree.rows["F/d.md"]!, "drop", ROW_H * 4 - 2);
    expect(s.writeOrder).toHaveBeenCalledTimes(1);
    expect(s.onSelectionOutsideWindow).not.toHaveBeenCalled();
  });
});

/**
 * The capture-phase drop handler is document-wide.
 *
 * It has to be: Obsidian's drag ghost is `position: fixed` with no
 * `pointer-events: none` and is attached to `body`, so it is usually the node
 * under the pointer and a container-scoped listener never fires (see the class
 * comment). What that costs is that a drop is claimed on GEOMETRY alone — the
 * pointer being inside the tree's rect — and `stopPropagation()` in capture
 * then cuts every handler below `document`, including one belonging to a
 * surface drawn ON TOP of the tree.
 *
 * spaces draws one of those itself: the create panel is
 * `position: absolute; inset: 0`, a SIBLING of `.nav-files-container` inside
 * the explorer pane. It covers the tree's rect exactly.
 */
describe("DragOrdering — a drop on a surface covering the tree", () => {
  function setup() {
    const tree = makeTree();
    const pane = document.createElement("div");
    pane.className = "workspace-leaf-content";
    pane.setAttribute("data-type", "file-explorer");
    document.body.replaceChildren(pane);
    pane.appendChild(tree.container);
    tree.addRow("F/a.md", false);
    tree.addRow("F/b.md", false);
    // The overlay, over the tree's whole box.
    const overlay = document.createElement("div");
    overlay.className = "spaces-create-panel";
    pane.appendChild(overlay);
    const writeOrder = vi.fn().mockResolvedValue(undefined);
    const deps: DragOrderingDeps = {
      describeRow: (path) =>
        path.startsWith("F/") ? { parent: "F", isFolder: false } : null,
      displayedOrder: () => ["F/a.md", "F/b.md"],
      storedOrder: () => undefined,
      writeOrder: writeOrder as unknown as DragOrderingDeps["writeOrder"],
      moveInto: vi.fn().mockResolvedValue(undefined) as unknown as DragOrderingDeps["moveInto"],
      enabled: () => true,
      indicatorStyle: () => "line" as const,
    };
    const d = new DragOrdering(deps);
    d.bind(tree.container);
    return { tree, pane, overlay, writeOrder };
  }

  it("does not claim a drop that landed on an overlay inside the explorer pane", () => {
    const s = setup();
    fire(s.tree.rows["F/a.md"]!, "dragstart", 4);
    const r = withProbe(s.overlay, "drop", ROW_H * 2 - 2);
    expect(s.writeOrder).not.toHaveBeenCalled();
    expect(r.defaultPrevented).toBe(false);
    // The overlay's own drop handler must still run — cutting it is the defect.
    expect(r.reachedTarget).toBe(true);
  });

  it("draws no line under an overlay either", () => {
    const s = setup();
    fire(s.tree.rows["F/a.md"]!, "dragstart", 4);
    fire(s.overlay, "dragover", ROW_H * 2 - 2);
    expect(visibleLines()).toBe(0);
  });

  it("still claims a drop whose target is outside the pane entirely (the drag ghost)", () => {
    // The ghost lives in `body`, not in the explorer pane, and the drop it
    // swallows is a real tree drop — this is the case the document listener
    // exists for, and the narrowing must not take it away.
    const s = setup();
    const ghost = document.createElement("div");
    document.body.appendChild(ghost);
    fire(s.tree.rows["F/a.md"]!, "dragstart", 4);
    fireAt(ghost, "drop", 50, ROW_H * 2 - 2);
    expect(s.writeOrder).toHaveBeenCalledTimes(1);
  });
});
