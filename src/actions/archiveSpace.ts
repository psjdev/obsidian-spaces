import type { DefinitionStore } from "../definitions/DefinitionStore";
import { isArchived } from "../definitions/archived";

/**
 * Archiving is not deletion. The space keeps its place in `spaces`, its
 * members, its exclude list, its root and its entry in `orders.bySpaceId`
 * (the one thing `deleteSpace` drops), so a restored space comes back whole.
 * Nothing here touches `d.orders`.
 */
export async function archiveSpace(defs: DefinitionStore, id: string): Promise<void> {
  await defs.mutate((d) => {
    const s = d.spaces.find((x) => x.id === id);
    if (s && !isArchived(s)) s.archived = true;
  });
}

/**
 * Deletes the flag rather than setting it to `false`, so the restored space
 * carries no record of having been archived: no `archived: false` key for a
 * later reader, a diff or a schema change to interpret. What the rest of the
 * document looks like afterwards is `validateDefinitions`' business, the same
 * as it is for every other write.
 */
export async function restoreSpace(defs: DefinitionStore, id: string): Promise<void> {
  await defs.mutate((d) => {
    const s = d.spaces.find((x) => x.id === id);
    if (s && isArchived(s)) delete s.archived;
  });
}
