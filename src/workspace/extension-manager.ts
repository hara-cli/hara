// One Workspace owns reviewed sources, private invocation history, and attempt-scoped upstream pools.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { ensurePrivateStateSubdirectory } from "../security/private-state.js";
import { assertRuntimeProxyReachable } from "../security/runtime-proxy.js";
import { redactSensitiveText, redactSensitiveValue } from "../security/secrets.js";
import type { Tool } from "../tools/registry.js";
import { VersionedSettings } from "./versioned-settings.js";
import { plain, exact, canonical } from "./local-state.js";
import { currentWorkspaceResourceBinding, sameWorkspaceResourceBinding, workspaceStateHome, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { extensionDigest, validateExtensionCatalog, type ExtensionSourceDescriptor } from "./extension-catalog.js";
import { WorkspaceExtensions, type ExtensionToolSnapshot } from "./extensions.js";
import { bindWorkspaceExtensionTool } from "./extension-binding.js";
import { ManagedMcpStdioTransport, managedMcpProxy } from "./extension-process.js";
import { assertWorkspaceMcpReviewCurrent, workspaceMcpReviewPlan, WorkspaceMcpError, type ReviewedMcpSource } from "./extension-review.js";

type CallState = "dispatched" | "server_reported_success" | "tool_error" | "denied" | "outcome_unknown";
interface CallRecord { operationId: string; runId: string; sourceId: string; toolId: string; inputDigest: string; at: string; durationMs: number; outcome: CallState; code: string | null }
interface InvocationState { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; calls: CallRecord[] }
export interface WorkspaceMcpAttempt { readonly tools: Tool[]; close(): Promise<void> }
interface Connection { client: Client; transport: ManagedMcpStdioTransport; stale: boolean }
const states = new Set<CallState>(["dispatched", "server_reported_success", "tool_error", "denied", "outcome_unknown"]);
export const workspaceMcpToolName = (sourceId: string, toolId: string) => `mcp_${extensionDigest(sourceId).slice(0, 12)}_${extensionDigest(toolId).slice(0, 12)}`;
export class WorkspaceMcpManager {
  private readonly state: VersionedSettings<InvocationState>;
  private reviews = new Map<string, ReviewedMcpSource>();
  private readonly attempts = new Set<WorkspaceMcpAttempt>();
  private children = 0;
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly input: {
    accountHome: string; proxy(): { revision: number; proxyUrl: string | null; readOnly: boolean }; onChange?(): void;
  }) {
    const binding = () => storage.run(() => ({ ...currentWorkspaceResourceBinding()! }));
    this.state = new VersionedSettings(() => storage.run(() => workspaceStateHome()), "workspace-extension-invocations-v1.json", 1,
      () => ({ schemaVersion: 1, revision: 0, resourceBinding: binding(), calls: [] }), raw => {
        if (!plain(raw) || !exact(raw, ["schemaVersion", "revision", "resourceBinding", "calls"]) || raw.schemaVersion !== 1
          || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, binding())
          || !Array.isArray(raw.calls) || raw.calls.length > 128) throw new WorkspaceMcpError("mcp_call_unavailable");
        for (const row of raw.calls) if (!plain(row) || !exact(row, ["operationId", "runId", "sourceId", "toolId", "inputDigest", "at", "durationMs", "outcome", "code"])
          || ![row.operationId, row.runId, row.sourceId, row.toolId, row.at].every(value => typeof value === "string" && value.length < 300)
          || typeof row.inputDigest !== "string" || !/^[a-f0-9]{64}$/u.test(row.inputDigest) || !states.has(row.outcome as CallState)
          || !Number.isSafeInteger(row.durationMs) || Number(row.durationMs) < 0 || !(row.code === null || typeof row.code === "string" && /^mcp_[a-z_]+$/u.test(row.code))) throw new WorkspaceMcpError("mcp_call_unavailable");
        return raw as unknown as InvocationState;
      }, {}, storage);
  }
  /** Reconcile reviewed Host identities against the current candidate, never a same-name overwrite. */
  catalog(candidates: readonly ExtensionSourceDescriptor[], reviews: readonly ReviewedMcpSource[]): ExtensionSourceDescriptor[] {
    const next = new Map<string, ReviewedMcpSource>(), found = new Map(validateExtensionCatalog(candidates).map(source => [source.sourceId, source]));
    for (const reviewed of reviews) {
      const plan = workspaceMcpReviewPlan(reviewed), original = found.get(plan.record.source.sourceId);
      if ((!original && plan.record.source.kind !== "workspace") || original && extensionDigest(original) !== extensionDigest(plan.record.source)) continue;
      assertWorkspaceMcpReviewCurrent(reviewed);
      if (next.has(reviewed.descriptor.sourceId)) throw new WorkspaceMcpError("mcp_source_unreviewed");
      next.set(reviewed.descriptor.sourceId, reviewed); found.set(reviewed.descriptor.sourceId, reviewed.descriptor);
    }
    this.reviews = next; return [...found.values()];
  }
  invalidate(): void { this.reviews.clear(); }
  view<T extends { sources: { sourceId: string; workspaceEnabled: boolean; allowedTools: string[]; status: string; effectiveTools?: string[] }[] }>(view: T) {
    const calls = this.state.read();
    return { ...view, sources: view.sources.map(source => {
      const reviewed = this.reviews.has(source.sourceId);
      const last = [...calls.value.calls].reverse().find(row => row.sourceId === source.sourceId);
      return { ...source, callable: process.platform === "darwin" && !calls.readOnly && reviewed && source.status === "ready" && source.workspaceEnabled && (source.effectiveTools === undefined ? source.allowedTools.length > 0 : source.effectiveTools.length > 0),
        managerStatus: reviewed ? "reviewed" as const : "unreviewed" as const,
        ...(last ? { lastCall: { at: last.at, durationMs: last.durationMs, toolId: last.toolId,
          outcome: last.outcome === "dispatched" ? "outcome_unknown" as const : last.outcome, code: last.code } } : {}) };
    }) };
  }
  private record(record: CallRecord): void {
    const { value, readOnly } = this.state.read(); if (readOnly) throw new WorkspaceMcpError("mcp_call_unavailable");
    this.state.update(value.revision, state => {
      const existing = state.calls.findIndex(row => row.operationId === record.operationId);
      if (existing >= 0) state.calls[existing] = record;
      else {
        if (state.calls.length >= 128) { const drop = state.calls.findIndex(row => !["dispatched", "outcome_unknown"].includes(row.outcome)); if (drop < 0) throw new WorkspaceMcpError("mcp_call_unavailable"); state.calls.splice(drop, 1); }
        state.calls.push(record);
      }
      return state;
    });
    this.input.onChange?.();
  }
  createAttempt(input: {
    snapshot: ExtensionToolSnapshot; extensions: WorkspaceExtensions; runId: string; deadline: number; signal: AbortSignal;
    assertCurrent(): void;
  }): WorkspaceMcpAttempt {
    if (!Number.isFinite(input.deadline) || input.deadline <= Date.now() || input.snapshot.workspaceId !== this.storage.scope.workspaceId) throw new WorkspaceMcpError("mcp_call_cancelled");
    const proxy = this.input.proxy(), proxyUrl = managedMcpProxy(proxy.proxyUrl);
    if (proxy.readOnly) throw new WorkspaceMcpError("mcp_proxy_unavailable");
    const controller = new AbortController(), signal = AbortSignal.any([input.signal, controller.signal]);
    const connections = new Map<string, Promise<Connection>>(), approvals = new Map<string, string>(), consumed = new Set<string>();
    let ended = false, closing: Promise<void> | undefined;
    const current = (sourceId: string, toolId: string, reviewed: ReviewedMcpSource) => {
      if (ended || signal.aborted || Date.now() >= input.deadline) throw new WorkspaceMcpError("mcp_call_cancelled");
      input.assertCurrent(); input.extensions.assertCurrentTool(input.snapshot, sourceId, toolId, input.snapshot.agentEpoch);
      if (!this.reviews.has(sourceId) || extensionDigest(this.reviews.get(sourceId)!.descriptor) !== extensionDigest(reviewed.descriptor)) throw new WorkspaceMcpError("mcp_source_stale");
      assertWorkspaceMcpReviewCurrent(reviewed);
      const latest = this.input.proxy(); if (latest.readOnly || latest.revision !== proxy.revision || managedMcpProxy(latest.proxyUrl) !== proxyUrl) throw new WorkspaceMcpError("mcp_proxy_unavailable");
    };
    const connect = (sourceId: string, reviewed: ReviewedMcpSource): Promise<Connection> => {
      const existing = connections.get(sourceId); if (existing) return existing;
      if (this.children >= 2) throw new WorkspaceMcpError("mcp_call_unavailable"); this.children++;
      const promise = (async () => {
        let transport: ManagedMcpStdioTransport | undefined;
        try {
          try { await assertRuntimeProxyReachable(proxyUrl, signal); } catch { throw new WorkspaceMcpError(signal.aborted ? "mcp_call_cancelled" : "mcp_proxy_unavailable"); }
          const root = this.storage.run(() => ensurePrivateStateSubdirectory(workspaceStateHome(), [".hara", "extension-processes", input.snapshot.agentId, input.runId, extensionDigest(sourceId).slice(0, 24)]).path);
          for (const name of ["home", "config", "cache", "state", "tmp"]) ensurePrivateStateSubdirectory(root, [name]);
          transport = new ManagedMcpStdioTransport({ source: reviewed, root, accountHome: this.input.accountHome,
            stateHome: this.storage.run(() => workspaceStateHome()), proxy: proxyUrl, signal });
          const client = new Client({ name: "hara-workspace-mcp", version: "1.0.0" }, { capabilities: {} });
          const connection: Connection = { client, transport, stale: false };
          client.setNotificationHandler(ToolListChangedNotificationSchema, () => { connection.stale = true; });
          await client.connect(transport, { signal, timeout: Math.max(1, Math.min(10_000, input.deadline - Date.now())) });
          const inventory = await client.listTools({}, { signal, timeout: Math.max(1, Math.min(10_000, input.deadline - Date.now())) });
          const plan = workspaceMcpReviewPlan(reviewed);
          if (inventory.nextCursor || inventory.tools.length !== plan.record.tools.length
            || new Set(inventory.tools.map(tool => tool.name)).size !== inventory.tools.length || inventory.tools.some(tool => {
            const trusted = plan.record.tools.find(row => row.remoteName === tool.name);
            return !trusted || !exact(tool, ["name", "description", "inputSchema"].filter(key => key !== "description" || tool.description !== undefined)) || extensionDigest({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }) !== plan.schemaDigests.get(trusted.toolId);
          })) { connection.stale = true; throw new WorkspaceMcpError("mcp_schema_stale"); }
          return connection;
        } catch (error) {
          await transport?.close(); this.children--;
          throw error instanceof WorkspaceMcpError ? error : new WorkspaceMcpError("mcp_call_unavailable");
        }
      })();
      connections.set(sourceId, promise); return promise;
    };
    const built: Tool[] = [];
    for (const allowed of process.platform === "darwin" ? input.snapshot.tools : []) {
      const reviewed = this.reviews.get(allowed.sourceId); if (!reviewed) continue;
      const plan = workspaceMcpReviewPlan(reviewed), tool = plan.record.tools.find(row => row.toolId === allowed.toolId);
      if (!tool || reviewed.descriptor.sourceRevision !== allowed.sourceRevision) throw new WorkspaceMcpError("mcp_source_stale");
      const assertCurrent = () => current(allowed.sourceId, allowed.toolId, reviewed);
      const name = workspaceMcpToolName(allowed.sourceId, allowed.toolId);
      const binding = { attemptId: input.runId, sourceName: reviewed.descriptor.name, toolName: tool.remoteName, effect: tool.effect,
        assertCurrent, approve: (callId: string, digest: string) => { assertCurrent(); if (approvals.has(callId) || consumed.has(callId)) throw new WorkspaceMcpError("mcp_approval_required"); approvals.set(callId, digest); } };
      built.push(bindWorkspaceExtensionTool({ name, kind: "exec", trustBoundary: "external", concurrencySafe: false,
        description: `${reviewed.descriptor.name}: ${tool.description}`, input_schema: structuredClone(tool.inputSchema),
        classify: () => ({ effect: tool.effect, concurrencySafe: false, approvalKind: "exec", requiresExplicitApproval: true,
          approvalTarget: `${reviewed.descriptor.name} / ${tool.remoteName}` }),
        run: async (args: unknown, context) => {
          const callId = context.toolCallId, inputDigest = extensionDigest(args);
          if (!callId || approvals.get(callId) !== inputDigest || consumed.has(callId)) throw new WorkspaceMcpError("mcp_approval_required");
          approvals.delete(callId); consumed.add(callId); assertCurrent();
          if (!plain(args) || Buffer.byteLength(canonical(args)) > 32 * 1024 || !plan.validators.get(tool.toolId)!(args)) throw new WorkspaceMcpError("mcp_input_invalid");
          const old = this.state.read();
          if (old.readOnly || old.value.calls.some(row => row.operationId === `${input.runId}:${callId}`
            || row.sourceId === allowed.sourceId && row.toolId === tool.toolId && row.inputDigest === inputDigest && ["dispatched", "outcome_unknown"].includes(row.outcome))) throw new WorkspaceMcpError("mcp_outcome_unknown");
          const record: CallRecord = { operationId: `${input.runId}:${callId}`, runId: input.runId, sourceId: allowed.sourceId, toolId: tool.toolId, inputDigest,
            at: new Date().toISOString(), durationMs: 0, outcome: "dispatched", code: null };
          this.record(record); const started = performance.now(); let dispatched = false;
          try {
            const connection = await connect(allowed.sourceId, reviewed); assertCurrent();
            if (connection.stale) throw new WorkspaceMcpError("mcp_schema_stale");
            dispatched = true;
            const result = await connection.client.callTool({ name: tool.remoteName, arguments: args }, undefined,
              { signal, timeout: Math.max(1, Math.min(30_000, input.deadline - Date.now())) });
            assertCurrent(); // A late result cannot restore revoked authority or outlive the deadline.
            if (!Array.isArray(result.content) || Buffer.byteLength(JSON.stringify(result)) > 512 * 1024
              || result.content.some(block => !plain(block) || block.type !== "text" || typeof block.text !== "string")) throw new WorkspaceMcpError("mcp_result_limit");
            const content = result.content.map(block => redactSensitiveText(String((block as { text: string }).text)).text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "")).join("\n");
            const structuredContent = result.structuredContent === undefined ? undefined : redactSensitiveValue(result.structuredContent).value;
            record.outcome = result.isError ? "tool_error" : "server_reported_success"; record.code = result.isError ? "mcp_call_unavailable" : null;
            return result.isError ? `Error: ${content.slice(0, 4000)}` : JSON.stringify({ sourceId: allowed.sourceId, toolId: tool.toolId,
              outcome: "server_reported_success", verified: false, content, ...(structuredContent === undefined ? {} : { structuredContent }) });
          } catch (error) {
            const failure = dispatched ? new WorkspaceMcpError("mcp_outcome_unknown") : error instanceof WorkspaceMcpError ? error : new WorkspaceMcpError("mcp_call_unavailable");
            record.outcome = dispatched ? "outcome_unknown" : "denied"; record.code = failure.code; throw failure;
          } finally { record.durationMs = Math.max(0, Math.round(performance.now() - started)); this.record(record); }
        },
      }, binding));
    }
    if (built.length > 32 || new Set(built.map(tool => tool.name)).size !== built.length) throw new WorkspaceMcpError("mcp_source_unreviewed");
    const timeout = setTimeout(() => controller.abort(), Math.min(2_147_483_647, Math.max(1, input.deadline - Date.now()))); timeout.unref();
    const close = (): Promise<void> => closing ??= (async () => {
      ended = true; controller.abort(); clearTimeout(timeout); input.signal.removeEventListener("abort", onAbort); approvals.clear();
      const settled = await Promise.allSettled([...connections.values()]);
      let failed = false;
      for (const result of settled) if (result.status === "rejected") {
        if (result.reason instanceof WorkspaceMcpError && result.reason.code === "mcp_drain_unknown") failed = true;
      } else {
        try { await result.value.client.close(); await result.value.transport.close(); this.children--; } catch { failed = true; }
      }
      if (failed) throw new WorkspaceMcpError("mcp_drain_unknown"); this.attempts.delete(attempt);
    })();
    const onAbort = () => { void close().catch(() => {}); };
    const attempt: WorkspaceMcpAttempt = { tools: built, close }; this.attempts.add(attempt);
    input.signal.addEventListener("abort", onAbort, { once: true }); if (input.signal.aborted) onAbort();
    return attempt;
  }
  async close(): Promise<void> { await Promise.all([...this.attempts].map(attempt => attempt.close())); }
}
