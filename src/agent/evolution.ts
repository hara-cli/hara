import type { HaraConfig } from "../config.js";

const EVOLUTION_READ_TOOLS = new Set([
  "memory_search",
  "memory_get",
  "read_file",
  "grep",
  "glob",
  "ls",
  "codebase_search",
]);

/** Self-evolution is an auditable memory/skill curation pass, never autonomous product mutation. */
export const EVOLUTION_SYSTEM =
  "Review this session for durable, reusable learning. This is an AUDITABLE CURATION pass, not permission to rewrite yourself. " +
  "Use memory_write only for evidence-backed facts, decisions, project conventions, or explicit user preferences. Put tentative or one-off observations in target=log; " +
  "promote directly to memory/user only when stable and clearly supported by the conversation or verified workspace state. Include a short source/evidence phrase and avoid duplicates. " +
  "Use skill_create only for a repeatable procedure that was actually exercised or verified; do not turn a single guess into a playbook. " +
  "Never store secrets, credentials, raw private content, large transcripts, or stale task state. Never edit product code, AGENTS.md, permissions, configuration, or system prompts as 'self-evolution'; " +
  "those require a separate normal task and human-reviewed change. If nothing qualifies, write nothing. Reply only DONE with a short count of memories/skills saved.";

export function evolutionStatus(config: Pick<HaraConfig, "evolve" | "assetCapture">): string {
  const mode = config.evolve === "off"
    ? "off — no reflection/distillation runs"
    : config.evolve === "light"
      ? "light — memory tools are available; curation runs on /evolve now or manual /compact"
      : "proactive — eligible session exits reflect automatically; /evolve now is also available";
  const capture = config.assetCapture === "off"
    ? "skill capture off"
    : config.assetCapture === "auto"
      ? "memory/skill writes auto-approved during a curation pass"
      : "memory/skill writes require confirmation during a curation pass";
  return `self-evolution: ${mode}\npolicy: evidence-backed memory + verified reusable skills only; never autonomous code/system-prompt changes\ncapture: ${capture}`;
}

export function shouldAutoEvolve(mode: HaraConfig["evolve"], historyLength: number): boolean {
  return mode === "proactive" && historyLength >= 4;
}

/** Runtime capability boundary for curation. In particular, todo_write is not "read-only" here: it would
 * mutate the active execution checkpoint. Network tools are also unnecessary for distilling local evidence. */
export function allowsEvolutionTool(name: string, assetCapture: HaraConfig["assetCapture"]): boolean {
  return name === "memory_write" || (assetCapture !== "off" && name === "skill_create") || EVOLUTION_READ_TOOLS.has(name);
}
