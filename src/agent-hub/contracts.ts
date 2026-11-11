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
  /** Canonical deterministic source for the current Host binding and authenticated frozen pair. */
  externalSource(agent: RegisteredHubAgent): ExternalSource;
  /** Stored historical shape only; does not authenticate or authorize a new publication. */
  isExternalSource(value: unknown): value is ExternalSource;
  savedReceipt(facts: HubSavedFacts): SavedReceipt;
  isSavedReceipt(value: unknown): value is SavedReceipt;
}
export interface HubStoredAttachment extends Omit<HubAttachment, "base64"> {
  attachmentId: string; fileId: string; state: "available" | "expired";
}
export interface HubStoredMessage<ExternalSource> {
  schema: 2; messageId: string; requestId: string; connectionId: string; digest: string;
  source: ExternalSource; receivedAt: string;
  text: { fileId: string; bytes: number; sha256: string; preview: string };
  attachments: HubStoredAttachment[];
}
export interface HubVisibleMessage<ExternalSource> {
  schema: 2; messageId: string; requestId: string; connectionId: string; source: ExternalSource;
  receivedAt: string; seq: number; textPreview: string; textBytes: number;
  attachments: Omit<HubStoredAttachment, "fileId">[];
}
/** Future G0 egress consumes C0's receipt. No implementation, tmux control or autonomous dispatch here. */
export interface AgentHubEgressContract<TransportReceipt, UserAction> {
  sendText(input: { operationId: string; agentId: string; instanceId: string; text: string; userAction: UserAction }): Promise<TransportReceipt>;
  receipt(operationId: string): Promise<TransportReceipt>;
}
