// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StripReveal } from "../src/ui/stripReveal";
import { CLS_STRIP_OPEN, CLS_STRIP_ZONE } from "../src/explorer/selectors";

/**
 * The strip's right edge: the lip's while it is closed, and the settled one
 * when it is open. The two are the same number here so that every test that
 * is not about the difference reads as it did before the suppliers were
 * split; `the close threshold` below is the one that pulls them apart.
 */
const RIGHT = 38;

let pane: HTMLElement;
let strip: HTMLElement;
let reveal: StripReveal;

const zone = () => pane.querySelector<HTMLElement>(`.${CLS_STRIP_ZONE}`);
const enter = (el: Element) => el.dispatchEvent(new MouseEvent("mouseenter"));
const dragEnter = (el: Element) => el.dispatchEvent(new Event("dragenter", { bubbles: true }));
const move = (clientX: number) => window.dispatchEvent(new MouseEvent("mousemove", { clientX }));
const leaveDoc = (clientX: number) =>
  document.dispatchEvent(new MouseEvent("mouseleave", { clientX }));
const leavePane = (clientX: number) =>
  pane.dispatchEvent(new MouseEvent("mouseleave", { clientX }));
const moveCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((c) => c[0] === "mousemove");

beforeEach(() => {
  pane = document.createElement("div");
  strip = document.createElement("div");
  pane.appendChild(strip);
  document.body.appendChild(pane);
  reveal = new StripReveal({ pane, strip, lipRight: () => RIGHT, openRight: () => RIGHT });
});

afterEach(() => {
  reveal.destroy();
  pane.remove();
  vi.restoreAllMocks();
});

