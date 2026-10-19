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
  stallCleared,
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

  it("needs a full window of agreeing readings before it will say stalled", () => {
    // The cold-start guard, in its cheapest form. `resolved` fires mid-index
    // with files still queued — measured at +167 ms with twelve outstanding —
    // so anything short of the whole window says nothing at all.
    //
    // Built FROM the constant rather than from a literal: the threshold moved
    // from 3 to 7 in 0.12.0 and a hard-coded window would have gone on
    // asserting the old rule under a new name.
    const agreed = PROPERTY_STALL_SAMPLES_AGREED;
    for (let n = 1; n < agreed; n++) {
      expect(stallVerdict(Array(n).fill(11))).toBe("working");
    }
    expect(stallVerdict(Array(agreed).fill(11))).toBe("stalled");
  });

  it("waits at least thirty seconds of a motionless counter", () => {
    // The threshold is not arbitrary and it is not free to lower. The healthy
    // control run held `inProgressTaskCount` at one value for twenty seconds
    // in a run that finished fine, and a latch now costs a notice telling
    // somebody to take a note out of their vault. Anything at or under that
    // plateau accuses a healthy vault.
    const window = (PROPERTY_STALL_SAMPLES_AGREED - 1) * PROPERTY_STALL_SAMPLE_MS;
    expect(window).toBeGreaterThanOrEqual(30_000);
  });

  it("is stalled on the LAST window, not on the whole history", () => {
    // A vault that made progress and then stopped is still a stall.
    const tail = Array(PROPERTY_STALL_SAMPLES_AGREED).fill(14);
    expect(stallVerdict([30, 20, ...tail])).toBe("stalled");
  });

  it("is unknown, never stalled, when a reading is missing", () => {
    // A future Obsidian without `inProgressTaskCount` reads null. Treating
    // that as "unchanged" would repair on every launch, which is the exact
    // failure this file exists to prevent.
    expect(stallVerdict([null])).toBe("unknown");
    expect(stallVerdict([...Array(PROPERTY_STALL_SAMPLES_AGREED - 1).fill(11), null])).toBe(
      "unknown"
    );
    expect(stallVerdict(Array(PROPERTY_STALL_SAMPLES_AGREED).fill(null))).toBe("unknown");
    expect(stallVerdict([])).toBe("unknown");
  });

  it("is unknown when the LAST reading is missing even if earlier ones agreed", () => {
    expect(stallVerdict([11, 11, 11, null])).toBe("unknown");
  });
});

