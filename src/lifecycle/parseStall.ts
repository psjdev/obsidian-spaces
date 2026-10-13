/**
 * When to stop waiting for Obsidian to parse the rest of the vault.
 *
 * THE WHOLE RISK IS HERE. At cold start every file is unparsed, so a trigger
 * that fires on "files are unparsed" fires on every launch, and the repair
 * behind it would read the vault off disk every time the app opens. That is
 * far worse than the outage it exists to fix.
 *
 * ## What was measured, and what it ruled out
 *
 * The design's original trigger was "Obsidian says it is finished, and we are
 * not", via `metadataCache.on("resolved")`. Measured on 1.13.7 with a listener
 * registered from a plugin's own `onload`, on a jammed vault:
 *
 *     RESOLVED #1  +167 ms  layoutReady=false  inProgress=12
 *     RESOLVED #2  +570 ms  layoutReady=true   inProgress=11
 *
 * and then nothing for the remaining 10.8 minutes, with 14 of 18 files still
 * null. So `resolved` does NOT mean the queue drained — it fired twice
 * mid-index, with twelve and then eleven files outstanding. On a large healthy
 * vault the same event arrives at the same point, so that trigger would have
 * fired the repair on every ordinary cold start. It was ruled out by the
 * measurement, not by review.
 *
 * ## The trigger that replaced it
 *
 * ARM on the first `resolved` — it does not fire again once jammed, so waiting
 * for a second is waiting forever (two negative experiments: files written
 * while jammed produced no `resolved`, no `changed`, no `resolve`). THEN watch
 * `inProgressTaskCount` across a short interval and repair only if it has not
 * moved. Mid-index it falls; jammed it does not, in every reading.
 *
 * ## Two guards, because one is a judgement and the other is not
 *
 * This file is the judgement: it can be wrong about timing. The guard that
 * cannot be wrong is `PROPERTY_REPAIR_MAX_FILES` in `visibility/
 * propertyRepair.ts` — more than 200 unparsed files is not a jam and is never
 * read from disk, which makes a cold start of any real vault structurally
 * unreachable from here whatever this file decides.
 */

/**
 * 5 seconds between samples.
 *
 * Bounded below by what a healthy vault does between samples. The healthy
 * control run parsed 17 files in 27.4 s, and a single 8 MB file held
 * `inProgressTaskCount` at the same value for twenty seconds in the middle of
 * it — so no sampling interval short enough to be useful can prove the queue
 * is dead rather than busy. This interval does not try to.
 *
 * Bounded above by the outage it is sitting through: while this waits, a
 * property space shows the whole vault. Three samples at 5 s is a 15-second
 * worst case before the repair, against an outage that otherwise lasts as long
 * as the offending file is in the vault — measured across two restarts, so
 * vault-length and not session-length.
 *
 * What a mis-timed fire COSTS is the reason 5 s is affordable: at most 200
 * files are read, the result is byte-identical to what the cache would have
 * given (verified across 5,000 real files), and it simply arrives sooner. The
 * design's own third open question asks for exactly that: the 19-second window
 * during which a slow-but-not-stuck vault shows property spaces wide open is
 * worth closing too.
 */
export const PROPERTY_STALL_SAMPLE_MS = 5_000;

/**
 * Three samples that agree — two intervals with no progress — before calling
 * it stalled. Two samples would call a single slow file a jam far more often
 * for no useful gain in latency.
 */
export const PROPERTY_STALL_SAMPLES_AGREED = 3;

/**
 * 24 samples, two minutes, and then this stops sampling.
 *
 * Not a timeout on the repair: it is a timer that must not run for the life of
 * the session on a vault that simply has nothing to say. `arm()` restarts it,
 * and `main.ts` re-arms whenever something actually asks for properties and
 * gets an unavailable answer, so the give-up is never final for a user who is
 * waiting on it.
 */
export const PROPERTY_STALL_MAX_SAMPLES = 24;

export type StallVerdict =
  /** Obsidian has nothing queued. Stop watching; there is nothing wrong. */
  | "drained"
  /** It is still getting through them. Keep watching. */
  | "working"
  /** It has stopped. Repair. */
  | "stalled"
  /** Not enough readings yet, or this build cannot say. Keep watching. */
  | "unknown";

/**
 * The stall decision, as a pure function of the samples so far — most recent
 * last. Each sample is `inProgressTaskCount`, or null when the build does not
 * expose it.
 *
 * A null ANYWHERE in the window is "unknown", never "no progress". The
 * alternative — treating a missing reading as unchanged — turns a future
 * Obsidian that drops the field into a plugin that repairs on every launch,
 * which is the exact failure this whole file exists to prevent.
 */
export function stallVerdict(samples: readonly (number | null)[]): StallVerdict {
  const last = samples[samples.length - 1];
  if (last === undefined || last === null) return "unknown";
  if (last === 0) return "drained";
  const window = samples.slice(-PROPERTY_STALL_SAMPLES_AGREED);
  if (window.length < PROPERTY_STALL_SAMPLES_AGREED) return "working";
  if (window.some((s) => s === null)) return "unknown";
  return window.every((s) => s === last) ? "stalled" : "working";
}

/** The injected clock, the shape `eventCoalescer.ts` uses. */
export interface StallTimer {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

export interface ParseStallWatch {
  /**
   * Start sampling. A no-op while already sampling or once stalled; otherwise
   * it starts a fresh run, so a give-up is recoverable.
   */
  arm(): void;
  /** True once the samples have said Obsidian has stopped. Latched. */
  stalled(): boolean;
  /** Drop any pending sample so no timer outlives the plugin. */
  cancel(): void;
}

/**
 * The watcher. Sampling itself is FREE in the terms the work budget is written
 * in: it reads one scalar off `metadataCache` and makes no vault listing, no
 * tree walk and no `getFileCache` call. That is why it may run without asking
 * first whether anything is watching properties.
 */
export function createParseStallWatch(args: {
  timer: StallTimer;
  /** `inProgressTaskCount`, through the quarantine module, or null. */
  progress: () => number | null;
  /** Called once, when the verdict first turns "stalled". */
  onStalled: () => void;
  sampleMs?: number;
  maxSamples?: number;
}): ParseStallWatch {
  const sampleMs = args.sampleMs ?? PROPERTY_STALL_SAMPLE_MS;
  const maxSamples = args.maxSamples ?? PROPERTY_STALL_MAX_SAMPLES;

  let handle: number | null = null;
  let samples: Array<number | null> = [];
  let latched = false;
  let cancelled = false;

  const schedule = (): void => {
    if (cancelled || latched) return;
    handle = args.timer.set(tick, sampleMs);
  };

  const tick = (): void => {
    handle = null;
    if (cancelled || latched) return;
    samples.push(args.progress());
    const verdict = stallVerdict(samples);
    if (verdict === "drained") return; // healthy; stop until re-armed
    if (verdict === "stalled") {
      latched = true;
      args.onStalled();
      return;
    }
    if (samples.length >= maxSamples) return; // give up; `arm()` may restart
    schedule();
  };

  return {
    arm(): void {
      if (cancelled || latched || handle !== null) return;
      samples = [];
      schedule();
    },
    stalled: () => latched,
    cancel(): void {
      cancelled = true;
      if (handle !== null) args.timer.clear(handle);
      handle = null;
    },
  };
}
