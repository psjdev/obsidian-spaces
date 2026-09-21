import { describe, expect, it } from "vitest";
import { axisFor, pointerAlong, spanOf } from "../src/ui/stripAxis";

describe("axis projection", () => {
  it("runs along x when the strip is horizontal", () => {
    expect(axisFor("bottom")).toBe("x");
    expect(axisFor("top")).toBe("x");
  });

  it("runs along y when the strip is a ribbon", () => {
    expect(axisFor("left")).toBe("y");
    expect(axisFor("right")).toBe("y");
  });

  it("projects a rect onto the axis", () => {
    const rect = { left: 10, top: 20, width: 100, height: 200 };
    expect(spanOf(rect, "x")).toEqual({ start: 10, size: 100 });
    expect(spanOf(rect, "y")).toEqual({ start: 20, size: 200 });
  });

  it("projects a pointer onto the axis", () => {
    expect(pointerAlong({ clientX: 5, clientY: 9 }, "x")).toBe(5);
    expect(pointerAlong({ clientX: 5, clientY: 9 }, "y")).toBe(9);
  });
});
