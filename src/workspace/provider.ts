import { createOpenAIProvider } from "../providers/openai.js";
import { createAnthropicProvider } from "../providers/anthropic.js";
import type { Provider } from "../providers/types.js";
import type { ScopedConnection, ScopedRunConnection } from "./scoped-connections.js";
import { resolveWorkspaceFileCredential } from "./file-credential.js";

/** No ambient profile/env/OAuth fallback: the admitted Workspace generation is the whole audience. */
export function createWorkspaceProvider(connection: ScopedConnection, binding: ScopedRunConnection): Provider {
  if (connection.status !== "active" || connection.id !== binding.connectionId
    || connection.credentialGeneration !== binding.credentialGeneration || connection.revision !== binding.connectionRevision) {
    throw new Error("Workspace connection generation unavailable; no fallback selected");
  }
  const apiKey = connection.credentialFile ? resolveWorkspaceFileCredential(connection.credentialFile) : connection.apiKey;
  if (!apiKey) throw new Error("Workspace credential unavailable");
  // Deliberately no automatic retry/provider/model failover at this authority boundary.
  return connection.provider === "anthropic"
    ? createAnthropicProvider({ apiKey, baseURL: connection.baseURL, model: binding.model })
    : createOpenAIProvider({ apiKey, baseURL: connection.baseURL, model: binding.model });
}
