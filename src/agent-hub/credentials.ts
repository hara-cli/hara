import { join } from "node:path";
import { assertPrivateStateDirectory, writePrivateStateFileSync, type PrivateStateDirectoryIdentity } from "../security/private-state.js";
import { hubAssert } from "./errors.js";

export interface AgentHubCredential {
  schemaVersion: 1; endpoint: string; connectionId: string; from: string; token: string;
  scopeKey: string; generation: string;
}
/** Trusted native handoff only, never an ingress route. The private target comes from a human-approved
 * local connection flow, not a message or model. No raw token is printed or written to Hub history. */
export function writeAgentHubCredential(directory: PrivateStateDirectoryIdentity, credential: AgentHubCredential): string {
  assertPrivateStateDirectory(directory);
  hubAssert(credential.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(credential.token)
    && /^[a-f0-9]{64}$/.test(credential.scopeKey)
    && [credential.connectionId, credential.generation].every(value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(credential.from));
  const endpoint = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(credential.endpoint);
  hubAssert(endpoint && Number(endpoint[1]) <= 65535);
  const path = join(directory.path, "agent-hub-credential.json");
  // Serialize the fixed transport fields only; do not forward unknown caller properties/secrets.
  const { schemaVersion, endpoint: target, connectionId, from, token, scopeKey, generation } = credential;
  writePrivateStateFileSync({ directory, path }, JSON.stringify({ schemaVersion, endpoint: target, connectionId, from, token, scopeKey, generation }), { expectedMissing: true });
  return path;
}
