import { plain, exact } from "./local-state.js";
/** Private configuration only. owns is advisory provenance, never a path/tool grant. */
export interface WorkspaceLegacyToolPolicy { allow: string[] | null; deny: string[]; readOnly: boolean; owns: string[] }
export function validateWorkspaceLegacyToolPolicy(raw: unknown): WorkspaceLegacyToolPolicy {
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 128
    && value.every(item => typeof item === "string" && item.length > 0 && item.length <= 512 && !/[\u0000-\u001f\u007f]/.test(item));
  if (!plain(raw) || !exact(raw, ["allow", "deny", "readOnly", "owns"]) || !(raw.allow === null || strings(raw.allow))
    || !strings(raw.deny) || typeof raw.readOnly !== "boolean" || !strings(raw.owns)) throw new Error("Invalid legacy Agent policy");
  return structuredClone(raw) as unknown as WorkspaceLegacyToolPolicy;
}
const aliases: Record<string, string[]> = {
  workspace_read: ["read_file", "read"], workspace_verify: ["read_file", "read"], workspace_write: ["write_file", "edit_file", "apply_patch", "write", "edit"],
  workspace_list: ["ls", "glob"], workspace_skill: ["skill"],
};
/** Only filters an already scoped base tool set. No unknown tool, shell, app or external transport is
 * invented to satisfy an old allow-list. Deny remains an intersection; readOnly cannot be widened. */
export function legacyPolicyAllowsTool(policy: WorkspaceLegacyToolPolicy | undefined, name: string, kind?: string): boolean {
  if (!policy) return true;
  if (name === "workspace_receipt_read") return true; // Engine-owned instructions/evidence, not arbitrary files.
  const names = [name, ...(aliases[name] ?? [])];
  return (!policy.readOnly || kind === "read") && !names.some(value => policy.deny.includes(value))
    && (policy.allow === null || names.some(value => policy.allow!.includes(value)));
}
