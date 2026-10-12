import { describe, expect, it, vi } from "vitest";
import { PropertyRefreshHub } from "../src/visibility/PropertyRefreshHub";

/**
 * Stands in for the plugin class, which needs an Obsidian runtime. It owns the
 * REAL hub and mirrors what `main.ts` does with it: every event that replaces
 * the property snapshot notifies, and nothing else does. It deliberately holds
 * no spaces, so no space's membership can be what keeps a picker fresh.
 */
const fakePlugin = () => {
  const hub = new PropertyRefreshHub();
  return {
    subscribePropertyRefresh: (onChange: () => void) => hub.subscribe(onChange),
    emitMetadataChanged: () => hub.notify(),
    emitFileCreated: () => hub.notify(),
    emitFileDeleted: () => hub.notify(),
    emitFileRenamed: () => hub.notify(),
    emitResolved: () => hub.notify(),
    unload: () => hub.clear(),
  };
};

describe("an open picker is its own metadata consumer", () => {
  it("refreshes with no tag or property member anywhere in the vault", () => {
    const plugin = fakePlugin();
    const onChange = vi.fn();
    plugin.subscribePropertyRefresh(onChange);
    plugin.emitFileCreated(); // a note is added
    expect(onChange).toHaveBeenCalledTimes(1);
    plugin.emitMetadataChanged(); // and edited
    expect(onChange).toHaveBeenCalledTimes(2);
    plugin.emitFileDeleted(); // and deleted
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("refreshes on rename and on the readiness transition", () => {
    const plugin = fakePlugin();
    const onChange = vi.fn();
    plugin.subscribePropertyRefresh(onChange);
    plugin.emitFileRenamed();
    plugin.emitResolved();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("delivers nothing after the returned unsubscribe runs", () => {
    const plugin = fakePlugin();
    const onChange = vi.fn();
    const release = plugin.subscribePropertyRefresh(onChange);
    plugin.emitMetadataChanged();
    expect(onChange).toHaveBeenCalledTimes(1);
    release();
    plugin.emitMetadataChanged();
    plugin.emitFileCreated();
    plugin.emitFileDeleted();
    plugin.emitFileRenamed();
    plugin.emitResolved();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("releases only its own subscription, even for the same function", () => {
    const plugin = fakePlugin();
    const onChange = vi.fn();
    const first = plugin.subscribePropertyRefresh(onChange);
    plugin.subscribePropertyRefresh(onChange);
    first();
    plugin.emitMetadataChanged();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("is safe to release twice", () => {
    const plugin = fakePlugin();
    const onChange = vi.fn();
    const release = plugin.subscribePropertyRefresh(onChange);
    release();
    release();
    plugin.emitMetadataChanged();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("drops every subscription on unload", () => {
    const plugin = fakePlugin();
    const a = vi.fn();
    const b = vi.fn();
    plugin.subscribePropertyRefresh(a);
    plugin.subscribePropertyRefresh(b);
    plugin.unload();
    plugin.emitMetadataChanged();
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("does not call a watcher released mid-notify, and survives one that throws", () => {
    const plugin = fakePlugin();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const later = vi.fn();
    let releaseLater = () => {};
    plugin.subscribePropertyRefresh(() => {
      releaseLater();
      throw new Error("boom");
    });
    releaseLater = plugin.subscribePropertyRefresh(later);
    const survivor = vi.fn();
    plugin.subscribePropertyRefresh(survivor);
    plugin.emitMetadataChanged();
    expect(later).not.toHaveBeenCalled();
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
