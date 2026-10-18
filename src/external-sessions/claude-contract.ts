/** Structural legacy injection boundary only: no vendor SDK or global configuration is imported. */
export interface SDKSessionInfo { sessionId: string; lastModified: number; createdAt?: number; cwd?: string;
  summary?: string; firstPrompt?: string; customTitle?: string }
export interface SessionMessage { uuid: string; type: string; message: unknown }
export type SDKMessage =
  | { type: "assistant"; parent_tool_use_id: string | null; message: unknown; session_id: string }
  | { type: "tool_use_summary"; summary: string; session_id: string }
  | { type: "result"; subtype: "success"; result: string; session_id: string }
  | { type: "result"; subtype: "error"; errors: string[]; session_id: string }
  | { type: "other"; session_id: string };
export type CanUseTool = (name: string, input: Record<string, unknown>, prompt: {
  signal: AbortSignal; title?: string; description?: string; displayName?: string; suggestions?: unknown[];
}) => Promise<{ behavior: "deny"; message: string } | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }>;
export interface ClaudeAgentSdkFacade {
  getSessionInfo(id: string, options?: { dir?: string }): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(id: string, options: { dir?: string; limit: number }): Promise<SessionMessage[]>;
  listSessions(options: { limit: number; offset: number; includeProgrammatic: boolean }): Promise<SDKSessionInfo[]>;
  forkSession(id: string, options: { dir?: string; title: string }): Promise<{ sessionId: string }>;
  query(input: { prompt: string; options: { sessionId?: string; resume?: string; cwd?: string;
    pathToClaudeCodeExecutable: string; env: NodeJS.ProcessEnv; permissionMode: "default"; canUseTool: CanUseTool } }):
    AsyncIterable<SDKMessage> & { close(): void };
}
