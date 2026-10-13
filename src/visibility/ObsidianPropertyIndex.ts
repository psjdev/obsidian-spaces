import type { App } from "obsidian";
import { createPropertyIndex, type PropertySnapshot } from "./PropertyIndex";

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
 */
export function createObsidianPropertySnapshot(app: App, generation: number): PropertySnapshot {
  const entries: Array<{ path: string; frontmatter: Record<string, unknown> }> = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (cache === null) return { status: "unavailable" };
    const frontmatter = cache.frontmatter;
    if (frontmatter === undefined) continue;
    entries.push({ path: file.path, frontmatter });
  }
  return { status: "ready", index: createPropertyIndex(entries, generation) };
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
 * again. The walk stops at the first unparsed file, so a cold cache is cheap;
 * a PARTIALLY warm one is not, and it is the one this rule is for.
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