describe("stallCleared", () => {
  it("is true when the counter has FALLEN", () => {
    expect(stallCleared([11, 11, 11, 10])).toBe(true);
  });

  it("is FALSE when the counter has RISEN, because that is the jam growing", () => {
    // The bug this pins shut: on a jammed vault the queue only ever grows,
    // since every note the user saves lands behind the note that is stuck. A
    // rule of "any change clears it" read each of those saves as recovery,
    // un-latched, re-latched, and told the user to cut up their note again —
    // about seven times in a two-minute run.
    expect(stallCleared([11, 12])).toBe(false);
    expect(stallCleared([11, 11, 11, 12])).toBe(false);
    expect(stallCleared([11, 11, 11, 12, 13])).toBe(false);
  });

  it("is true when the counter has reached zero", () => {
    expect(stallCleared([11, 11, 11, 0])).toBe(true);
    expect(stallCleared([0])).toBe(true);
  });

  it("is FALSE while the counter is unchanged", () => {
    expect(stallCleared([11, 11])).toBe(false);
    expect(stallCleared([11, 11, 11])).toBe(false);
  });

  it("is FALSE on a window too short to say, so re-arming cannot un-latch", () => {
    expect(stallCleared([])).toBe(false);
    expect(stallCleared([11])).toBe(false);
  });

  it("is FALSE when either reading is missing", () => {
    // Symmetric with `stallVerdict`: a build that stops exposing the counter
    // must not be able to decide anything by itself.
    expect(stallCleared([11, null])).toBe(false);
    expect(stallCleared([null, 11])).toBe(false);
    expect(stallCleared([null, null])).toBe(false);
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

  it("latches stalled after a full window of agreeing samples, and calls back once", () => {
    const { clock, onStalled, watch } = watcher(() => 11);
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * (PROPERTY_STALL_SAMPLES_AGREED - 1));
    expect(watch.stalled()).toBe(false);
    expect(onStalled).not.toHaveBeenCalled();
    clock.advance(PROPERTY_STALL_SAMPLE_MS);
    expect(watch.stalled()).toBe(true);
    expect(onStalled).toHaveBeenCalledTimes(1);
    // The callback is on the TRANSITION, so a counter that goes on agreeing
    // does not call it again, even though sampling continues.
    clock.advance(PROPERTY_STALL_SAMPLE_MS * 10);
    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(watch.stalled()).toBe(true);
  });

  it("keeps sampling after a latch, and lets the counter take it back", () => {
    // The latch used to be permanent, and the project's own control run shows a
    // HEALTHY vault can earn one: `inProgressTaskCount` held still for twenty
    // seconds in a run that finished in 27.4 s. A wrong verdict has to cost one
    // repair, not the session.
    let count = 11;
    const { clock, onStalled, watch } = watcher(() => count);
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * PROPERTY_STALL_SAMPLES_AGREED);
    expect(watch.stalled()).toBe(true);
    expect(onStalled).toHaveBeenCalledTimes(1);

    // Obsidian was busy, not dead.
    count = 10;
    clock.advance(PROPERTY_STALL_SAMPLE_MS);
    expect(watch.stalled()).toBe(false);
  });

  it("un-latches when the queue drains, and stops", () => {
    let count = 4;
    const { clock, watch } = watcher(() => count);
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * PROPERTY_STALL_SAMPLES_AGREED);
    expect(watch.stalled()).toBe(true);
    count = 0;
    clock.advance(PROPERTY_STALL_SAMPLE_MS);
    expect(watch.stalled()).toBe(false);
    expect(clock.pending()).toBe(0); // healthy; nothing left to watch
  });

  it("earns a SECOND verdict, and a second callback, after one is taken back", () => {
    // One repair per verdict, not one per session. `main.ts` hangs the
    // clearing of its own "we tried these and got nowhere" memory off exactly
    // this second callback.
    let count = 11;
    const { clock, onStalled, watch } = watcher(() => count);
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * PROPERTY_STALL_SAMPLES_AGREED);
    expect(onStalled).toHaveBeenCalledTimes(1);
    count = 9;
    clock.advance(PROPERTY_STALL_SAMPLE_MS);
    expect(watch.stalled()).toBe(false);
    clock.advance(PROPERTY_STALL_SAMPLE_MS * PROPERTY_STALL_SAMPLES_AGREED);
    expect(watch.stalled()).toBe(true);
    expect(onStalled).toHaveBeenCalledTimes(2);
  });

  it("re-arming after the cap does NOT un-latch, because an empty window is not evidence", () => {
    // `arm()` clears the samples, and `main.ts` calls it on every ask that
    // finds unparsed files. Past the sample cap sampling has stopped, so that
    // arm really does start a fresh window — and if a short window counted as
    // the counter having moved, the first sample of it would take back the
    // verdict that is about to serve the very user who asked.
    const { clock, watch } = watcher(() => 11);
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * (PROPERTY_STALL_MAX_SAMPLES + 2));
    expect(watch.stalled()).toBe(true);
    expect(clock.pending()).toBe(0);

    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS);
    expect(watch.stalled()).toBe(true);
    clock.advance(PROPERTY_STALL_SAMPLE_MS);
    expect(watch.stalled()).toBe(true);
  });

  it("a build that stops reporting progress does not un-latch it either", () => {
    let count: number | null = 11;
    const { clock, watch } = watcher(() => count);
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * PROPERTY_STALL_SAMPLES_AGREED);
    expect(watch.stalled()).toBe(true);
    count = null;
    clock.advance(PROPERTY_STALL_SAMPLE_MS * 3);
    expect(watch.stalled()).toBe(true);
  });

  it("still gives up at the sample cap while latched, so no timer runs all session", () => {
    const { clock, watch } = watcher(() => 11);
    watch.arm();
    clock.advance(PROPERTY_STALL_SAMPLE_MS * (PROPERTY_STALL_MAX_SAMPLES + 5));
    expect(clock.pending()).toBe(0);
    expect(watch.stalled()).toBe(true); // the verdict survives; only the timer stops
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
