const ORDER = ["off", "minimal", "low", "medium"] as const;

/** Pick medium, or the nearest declared lower level. Never invent an unsupported level. */
export function defaultEffortForLevels(levels: readonly string[] | undefined): string | null {
  if (!levels?.length) return null;
  for (let index = ORDER.length - 1; index >= 0; index--) {
    if (levels.includes(ORDER[index])) return ORDER[index];
  }
  return null;
}
