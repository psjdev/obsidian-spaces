import type { SpaceDefinition } from "../types";

/**
 * The one place that answers "is this space archived". Pure, with no import
 * from "obsidian", so every layer can ask it. Absent means active.
 */
export function isArchived(space: { archived?: boolean }): boolean {
  return space.archived === true;
}

/** The spaces still in use, in their original order. */
export function activeSpaces<T extends { archived?: boolean }>(spaces: readonly T[]): T[] {
  return spaces.filter((s) => !isArchived(s));
}

/** The archived spaces, in their original order. */
export function archivedSpaces(spaces: readonly SpaceDefinition[]): SpaceDefinition[] {
  return spaces.filter(isArchived);
}
