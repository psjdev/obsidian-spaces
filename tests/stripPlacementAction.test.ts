import { describe, expect, it, vi } from "vitest";
import { setStripPlacement } from "../src/actions/stripPlacement";
import type { DefinitionStore } from "../src/definitions/DefinitionStore";

function store(initial = "bottom") {
  const state = { settings: { stripPlacement: initial } };
  return {
    calls: [] as string[],
    store: {
      get: () => state,
      mutate: async (fn: (d: typeof state) => void) => {
        fn(state);
      },
    } as unknown as DefinitionStore,
    read: () => state.settings.stripPlacement,
  };
}

describe("setStripPlacement", () => {
  it("writes the new placement", async () => {
    const s = store();
    await setStripPlacement(s.store, "left");
    expect(s.read()).toBe("left");
  });

  it("cancels an in-flight drag BEFORE writing, so nothing commits twice", async () => {
    const order: string[] = [];
    const state = { settings: { stripPlacement: "bottom" } };
    const store = {
      get: () => state,
      mutate: async (fn: (d: typeof state) => void) => {
        order.push("written");
        fn(state);
      },
    } as unknown as DefinitionStore;

    await setStripPlacement(store, "top", () => order.push("cancel"));

    expect(order).toEqual(["cancel", "written"]);
  });

  it("is a no-op when the placement is already that", async () => {
    const s = store("right");
    const mutate = vi.fn();
    const spy = { get: s.store.get, mutate } as unknown as DefinitionStore;
    await setStripPlacement(spy, "right");
    expect(mutate).not.toHaveBeenCalled();
  });
});
