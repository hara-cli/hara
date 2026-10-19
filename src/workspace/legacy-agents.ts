import { createHash } from "node:crypto";
import { parseRoleFrontmatter } from "../org/roles.js";
import { agentIdentityFromMetadata } from "../org/agent-identity.js";
import type { LegacyRolePlan } from "./legacy-plan.js";
import type { WorkspaceLegacyAgentInput } from "./agents.js";
import { validateWorkspaceLegacyToolPolicy } from "./legacy-role-policy.js";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Native global sources only, matched to the reviewed row hashes. Does not discover files, import
 * hidden/external/org identities, grant owns paths or create the new Fanli draft. */
export function legacyAgentInputs(sources: readonly { file: string; content: string }[], plan: readonly LegacyRolePlan[]): WorkspaceLegacyAgentInput[] {
  if (sources.length !== plan.length) throw new Error("Legacy Agent source set changed");
  return sources.map(source => {
    const { fm, body } = parseRoleFrontmatter(source.content), username = String(fm.name || source.file.replace(/\.md$/, ""));
    const row = plan.find(row => row.username === username);
    if (!row || row.validation !== "pass" || hash(source.content) !== row.sourceHash || hash(body) !== row.instructionsHash) throw new Error("Legacy Agent source changed or requires review");
    if (String(fm.archived).toLowerCase() === "true" && row.state === "active") throw new Error("An archived legacy Agent cannot be reactivated by inheritance");
    const { version: _version, source: _source, ...profile } = agentIdentityFromMetadata(fm, username, String(fm.description ?? ""), "global");
    const toolPolicy = validateWorkspaceLegacyToolPolicy({ allow: fm.allowTools ?? null, deny: fm.denyTools ?? [], owns: fm.owns ?? [],
      readOnly: String(fm.readOnly ?? (username === "reviewer")).toLowerCase() === "true" });
    return { username, profile, description: String(fm.description ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 180), instructions: body,
      state: row.state, toolPolicy, sourceHash: row.sourceHash, importId: hash("hara-legacy-native-role-v1\0" + username) };
  });
}
