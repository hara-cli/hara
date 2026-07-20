// hara serve protocol v1 — JSON-RPC 2.0 over WebSocket text frames. This is the contract the desktop
// shell (and any ACP/IDE client) speaks; the transport lives in server.ts, sessions in sessions.ts.
// Everything here is PURE (parse + frame builders + error codes) and unit-tested.
//
// Client → server requests:
//   initialize        {token,capabilities?}      → {name,version,protocol,cwd,provider,model,setupState,
//                                                   capabilities:{methods:[…]}}  (feature detection)
//   server.shutdown   {}                         → {accepted:true} (authenticated graceful local shutdown;
//                                                   BUSY while any client work/approval is active)
//   session.list      {cwd?}                     → {sessions:[{id,title,cwd,model,updatedAt}]}
//   session.create    {cwd?,approval?}           → {sessionId,model}
//   session.resume    {sessionId}                → {sessionId,model,history:[{role,text}]}
//   session.send      {sessionId,text,images?,newTask?} → (streams events, then) {reply,usage,taskId,turnId}
//   session.steer     {sessionId,text,expectedTurnId} → {accepted,taskId,turnId}
//                      images: [{path,mediaType?}] — pasted screenshots etc., inlined for vision models
//   session.interrupt {sessionId}                → {}
//   approval.reply    {approvalId,allow,always?}  → {}
//   plugins.list      {}                          → {plugins:[{name,version,description,enabled,skills,agents,mcpServers}]}
//   plugins.set       {name,enabled}              → {name,enabled}   (applies to future sessions/turns)
//   skills.list       {cwd?}                      → {skills:[{id,description,source}]}
//   automation.list   {}                          → {jobs:[{id,name,mode,enabled,lastRunAt,lastStatus,…}],
//                                                    sessions:[{id,title,source,sourceName,updatedAt,…}]}
//   models.list       {}                          → {models:[…], current, effortLevels:[…]}
//   settings.providers.list {}                    → redacted provider catalog + current profile state
//   settings.providers.test {provider,model,…}     → {ok,models,error?} (credential is ephemeral)
//   settings.providers.save {provider,model,…}     → redacted state (credential is never returned)
//   automation.add    {name,schedule,task,mode?,cwd?,tz?,deliver?,deliverMode?,alertAfter?}
//                                                               → {id,name,schedule}
//   automation.toggle {id,enabled}                → {id,enabled}
//   automation.delete {id}                        → {id,deleted}
//   artifact.import   {sourcePath,title?,kind?}    → {artifact,currentRevision,content}
//   artifact.list     {}                          → {artifacts,invalid,truncated}
//   artifact.get      {artifactId}                → {artifact,currentRevision,content}
//   artifact.revisions {artifactId}               → {artifactId,revisions}
//   session.rename    {sessionId,title}           → {sessionId,title}
//   session.archive   {sessionId,archived}        → {sessionId,archived}   (list hides archived unless {archived:true})
//   session.set-model {sessionId,model?,effort?}  → {sessionId,model,effort} (next turn; refused mid-turn)
// Server → client notifications (all carry sessionId):
//   event.text / event.reasoning {delta} · event.tool {name,preview} · event.diff {text}
//   event.notice {text} · event.turn_end {reply,usage,error?} · approval.request {approvalId,question}
//   event.task_state {version,taskId,turnId,objective,state,taskStatus,phase,checkpoint,…}
//                     authoritative execution plane; clients feature-detect it via capabilities.events

export const PROTOCOL_VERSION = 1;

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC error codes: standard ones plus hara-specific (-320xx). */
export const ERR = {
  PARSE: -32700,
  INVALID: -32600,
  METHOD: -32601,
  PARAMS: -32602,
  INTERNAL: -32603,
  UNAUTHORIZED: -32001, // initialize first (or bad token)
  BUSY: -32002, // requested operation conflicts with active server/session work
  NO_SESSION: -32003, // unknown/expired sessionId
  LOCKED: -32004, // session held by another live hara process (single-writer lock)
} as const;

/** Parse one inbound text frame into a request. Returns {error} (never throws) on malformed input —
 *  the transport turns that into a PARSE/INVALID error response. */
export function parseFrame(raw: string): { req: RpcRequest } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { error: "not JSON" };
  }
  const o = v as Partial<RpcRequest> | null;
  if (!o || typeof o !== "object" || o.jsonrpc !== "2.0" || typeof o.method !== "string" || !o.method) {
    return { error: "not a JSON-RPC 2.0 request" };
  }
  if (o.id !== undefined && typeof o.id !== "number" && typeof o.id !== "string") return { error: "bad id" };
  if (o.params !== undefined && (typeof o.params !== "object" || o.params === null || Array.isArray(o.params))) {
    return { error: "params must be an object" };
  }
  return { req: o as RpcRequest };
}

export function rpcResult(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

export function rpcError(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

export function rpcNotify(method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}
