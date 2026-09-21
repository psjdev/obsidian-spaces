// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyDock, clearDock } from "../src/ui/stripDock";

const pane = () => document.createElement("div");
const classes = (el: HTMLElement) => Array.from(el.classList).filter((c) => c.startsWith("spaces-dock-"));

describe("the pane's placement class", () => {
  it("adds nothing at all for bottom, which is the unstyled default", () => {
    const p = pane();
    applyDock(p, "bottom");
    expect(classes(p)).toEqual([]);
  });

  it("adds exactly one class for the others", () => {
    for (const [placement, expected] of [
      ["top", "spaces-dock-top"],
      ["left", "spaces-dock-left"],
      ["right", "spaces-dock-right"],
    ] as const) {
      const p = pane();
      applyDock(p, placement);
      expect(classes(p)).toEqual([expected]);
    }
  });

  it("never leaves two applied when switching", () => {
    const p = pane();
    applyDock(p, "left");
    applyDock(p, "top");
    applyDock(p, "right");
    expect(classes(p)).toEqual(["spaces-dock-right"]);
  });

  it("leaves the pane exactly as found when cleared", () => {
    const p = pane();
    p.className = "workspace-leaf-content";
    applyDock(p, "left");
    clearDock(p);
    expect(p.className).toBe("workspace-leaf-content");
  });

  it("tolerates a missing pane, because teardown can run after one is gone", () => {
    expect(() => clearDock(null)).not.toThrow();
  });
});
