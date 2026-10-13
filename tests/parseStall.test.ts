/**
 * The trigger. The one piece of this feature that can do real harm if it is
 * wrong, because at cold start EVERY file is unparsed and a repair that fired
 * then would read the whole vault off disk on every launch.
 *
 * Both halves are tested from the outside: the verdict as a pure function of
 * the readings, and the watcher against a manual clock.
 *
 * Layer 1 — no Obsidian, no real timers.
 */
import { describe, expect, it, vi } from "vitest";
import {
  PROPERTY_STALL_MAX_SAMPLES,
  PROPERTY_STALL_SAMPLE_MS,
  PROPERTY_STALL_SAMPLES_AGREED,
  createParseStallWatch,
  stallVerdict,
} from "../src/lifecycle/parseStall";
import { nativeParseProgress } from "../src/visibility/nativeParseProgress";

const manualTimer = () => {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timer: {
      set: (fn: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (id: number) => void pending.delete(id),
    },
    pending: () => pending.size,
    /**
     * Steps time forward, firing each due timer AT its own moment — so a
     * callback that schedules the next sample gets to run again inside one
     * `advance`. A clock that jumped straight to the target and swept once
     * would deliver one sample per call, and every "three samples" assertion
     * below would be asserting the opposite of what it says.
     */
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Infinity;
        for (const [id, t] of pending) {
          if (t.at <= target && t.at < dueAt) {
            dueAt = t.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const due = pending.get(dueId);
        if (due === undefined) break;
        now = dueAt;
        pending.delete(dueId);
        due.fn();
      }
      now = target;
    },
  };
};

describe("stallVerdict", () => {
  it("is drained the moment the queue reaches zero", () => {
    expect(stallVerdict([12, 8, 0])).toBe("drained");
    expect(stallVerdict([0])).toBe("drained");
  });

  it("is working while the count is still falling", () => {
    expect(stallVerdict([12, 11, 10])).toBe("working");
    expect(stallVerdict([12, 12, 11])).toBe("working");
  });

  it("needs three readings before it will call anything stalled", () => {
    // The cold-start guard, in its cheapest form. `resolved` fires mid-index
    // with files still queued — measured at +167 ms with twelve outstanding —
    // so one reading, or two, says nothing at all.
    expect(stallVerdict([11])).toBe("working");
    expect(stallVerdict([11, 11])).toBe("working");
    expect(stallVerdict([11, 11, 11])).toBe("stalled");
    expect(PROPERTY_STALL_SAMPLES_AGREED).toBe(3);
  });

  it("is stalled on the LAST three, not on the whole history", () => {
    // A vault that made progress and then stopped is still a stall.
    expect(stallVerdict([30, 20, 14, 14, 14])).toBe("stalled");
  });

  it("is unknown, never stalled, when a reading is missing", () => {
    // A future Obsidian without `inProgressTaskCount` reads null. Treating
    // that as "unchanged" would repair on every launch, which is the exact
    // failure this file exists to prevent.
    expect(stallVerdict([null])).toBe("unknown");
    expect(stallVerdict([11, null, 11])).toBe("unknown");
    expect(stallVerdict([null, null, null])).toBe("unknown");
    expect(stallVerdict([])).toBe("unknown");
  });

  it("is unknown when the LAST reading is missing even if earlier ones agreed", () => {
    expect(stallVerdict([11, 11, 11, null])).toBe("unknown");
  });
});

