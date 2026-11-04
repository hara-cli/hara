import { sanitizeMemoryForPrompt } from "../memory/guard.js";
import { redactSensitiveText } from "../security/secrets.js";
import type { WorkspaceAgentView } from "./agents.js";

const clean = (value: string, cap: number): string => redactSensitiveText(sanitizeMemoryForPrompt(value).text).text
  .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, cap);
/** A public directory, never bio/instructions, credentials or execution/completion evidence.
 * Column rows avoid repeating long JSON keys for every colleague; IDs are always exact. */
export function compactWorkspaceRoster(agents: readonly WorkspaceAgentView[], maxChars = 2000) {
  const active = agents.filter(agent => agent.state === "active");
  const rows = active.map(agent => [agent.agentId, clean(agent.identity.displayName, 32),
    clean(agent.identity.title ?? "", 24), agent.runtime.id, agent.state]);
  const packet = { columns: ["id", "name", "role", "runtime", "state"], agents: rows,
    total: active.length, truncated: false };
  // Shrink descriptive labels before omitting identities. Full details remain available by exact ID.
  for (const cap of [20, 12]) {
    if (JSON.stringify(packet).length <= maxChars) break;
    for (const row of rows) { row[1] = row[1]!.slice(0, cap); row[2] = row[2]!.slice(0, cap); }
  }
  while (JSON.stringify(packet).length > maxChars && rows.length) { rows.pop(); packet.truncated = true; }
  return packet;
}
