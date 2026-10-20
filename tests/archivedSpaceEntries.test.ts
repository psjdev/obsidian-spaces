import { describe, expect, it } from "vitest";
import { spaceEntries } from "../src/ui/spaceEntries";

const known = new Set<string>(["leaf"]);
const sp = (id: string, archived?: boolean) => ({ id, name: id, icon: "leaf", ...(archived ? { archived } : {}) });

describe("spaceEntries omits archived spaces", () => {
  it("leaves an archived space out of the list the header dropdown reads", () => {
    const entries = spaceEntries([sp("a"), sp("b", true), sp("c")], { kind: "all" }, known);
    expect(entries.map((e) => e.label)).toEqual(["All", "a", "c"]);
  });

  it("marks nothing active when the selection names an archived space", () => {
    const entries = spaceEntries([sp("a"), sp("b", true)], { kind: "space", id: "b" }, known);
    expect(entries.some((e) => e.active)).toBe(false);
  });
});
