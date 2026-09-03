/**
 * Provider-neutral metadata for coding-agent sessions discovered on this device.
 *
 * Native session IDs, full working-directory paths, transcript previews, credentials, and provider
 * objects must stay behind the Serve boundary. Desktop and future mobile clients receive only this
 * deliberately small projection.
 */
export type ExternalSessionSourceId = "codex" | "claude" | "runtime";

export type ExternalRuntimeAgentKind = "codex" | "claude";

export type ExternalRuntimeEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ExternalRuntimeClaudePermissionMode = "manual" | "acceptEdits" | "plan" | "auto" | "dontAsk";

export type ExternalRuntimeCodexSandboxMode = "read-only" | "workspace-write";

export type ExternalRuntimeServiceTier = "fast";

/**
 * Provider-native launch preferences for a Hara-owned terminal session. Hara deliberately exposes
 * only bounded, non-bypass choices; full host access and permission bypass stay unavailable here.
 */
export interface ExternalRuntimeLaunchOptions {
  model?: string;
  effort?: ExternalRuntimeEffort;
  permissionMode?: ExternalRuntimeClaudePermissionMode;
  sandboxMode?: ExternalRuntimeCodexSandboxMode;
  serviceTier?: ExternalRuntimeServiceTier;
}

export type ExternalSessionSourceState =
  | "ready"
  | "adapter_required"
  | "not_installed"
  | "error";

export type ExternalSessionState =
  | "stored"
  | "idle"
  | "working"
  | "waiting"
  | "error"
  | "unknown";

export interface ExternalSessionSourceCapabilities {
  listMetadata: boolean;
  read: boolean;
  create: boolean;
  fork: boolean;
  resume: boolean;
  observeLive: boolean;
  submit: boolean;
  steer: boolean;
  interrupt: boolean;
  /** Hara Live can explicitly terminate and remove a relay session created on this device. */
  remove?: boolean;
  /** Hara Live can expose a passive snapshot of its original provider terminal. */
  terminalView?: boolean;
  /** Hara Live can relay an explicit prompt or a bounded logical key to that same terminal. */
  terminalInput?: boolean;
}

export interface ExternalSessionSourceInfo {
  id: ExternalSessionSourceId;
  label: string;
  state: ExternalSessionSourceState;
  version?: string;
  reason?: "official_adapter_not_bundled" | "command_not_found" | "probe_failed";
  capabilities: ExternalSessionSourceCapabilities;
}

export interface ExternalSessionInfo {
  /** Hara-owned, device-stable keyed digest. Never a provider-native session/thread ID. */
  id: string;
  sourceId: ExternalSessionSourceId;
  title: string;
  /** Basename only. The full local path never crosses Serve. */
  workspaceName: string;
  /** Hara-owned keyed digest used for grouping without making guessed full paths testable. */
  workspaceId: string;
  state: ExternalSessionState;
  createdAt: string;
  updatedAt: string;
  origin?: "cli" | "vscode" | "exec" | "appServer" | "subAgent" | "haraRuntime" | "unknown";
  /** Present for Hara Live relay sessions; never inferred from transcript text. */
  agentKind?: ExternalRuntimeAgentKind | "other";
  ephemeral: boolean;
}

export type ExternalSessionMessageRole = "user" | "assistant" | "notice";

export interface ExternalSessionMessage {
  /** Hara-owned keyed digest. Provider message/turn identifiers never cross Serve. */
  id: string;
  role: ExternalSessionMessageRole;
  text: string;
}

export interface ExternalSessionReadResult {
  session: ExternalSessionInfo;
  messages: ExternalSessionMessage[];
  /** True for provider history that has not yet been explicitly resumed through Hara. */
  readOnly: boolean;
  /**
   * `live` is the provider's currently loaded session, `managed` is an explicitly resumed or
   * Hara-created continuation, and `history` is protected provider history awaiting user consent.
   */
  controlMode: "history" | "managed" | "live";
}

export interface ExternalSessionForkResult extends ExternalSessionReadResult {
  /** The selected Hara opaque id. The returned session owns a different opaque id. */
  sourceSessionId: string;
}

export type ExternalTurnStatus = "completed" | "interrupted" | "failed";

