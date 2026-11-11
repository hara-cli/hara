import { AGENT_HUB_ERRORS, createAgentHubBoundaryContract, parseAgentHubDocument,
  type ExternalAgentSourceV1, type HubSavedReceiptV1, type HubTransportReceiptV1,
  type HubErrorV1, type HubResourceBindingV1 } from "../workspace/agent-boundaries-contract.js";
import { AgentHubStore, type AgentHubOptions } from "./store.js";
import { startAgentHubIngress } from "./ingress.js";
import type { AgentHubBoundaryContract, AgentHubEgressContract } from "./contracts.js";
import type { AgentHubErrorCode } from "./errors.js";

export type C0AgentHubStore = AgentHubStore<ExternalAgentSourceV1, HubSavedReceiptV1>;
export type C0AgentHubEgress<UserAction> = AgentHubEgressContract<HubTransportReceiptV1, UserAction>;
/** Canonical C0 wire data. Parsing never authenticates a source or proves a storage commit. */
export function createC0HubBoundary(binding: HubResourceBindingV1): AgentHubBoundaryContract<ExternalAgentSourceV1, HubSavedReceiptV1> {
  const current = createAgentHubBoundaryContract(binding), scopeKey = binding.scopeKey;
  const history = (value: unknown, kind: "external-agent-source" | "hub-ingress-receipt") => {
    try { const parsed = parseAgentHubDocument(value); return parsed.kind === kind && parsed.binding.scopeKey === scopeKey; }
    catch { return false; }
  };
  return Object.freeze({
    externalSource: current.externalSource,
    savedReceipt: current.savedReceipt,
    // Old-generation display records stay readable in their exact scope. Every new admission still
    // uses current factories, the live C1 fence and the grant's current-generation/registered pair.
    isExternalSource: (value: unknown): value is ExternalAgentSourceV1 => history(value, "external-agent-source"),
    isSavedReceipt: (value: unknown): value is HubSavedReceiptV1 => history(value, "hub-ingress-receipt"),
  });
}
export function createC0AgentHubStore(options: Omit<AgentHubOptions<ExternalAgentSourceV1, HubSavedReceiptV1>, "boundary">): C0AgentHubStore {
  return new AgentHubStore({ ...options, boundary: createC0HubBoundary({ schemaVersion: 1, scopeKey: options.scopeKey, generation: options.generation }) });
}
export function c0AgentHubError(code: AgentHubErrorCode): HubErrorV1 {
  return Object.freeze({ code, retry: AGENT_HUB_ERRORS[code] });
}
export function startC0AgentHubIngress(store: C0AgentHubStore) {
  return startAgentHubIngress({ store, errorBody: c0AgentHubError });
}
