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
  "Use learning_capture for evidence-backed business rules, decisions, project conventions, explicit user preferences, corrections, exercised workflows, or recurring failures. " +
  "Every capture remains a review candidate; choose a stable dotted pattern key so repeated tasks deduplicate, and include concise observed evidence. Use project/personal scope locally; " +
  "organization scope is only a local proposal and is never uploaded by this pass. Do not write directly to durable memory during curation. " +
  "Use skill_create only for a repeatable procedure that was actually exercised or verified; do not turn a single guess into a playbook. " +
  "Never store secrets, credentials, raw private content, large transcripts, or stale task state. Never edit product code, AGENTS.md, permissions, configuration, or system prompts as 'self-evolution'; " +
  "those require a separate normal task and human-reviewed change. If nothing qualifies, write nothing. Reply only DONE with a short count of candidates/skills saved.";

export function evolutionStatus(config: Pick<HaraConfig, "evolve" | "assetCapture">): string {
  const mode = config.evolve === "off"
    ? "off — no reflection/distillation runs"
    : config.evolve === "light"
      ? "light — runtime capture is available; curation runs on /evolve now or manual /compact"
      : "proactive — eligible session exits reflect automatically; /evolve now is also available";
  const capture = config.assetCapture === "off"
    ? "skill capture off"
    : config.assetCapture === "auto"
      ? "verified skill capture auto-approved; learning candidates still require review"
      : "skill capture requires confirmation; learning candidates require review";
  return `self-evolution: ${mode}\npolicy: execution-time evidence → redacted candidate → review → versioned prompt context; never autonomous code/system-prompt changes\ncapture: ${capture}`;
}

export function shouldAutoEvolve(mode: HaraConfig["evolve"], historyLength: number): boolean {
  return mode === "proactive" && historyLength >= 4;
}

/** Runtime capability boundary for curation. In particular, todo_write is not "read-only" here: it would
 * mutate the active execution checkpoint. Network tools are also unnecessary for distilling local evidence. */
export function allowsEvolutionTool(name: string, assetCapture: HaraConfig["assetCapture"]): boolean {
  return name === "learning_capture" || (assetCapture !== "off" && name === "skill_create") || EVOLUTION_READ_TOOLS.has(name);
}

/** Daily-log consolidation is the one explicit direct-memory promotion pass. It is separate from session
 * self-evolution so the latter cannot bypass candidate review. */
export function allowsMemoryDistillTool(name: string): boolean {
  return name === "memory_write" || EVOLUTION_READ_TOOLS.has(name);
}