describe("the watcher", () => {
  const watcher = (progress: () => number | null) => {
    const clock = manualTimer();
    const onStalled = vi.fn();
    const watch = createParseStallWatch({ timer: clock.timer, progress, onStalled });
    return { clock, onStalled, watch };
  };

  it("samples nothing until it is armed", () => {
    const progress = vi.fn(() => 5);
    const { clock, watch } = watcher(progress);
    clock.advance(PROPERTY_STALL_SAMPLE_MS * 10);
    expect(progress).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
    watch.arm();
    expect(clock.pending()).toBe(1);
  });

  it("latches stalled after three agreeing samples, and calls back once", () => {
    const { clock, onStalled, watch } = watcher(() => 11);
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * 2);
    expect(watch.stalled()).toBe(false);
    expect(onStalled).not.toHaveBeenCalled();
    clock.advance(PROPERTY_STALL_SAMPLE_MS);
    expect(watch.stalled()).toBe(true);
    expect(onStalled).toHaveBeenCalledTimes(1);
    // And it stops: no timer is left running, and no second callback.
    clock.advance(PROPERTY_STALL_SAMPLE_MS * 20);
    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
  });

  it("never latches on a vault that is merely cold and still working", () => {
    // 5,000 files draining a hundred at a time: the shape of every ordinary
    // cold start. Nothing here may ever reach `onStalled`.
    let left = 5_000;
    const { clock, onStalled, watch } = watcher(() => (left = Math.max(0, left - 100)));
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * PROPERTY_STALL_MAX_SAMPLES * 2);
    expect(onStalled).not.toHaveBeenCalled();
    expect(watch.stalled()).toBe(false);
  });

  it("stops sampling once the queue drains", () => {
    const progress = vi.fn(() => 0);
    const { clock, onStalled, watch } = watcher(progress);
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * 10);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(onStalled).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it("never latches when the build cannot report progress", () => {
    const { clock, onStalled, watch } = watcher(() => null);
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * PROPERTY_STALL_MAX_SAMPLES * 2);
    expect(onStalled).not.toHaveBeenCalled();
  });

  it("gives up after the sample cap rather than running all session", () => {
    let n = 1000;
    const { clock, watch } = watcher(() => (n += 1)); // never agrees, never drains
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * (PROPERTY_STALL_MAX_SAMPLES + 5));
    expect(clock.pending()).toBe(0);
  });

  it("can be re-armed after giving up, which is how a late consumer is served", () => {
    let n = 1000;
    const progress = vi.fn(() => (n += 1));
    const { clock, onStalled, watch } = watcher(progress);
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * (PROPERTY_STALL_MAX_SAMPLES + 5));
    const after = progress.mock.calls.length;
    // Now the vault jams.
    progress.mockImplementation(() => 7);
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * PROPERTY_STALL_SAMPLES_AGREED);
    expect(progress.mock.calls.length).toBeGreaterThan(after);
    expect(onStalled).toHaveBeenCalledTimes(1);
  });

  it("arming twice does not double the sampling", () => {
    const progress = vi.fn(() => 5);
    const { clock, watch } = watcher(progress);
    watch.arm();
    watch.arm();
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS);
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it("cancel leaves no timer and no later callback", () => {
    const { clock, onStalled, watch } = watcher(() => 11);
    watch.arm();
    watch.cancel();
    expect(clock.pending()).toBe(0);
    clock.advance(PROPERTY_STALL_SAMPLE_MS * 10);
    expect(onStalled).not.toHaveBeenCalled();
    // And it stays cancelled: teardown is not undone by a late `arm`.
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * 10);
    expect(onStalled).not.toHaveBeenCalled();
  });
});

describe("nativeParseProgress", () => {
  const app = (metadataCache: unknown) => ({ metadataCache });

  it("reads the count when the build has one", () => {
    expect(nativeParseProgress(app({ inProgressTaskCount: 11 }))).toBe(11);
    expect(nativeParseProgress(app({ inProgressTaskCount: 0 }))).toBe(0);
  });

  it("is null for every shape it does not recognise", () => {
    // Fail-open: null is "this build cannot say", and `stallVerdict` turns
    // that into "unknown", which repairs nothing.
    expect(nativeParseProgress(app({}))).toBeNull();
    expect(nativeParseProgress(app({ inProgressTaskCount: "11" }))).toBeNull();
    expect(nativeParseProgress(app({ inProgressTaskCount: NaN }))).toBeNull();
    expect(nativeParseProgress(app({ inProgressTaskCount: -1 }))).toBeNull();
    expect(nativeParseProgress(app(null))).toBeNull();
    expect(nativeParseProgress(app(undefined))).toBeNull();
    expect(nativeParseProgress(null)).toBeNull();
    expect(nativeParseProgress(undefined)).toBeNull();
    expect(nativeParseProgress("app")).toBeNull();
  });

  it("absorbs a getter that throws", () => {
    const cache = {};
    Object.defineProperty(cache, "inProgressTaskCount", {
      get() {
        throw new Error("gone");
      },
    });
    expect(nativeParseProgress(app(cache))).toBeNull();
  });

  it("is the only name for the private field in src/", async () => {
    // The quarantine contract, asserted rather than asked for in a comment.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".ts")) files.push(full);
      }
    };
    walk("src");
    // Comments are stripped first, the way `noNetwork.test.ts` does it:
    // DISCUSSING the private field is how the quarantine explains itself, and
    // a check that forbade the discussion would push the explanation out of
    // the code to satisfy itself.
    const code = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const offenders = files
      .map((f) => f.replace(/\\/g, "/"))
      .filter(
        (f) =>
          f !== "src/visibility/nativeParseProgress.ts" &&
          code(readFileSync(f, "utf8")).includes("inProgressTaskCount")
      );
    expect(offenders).toEqual([]);
    // And the quarantine module really does name it, so this cannot pass by
    // the grep having gone blind.
    expect(readFileSync("src/visibility/nativeParseProgress.ts", "utf8")).toContain(
      "inProgressTaskCount"
    );
  });
});
