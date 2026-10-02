import type { MemberKind } from "../types";

/**
 * The engine's only view of the vault. Deliberately narrow so the engine
 * stays pure and testable without an Obsidian runtime.
 */
export interface VaultIndex {
  exists(path: string): boolean;
  kindOf(path: string): MemberKind | null;
  /** Immediate children, folders and files. */
  childrenOf(path: string): string[];
  /** Every descendant at any depth. */
  descendantsOf(path: string): string[];
  allPaths(): string[];
}

/** Ancestors of "a/b/c.md" -> ["a", "a/b"]. Never includes the path itself. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** True when `child` is strictly under `parent`, on a segment boundary. */
export function isUnder(child: string, parent: string): boolean {
  if (parent === "") return child.length > 0;
  return child.startsWith(parent + "/");
}

/**
 * A `VaultIndex` backed by a parent -> children map instead of a linear scan
 * over every path in the vault. The scan made `childrenOf` and
 * `descendantsOf` O(V), so a snapshot cost O(V x folders-in-scope): 3.2 s for
 * five top-level folder members on a 30 k-path vault.
 *
 * Pure on purpose. It lives beside the interface rather than inside
 * `ObsidianVaultIndex` so it stays testable in plain node — importing
 * `"obsidian"` throws in Vitest, and an untested index is how the ordering
 * regression this replaces would have shipped unnoticed. `ObsidianVaultIndex`
 * keeps the only part that needs the Obsidian runtime: the walk.
 *
 * `kinds` is taken by reference and retained; the caller must not mutate it
 * afterwards. Entries must arrive in tree pre-order (which `walk()` produces),
 * because that order is what `childrenOf`/`descendantsOf` reproduce.
 *
 * Only children are stored. Descendants are a walk of that map, so a 30 k-path
 * vault carries one array of siblings per folder and no second map.
 */
export function createTreeVaultIndex(
  kinds: Map<string, MemberKind>
): VaultIndex {
  const children = new Map<string, string[]>();

  const push = (parent: string, path: string): void => {
    const bucket = children.get(parent);
    if (bucket === undefined) children.set(parent, [path]);
    else bucket.push(path);
  };

  // An entry whose parent folder is absent is still reachable by the linear
  // scan, so the missing ancestors are synthesised to keep the subtree
  // connected. They are linked but never emitted, which is what the scan did.
  // walk() never produces this, so the flag stays false and the extra work
  // stays off the hot path.
  let synthetic = false;
  const synthesised = new Set<string>();
  const synthesise = (path: string): void => {
    for (let p = path; p !== "" && !synthesised.has(p); ) {
      synthesised.add(p);
      const cut = p.lastIndexOf("/");
      const parent = cut === -1 ? "" : p.slice(0, cut);
      push(parent, p);
      p = kinds.has(parent) ? "" : parent;
    }
  };

  for (const path of kinds.keys()) {
    const cut = path.lastIndexOf("/");
    if (cut === -1) {
      push("", path);
      continue;
    }
    const parent = path.slice(0, cut);
    if (!kinds.has(parent)) {
      synthetic = true;
      synthesise(parent);
    }
    push(parent, path);
  }

  return {
    exists: (p) => kinds.has(p),
    kindOf: (p) => kinds.get(p) ?? null,
    childrenOf: (p) => {
      const bucket = children.get(p);
      if (bucket === undefined) return [];
      // A fresh array every call: the linear scan returned one, and callers
      // are free to sort or splice what they get back.
      return synthetic ? bucket.filter((c) => kinds.has(c)) : bucket.slice();
    },
    descendantsOf: (p) => {
      const bucket = children.get(p);
      if (bucket === undefined) return [];
      // Depth-first, pre-order, siblings in vault order — the order the scan
      // produced, which the explorer render and section 22.5 ordering rely on.
      const out: string[] = [];
      const stack: string[] = [];
      for (let i = bucket.length - 1; i >= 0; i--) stack.push(bucket[i]);
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        if (kinds.has(cur)) out.push(cur);
        const kids = children.get(cur);
        if (kids !== undefined) {
          for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        }
      }
      return out;
    },
    allPaths: () => [...kinds.keys()],
  };
}

/**
 * A `VaultIndex` that does not exist until something asks it a question.
 *
 * The counterpart to `createLazyTagIndex`, and for the same reason.
 * `createObsidianVaultIndex` walks the whole vault tree — 6.6 ms on a 10,000
 * note vault — and it was built eagerly in the `SpaceController` constructor,
 * inside the load Obsidian awaits. But `SpaceController.recompute` returns
 * before it touches the vault index at all when *All* is active, which is the
 * majority case and the only case for a user who has never made a space. The
 * walk was provably unused and still paid for, on the one path where cost is
 * most visible to the user.
 *
 * Built at most ONCE per wrapper, so one recompute sees one consistent
 * picture, exactly as an eagerly built snapshot does. A caller wanting a
 * fresh picture makes a fresh wrapper, which is what the coalescer's flush
 * does.
 *
 * It preserves the ordering invariant `TagIndex.ts` documents rather than
 * weakening it: the flush installs the vault index before the tag index, and
 * a wrapper can only ever build at or AFTER the moment it was installed, so a
 * recompute still cannot read a fresh vault against a tag index taken before
 * it.
 */
export function createLazyVaultIndex(build: () => VaultIndex): VaultIndex {
  let built: VaultIndex | null = null;
  const index = (): VaultIndex => (built ??= build());
  return {
    exists: (p) => index().exists(p),
    kindOf: (p) => index().kindOf(p),
    childrenOf: (p) => index().childrenOf(p),
    descendantsOf: (p) => index().descendantsOf(p),
    allPaths: () => index().allPaths(),
  };
}
