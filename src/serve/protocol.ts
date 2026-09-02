// hara serve protocol v1 — JSON-RPC 2.0 over WebSocket text frames. This is the contract the desktop
// shell (and any ACP/IDE client) speaks; the transport lives in server.ts, sessions in sessions.ts.
// Everything here is PURE (parse + frame builders + error codes) and unit-tested.
//
// Client → server requests:
//   initialize        {token,capabilities?}      → {name,version,protocol,cwd,provider,model,setupState,
//                                                   capabilities:{methods:[…],events:[…],features:[…]}}
//                                                   (additive feature detection)
//   server.shutdown   {}                         → {accepted:true} (authenticated graceful local shutdown;
//                                                   BUSY while any client work/approval is active)
//   session.list      {cwd?,cursor?,limit?,archived?} → {sessions:[{id,title,cwd,model,profileId?,updatedAt}],
//                                                        page:{hasMore,limit,nextCursor?}}
//                                                        Interactive sessions only; automation history has
//                                                        its own cursor under automation.list.
//   external.sources.list {}                         → {sources:[{id,label,state,version?,reason?,capabilities}]}
//   external.sessions.list {sourceId?,cursor?,limit?,search?}
//                                                   → {sources,sessions:[{opaque id,sourceId,title,
//                                                        workspaceName,workspaceId,state,createdAt,updatedAt,
//                                                        origin?,ephemeral}],page}
//   external.sessions.create {sourceId:"runtime",cwd,agentKind:"codex"|"claude",title?}
//                                                   → {session,messages,readOnly:false,controlMode:"live"}
//   external.sessions.read {sessionId}              → {session,messages:[{id,role,text}],readOnly:boolean}
//   external.sessions.resume {sessionId}            → {session,messages,readOnly:false,controlMode:"managed"|"live"}
//   external.sessions.fork {sessionId}              → {sourceSessionId,session,messages,readOnly:false}
//   external.sessions.submit {sessionId,text}       → {sessionId,turnId,status,reply,error?}
//   external.sessions.steer {sessionId,text}        → {sessionId,turnId,accepted:true}
//   external.sessions.interrupt {sessionId}         → {}
//                                                        Personal Space only. Provider-native IDs, full paths,
//                                                        provider cursors and credentials never cross Serve. A
//                                                        source history is read-only until explicitly resumed in
//                                                        place or copied with the optional fork operation.
//   session.create    {cwd?,approval?,agentRef?} → {sessionId,title,cwd,model,profileId,spaceId,
//                                                   approval,updatedAt,source,agentRef?}
//   agents.list       {cwd?,sessionId?}          → {agents,offices,currentOfficeId}
//   session.resume    {sessionId,approval?}      → {sessionId,model,profileId,approval,history:[{role,text}]}
//                                                    approval only migrates legacy sessions with no saved choice.
//   session.history   {sessionId}                → {sessionId,model,profileId,approval?,history:[{role,text}],readOnly:true}
//                                                    Provider-independent local replay for unavailable routes.
//   session.fork      {sessionId,targetProfileId?,targetModel?,transferHistory?}
//                                                   → {sessionId,model,profileId,approval,history:[{role,text}]}
//                                                    Cross-route copies require transferHistory:true.
//   session.submit    {sessionId,text,images?,attachments?,newTask?,mode?,expectedTurnId?,expectedModel?,expectedEffort?}
//                                                   → {submission:"started",reply,usage,taskId,turnId,…}
//                                                   | {submission:"steered",taskId,turnId}
//                                                   | {submission:"not_submitted",reason,activeTurnId?}
//                      mode: "start_or_steer" (default) atomically starts an idle session or steers its
//                            authoritative live turn; "start_if_idle" and "steer" expose strict variants.
//                      newTask:true is never steerable: when occupied it returns not_idle and starts only
//                                   after the session is idle.
//                      expectedModel + expectedEffort guard a staged next-turn route from starting on an
//                                   older provider configuration during an idle transition.
//   session.send      {sessionId,text,images?,attachments?,newTask?} → (legacy start_if_idle; streams events, then)
//                                                             {reply,usage,taskId,turnId,status?,stopReason?}
//   session.steer     {sessionId,text,expectedTurnId} → {accepted,taskId,turnId} (legacy strict steer)
//                      images: [{path,mediaType?}] — pasted screenshots etc., inlined for vision models
//                      attachments: [{kind:"image"|"file"|"directory",path,mediaType?}]
//                      File-picker paths avoid lossy @mention encoding; Serve enforces type/security limits.
//   session.interrupt {sessionId}                → {}
//   approval.reply    {approvalId,allow,always?}  → {} (`always` persists only the engine-declared project scope)
//   plugins.list      {}                          → {plugins:[{name,version,description,enabled,skills,agents,mcpServers}]}
//   plugins.set       {name,enabled}              → {name,enabled}   (applies to future sessions/turns)
//   skills.list       {cwd?}                      → {skills:[{id,description,source}]}
//   learning.list     {cwd?,scope?,status?,limit?} → {learnings:[reviewable redacted candidates],summary}
//   learning.review   {id,decision,expectedRevision?,note?,cwd?}
//   learning.submit   {id,cwd?}                    → explicit redacted organization proposal upload
//   learning.sync     {cwd?}                       → versioned Control-approved organization bundle
//                                                    → {learning}; approve/reject/revoke local personal/project
//                                                    records only; organization records require Control review.
//   automation.list   {sessionCursor?,sessionLimit?} → {jobs:[{id,name,mode,enabled,task,scheduleSpec,
//                                                    delivery:{kind,label,mode?},nextRunAt?,nextRunDeferred?,…}],
//                                                    sessions:[{id,title,source,sourceName,jobId?,updatedAt,
//                                                               status?,startedAt?,finishedAt?,durationMs?,error?}],
//                                                    sessionPage:{hasMore,limit,nextCursor?},
//                                                    scheduler:{installed,supported,platform,detail}}
//                                                    Raw delivery targets are write-only and never returned.
//   models.list       {sessionId?}                → {models:[…],current,currentAvailable?,recommendedModel?,
//                                                    entries:[{id,providerId,available?,effortLevels,
//                                                    attachmentCapabilities}],current,profileId?,
//                                                    effortLevels:[…],attachmentCapabilities}
//   settings.providers.list {}                    → redacted provider catalog + current profile state
//   settings.providers.test {provider,model,…}     → {ok,models,error?} (credential is ephemeral)
//   settings.providers.save {provider,model,…}     → redacted state (credential is never returned)
//   settings.gateways.list {}                      → {gateways:[redacted configuration/runtime health]}
//   settings.gateways.login.start {platform:"weixin"} → {login:{id,phase,qrPayload?,qrRevision,…}}
//   settings.gateways.login.status {platform:"weixin",id?} → {login:{id,phase,qrPayload?,…}}
//   settings.gateways.login.cancel {platform:"weixin",id} → {login:{id,phase:"cancelled",…}}
//                                                    QR data stays on authenticated loopback; tokens never return
//   settings.organizations.list {cwd?}              → {activeId,activeSource,switchLocked,
//                                                    connections:[{id,label,model,availableModels?,accessState,…}]}
//   settings.organizations.enroll {id,label?,gatewayUrl,code,activate?,cwd?}
//                                                    → organization state (code/token never returned)
//   settings.organizations.use {id,cwd?}             → organization state
//   settings.organizations.remove {id,cwd?}          → organization state (local removal; no remote revoke)
//   settings.organizations.check {id,cwd?}           → {id,ok,checkedAt}
//   desk.connections.list {}                         → {connections:[{profileId,configured,needsRebind?,
//                                                        bindingRevision?,host?,agentId?,owner?}],legacyUnbound}
//                                                        Pure local read; Desk credentials are never returned.
//   desk.snapshot    {profileId,state?}               → {profileId,fetchedAt,me,tasks,agents,events,
//                                                        circles,truncated}
//                                                        Task summaries contain a short excerpt, not body.
//   desk.task.get    {profileId,taskId}               → {profileId,task:{...,body},events}
//                                                        Remote Desk reads are explicit and profile-pinned;
//                                                        changing the active organization cannot reroute them.
//   automation.validate {schedule,tz?,id?}         → {schedule,description,nextRuns:[…],nextRunDeferred?}
//   automation.add    {name,schedule,task,mode?,cwd?,tz?,deliver?,deliverMode?,alertAfter?}
//                                                               → {id,name,schedule}
//   automation.update {id,name,schedule,task,mode,cwd?,tz?,deliver?,deliverMode?,clearDeliver?,alertAfter?}
//                                                               → {id,name,schedule,scheduleSpec}
//                                                    Omit deliver to preserve it; clearDeliver removes it.
//   automation.run    {id}                         → {id,ok,error?}
//   automation.toggle {id,enabled}                → {id,enabled}
//   automation.delete {id}                        → {id,deleted}
//   automation.scheduler.install {}               → {scheduler:{installed,supported,platform,detail}}
//   artifact.import   {sourcePath,title?,kind?}    → {artifact,currentRevision,content}
//   artifact.commit   {artifactId,baseRevisionId,sourcePath,taskRunId?,changedPaths?}
//                                                   → {artifact,currentRevision,content}
//   artifact.revert   {artifactId,baseRevisionId,targetRevisionId,taskRunId?}
//                                                   → {artifact,currentRevision,content}
//   artifact.validate {artifactId,revisionId}      → {report:ValidationReport}
//   artifact.export   {artifactId,revisionId,validationReportId,destinationPath}
//                                                   → {receipt:ExportReceipt} (exact-format, create-only)
//   artifact.list     {}                          → {artifacts,invalid,truncated}
//   artifact.get      {artifactId}                → {artifact,currentRevision,content}
//   artifact.revisions {artifactId}               → {artifactId,revisions}
//   presentation.create {title?,project?}          → {artifact,currentRevision,content,project}
//   presentation.import {sourcePath,title?}        → {artifact,currentRevision,content,project,warnings}
//                                                     Accepts controlled Slidev Markdown or Hara JSON.
//   presentation.update {artifactId,baseRevisionId,project}
//                                                   → {artifact,currentRevision,content,project}
//   presentation.get {artifactId,revisionId?}      → {artifact,currentRevision,content,project}
//   presentation.validate {artifactId,revisionId}  → {report:ValidationReport}
//   presentation.export {artifactId,revisionId,validationReportId,destinationPath,format} // json|html|pdf|pptx
//                                                   → {receipt:ExportReceipt}; format=json|html|pdf|pptx
//   presentation.render {project}                  → {html} (bounded, ephemeral draft preview)
//   presentation.preview {artifactId,revisionId}    → {html,revisionId} (same renderer as HTML export)
//   presentation.preview-file {artifactId,revisionId} → {path,revisionId} (private local HTML)
//   session.rename    {sessionId,title}           → {sessionId,title}
//   session.archive   {sessionId,archived}        → {sessionId,archived}   (list hides archived unless {archived:true})
//   session.set-model {sessionId,model?,effort?}  → {sessionId,model,effort} (next turn; refused mid-turn)
//   session.set-approval {sessionId,approval}      → {sessionId,approval} (next turn; refused mid-turn)
// Server → client notifications (all carry sessionId):
//   event.text {delta} · event.tool {name,preview} · event.diff {text}
//   event.notice {text} · event.surface {kind,title,resource} · event.turn_end {reply,usage,error?,status?,stopReason?}
//   approval.request {approvalId,question,allowAlways}
//   event.task_state {version,streamId,sequence,taskId,turnId,objective,state,taskStatus,phase,checkpoint,…}
//                     authoritative execution plane; clients feature-detect it via capabilities.events.
// Provider reasoning content is intentionally never sent to persistent clients.

export const PROTOCOL_VERSION = 1;

/** One ordered Core routing decision. Adding this method is protocol-v1 compatible because clients
 * feature-detect methods during initialize; session.send/session.steer remain legacy adapters. */
export type SessionSubmitMode = "start_or_steer" | "start_if_idle" | "steer";

export type SessionNotSubmittedReason =
  | "not_idle"
  | "no_active_turn"
  | "expected_turn_mismatch"
  | "configuration_mismatch"
  | "active_turn_not_steerable"
  | "attachments_not_steerable"
  | "empty_input";

export type SessionSubmitResult<TStarted> =
  | ({ submission: "started" } & TStarted)
  | { submission: "steered"; taskId: string; turnId: string }
  | {
      submission: "not_submitted";
      reason: SessionNotSubmittedReason;
      activeTurnId?: string;
      expectedTurnId?: string;
      detail?: string;
    };

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
  CONFLICT: -32005, // optimistic version/base no longer matches the current object
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
