import type { App } from "obsidian";
import { createPropertyIndex, type PropertySnapshot } from "./PropertyIndex";

/**
 * The vault walk and the frontmatter read, and nothing else.
 *
 * Mirrors `createObsidianTagIndex`: a snapshot built when the caller builds it
 * rather than queried live. A READY snapshot is a consistent picture for as
 * long as it is held; while the cache is cold each ask rebuilds, so one
 * recompute may see more than one answer.
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
 * Calls `build` on the first ask, not before, and keeps a READY snapshot for
 * every ask after that. An unavailable result is NOT kept: a cold cache warms,
 * so the next ask builds again rather than reporting unavailable forever.
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
  let ready: PropertySnapshot | null = null;
  return () => {
    if (ready !== null) return ready;
    const snapshot = build();
    if (snapshot.status === "ready") ready = snapshot;
    return snapshot;
  };
}
