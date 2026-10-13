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
 * read from disk, which bounds what a mistaken verdict here can cost to 200
 * files. It bounds the LIST AT THE MOMENT OF THE ASK and not the vault, so it
 * is a blast radius and not a proof that a cold start can never be read; see
 * that file for what it does and does not guarantee.
 *
 * And because this judgement can be wrong, it is not permanent. Sampling
 * continues past a latch and a counter that moves or drains takes it back —
 * `stallCleared` below.
 */

/**
 * 5 seconds between samples.
 *
 * Bounded below by what a healthy vault does between samples. The healthy
 * control run parsed 17 files in 27.4 s, and `inProgressTaskCount` held at the
 * same value for twenty seconds in the middle of it — so no sampling interval
 * short enough to be useful can prove the queue is dead rather than busy. This
 * interval does not try to.
 *
 * The plateau belongs to the file the run was ON, not to the largest file in
 * the vault: `jam-questions-report.md`, question 2, session 3, puts the
 * 20-second gap BEFORE `09 huge-frontmatter.md` (437,811 B), with the 8 MB
 * `10 long-line.md` accounting for the following 6.4 s (+20,650 ms to
 * +27,073 ms). The plateau is the stronger fact, because it is what makes a
 * false latch reachable on a healthy vault at all — which is why the latch is
 * provisional. See `stallCleared`.
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

/**
 * Whether a latched verdict has been CONTRADICTED by the newest reading.
 *
 * A latch is a verdict about a moment, not about the session, and the project's
 * own control run shows a healthy vault can earn one: `jam-questions-report.md`
 * records `inProgressTaskCount` holding still for twenty seconds in a run that
 * completed in 27.4 s, which is longer than the two intervals this file latches
 * on. So a wrong verdict has to be able to cost ONE repair rather than the rest
 * of the session.
 *
 * Exactly two readings contradict "the counter has stopped": one that has
 * MOVED, and one that has reached zero. Everything else leaves the latch alone
 * — in particular a window too short to judge, so that re-arming (which clears
 * the samples) cannot un-latch by itself, and a null, so that a build which
 * stops exposing the counter cannot either.
 */
export function stallCleared(samples: readonly (number | null)[]): boolean {
  const last = samples[samples.length - 1];
  if (last === undefined || last === null) return false;
  if (last === 0) return true;
  const previous = samples[samples.length - 2];
  if (previous === undefined || previous === null) return false;
  return last !== previous;
}

/** The injected clock, the shape `eventCoalescer.ts` uses. */
export interface StallTimer {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

export interface ParseStallWatch {
  /**
   * Start sampling. A no-op while already sampling; otherwise it starts a
   * fresh run, so a give-up is recoverable. Re-arming never un-latches by
   * itself — see `stallCleared`.
   */
  arm(): void;
  /**
   * Whether the samples currently say Obsidian has stopped.
   *
   * Latched but NOT permanent: sampling continues past a latch, and a counter
   * that moves or reaches zero clears it. A wrong verdict therefore costs one
   * repair rather than the rest of the session.
   */
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
  /**
   * Called when the verdict TURNS "stalled" — on the transition, so a run that
   * stays stalled calls it once. A latch that is cleared and earned again
   * calls it again, which is the point: the second verdict is about a second
   * situation.
   */
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
    if (cancelled) return;
    handle = args.timer.set(tick, sampleMs);
  };

  const tick = (): void => {
    handle = null;
    if (cancelled) return;
    samples.push(args.progress());
    // SAMPLING CONTINUES PAST A LATCH, which is what keeps the verdict
    // provisional. A healthy vault can earn a latch — a 20-second plateau in a
    // 27.4-second run, in the project's own control measurement — and before
    // this, nothing ever took it back for the rest of the session.
    if (latched && stallCleared(samples)) latched = false;
    const verdict = stallVerdict(samples);
    if (verdict === "drained") return; // healthy; stop until re-armed
    if (verdict === "stalled" && !latched) {
      latched = true;
      args.onStalled();
    }
    if (samples.length >= maxSamples) return; // give up; `arm()` may restart
    schedule();
  };

  return {
    arm(): void {
      if (cancelled || handle !== null) return;
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
