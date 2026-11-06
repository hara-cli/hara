import { simpleAnswerObjective } from "../agent/governance-c-lite.js";

/** An unchosen persisted setting stays automatic. Resolve only with a concrete Host objective;
 * capability caches must never freeze one request's automatic result into later conversations. */
export function defaultEffortForLevels(levels: readonly string[] | undefined, objective?: string): string | null {
  if (objective === undefined || !levels?.length) return null;
  const order = simpleAnswerObjective(objective) ? ["low", "minimal", "off"] : ["medium", "low", "minimal", "off"];
  return order.find(level => levels.includes(level)) ?? null;
}

/** "Follow the engine default": omit one-shot overrides; persistent Codex resolves its catalog
 * default explicitly. Distinct from null/"auto" (Hara chooses for the current request). */
export const ENGINE_DEFAULT_EFFORT = "engine-default";
/** A saved setting as it may reach a launch when the inventory is unavailable: only a fixed level passes. */
export function launchableSavedEffort(effort: string | null): string | null {
  return effort === "auto" || effort === ENGINE_DEFAULT_EFFORT ? null : effort;
}

/** Explicit settings retain their exact value. Unknown/unsupported capabilities receive no automatic
 * override; automatic selection never escalates to high/xhigh/max or invents a provider level. */
export function resolveReasoningEffort(configured: string | null | undefined, levels: readonly string[] | undefined,
  objective: string): string | null {
  return configured != null && configured !== "auto" ? configured : defaultEffortForLevels(levels, objective);
}
