import { withClientLocale } from "../i18n/locale.js";
import { publicErrorData } from "../i18n/errors.js";
import { createServer } from "node:http";
import { parseMessageTimingInput } from "../workspace/message-timing.js";
import type { WorkspaceMcpLaunchProvider } from "../workspace/extension-candidate.js";
import type { ReviewedMcpSource } from "../workspace/extension-review.js";
import { availableRuntimePermissionTiers, isRuntimePermissionTier, NativeEngineUnsupportedError, RuntimeTierUnavailableError, runtimeWriteProtection } from "../agent-runtime/execution-policy.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { LocalWorkspaceHost, WorkspaceArchiveError, type LocalWorkspaceProviderFactory } from "../workspace/local-host.js";
import { AGENT_BOUNDARIES_CONTRACT, AGENT_BOUNDARY_ERRORS, AgentBoundaryContractError } from "../workspace/agent-boundaries-contract.js";
import { AgentBoundaryTransports, type AgentBoundaryTransport } from "../workspace/agent-boundary-transport.js";
import type { AgentHubDirectory } from "../agent-hub/contracts.js";
import { exact, messageBody, plain, positive, text, UUID } from "../workspace/local-state.js";
import type { ArkAcceptanceSlice } from "../workspace/real-key-provider.js";
import { bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, removePrivateStateFile, writePrivateStateFileSync } from "../security/private-state.js";
import type { ServeHandle, ServeOpts } from "./server.js";
import { workspaceRequestSource } from "../workspace/request-journal.js";
import type { RuntimeLoginSource, WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import type { CredentialVault } from "../workspace/credential-vault.js";
import { isAgentRuntimeId } from "../agent-runtime/bindings.js";
import type { ExtensionCatalogProvider } from "../workspace/extension-catalog.js";
import type { WorkspaceAgentPersonaInput } from "../workspace/agents.js";

const CAPABILITY = "workspace.local-dev.v2";
function tokenMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual) || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
export async function startLocalWorkspaceServe(opts: ServeOpts, input: { root: string; version: string; mode?: "workspace"; hostHome?: string; discoveryHome?: string; legacySourceHome?: string; credentialVault?: CredentialVault; realKeyFile?: string; realKeySlice?: ArkAcceptanceSlice; allowedOrigins?: readonly string[]; providerFactory?: LocalWorkspaceProviderFactory; extensionCatalog?: ExtensionCatalogProvider; reviewedMcpSources?: () => readonly ReviewedMcpSource[]; mcpReviewHome?: string; mcpLaunchCandidate?: WorkspaceMcpLaunchProvider; runtimeInstallerOptions?: ConstructorParameters<typeof WorkspaceRuntimeInstaller>[1]; backgroundRuntimeDetectionMs?: number; agentBoundaries?: { ownerCredential: string; maxCommandLifetimeMs?: number; externalDirectory?: AgentHubDirectory } }): Promise<ServeHandle> {
  if (opts.host !== "127.0.0.1" || !Number.isSafeInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error("Workspace Dev listens only on explicit IPv4 loopback");
  const token = opts.token ?? randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid Workspace Dev transport token");
  // Separate owner capability supplied only by a trusted native bootstrap. It is never included
  // in the generic transport discovery receipt or returned ServeHandle. CLI defaults stay closed.
  if (input.agentBoundaries?.ownerCredential === token) throw new AgentBoundaryContractError("AUTHORITY_UNVERIFIED", "authority.bootstrap");
  const boundaryTransports = input.agentBoundaries ? new AgentBoundaryTransports(input.agentBoundaries.ownerCredential) : undefined;
  type Client = { id: string; initialized: boolean; boundaryTransport?: AgentBoundaryTransport };
  const origins = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", ...(input.allowedOrigins ?? [])]);
  const dispatch: typeof dispatchMethod = (client, method, params, rpcId, receivedAt) => {
    if (!plain(params)) return Promise.reject(new Error("invalid Workspace RPC parameters"));
    const { clientLocale, ...businessParams } = params;
    return withClientLocale(clientLocale, () => dispatchMethod(client, method, businessParams, rpcId, receivedAt));
  };
  const clients = new Map<WebSocket, Client>();
  let closing = false;
  const capability = input.mode === "workspace" ? "workspace.v1" : CAPABILITY;
  const host = new LocalWorkspaceHost(input.root, { boundaryTransports, boundaryMaxCommandLifetimeMs: input.agentBoundaries?.maxCommandLifetimeMs, boundaryExternalDirectory: input.agentBoundaries?.externalDirectory, mode: input.mode, hostHome: input.hostHome, discoveryHome: input.discoveryHome, legacySourceHome: input.legacySourceHome, credentialVault: input.credentialVault, realKeyFile: input.realKeyFile, realKeySlice: input.realKeySlice, providerFactory: input.providerFactory, extensionCatalog: input.extensionCatalog, reviewedMcpSources: input.reviewedMcpSources, mcpReviewHome: input.mcpReviewHome, mcpLaunchCandidate: input.mcpLaunchCandidate, runtimeInstallerOptions: input.runtimeInstallerOptions, backgroundRuntimeDetectionMs: input.backgroundRuntimeDetectionMs, onChange(event) {
    for (const [client, state] of clients) if (state.initialized && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ jsonrpc: "2.0", method: "workspace.changed", params: event }));
  }, onAssistantPreview(clientId, frame) {
    for (const [client, state] of clients) if (state.id === clientId && state.initialized && client.readyState === WebSocket.OPEN) {
      // Only the originating opted-in view; preview is never an initialized-client broadcast.
      if (client.bufferedAmount > 256 * 1024) return false;
      client.send(JSON.stringify({ jsonrpc: "2.0", method: "workspace.assistant.preview", params: frame })); return true;
    }
    return false;
  } });
  await host.initialize();
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    const match = /^\/workspace-media\/([a-f0-9]{64})(\/path)?$/u.exec(request.url ?? "");
    const authorization = request.headers.authorization;
    if (closing || !match || !authorization?.startsWith("Bearer ") || !tokenMatches(authorization.slice(7), token) || !["GET", "HEAD"].includes(request.method ?? "")) {
      response.writeHead(404); response.end(); return;
    }
    try {
      const media = host.readMedia(match[1]!, request.headers.range, request.method === "HEAD", !!match[2]);
      if (match[2]) { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ path: media.path })); }
      else { response.writeHead(media.status, media.headers); response.end(media.bytes); }
    } catch (error) { response.writeHead(error instanceof RangeError ? 416 : 404); response.end(); }
  });
  const wss = new WebSocketServer({ server, maxPayload: 128 * 1024,
    verifyClient: (info: { origin: string }, done: (allowed: boolean, code?: number, message?: string) => void) => {
      const allowed = !info.origin || origins.has(info.origin); done(allowed, allowed ? undefined : 403, allowed ? undefined : "Forbidden");
    } });
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(opts.port, opts.host, resolve); }); }
  catch (error) { wss.close(); server.close(); await host.close(); throw error; }
  const port = (server.address() as { port: number }).port;
  // Private IPC discovery only. Neither stdout logs nor RPC metadata contain this token.
  const receiptFile = bindPrivateHaraStateFile(host.home, [input.mode === "workspace" ? "workspace-runtime" : "workspace-local-dev"], "serve-v2.json");
  const previous = readPrivateStateFileSnapshotSync(receiptFile.path, 4096);
  if (previous) {
    let pid: number | undefined;
    try { const parsed = JSON.parse(previous.text); if (positive(parsed.pid)) pid = parsed.pid; } catch { /* unknown is not dead */ }
    let dead = false; if (pid) { try { process.kill(pid, 0); } catch (error: any) { dead = error?.code === "ESRCH"; } }
    if (!dead) { wss.close(); server.close(); await host.close(); throw new Error("Workspace Dev discovery is already owned or malformed"); }
    removePrivateStateFile(receiptFile.path, previous, receiptFile.directory);
  }
  const receipt = { schemaVersion: 2, instanceId: randomUUID(), pid: process.pid, port, token, capability,
    ...(input.mode === "workspace" ? { executionMode: "workspace" } : input.realKeyFile ? { executionMode: "ark-real-key" } : {}) };
  try { writePrivateStateFileSync(receiptFile, JSON.stringify(receipt) + "\n", { expectedMissing: true }); }
  catch (error) { wss.close(); server.close(); await host.close(); throw error; }
  const ownedReceipt = readPrivateStateFileSnapshotSync(receiptFile.path, 4096)!;
  const dispatchMethod = async (client: Client, method: string, params: unknown, rpcId: string | number, receivedAt: number): Promise<unknown> => {
    if (!plain(params)) throw new Error("invalid Workspace RPC parameters");
    if (method === "initialize") {
      // Every reauthentication first retires the old connection authority, including failures.
      boundaryTransports?.disconnect(client.boundaryTransport); client.boundaryTransport = undefined; client.initialized = false;
      if (!tokenMatches(params.token, token)) throw new Error("unauthorized");
      if (params.clientCapabilities !== undefined && (!Array.isArray(params.clientCapabilities) || params.clientCapabilities.length > 32
        || !params.clientCapabilities.every(value => typeof value === "string" && value.length <= 100))) throw new Error("invalid client capabilities");
      client.boundaryTransport = boundaryTransports?.connect(client.id, params.boundaryCredential);
      host.setAssistantPreviewCapability(client.id, Array.isArray(params.clientCapabilities) && params.clientCapabilities.includes("workspace.assistant-preview.v1"));
      host.setExtensionClientCapability(client.id, Array.isArray(params.clientCapabilities) && params.clientCapabilities.includes("workspace.extensions.manager.v1"));
      host.setExtensionOwnerReviewCapability(client.id, Array.isArray(params.clientCapabilities) && params.clientCapabilities.includes("workspace.extensions.owner-review.v1"));
      client.initialized = true;
      const mode = host.modelMode();
      return { name: "hara", version: input.version, protocol: 1, provider: input.mode === "workspace" ? "workspace" : mode.syntheticOnly ? "synthetic" : "openai",
        model: mode.budget?.model ?? (input.mode === "workspace" ? "workspace-selected" : "hara-synthetic-v1"), cwd: host.project,
        instanceId: receipt.instanceId, runtimePlatform: { writeProtection: runtimeWriteProtection(), permissionTiers: availableRuntimePermissionTiers() }, capabilities: [capability, ...(boundaryTransports ? ["workspace.agent-boundaries.authority.v1"] : []), "workspace.extensions.v1", "workspace.extensions.manager.v1", "workspace.extensions.owner-review.v1", "workspace.user-interaction.v1", "workspace.interaction.v2", "workspace.local-channels.v1", "workspace.local-channels.peer.v1", "workspace.channel-pass.v1", "workspace.channel-queue.v1", "workspace.channel-autonomy.v1", "workspace.colleague-schedules.v1", "workspace.runtime-login-effort.v1", "workspace.runtime-form.v1", "workspace.media.v1", "workspace.media.states.v1", "workspace.i18n.v1", "workspace.agents.archive.v1", "workspace.runtime-proxy.v1", "workspace.runtime-stage-events.v1", "workspace.message-timing.v1", "workspace.assistant-preview.v1","workspace.native-session.v1","workspace.runtime-permissions.v1", ...(input.mode === "workspace" ? ["workspace.connection-models.v1"] : []), ...(input.realKeyFile ? ["workspace.real-key-slice.v1"] : [])], workspace: host.list(), ...mode };
    }
    if (!client.initialized) throw new Error("unauthorized");
    const fields = (allowed: readonly string[]) => { if (!exact(params, allowed)) throw new Error("unsupported Workspace RPC fields"); };
    if (method === "workspace.message-timing.clock") { fields([]); return { hostAtMs: performance.now() }; }
    if (method === "workspace.list") { fields([]); return host.list(); }
    if (method === "workspace.create") { fields(["label", "expectedRevision"]); if (!text(params.label, 80) || !positive(params.expectedRevision)) throw new Error("invalid Workspace creation"); return host.createWorkspace(params.label, params.expectedRevision); }
    if (method === "workspace.preferences.get") { fields([]); return host.getPreferences(); }
    if (method === "workspace.preferences.set") { fields(["theme", "expectedRevision", ...["executionDetails", "collapseDetails", "alwaysShowTimingDiagnostics", "updates"].filter(key => Object.hasOwn(params, key))]); return host.setPreferences(params.theme, params.expectedRevision as number, params); }
    if (method === "workspace.activity") { fields([]); return host.activity(); }
    if (method === "workspace.update.prepare") { fields(["approved"]); if (params.approved !== true) throw new Error("Explicit restart approval required"); return host.prepareUpdate(client.id); }
    if (method === "workspace.update.release") { fields(["id"]); if (!text(params.id)) throw new Error("Invalid update lease"); host.releaseUpdate(client.id, params.id); return { released: true }; }
    if (method.startsWith("workspace.boundaries.")) {
      // Authenticate the actual connection before any Workspace lookup, parser or metadata read.
      host.assertBoundaryTransport(client.boundaryTransport);
      if (!text(params.workspaceId) || (method !== "workspace.boundaries.linkExternal" && !text(params.agentId))) throw new AgentBoundaryContractError("INVALID_DOCUMENT", "authority.request");
      const workspaceId = params.workspaceId;
      if (method === "workspace.boundaries.get") {
        fields(["workspaceId", "agentId"]); return host.agentBoundaryView(client.boundaryTransport, workspaceId, params.agentId as string);
      }
      host.assertGeneration(workspaceId, params.expectedGeneration);
      if (method === "workspace.boundaries.prepareProject") {
        fields(["workspaceId", "expectedGeneration", "agentId"]); return host.prepareAgentBoundaryProject(client.boundaryTransport, workspaceId, params.agentId as string);
      }
      if (method === "workspace.boundaries.configure") {
        fields(["workspaceId", "expectedGeneration", "agentId", "expectedRevision", "duty", "boundary", "rights"]);
        return host.configureAgentBoundary(client.boundaryTransport, workspaceId, params.agentId as string,
          { expectedRevision: params.expectedRevision, duty: params.duty, boundary: params.boundary, rights: params.rights });
      }
      if (method === "workspace.boundaries.linkExternal") {
        fields(["workspaceId", "expectedGeneration", "expectedRevision", "externalAgentId", "instanceId", "agentId", "resourceId"]);
        return host.linkAgentBoundaryExecutor(client.boundaryTransport, workspaceId,
          { expectedRevision: params.expectedRevision, externalAgentId: params.externalAgentId, instanceId: params.instanceId, agentId: params.agentId, resourceId: params.resourceId });
      }
      if (method === "workspace.boundaries.draft") {
        fields(["workspaceId", "expectedGeneration", "agentId", "commandId", "rootRequestId", "operation", "lifetimeMs"]);
        return host.draftAgentBoundaryCommand(client.boundaryTransport, workspaceId, params.agentId as string,
          { commandId: params.commandId, rootRequestId: params.rootRequestId, operation: params.operation, lifetimeMs: params.lifetimeMs });
      }
      if (method === "workspace.boundaries.check") {
        fields(["workspaceId", "expectedGeneration", "agentId", "command"]);
        if (!plain(params.command) || params.command.agentId !== params.agentId) throw new AgentBoundaryContractError("INVALID_DOCUMENT", "authority.target");
        return host.checkAgentBoundaryCommand(client.boundaryTransport, workspaceId, params.command);
      }
      throw new AgentBoundaryContractError("INVALID_DOCUMENT", "authority.method");
    }
    const workspaceId = params.workspaceId;
    if (!text(workspaceId)) throw new Error("Workspace must be explicit");
    if (method === "workspace.select" || method === "workspace.settings.select") { fields(["workspaceId", "expectedRevision"]); if (!positive(params.expectedRevision)) throw new Error("invalid Workspace selection"); host.select(client.id, workspaceId, params.expectedRevision, method === "workspace.settings.select"); return host.snapshot(workspaceId, undefined, client.id); }
    if (method === "workspace.snapshot") { fields(["workspaceId", "agentId"]); if (params.agentId !== null && !text(params.agentId)) throw new Error("invalid Agent selection"); return host.snapshot(workspaceId, typeof params.agentId === "string" ? params.agentId : undefined, client.id); }
    host.assertGeneration(workspaceId, params.expectedGeneration);
    if (method === "workspace.rename") { fields(["workspaceId", "expectedGeneration", "label", "expectedRevision"]);
      if (!text(params.label, 80) || !positive(params.expectedRevision)) throw new Error("Invalid Workspace rename");
      return host.renameWorkspace(workspaceId, params.label, params.expectedRevision); }
    if (method === "workspace.media.register" || method === "workspace.media.describe") {
      fields(["workspaceId", "expectedGeneration", "path"]); if (!text(params.path, 4096)) throw new Error("Invalid Workspace media path");
      return host.registerMedia(workspaceId, params.path, method === "workspace.media.describe", client.id);
    }
    if (method === "workspace.session.paint") {
      fields(["workspaceId", "expectedGeneration", "agentId", "sessionId", "runId", "attemptId", "timing"]);
      const timing = parseMessageTimingInput(params.timing);
      if (!text(params.agentId) || ![params.sessionId, params.runId, params.attemptId].every(value => typeof value === "string" && UUID.test(value)) || !timing) throw new Error("Invalid message paint metadata");
      return host.recordMessagePaint(client.id, workspaceId, params.agentId, params.sessionId as string, params.runId as string, params.attemptId as string, timing);
    }
    if (method === "workspace.runtime.diagnostics.export") {
      fields(["workspaceId", "expectedGeneration", "agentId", "sessionId", "runId", "attemptId"]);
      if (!text(params.agentId) || ![params.sessionId, params.runId, params.attemptId].every(value => typeof value === "string" && UUID.test(value)))
        throw new Error("Invalid Runtime diagnostic identity");
      return host.exportRuntimeDiagnostic(workspaceId, params.agentId, params.sessionId as string, params.runId as string, params.attemptId as string);
    }
    if (method === "workspace.channels.list") { fields(["workspaceId", "expectedGeneration"]); return host.listChannels(workspaceId); }
    if (method === "workspace.channels.create" || method === "workspace.channels.update") {
      fields(["workspaceId", "expectedGeneration", "channelId", "name", "memberIds", "expectedRevision",
        ...(method.endsWith(".update") && Object.hasOwn(params, "autonomy") ? ["autonomy"] : [])]);
      if (typeof params.channelId !== "string" || !UUID.test(params.channelId) || !text(params.name, 80)) throw new Error("invalid local channel");
      return method.endsWith(".create") ? host.createChannel(client.id, workspaceId, params.channelId, params.name, params.memberIds, params.expectedRevision as number)
        : host.updateChannel(client.id, workspaceId, params.channelId, params.name, params.memberIds, params.expectedRevision as number, params.autonomy);
    }
    if (["workspace.channels.select", "workspace.channels.snapshot", "workspace.channels.cancel", "workspace.channels.resumeQueue", "workspace.channels.clearQueue"].includes(method)) {
      fields(["workspaceId", "expectedGeneration", "channelId"]);
      if (typeof params.channelId !== "string" || !UUID.test(params.channelId)) throw new Error("invalid local channel");
      if (method.endsWith(".resumeQueue")) return host.resumeChannelQueue(client.id, workspaceId, params.channelId);
      if (method.endsWith(".clearQueue")) return host.clearChannelQueue(client.id, workspaceId, params.channelId);
      if (method.endsWith(".select")) return host.selectChannel(client.id, workspaceId, params.channelId);
      if (method.endsWith(".cancel")) { host.cancelChannel(client.id, workspaceId, params.channelId); return { state: "draining" }; }
      return host.channelSnapshot(workspaceId, params.channelId, client.id);
    }
    if (method === "workspace.session.pause-question" || method === "workspace.channels.pause-question") {
      const channel = method.startsWith("workspace.channels.");
      fields(["workspaceId", "expectedGeneration", "agentId", "questionId", ...(channel ? ["channelId"] : [])]);
      if (!text(params.agentId) || typeof params.questionId !== "string" || !UUID.test(params.questionId)
        || (channel && (typeof params.channelId !== "string" || !UUID.test(params.channelId)))) throw new Error("invalid pending question pause");
      return host.pauseUserQuestion(client.id, workspaceId, params.agentId, params.questionId, channel ? params.channelId as string : undefined);
    }
    if (method === "workspace.session.answer-async" || method === "workspace.channels.answer-async") {
      const channel = method.startsWith("workspace.channels.");
      fields(["workspaceId", "expectedGeneration", "agentId", "questionId", "message", ...(channel ? ["channelId"] : [])]);
      if (!text(params.agentId) || typeof params.questionId !== "string" || !UUID.test(params.questionId) || !messageBody(params.message, 2000)
        || (channel && (typeof params.channelId !== "string" || !UUID.test(params.channelId)))) throw new Error("invalid async question answer");
      return host.answerAsyncQuestion(client.id, workspaceId, params.agentId, params.questionId, params.message, channel ? params.channelId as string : undefined);
    }
    if (method === "workspace.channels.answer") {
      fields(["workspaceId", "expectedGeneration", "channelId", "agentId", "questionId", "message", "requestId"]);
      if (typeof params.channelId !== "string" || !UUID.test(params.channelId) || !text(params.agentId)
        || typeof params.questionId !== "string" || !UUID.test(params.questionId) || !messageBody(params.message)
        || typeof params.requestId !== "string" || !UUID.test(params.requestId)) throw new Error("invalid channel user answer");
      return host.answerChannel(client.id, workspaceId, params.channelId, params.agentId, params.questionId, params.message, params.requestId);
    }
    if (method === "workspace.channels.send") {
      fields(["workspaceId", "expectedGeneration", "channelId", "message", "requestId", "recipientIds"]);
      if (typeof params.channelId !== "string" || !UUID.test(params.channelId) || !messageBody(params.message) || typeof params.requestId !== "string" || !UUID.test(params.requestId)) throw new Error("invalid local channel message");
      return host.sendChannel(client.id, workspaceId, params.channelId, params.message, params.requestId, params.recipientIds);
    }
    if (method === "workspace.channels.receipt") {
      fields(["workspaceId", "expectedGeneration", "channelId", "requestId"]);
      if (typeof params.channelId !== "string" || !UUID.test(params.channelId) || typeof params.requestId !== "string" || !UUID.test(params.requestId)) throw new Error("invalid local channel receipt");
      return host.channelReceipt(workspaceId, params.channelId, params.requestId);
    }
    if (method === "workspace.extensions.review.list") { fields(["workspaceId", "expectedGeneration"]); return host.mcpOwnerReviews(client.id, workspaceId); }
    if (method === "workspace.extensions.review.cancel") {
      fields(["workspaceId", "expectedGeneration", "recordId"]); if (!text(params.recordId, 80)) throw new Error("Invalid review record");
      return host.cancelMcpOwnerReview(client.id, workspaceId, params.recordId);
    }
    if (method === "workspace.extensions.review.describe") {
      fields(["workspaceId", "expectedGeneration", "recordId"]); if (!text(params.recordId, 80)) throw new Error("Invalid review record");
      return host.describeMcpOwnerReview(client.id, workspaceId, params.recordId);
    }
    if (["workspace.extensions.review.inspect", "workspace.extensions.review.approve", "workspace.extensions.review.revoke"].includes(method)) {
      fields(["workspaceId", "expectedGeneration", "recordId", "confirmed"]);
      if (!text(params.recordId, 80) || typeof params.confirmed !== "boolean") throw new Error("Invalid review decision");
      if (method.endsWith(".inspect")) return host.inspectMcpOwnerReview(client.id, workspaceId, params.recordId, params.confirmed);
      if (method.endsWith(".approve")) return host.approveMcpOwnerReview(client.id, workspaceId, params.recordId, params.confirmed);
      return host.revokeMcpOwnerReview(client.id, workspaceId, params.recordId, params.confirmed);
    }
    if (method === "workspace.extensions.list") {
      fields(["workspaceId", "expectedGeneration"]); return host.workspaceExtensions(workspaceId);
    }
    if (method === "workspace.extensions.describe") {
      fields(["workspaceId", "expectedGeneration", "sourceId"]);
      if (!text(params.sourceId, 256)) throw new Error("Invalid extension source");
      return host.workspaceExtensions(workspaceId, params.sourceId);
    }
    if (method === "workspace.agents.extensions.list") {
      fields(["workspaceId", "expectedGeneration", "agentId", "agentEpoch"]);
      if (!text(params.agentId) || !positive(params.agentEpoch)) throw new Error("Invalid extension colleague");
      return host.agentExtensions(workspaceId, params.agentId, params.agentEpoch);
    }
    if (method === "workspace.extensions.propose") {
      fields(["workspaceId", "expectedGeneration", "change", "expectedRevision"]);
      return host.proposeExtensions(client.id, workspaceId, params.change, params.expectedRevision as number);
    }
    if (method === "workspace.extensions.approve") {
      fields(["workspaceId", "expectedGeneration", "proposalId", "approved", "expectedRevision"]);
      if (typeof params.proposalId !== "string" || !UUID.test(params.proposalId) || typeof params.approved !== "boolean") throw new Error("Invalid extension approval");
      return host.approveExtensions(client.id, workspaceId, params.proposalId, params.approved, params.expectedRevision as number);
    }
    if (method === "workspace.features.list") { fields(["workspaceId", "expectedGeneration"]); return host.workspaceFeatures(workspaceId); }
    if (method === "workspace.tasks") { fields(["workspaceId", "expectedGeneration"]); return host.workspaceTasks(workspaceId); }
    if (method === "workspace.schedule.save") { fields(["workspaceId", "expectedGeneration", "input", "expectedRevision", "approved"]); return host.saveSchedule(workspaceId, params.input, params.expectedRevision as number, params.approved === true); }
    if (method === "workspace.schedule.delete") { fields(["workspaceId", "expectedGeneration", "id", "expectedRevision", "approved"]); if (!text(params.id)) throw new Error("Invalid schedule"); return host.deleteSchedule(workspaceId, params.id, params.expectedRevision as number, params.approved === true); }
    if (method === "workspace.schedule.run") { fields(["workspaceId", "expectedGeneration", "id", "approved"]); if (!text(params.id)) throw new Error("Invalid schedule"); return host.runSchedule(workspaceId, params.id, params.approved === true); }
    if (method === "workspace.features.update") { fields(["workspaceId", "expectedGeneration", "kind", "id", "enabled", "expectedRevision", ...(Object.hasOwn(params, "version") ? ["version"] : [])]); return host.updateFeature(workspaceId, params.kind, params.id, params.enabled, params.expectedRevision as number, params.version); }
    if (method === "workspace.skill.read") { fields(["workspaceId", "expectedGeneration", "id"]); if (!text(params.id)) throw new Error("Invalid skill"); return host.workspaceSkill(workspaceId, params.id); }
    if (method === "workspace.skill.fork") { fields(["workspaceId", "expectedGeneration", "id", "content", "approved", "expectedRevision"]); if (!text(params.id) || params.approved !== true) throw new Error("Private skill fork requires confirmation"); return host.forkWorkspaceSkill(workspaceId, params.id, params.content, params.expectedRevision as number); }
    if (method === "workspace.runtime.proxy.get") { fields(["workspaceId", "expectedGeneration"]); return host.runtimeProxy(workspaceId); }
    if (method === "workspace.runtime.proxy.set") { fields(["workspaceId", "expectedGeneration", "proxyUrl", "expectedRevision"]); return host.setRuntimeProxy(workspaceId, params.proxyUrl, params.expectedRevision as number); }
    if (method === "workspace.runtime.detect") { fields(["workspaceId", "expectedGeneration"]); await host.detectRuntimes(workspaceId); host.assertGeneration(workspaceId, params.expectedGeneration); return host.snapshot(workspaceId, undefined, client.id).runtimes; }
    if (method === "workspace.runtime.registerLocal") { fields(["workspaceId", "expectedGeneration", "runtimeId", "fingerprint", "approved",
      ...(Object.hasOwn(params, "loginSource") ? ["loginSource"] : [])]);
      if (params.approved !== true) throw new Error("Explicit local runtime approval required");
      // A new binding defaults to the host login; `isolated` must be asked for explicitly because it is
      // the mode that makes the user sign in again. The renderer's confirmation card is the human gate.
      if (params.loginSource !== undefined && params.loginSource !== "host" && params.loginSource !== "isolated") throw new Error("Invalid runtime login source");
      host.registerLocalRuntime(workspaceId, params.runtimeId, params.fingerprint, params.loginSource === "isolated" || params.loginSource === undefined && params.runtimeId === "agy" ? "isolated" : "host");
      return { registered: true }; }
    // Switching back and forth reuses `registerLocal` with the same verified fingerprint and a different
    // `loginSource`; no second method name is introduced for the same confirmed decision.
    if (method === "workspace.runtime.loginInstructions") { fields(["workspaceId", "expectedGeneration", "runtimeId"]); return host.runtimeLoginInstructions(workspaceId, params.runtimeId); }
    if (method === "workspace.runtime.formOptions") { fields(["workspaceId", "expectedGeneration", "runtimeId", ...(Object.hasOwn(params, "agentId") ? ["agentId"] : [])]);
      if (params.agentId !== undefined && !text(params.agentId)) throw new Error("Invalid runtime form colleague");
      return host.runtimeFormOptions(workspaceId, params.runtimeId, params.agentId as string | undefined); }
    if (method === "workspace.runtime.listModels") { fields(["workspaceId", "expectedGeneration", "runtimeId"]); return host.listRuntimeModels(workspaceId, params.runtimeId); }
    if (method === "workspace.runtime.selectModel") { fields(["workspaceId", "expectedGeneration", "runtimeId", "modelId", "expectedRevision",
      ...(Object.hasOwn(params, "effort") ? ["effort"] : [])]);
      await host.selectRuntimeModel(workspaceId, params.runtimeId, params.modelId, params.expectedRevision, params.effort); return { selected: true }; }
    if (method === "workspace.runtime.propose") { fields(["workspaceId", "expectedGeneration", "runtimeId"]); return host.proposeRuntime(client.id, workspaceId, params.runtimeId); }
    if (method === "workspace.runtime.approve") { fields(["workspaceId", "expectedGeneration", "proposalId", "approved",
      ...(Object.hasOwn(params, "loginSource") ? ["loginSource"] : [])]);
      if (typeof params.proposalId !== "string" || !UUID.test(params.proposalId) || typeof params.approved !== "boolean") throw new Error("invalid runtime approval");
      if (params.loginSource !== undefined && params.loginSource !== "host" && params.loginSource !== "isolated") throw new Error("Invalid runtime login source");
      return host.approveRuntime(client.id, workspaceId, params.proposalId, params.approved, params.loginSource === "isolated" ? "isolated" : "host"); }
    if (method === "workspace.runtime.cancel") { fields(["workspaceId", "expectedGeneration", "operationId"]);
      if (typeof params.operationId !== "string" || !UUID.test(params.operationId)) throw new Error("invalid runtime operation");
      host.cancelRuntime(workspaceId, params.operationId); return { state: "cancelling" }; }
    if (method === "workspace.agent.select") { fields(["workspaceId", "expectedGeneration", "agentId"]); if (!text(params.agentId)) throw new Error("invalid Agent selection"); host.selectAgent(client.id, workspaceId, params.agentId); return host.snapshot(workspaceId, params.agentId, client.id); }
    if (method === "workspace.agents.setPermissionTier") {
      fields(["workspaceId", "expectedGeneration", "agentId", "permissionTier", "configRevision", "agentEpoch"]);
      if (!text(params.agentId) || !isRuntimePermissionTier(params.permissionTier) || !positive(params.configRevision) || !positive(params.agentEpoch)) throw new Error("Invalid colleague permission update");
      return host.setAgentPermissionTier(workspaceId, params.agentId, params.permissionTier, params.configRevision, params.agentEpoch);
    }
    if (method === "workspace.agents.archiveStatus") {
      fields(["workspaceId", "expectedGeneration", "agentId", "configRevision", "agentEpoch"]);
      if (!text(params.agentId) || !positive(params.configRevision) || !positive(params.agentEpoch)) throw new Error("Invalid colleague archive status");
      return host.agentArchiveStatus(workspaceId, params.agentId, params.configRevision, params.agentEpoch);
    }
    if (method === "workspace.agents.setArchived") {
      fields(["workspaceId", "expectedGeneration", "agentId", "archived", "configRevision", "agentEpoch", ...(Object.hasOwn(params, "confirmedRunIds") ? ["confirmedRunIds"] : [])]);
      if (!text(params.agentId) || typeof params.archived !== "boolean" || !positive(params.configRevision) || !positive(params.agentEpoch))
        throw new Error("Invalid colleague lifecycle update");
      return host.setAgentArchived(workspaceId, params.agentId, params.archived, params.configRevision, params.agentEpoch, params.confirmedRunIds as string[] | undefined);
    }
    if (method === "workspace.agents.setRuntime") {
      fields(["workspaceId", "expectedGeneration", "agentId", "runtimeId", "configRevision", "agentEpoch"]);
      if (!text(params.agentId) || !isAgentRuntimeId(params.runtimeId) || !positive(params.configRevision) || !positive(params.agentEpoch)) throw new Error("invalid Workspace Agent Runtime update");
      return host.setAgentRuntime(workspaceId, params.agentId, params.runtimeId, params.configRevision, params.agentEpoch);
    }
    if (method === "workspace.agents.applyRuntimeForm") {
      fields(["workspaceId", "expectedGeneration", "agentId", "runtimeId", "configRevision", "agentEpoch",
        ...["confirm", "model"].filter(key => Object.hasOwn(params, key))]);
      if (!text(params.agentId) || !isAgentRuntimeId(params.runtimeId) || !positive(params.configRevision) || !positive(params.agentEpoch)) throw new Error("Invalid colleague engine form");
      const confirm = params.confirm, model = params.model;
      if (confirm !== undefined && (!plain(confirm) || !exact(confirm, ["fingerprint", "loginSource"]) || typeof confirm.fingerprint !== "string"
        || confirm.loginSource !== "host" && confirm.loginSource !== "isolated")) throw new Error("Invalid engine confirmation");
      if (model !== undefined && (!plain(model) || !exact(model, ["modelId", "expectedRevision", ...(Object.hasOwn(model, "effort") ? ["effort"] : [])])
        || model.effort !== undefined && model.effort !== null && typeof model.effort !== "string")) throw new Error("Invalid engine model choice");
      return host.applyRuntimeForm(workspaceId, { agentId: params.agentId, runtimeId: params.runtimeId, configRevision: params.configRevision, agentEpoch: params.agentEpoch,
        ...(confirm ? { confirm: { fingerprint: confirm.fingerprint as string, loginSource: confirm.loginSource as RuntimeLoginSource } } : {}),
        ...(model ? { model: { modelId: model.modelId, expectedRevision: model.expectedRevision, ...(Object.hasOwn(model, "effort") ? { effort: model.effort } : {}) } } : {}) });
    }
    if (method === "workspace.agents.updatePersona") {
      fields(["workspaceId", "expectedGeneration", "agentId", "input", "configRevision", "agentEpoch"]);
      if (!text(params.agentId) || !plain(params.input) || !exact(params.input, ["profile"]) || !plain(params.input.profile)
        || !positive(params.configRevision) || !positive(params.agentEpoch)) throw new Error("invalid Workspace Agent persona update");
      const profile = params.input.profile;
      if (!exact(profile, ["displayName", ...["title", "emoji", "avatar"].filter(key => Object.hasOwn(profile, key))])
        || !text(profile.displayName, 64)) throw new Error("invalid Workspace Agent persona profile");
      return host.updateAgentPersona(workspaceId, params.agentId, params.input as unknown as WorkspaceAgentPersonaInput, params.configRevision, params.agentEpoch);
    }
    if (method === "workspace.connection.synthetic") { fields(["workspaceId", "expectedGeneration", "expectedRevision"]); if (!Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 0) throw new Error("invalid connection revision"); host.configureSynthetic(workspaceId, params.expectedRevision as number); return host.snapshot(workspaceId, undefined, client.id); }
    if (method === "workspace.connection.approved") { fields(["workspaceId", "expectedGeneration", "expectedRevision"]); if (!Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 0) throw new Error("invalid connection revision"); host.configureApprovedConnection(workspaceId, params.expectedRevision as number); return host.snapshot(workspaceId, undefined, client.id); }
    if (method === "workspace.connection.add") { fields(["workspaceId", "expectedGeneration", "input", "expectedRevision"]); host.configureConnection(workspaceId, params.input, params.expectedRevision as number); return { configured: true }; }
    if (method === "workspace.connection.listModels") { fields(["workspaceId", "expectedGeneration", "agentId", "connectionId"]); if (input.mode !== "workspace" || !text(params.agentId) || !text(params.connectionId)) throw new Error("Invalid connection model request"); return host.listConnectionModels(workspaceId, params.agentId as string, params.connectionId as string); }
    if (method === "workspace.connection.legacy") { fields(["workspaceId", "expectedGeneration"]); return host.legacyConnections(workspaceId); }
    if (method === "workspace.connection.import") { fields(["workspaceId", "expectedGeneration", "sourceId", "approved", "expectedRevision"]); if (typeof params.sourceId !== "string" || typeof params.approved !== "boolean") throw new Error("Invalid import approval"); host.importConnection(workspaceId, params.sourceId, params.expectedRevision as number, params.approved); return { imported: true }; }
    if (method === "workspace.connection.edit") { fields(["workspaceId", "expectedGeneration", "connectionId", "input", "expectedRevision"]); if (typeof params.connectionId !== "string") throw new Error("Invalid connection"); host.editConnection(workspaceId, params.connectionId, params.input, params.expectedRevision as number); return { edited: true }; }
    if (method === "workspace.connection.select") { fields(["workspaceId", "expectedGeneration", "connectionId", "expectedRevision", ...(Object.hasOwn(params, "modelId") ? ["modelId"] : []), ...(Object.hasOwn(params, "effort") ? ["effort"] : [])]); if (typeof params.connectionId !== "string" || params.modelId !== undefined && typeof params.modelId !== "string" || params.effort !== undefined && params.effort !== null && typeof params.effort !== "string") throw new Error("Invalid connection selection"); host.selectConnection(workspaceId, params.connectionId, params.expectedRevision as number, params.modelId as string | undefined, params.effort as string | null | undefined); return { selected: true }; }
    if (method === "workspace.connection.delete") { fields(["workspaceId", "expectedGeneration", "connectionId", "expectedRevision", "approved"]); if (params.approved !== true || typeof params.connectionId !== "string") throw new Error("Explicit connection deletion approval required"); host.revokeConnection(workspaceId, params.connectionId, params.expectedRevision as number); return { deleted: true }; }
    if (method === "workspace.connection.cleanup") { fields(["workspaceId", "expectedGeneration", "connectionId", "expectedRevision", "approved"]); if (params.approved !== true || typeof params.connectionId !== "string") throw new Error("Explicit credential cleanup approval required"); host.cleanupCredentials(workspaceId, params.connectionId, params.expectedRevision as number); return { cleaned: true }; }
    if (method === "workspace.connection.migration.retry") { fields(["workspaceId", "expectedGeneration", "expectedRevision", "approved"]); if (params.approved !== true) throw new Error("Explicit migration retry approval required"); return host.retryConnectionMigration(workspaceId, params.expectedRevision as number, true); }
    if (method === "workspace.connection.revoke") { fields(["workspaceId", "expectedGeneration", "connectionId", "expectedRevision"]); if (!text(params.connectionId)) throw new Error("invalid connection"); host.revokeConnection(workspaceId, params.connectionId, params.expectedRevision as number); return { revoked: true }; }
    if (method === "workspace.approval.respond") { fields(["workspaceId", "expectedGeneration", "approvalId", "approved", ...(Object.hasOwn(params, "draft") ? ["draft"] : [])]); if (!text(params.approvalId) || typeof params.approved !== "boolean") throw new Error("invalid approval"); host.answerApproval(client.id, workspaceId, params.approvalId, params.approved, params.draft); return { accepted: true }; }
    if (method === "workspace.session.answer") {
      const clientTiming = Object.hasOwn(params, "timing") ? parseMessageTimingInput(params.timing) : undefined;
      if (clientTiming === null) throw new Error("Invalid message timing metadata");
      fields(["workspaceId", "expectedGeneration", "agentId", "message", "requestId", "questionId", ...(Object.hasOwn(params, "timing") ? ["timing"] : [])]);
      if (!text(params.agentId) || !messageBody(params.message) || typeof params.requestId !== "string" || !UUID.test(params.requestId)
        || typeof params.questionId !== "string" || !UUID.test(params.questionId)) throw new Error("invalid Workspace user answer");
      return host.start(client.id, workspaceId, params.agentId, params.message, params.requestId, true, undefined, undefined,
        { source: "ui", channel: "rpc", clientId: client.id, rpcIdHash: createHash("sha256").update(JSON.stringify(rpcId)).digest("hex") }, undefined, params.questionId, undefined, { receivedAt, client: clientTiming });
    }
    if (method === "workspace.session.send" || method === "workspace.session.resume") {
      const clientTiming = Object.hasOwn(params, "timing") ? parseMessageTimingInput(params.timing) : undefined;
      if (clientTiming === null) throw new Error("Invalid message timing metadata");
      fields(["workspaceId", "expectedGeneration", "agentId", "message", "requestId", ...(Object.hasOwn(params, "source") ? ["source"] : []), ...(Object.hasOwn(params, "timing") ? ["timing"] : [])]);
      if (!text(params.agentId) || !messageBody(params.message) || typeof params.requestId !== "string" || !UUID.test(params.requestId)) throw new Error("invalid Workspace message");
      if (params.source !== undefined && (!workspaceRequestSource(params.source) || !["ui", "cli", "automatic_retry"].includes(params.source))) throw new Error("invalid Workspace request source");
      return host.start(client.id, workspaceId, params.agentId, params.message, params.requestId, method.endsWith(".resume"), undefined, undefined,
        { source: params.source ?? "legacy_rpc", channel: "rpc", clientId: client.id, rpcIdHash: createHash("sha256").update(JSON.stringify(rpcId)).digest("hex") }, undefined, undefined, undefined, { receivedAt, client: clientTiming });
    }
    if (method === "workspace.session.receipt") {
      fields(["workspaceId", "expectedGeneration", "agentId", "requestId"]);
      if (!text(params.agentId) || typeof params.requestId !== "string" || !UUID.test(params.requestId)) throw new Error("invalid Workspace receipt request");
      return host.requestReceipt(workspaceId, params.agentId, params.requestId);
    }
    if (method === "workspace.session.new") {
      fields(["workspaceId", "expectedGeneration", "agentId", "expectedRevision", "expectedNativeRevision", "requestId", "approved"]);
      if (!text(params.agentId) || params.approved !== true || typeof params.requestId !== "string" || !UUID.test(params.requestId)
        || !Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 0
        || !Number.isSafeInteger(params.expectedNativeRevision) || Number(params.expectedNativeRevision) < 0) throw new Error("Explicit native session reset approval and current revisions required");
      return host.newNativeSession(client.id, workspaceId, params.agentId, Number(params.expectedRevision), Number(params.expectedNativeRevision), params.requestId);
    }
    if (method === "workspace.session.cancel") { fields(["workspaceId", "expectedGeneration", "agentId", "runId"]); if (!text(params.agentId) || !text(params.runId)) throw new Error("invalid cancel"); host.cancel(workspaceId, params.agentId, params.runId); return { state: "draining" }; }
    throw new Error("unsupported Workspace method; no legacy route or authority fallback");
  };
  wss.on("connection", ws => {
    const client: Client = { id: randomUUID(), initialized: false }; clients.set(ws, client);
    ws.on("error", () => {});
    ws.on("close", () => { boundaryTransports?.disconnect(client.boundaryTransport); host.disconnect(client.id); clients.delete(ws); });
    ws.on("message", raw => {
      const receivedAt = performance.now();
      void (async () => {
        let id: string | number | null = null;
        try {
          const request: unknown = JSON.parse(raw.toString());
          if (closing || !plain(request) || !exact(request, ["jsonrpc", "id", "method", "params"]) || request.jsonrpc !== "2.0"
            || (typeof request.id !== "string" && typeof request.id !== "number") || !text(request.method, 100)) throw new Error("invalid Workspace RPC request");
          id = request.id; const result = await dispatch(client, request.method, request.params, request.id, receivedAt);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Workspace request failed";
          // Fixed classification, not arbitrary provider errors/paths/credentials.
          const safe = message === "unauthorized" ? "unauthorized" : message.includes("真實模型") ? message
            : message.replaceAll(token, "[transport credential]").replaceAll(input.agentBoundaries?.ownerCredential ?? token, "[owner credential]").replaceAll(host.root, "[Dev state]").slice(0, 500);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: message === "unauthorized" ? -32001 : -32602, message: safe, data: { ...publicErrorData(error, [token, host.root, ...(input.agentBoundaries ? [input.agentBoundaries.ownerCredential] : [])]), ...(error instanceof AgentBoundaryContractError ? { boundary: { contract: AGENT_BOUNDARIES_CONTRACT, code: error.code, retry: AGENT_BOUNDARY_ERRORS[error.code] } } : {}), ...(error instanceof WorkspaceArchiveError ? { archiveReason: error.reason, retryable: true } : {}), ...(error instanceof RuntimeTierUnavailableError || error instanceof NativeEngineUnsupportedError ? { platformReason: error.code } : {}) } } }));
        }
      })();
    });
  });
  host.startScheduler();
  return { port, token, async close() {
    if (closing) return; closing = true; boundaryTransports?.close();
    await host.close();
    for (const client of clients.keys()) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections?.(); });
    try { removePrivateStateFile(receiptFile.path, ownedReceipt, receiptFile.directory); } catch { /* foreign replacement retained */ }
  } };
}
