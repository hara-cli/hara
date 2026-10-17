import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { LocalWorkspaceHost, type LocalWorkspaceProviderFactory } from "../workspace/local-host.js";
import { exact, messageBody, plain, positive, text, UUID } from "../workspace/local-state.js";
import type { ArkAcceptanceSlice } from "../workspace/real-key-provider.js";
import { bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, removePrivateStateFile, writePrivateStateFileSync } from "../security/private-state.js";
import type { ServeHandle, ServeOpts } from "./server.js";
import { workspaceRequestSource } from "../workspace/request-journal.js";

const CAPABILITY = "workspace.local-dev.v2";
function tokenMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual) || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
export async function startLocalWorkspaceServe(opts: ServeOpts, input: { root: string; version: string; realKeyFile?: string; realKeySlice?: ArkAcceptanceSlice; allowedOrigins?: readonly string[]; providerFactory?: LocalWorkspaceProviderFactory }): Promise<ServeHandle> {
  if (opts.host !== "127.0.0.1" || !Number.isSafeInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error("Workspace Dev listens only on explicit IPv4 loopback");
  const token = opts.token ?? randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid Workspace Dev transport token");
  const origins = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", ...(input.allowedOrigins ?? [])]);
  const clients = new Map<WebSocket, { id: string; initialized: boolean }>();
  let closing = false;
  const host = new LocalWorkspaceHost(input.root, { realKeyFile: input.realKeyFile, realKeySlice: input.realKeySlice, providerFactory: input.providerFactory, onChange(event) {
    for (const [client, state] of clients) if (state.initialized && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ jsonrpc: "2.0", method: "workspace.changed", params: event }));
  } });
  const wss = new WebSocketServer({ host: opts.host, port: opts.port, maxPayload: 128 * 1024,
    verifyClient: (info: { origin: string }, done: (allowed: boolean, code?: number, message?: string) => void) => {
      const allowed = !info.origin || origins.has(info.origin); done(allowed, allowed ? undefined : 403, allowed ? undefined : "Forbidden");
    } });
  try { await new Promise<void>((resolve, reject) => { wss.once("listening", resolve); wss.once("error", reject); }); }
  catch (error) { wss.close(); await host.close(); throw error; }
  const port = (wss.address() as { port: number }).port;
  // Private IPC discovery only. Neither stdout logs nor RPC metadata contain this token.
  const receiptFile = bindPrivateHaraStateFile(host.home, ["workspace-local-dev"], "serve-v2.json");
  const previous = readPrivateStateFileSnapshotSync(receiptFile.path, 4096);
  if (previous) {
    let pid: number | undefined;
    try { const parsed = JSON.parse(previous.text); if (positive(parsed.pid)) pid = parsed.pid; } catch { /* unknown is not dead */ }
    let dead = false; if (pid) { try { process.kill(pid, 0); } catch (error: any) { dead = error?.code === "ESRCH"; } }
    if (!dead) { wss.close(); await host.close(); throw new Error("Workspace Dev discovery is already owned or malformed"); }
    removePrivateStateFile(receiptFile.path, previous, receiptFile.directory);
  }
  const receipt = { schemaVersion: 2, instanceId: randomUUID(), pid: process.pid, port, token, capability: CAPABILITY,
    ...(input.realKeyFile ? { executionMode: "ark-real-key" } : {}) };
  try { writePrivateStateFileSync(receiptFile, JSON.stringify(receipt) + "\n", { expectedMissing: true }); }
  catch (error) { wss.close(); await host.close(); throw error; }
  const ownedReceipt = readPrivateStateFileSnapshotSync(receiptFile.path, 4096)!;
  const dispatch = async (client: { id: string; initialized: boolean }, method: string, params: unknown, rpcId: string | number): Promise<unknown> => {
    if (!plain(params)) throw new Error("invalid Workspace RPC parameters");
    if (method === "initialize") {
      if (!tokenMatches(params.token, token)) throw new Error("unauthorized");
      client.initialized = true;
      const mode = host.modelMode();
      return { name: "hara", version: input.version, protocol: 1, provider: mode.syntheticOnly ? "synthetic" : "openai",
        model: mode.budget?.model ?? "hara-synthetic-v1", cwd: host.project,
        instanceId: receipt.instanceId, capabilities: [CAPABILITY, ...(!mode.syntheticOnly ? ["workspace.real-key-slice.v1"] : [])], workspace: host.list(), ...mode };
    }
    if (!client.initialized) throw new Error("unauthorized");
    const fields = (allowed: readonly string[]) => { if (!exact(params, allowed)) throw new Error("unsupported Workspace RPC fields"); };
    if (method === "workspace.list") { fields([]); return host.list(); }
    if (method === "workspace.create") { fields(["label", "expectedRevision"]); if (!text(params.label, 80) || !positive(params.expectedRevision)) throw new Error("invalid Workspace creation"); return host.createWorkspace(params.label, params.expectedRevision); }
    const workspaceId = params.workspaceId;
    if (!text(workspaceId)) throw new Error("Workspace must be explicit");
    if (method === "workspace.select") { fields(["workspaceId", "expectedRevision"]); if (!positive(params.expectedRevision)) throw new Error("invalid Workspace selection"); host.select(client.id, workspaceId, params.expectedRevision); return host.snapshot(workspaceId, undefined, client.id); }
    if (method === "workspace.snapshot") { fields(["workspaceId", "agentId"]); if (params.agentId !== null && !text(params.agentId)) throw new Error("invalid Agent selection"); return host.snapshot(workspaceId, typeof params.agentId === "string" ? params.agentId : undefined, client.id); }
    host.assertGeneration(workspaceId, params.expectedGeneration);
    if (method === "workspace.agent.select") { fields(["workspaceId", "expectedGeneration", "agentId"]); if (!text(params.agentId)) throw new Error("invalid Agent selection"); host.selectAgent(client.id, workspaceId, params.agentId); return host.snapshot(workspaceId, params.agentId, client.id); }
    if (method === "workspace.connection.synthetic") { fields(["workspaceId", "expectedGeneration", "expectedRevision"]); if (!Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 0) throw new Error("invalid connection revision"); host.configureSynthetic(workspaceId, params.expectedRevision as number); return host.snapshot(workspaceId, undefined, client.id); }
    if (method === "workspace.connection.approved") { fields(["workspaceId", "expectedGeneration", "expectedRevision"]); if (!Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 0) throw new Error("invalid connection revision"); host.configureApprovedConnection(workspaceId, params.expectedRevision as number); return host.snapshot(workspaceId, undefined, client.id); }
    if (method === "workspace.connection.add") { fields(["workspaceId", "expectedGeneration", "input", "expectedRevision"]); host.configureConnection(workspaceId, params.input, params.expectedRevision as number); return { configured: true }; }
    if (method === "workspace.connection.revoke") { fields(["workspaceId", "expectedGeneration", "connectionId", "expectedRevision"]); if (!text(params.connectionId)) throw new Error("invalid connection"); host.revokeConnection(workspaceId, params.connectionId, params.expectedRevision as number); return { revoked: true }; }
    if (method === "workspace.approval.respond") { fields(["workspaceId", "expectedGeneration", "approvalId", "approved"]); if (!text(params.approvalId) || typeof params.approved !== "boolean") throw new Error("invalid approval"); host.answerApproval(client.id, workspaceId, params.approvalId, params.approved); return { accepted: true }; }
    if (method === "workspace.session.send" || method === "workspace.session.resume") {
      fields(["workspaceId", "expectedGeneration", "agentId", "message", "requestId", ...(Object.hasOwn(params, "source") ? ["source"] : [])]);
      if (!text(params.agentId) || !messageBody(params.message) || typeof params.requestId !== "string" || !UUID.test(params.requestId)) throw new Error("invalid Workspace message");
      if (params.source !== undefined && (!workspaceRequestSource(params.source) || !["ui", "cli", "automatic_retry"].includes(params.source))) throw new Error("invalid Workspace request source");
      return host.start(client.id, workspaceId, params.agentId, params.message, params.requestId, method.endsWith(".resume"), undefined, undefined,
        { source: params.source ?? "legacy_rpc", channel: "rpc", clientId: client.id, rpcIdHash: createHash("sha256").update(JSON.stringify(rpcId)).digest("hex") });
    }
    if (method === "workspace.session.receipt") {
      fields(["workspaceId", "expectedGeneration", "agentId", "requestId"]);
      if (!text(params.agentId) || typeof params.requestId !== "string" || !UUID.test(params.requestId)) throw new Error("invalid Workspace receipt request");
      return host.requestReceipt(workspaceId, params.agentId, params.requestId);
    }
    if (method === "workspace.session.cancel") { fields(["workspaceId", "expectedGeneration", "agentId", "runId"]); if (!text(params.agentId) || !text(params.runId)) throw new Error("invalid cancel"); host.cancel(workspaceId, params.agentId, params.runId); return { state: "draining" }; }
    throw new Error("unsupported Workspace method; no legacy route or authority fallback");
  };
  wss.on("connection", ws => {
    const client = { id: randomUUID(), initialized: false }; clients.set(ws, client);
    ws.on("error", () => {});
    ws.on("close", () => { host.disconnect(client.id); clients.delete(ws); });
    ws.on("message", raw => {
      void (async () => {
        let id: string | number | null = null;
        try {
          const request: unknown = JSON.parse(raw.toString());
          if (closing || !plain(request) || !exact(request, ["jsonrpc", "id", "method", "params"]) || request.jsonrpc !== "2.0"
            || (typeof request.id !== "string" && typeof request.id !== "number") || !text(request.method, 100)) throw new Error("invalid Workspace RPC request");
          id = request.id; const result = await dispatch(client, request.method, request.params, request.id);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Workspace request failed";
          // Fixed classification, not arbitrary provider errors/paths/credentials.
          const safe = message === "unauthorized" ? "unauthorized" : message.includes("真實模型") ? message
            : message.replaceAll(token, "[transport credential]").replaceAll(host.root, "[Dev state]").slice(0, 500);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: message === "unauthorized" ? -32001 : -32602, message: safe } }));
        }
      })();
    });
  });
  return { port, token, async close() {
    if (closing) return; closing = true;
    await host.close();
    for (const client of clients.keys()) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    try { removePrivateStateFile(receiptFile.path, ownedReceipt, receiptFile.directory); } catch { /* foreign replacement retained */ }
  } };
}
