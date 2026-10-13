import type { App } from "obsidian";
import { createPropertyIndex, type PropertySnapshot } from "./PropertyIndex";

/** One file's frontmatter, as the index wants it. */
export interface PropertyEntry {
  readonly path: string;
  readonly frontmatter: Record<string, unknown>;
}

/**
 * What ONE walk of the metadata cache saw: the files it could read, and the
 * files Obsidian has not parsed.
 *
 * Exposed as a value rather than folded straight into a snapshot because the
 * repair needs both halves. Re-deriving the entries after the async read would
 * mean walking twice and merging two different pictures of the vault; handing
 * the walk over means the repaired snapshot is THE SAME WALK with its holes
 * filled in.
 */
export interface PropertyWalk {
  readonly entries: readonly PropertyEntry[];
  /** Paths whose `getFileCache` answered `null`, in vault listing order. */
  readonly unparsed: readonly string[];
}

/**
 * The vault walk and the frontmatter read, and nothing else.
 *
 * Mirrors `createObsidianTagIndex`: a snapshot built when the caller builds it
 * rather than queried live. A snapshot is a consistent picture for as long as
 * it is held, unavailable ones included: `createLazyPropertySnapshot` keeps
 * whatever this answered until the accessor itself is replaced.
 *
 * READINESS IS A PROPERTY OF THE WALK. A file whose cache has not been parsed
 * yet reports `null`, and one such file makes the whole snapshot unavailable:
 * a partially populated cache must not be served as a complete answer, or a
 * count labelled complete is a lie and a space resolves to fewer notes than it
 * holds. A file whose cache exists but has no frontmatter is not unavailable;
 * it contributes nothing.
 *
 * THE WALK NO LONGER ABANDONS AT THE FIRST NULL, and that is a deliberate
 * trade. Abandoning made a cold start cheap and left us unable to say WHICH
 * files were missing, so a vault holding a file Obsidian cannot parse — a
 * markdown file somewhat over 32 MB jams the parse queue for the life of the
 * vault, not merely the session — turned property members off permanently,
 * with nothing to name and nothing to repair from. Running to the end buys the
 * path list the repair is driven by, and costs the COLD path N listings and N
 * cache reads where it used to pay one of each.
 *
 * MEASURED, not assumed, because this is the path the performance budgets
 * protect. In a running Obsidian 1.13.7 on the 5,000-note property fixture,
 * both shapes transcribed and run through the same `getFileCache` wrapper,
 * minima over 60 repetitions (`e2e/wave6-cold-walk.mjs` beside the design
 * notes):
 *
 *   cold (every file null)   0.4 ms before   0.5 ms after
 *   warm (every file parsed) 3.2 ms before   3.4 ms after
 *
 * One tick of that clock's 0.1 ms resolution, in both directions. The reason
 * the cold case was never as cheap as "abandon at file 1" suggests is that
 * `getMarkdownFiles()` itself is 0.4 ms of it: the listing dominates, and the
 * early return was saving 4,999 property reads out of a call that had already
 * walked the tree. The whole snapshot build, listing and
 * `createPropertyIndex` together, is 9.6 ms warm.
 */
export function walkPropertyCache(app: App): PropertyWalk {
  const entries: PropertyEntry[] = [];
  const unparsed: string[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (cache === null) {
      unparsed.push(file.path);
      continue;
    }
    const frontmatter = cache.frontmatter;
    if (frontmatter === undefined) continue;
    entries.push({ path: file.path, frontmatter });
  }
  return { entries, unparsed };
}

/**
 * A walk as a snapshot. Any unparsed file at all is still `unavailable`, which
 * is the rule the docblock above states and the one the repair does NOT relax:
 * the repair produces a different walk, with fewer holes, and runs it through
 * here again. A repair that could not read every hole therefore stays
 * unavailable, and says which files it could not read.
 */
export function snapshotFromWalk(walk: PropertyWalk, generation: number): PropertySnapshot {
  if (walk.unparsed.length > 0) return { status: "unavailable", unparsed: walk.unparsed };
  return { status: "ready", index: createPropertyIndex(walk.entries, generation) };
}

export function createObsidianPropertySnapshot(app: App, generation: number): PropertySnapshot {
  return snapshotFromWalk(walkPropertyCache(app), generation);
}

/**
 * Calls `build` on the first ask, not before, and answers every later ask
 * from that one result — READY OR UNAVAILABLE ALIKE.
 *
 * AN UNAVAILABLE ANSWER IS KEPT FOR THE LIFE OF THIS ACCESSOR, AND NO LONGER.
 * The accessor is not the session: `main.ts` installs a new one on every
 * metadata event and on a full flush, so an unavailable answer survives
 * exactly one burst and the next event retries a warming cache. That is the
 * narrow rule both failures need. Rebuilding on every ask instead meant that
 * while ANY note was unparsed, a burst that asks twice — once to notify the
 * pickers, once to recompute the space, which is what `runFlush` does in that
 * order — paid two near-full walks that both returned nothing, breaking "one
 * metadata event costs at most one vault walk". Keeping it across accessors
 * instead would report unavailable forever, since nothing else would ever ask
 * again. The memo matters MORE now than it did: the walk no longer stops at
 * the first unparsed file, so the cold case costs a full walk too, and only
 * this keeps that at one per accessor rather than one per ask.
 *
 * Returns a FUNCTION, not an object pretending to be a snapshot. A proxy with
 * getters cannot honestly satisfy a discriminated union: it would carry an
 * `index` property in both states, so `"index" in snapshot` answers true while
 * unavailable and the readiness check the type exists to force becomes
 * decorative.
 */
export function createLazyPropertySnapshot(
  build: () => PropertySnapshot
): () => PropertySnapshot {
  let answered: PropertySnapshot | null = null;
  return () => {
    if (answered === null) answered = build();
    return answered;
  };
}
