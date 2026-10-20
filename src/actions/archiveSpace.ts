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
 * Deletes the flag rather than setting it to `false`, so a restored space is
 * byte-identical to one that was never archived.
 */
export async function restoreSpace(defs: DefinitionStore, id: string): Promise<void> {
  await defs.mutate((d) => {
    const s = d.spaces.find((x) => x.id === id);
    if (s && isArchived(s)) delete s.archived;
  });
}
