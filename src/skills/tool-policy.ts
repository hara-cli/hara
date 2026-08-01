const MAX_SKILL_TOOL_NAMES = 128;
const MAX_TOOL_NAME_CHARS = 160;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;

/** Engine-owned controls needed to preserve Hara's safety/lifecycle boundaries. These helpers cannot
 * execute the skill's task themselves; nested skills can only narrow the active floor further. */
export const SKILL_POLICY_HELPERS = new Set([
  "skill",
  "task_intake",
  "tool_search",
  "tool_result_read",
  "exit_plan",
  "structured_output",
]);

export interface SkillToolPolicyInput {
  id: string;
  allowedTools: readonly string[];
}

export interface SkillToolPolicy {
  skillIds: readonly string[];
  allowedTools: ReadonlySet<string>;
}

export type SkillToolPolicyActivation =
  | { ok: true; policy: SkillToolPolicy }
  | { ok: false; reason: string };

function normalizeToolNames(rawNames: readonly string[]): { ok: true; names: string[] } | { ok: false; reason: string } {
  if (rawNames.length > MAX_SKILL_TOOL_NAMES) {
    return { ok: false, reason: `allowed-tools has ${rawNames.length} entries; maximum is ${MAX_SKILL_TOOL_NAMES}` };
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const rawName of rawNames) {
    const name = String(rawName).trim();
    if (!name || name.length > MAX_TOOL_NAME_CHARS || !TOOL_NAME.test(name) || name.includes("*")) {
      return { ok: false, reason: `invalid exact tool name ${JSON.stringify(name || rawName)}` };
    }
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return { ok: true, names };
}

/** Add a skill's declared allowlist to the active run. Multiple skills compose by intersection, never
 * union, so loading another skill cannot widen authority granted by one already in context. */
export function activateSkillToolPolicy(
  current: SkillToolPolicy | undefined,
  input: SkillToolPolicyInput,
): SkillToolPolicyActivation {
  const normalized = normalizeToolNames(input.allowedTools);
  if (!normalized.ok) return normalized;
  const incoming = new Set(normalized.names);
  const allowedTools = current
    ? new Set([...current.allowedTools].filter((name) => incoming.has(name)))
    : incoming;
  const skillIds = current?.skillIds.includes(input.id)
    ? [...current.skillIds]
    : [...(current?.skillIds ?? []), input.id];
  return { ok: true, policy: { skillIds, allowedTools } };
}

export function skillToolAllowed(policy: SkillToolPolicy | undefined, toolName: string): boolean {
  return !policy || SKILL_POLICY_HELPERS.has(toolName) || policy.allowedTools.has(toolName);
}

export function skillToolPolicyLabel(policy: SkillToolPolicy): string {
  const allowed = [...policy.allowedTools].sort();
  return `${policy.skillIds.join(" + ")} (${allowed.length ? allowed.join(", ") : "no task tools"})`;
}
