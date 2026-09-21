import type { DefinitionStore } from "../definitions/DefinitionStore";
import type { StripPlacement } from "../types";

/**
 * The only way placement changes.
 *
 * Settings, the four commands and a completed drag all come through here, so
 * they cannot drift apart. `onCancelDrag` runs FIRST and is deliberately not
 * the lock: cancelling an interaction and persisting a preference are separate
 * concerns, and locking must never write a placement.
 */
export async function setStripPlacement(
  defs: DefinitionStore,
  next: StripPlacement,
  onCancelDrag?: () => void
): Promise<void> {
  onCancelDrag?.();
  if (defs.get().settings.stripPlacement === next) return;
  await defs.mutate((d) => {
    d.settings.stripPlacement = next;
  });
}