export interface ExternalTurnResult {
  sessionId: string;
  /** Hara-owned turn id. */
  turnId: string;
  status: ExternalTurnStatus;
  reply: string;
  error?: string;
}

export interface ExternalSteerResult {
  sessionId: string;
  /** Hara-owned turn id for correlating the accepted follow-up with the active stream. */
  turnId: string;
  accepted: true;
}

export interface ExternalApprovalRequest {
  question: string;
  allowAlways?: boolean;
}

export interface ExternalTurnSink {
  text(delta: string): void;
  tool(name: string, preview: string): void;
  notice(text: string): void;
  confirm(request: ExternalApprovalRequest, signal: AbortSignal): Promise<boolean | "always">;
}

export interface ExternalSessionListInput {
  sourceId?: ExternalSessionSourceId;
  cursor?: string;
  limit?: number;
  search?: string;
}

export interface ExternalSessionCreateInput {
  sourceId: "runtime";
  cwd: string;
  agentKind: ExternalRuntimeAgentKind;
  title?: string;
  launch?: ExternalRuntimeLaunchOptions;
}

export interface ExternalTerminalSnapshot {
  sessionId: string;
  text: string;
  state: ExternalSessionState;
  updatedAt: string;
}

export type ExternalTerminalKey =
  | "enter"
  | "esc"
  | "up"
  | "down"
  | "left"
  | "right"
  | "tab"
  | "shift+tab"
  | "ctrl+c"
  | "ctrl+d"
  | "ctrl+l";

export interface ExternalSessionListResult {
  sources: ExternalSessionSourceInfo[];
  sessions: ExternalSessionInfo[];
  page: {
    limit: number;
    hasMore: boolean;
    nextCursor?: string;
  };
}

/** Internal adapter result. `nextCursor` is provider-owned and must be wrapped by the registry. */
export interface ExternalSessionAdapterPage {
  sessions: ExternalSessionInfo[];
  nextCursor?: string;
}

export interface ExternalSessionAdapter {
  readonly id: ExternalSessionSourceId;
  inspect(): Promise<ExternalSessionSourceInfo>;
  list(input: { cursor?: string; limit: number; search?: string }): Promise<ExternalSessionAdapterPage>;
  create?(input: Omit<ExternalSessionCreateInput, "sourceId">): Promise<ExternalSessionReadResult>;
  read?(sessionId: string): Promise<ExternalSessionReadResult>;
  resume?(sessionId: string): Promise<ExternalSessionReadResult>;
  fork?(sessionId: string): Promise<ExternalSessionForkResult>;
  submit?(sessionId: string, text: string, sink: ExternalTurnSink): Promise<ExternalTurnResult>;
  steer?(sessionId: string, text: string): Promise<ExternalSteerResult>;
  interrupt?(sessionId: string): Promise<void>;
  remove?(sessionId: string): Promise<void>;
  terminalSnapshot?(sessionId: string): Promise<ExternalTerminalSnapshot>;
  terminalInput?(sessionId: string, text: string): Promise<void>;
  terminalKey?(sessionId: string, key: ExternalTerminalKey): Promise<void>;
  close?(): Promise<void>;
}

export interface ExternalSessionService {
  listSources(): Promise<{ sources: ExternalSessionSourceInfo[] }>;
  listSessions(input?: ExternalSessionListInput): Promise<ExternalSessionListResult>;
  createSession(input: ExternalSessionCreateInput): Promise<ExternalSessionReadResult>;
  readSession(sessionId: string): Promise<ExternalSessionReadResult>;
  resumeSession(sessionId: string): Promise<ExternalSessionReadResult>;
  forkSession(sessionId: string): Promise<ExternalSessionForkResult>;
  submit(sessionId: string, text: string, sink: ExternalTurnSink): Promise<ExternalTurnResult>;
  steer(sessionId: string, text: string): Promise<ExternalSteerResult>;
  interrupt(sessionId: string): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  terminalSnapshot(sessionId: string): Promise<ExternalTerminalSnapshot>;
  terminalInput(sessionId: string, text: string): Promise<void>;
  terminalKey(sessionId: string, key: ExternalTerminalKey): Promise<void>;
  close(): Promise<void>;
}

export class ExternalSessionInputError extends Error {}
