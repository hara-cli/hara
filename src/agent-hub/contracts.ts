import type { HubAttachment } from "./attachments.js";

/** G0 metadata contract. Implementations must never discover/read native transcripts or capture panes. */
export interface RegisteredHubAgent {
  agentId: string; instanceId: string; alias: string; displayName: string;
  engine: "claude" | "codex" | "opencode" | "other";
}
export interface AgentHubDirectory {
  /** Exact, already-registered local identity; null/throw is unavailable, never implicit discovery. */
  registeredAgent(agentId: string): RegisteredHubAgent | null;
}
export interface HubSavedFacts {
  messageId: string; requestId: string; connectionId: string; seq: number; savedAt: string;
}
/** C0 supplies these factories/validators. Hub defines no competing actor or receipt discriminant. */
export interface AgentHubBoundaryContract<ExternalSource, SavedReceipt> {
  externalSource(agent: RegisteredHubAgent): ExternalSource;
  isExternalSource(value: unknown): value is ExternalSource;
  savedReceipt(facts: HubSavedFacts): SavedReceipt;
  isSavedReceipt(value: unknown): value is SavedReceipt;
}
export interface HubStoredMessage<ExternalSource> {
  schema: 1; messageId: string; requestId: string; connectionId: string; digest: string;
  source: ExternalSource; receivedAt: string; text: string; attachments: HubAttachment[];
}
export type HubVisibleMessage<ExternalSource> = Omit<HubStoredMessage<ExternalSource>, "digest" | "attachments"> & {
  seq: number; attachments: Omit<HubAttachment, "base64">[];
};
/** Future G0 egress consumes C0's receipt. No implementation, tmux control or autonomous dispatch here. */
export interface AgentHubEgressContract<TransportReceipt, UserAction> {
  sendText(input: { operationId: string; agentId: string; instanceId: string; text: string; userAction: UserAction }): Promise<TransportReceipt>;
  receipt(operationId: string): Promise<TransportReceipt>;
}