describe("StripReveal", () => {
  it("binds no pointer-move listener while closed", () => {
    const add = vi.spyOn(window, "addEventListener");
    reveal.attach();
    expect(moveCalls(add)).toHaveLength(0);
    expect(reveal.isOpen()).toBe(false);
  });

  it("creates the zone as a direct child of the pane", () => {
    reveal.attach();
    expect(zone()?.parentElement).toBe(pane);
  });

  it("opens when the pointer enters the zone", () => {
    reveal.attach();
    enter(zone()!);
    expect(reveal.isOpen()).toBe(true);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(true);
  });

  it("opens when the pointer enters the strip itself", () => {
    reveal.attach();
    enter(strip);
    expect(reveal.isOpen()).toBe(true);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(true);
  });

  it("opens when the pointer leaves the document left of the strip", () => {
    reveal.attach();
    leaveDoc(0);
    expect(reveal.isOpen()).toBe(true);
  });

  it("does not open when the pointer leaves the document right of the strip", () => {
    reveal.attach();
    leaveDoc(RIGHT + 200);
    expect(reveal.isOpen()).toBe(false);
  });

  it("opens when the pointer leaves the pane left of the lip", () => {
    reveal.attach();
    leavePane(10);
    expect(reveal.isOpen()).toBe(true);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(true);
  });

  it("does not open when the pointer leaves the pane to the right of the lip", () => {
    reveal.attach();
    leavePane(RIGHT + 1);
    expect(reveal.isOpen()).toBe(false);
  });

  it("destroy removes the pane mouseleave handler", () => {
    const add = vi.spyOn(pane, "addEventListener");
    const remove = vi.spyOn(pane, "removeEventListener");
    reveal.attach();
    const added = add.mock.calls.filter((c) => c[0] === "mouseleave").map((c) => c[1]);
    expect(added).toHaveLength(1);
    reveal.destroy();
    expect(remove.mock.calls.filter((c) => c[0] === "mouseleave").map((c) => c[1])).toEqual(added);
    leavePane(0);
    expect(reveal.isOpen()).toBe(false);
  });

  it("stays open while the pointer is left of the strip's right edge", () => {
    reveal.attach();
    enter(zone()!);
    move(5);
    move(RIGHT);
    expect(reveal.isOpen()).toBe(true);
  });

  it("closes as soon as the pointer passes the strip's right edge", () => {
    reveal.attach();
    enter(zone()!);
    move(RIGHT + 1);
    expect(reveal.isOpen()).toBe(false);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(false);
  });

  it("binds the pointer-move listener on open and removes it when it closes", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    reveal.attach();
    enter(zone()!);
    expect(moveCalls(add)).toHaveLength(1);
    move(RIGHT + 1);
    expect(moveCalls(remove)).toHaveLength(1);
    expect(moveCalls(remove)[0][1]).toBe(moveCalls(add)[0][1]);
  });

  it("does not stack listeners when entered twice", () => {
    const add = vi.spyOn(window, "addEventListener");
    reveal.attach();
    enter(zone()!);
    enter(strip);
    expect(moveCalls(add)).toHaveLength(1);
  });

  it("a drag reveal closes on the first pointer move past the edge", () => {
    // Nothing holds the strip open for the drag's duration, and nothing has
    // to: a native drag fires no `mousemove`, so the first one to arrive is
    // already after the drag, however it ended and whether or not its end
    // events reached us. An OS-originated drag sends none.
    reveal.attach();
    dragEnter(zone()!);
    expect(reveal.isOpen()).toBe(true);
    move(RIGHT + 100);
    expect(reveal.isOpen()).toBe(false);
  });

  it("destroy removes the zone and every listener", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    reveal.attach();
    const z = zone()!;
    enter(z);
    reveal.destroy();
    expect(zone()).toBeNull();
    expect(moveCalls(remove)).toHaveLength(1);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(false);
    // Nothing reacts any more.
    enter(z);
    enter(strip);
    leaveDoc(0);
    expect(reveal.isOpen()).toBe(false);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(false);
  });

  it("destroy removes the very handlers attach registered, on the strip and the document", () => {
    // Assert the teardown itself: the `show()` guard would hide a missing
    // removal if we only checked what the controller does afterwards.
    const handlers = (spy: { mock: { calls: unknown[][] } }, type: string) =>
      spy.mock.calls.filter((c) => c[0] === type).map((c) => c[1]);
    const stripAdd = vi.spyOn(strip, "addEventListener");
    const stripRemove = vi.spyOn(strip, "removeEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");
    reveal.attach();
    const stripAdded = handlers(stripAdd, "mouseenter");
    const docAdded = handlers(docAdd, "mouseleave");
    expect(stripAdded).toHaveLength(1);
    expect(docAdded).toHaveLength(1);
    reveal.destroy();
    expect(handlers(stripRemove, "mouseenter")).toEqual(stripAdded);
    expect(handlers(docRemove, "mouseleave")).toEqual(docAdded);
  });

  it("attaching twice leaves one zone and one set of listeners", () => {
    const stripAdd = vi.spyOn(strip, "addEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    reveal.attach();
    reveal.attach();
    expect(pane.querySelectorAll(`.${CLS_STRIP_ZONE}`)).toHaveLength(1);
    expect(stripAdd.mock.calls.filter((c) => c[0] === "mouseenter")).toHaveLength(1);
    expect(docAdd.mock.calls.filter((c) => c[0] === "mouseleave")).toHaveLength(1);
  });

  it("reads both edges on every event, not once", () => {
    let lip = RIGHT;
    let settled = RIGHT;
    reveal.destroy();
    reveal = new StripReveal({ pane, strip, lipRight: () => lip, openRight: () => settled });
    reveal.attach();
    leaveDoc(100);
    expect(reveal.isOpen()).toBe(false);
    lip = 200; // a pane that has moved right, so the lip is further over
    leaveDoc(100);
    expect(reveal.isOpen()).toBe(true);
    settled = 200;
    move(150);
    expect(reveal.isOpen()).toBe(true);
    settled = 50; // and back
    move(150);
    expect(reveal.isOpen()).toBe(false);
  });

  it("does not close under a pointer inside the strip while the reveal animates", () => {
    // Measured in the running app: the painted right edge runs
    // 50, 57, 63, 69, 74, 78, 81, 82 over about 111ms while the strip slides
    // out. A pointer at x=70 is inside the settled bounds for every one of
    // those samples, and comparing it against the painted edge closed the
    // strip under the user for the first four.
    const painted = [50, 57, 63, 69, 74, 78, 81, 82];
    let frame = 0;
    const SETTLED = 82;
    reveal.destroy();
    reveal = new StripReveal({
      pane,
      strip,
      lipRight: () => painted[frame],
      openRight: () => SETTLED,
    });
    reveal.attach();
    enter(strip);
    expect(reveal.isOpen()).toBe(true);
    for (frame = 0; frame < painted.length; frame++) {
      move(70);
      expect(reveal.isOpen(), `painted edge at ${painted[frame]}`).toBe(true);
    }
    // The settled edge still closes it, which is the rule the README states.
    move(SETTLED + 1);
    expect(reveal.isOpen()).toBe(false);
  });

  it("opens when a drag enters the zone", () => {
    reveal.attach();
    dragEnter(zone()!);
    expect(reveal.isOpen()).toBe(true);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(true);
  });

  it("opens when a drag enters the strip", () => {
    reveal.attach();
    dragEnter(strip);
    expect(reveal.isOpen()).toBe(true);
  });

  it("destroy removes the dragenter handlers", () => {
    reveal.attach();
    const z = zone()!;
    reveal.destroy();
    dragEnter(z);
    dragEnter(strip);
    expect(reveal.isOpen()).toBe(false);
  });

  it("destroy is idempotent", () => {
    reveal.attach();
    reveal.destroy();
    expect(() => reveal.destroy()).not.toThrow();
  });
});
