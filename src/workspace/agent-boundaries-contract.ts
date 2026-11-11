/** C0 portable wire contract. Parsing is NOT authentication, authorization or an execution permit.
 * No filesystem, network, clock, token store, runtime hook or permission issuer belongs here.
 * Canonical source: hara-cli/src/workspace/agent-boundaries-contract.ts. */
export const AGENT_BOUNDARIES_CONTRACT = "hara.agent-boundaries.v1" as const;
export const AGENT_BOUNDARIES_ACTION_PHASE = Object.freeze({
  "task.dispatch": "1.3.0", "task.stop": "1.3.0", "duty.update": "1.3.0", "boundary.update": "1.3.0",
  "agent.pause": "1.3.0", "agent.resume": "1.3.0", "agent.dismiss": "1.3.0",
  "task.reprioritize": "1.3.x", "task.handoff": "1.3.x", "agent.activity.read": "1.3.x",
  "agent.memory.read": "1.3.x", "approval.decide": "1.3.x", "agent.share": "1.3.x", "task.report.route": "1.3.x",
} as const);
export type AgentBoundaryAction = keyof typeof AGENT_BOUNDARIES_ACTION_PHASE;
export const AGENT_BOUNDARY_ERRORS = Object.freeze({
  CONTRACT_VERSION_UNSUPPORTED: "upgrade_contract",
  INVALID_DOCUMENT: "never",
  PERSONAL_MODE_ONLY: "never",
  ACTION_DEFERRED: "never",
  CONTEXT_MISMATCH: "refresh_state",
  AUTHORITY_UNVERIFIED: "never",
  AUTHORIZATION_DENIED: "never",
  GRANT_REVOKED: "refresh_state",
  STALE_REVISION: "refresh_state",
  COUNTER_EXHAUSTED: "never",
  CONTROL_HELD: "refresh_state",
  COMMAND_ID_CONFLICT: "original_receipt_only",
  EFFECT_OUTCOME_UNKNOWN: "original_receipt_only",
  RUNTIME_UNSUPPORTED: "never",
  BOUNDARY_CONFIRMATION_REQUIRED: "confirm_migration",
} as const);
export type AgentBoundaryErrorCode = keyof typeof AGENT_BOUNDARY_ERRORS;
export class AgentBoundaryContractError extends Error {
  readonly code: AgentBoundaryErrorCode;
  readonly field: string;
  constructor(code: AgentBoundaryErrorCode, field: string) {
    // Never interpolate values, unknown property names, paths, secrets or source documents.
    super(`Agent boundary contract: ${code} (${field})`);
    this.name = "AgentBoundaryContractError"; this.code = code; this.field = field;
  }
}
function fail(code: AgentBoundaryErrorCode, field: string): never { throw new AgentBoundaryContractError(code, field); }
type Guard<T> = (value: unknown, field: string) => T;
type Value<G> = G extends Guard<infer T> ? T : never;
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** Reject non-JSON objects/accessors before reading fields. Bounded before cloning/canonicalizing. */
function jsonOnly(value: unknown, depth = 0, budget = { nodes: 0, chars: 0 }): void {
  if (++budget.nodes > 20000 || depth > 20) fail("INVALID_DOCUMENT", "document");
  if (typeof value === "string") {
    budget.chars += value.length;
    if (budget.chars > 1048576) fail("INVALID_DOCUMENT", "document");
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail("INVALID_DOCUMENT", "document");
      } else if (c >= 0xdc00 && c <= 0xdfff) fail("INVALID_DOCUMENT", "document");
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return;
  if (!plain(value) && !(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype)) fail("INVALID_DOCUMENT", "document");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") fail("INVALID_DOCUMENT", "document");
    const descriptor = descriptors[key];
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) fail("INVALID_DOCUMENT", "document");
    if (Array.isArray(value) && key === "length") continue;
    if (!descriptor.enumerable) fail("INVALID_DOCUMENT", "document");
    budget.chars += key.length;
    if (key.length > 256 || budget.chars > 1048576) fail("INVALID_DOCUMENT", "document");
    jsonOnly(descriptor.value, depth + 1, budget);
  }
}
function literal<const T extends string | number | boolean | null>(expected: T, code: AgentBoundaryErrorCode = "INVALID_DOCUMENT"): Guard<T> {
  return (value, field) => value === expected ? expected : fail(code, field);
}
function choices<const T extends readonly string[]>(values: T): Guard<T[number]> {
  return (value, field) => typeof value === "string" && values.includes(value) ? value : fail("INVALID_DOCUMENT", field);
}
function text(max: number, pattern?: RegExp): Guard<string> {
  return (value, field) => typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && (!pattern || pattern.test(value)) ? value : fail("INVALID_DOCUMENT", field);
}
const prose: Guard<string> = (value, field) => typeof value === "string" && value.length <= 4096 && value.trim().length > 0
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value) ? value : fail("INVALID_DOCUMENT", field);
const id = text(160, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const uuid = text(36, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const workspaceId = text(39, /^ws_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const digest = text(64, /^[a-f0-9]{64}$/);
const revision: Guard<number> = (value, field) => Number.isSafeInteger(value) && Number(value) > 0 ? value as number : fail("INVALID_DOCUMENT", field);
const epoch: Guard<number> = (value, field) => Number.isSafeInteger(value) && Number(value) >= 0 ? value as number : fail("INVALID_DOCUMENT", field);
const bool: Guard<boolean> = (value, field) => typeof value === "boolean" ? value : fail("INVALID_DOCUMENT", field);
function nullable<T>(guard: Guard<T>): Guard<T | null> { return (value, field) => value === null ? null : guard(value, field); }
function list<T>(guard: Guard<T>, max = 128): Guard<T[]> {
  return (value, field) => {
    if (!Array.isArray(value) || value.length > max) return fail("INVALID_DOCUMENT", field);
    const parsed = Array.from(value, item => guard(item, field));
    if (new Set(parsed.map(item => canonical(item))).size !== parsed.length) return fail("INVALID_DOCUMENT", field);
    return parsed;
  };
}
function form<const S extends Record<string, Guard<unknown>>>(fields: S): Guard<{ [K in keyof S]: Value<S[K]> }> {
  return (value, field) => {
    if (!plain(value) || Object.keys(value).length !== Object.keys(fields).length
      || Object.keys(value).some(key => !Object.prototype.hasOwnProperty.call(fields, key))) return fail("INVALID_DOCUMENT", field);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(fields)) result[key] = fields[key](value[key], `${field}.${key}`);
    return result as { [K in keyof S]: Value<S[K]> };
  };
}
function tagged<const S extends Record<string, Guard<unknown>>>(fieldName: string, variants: S): Guard<Value<S[keyof S]>> {
  return (value, field) => {
    if (!plain(value) || typeof value[fieldName] !== "string" || !Object.prototype.hasOwnProperty.call(variants, value[fieldName] as string)) return fail("INVALID_DOCUMENT", field);
    return variants[value[fieldName] as keyof S](value, field) as Value<S[keyof S]>;
  };
}
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const version = literal(1, "CONTRACT_VERSION_UNSUPPORTED");
const personal = literal("personal", "PERSONAL_MODE_ONLY");
const future = literal(null, "PERSONAL_MODE_ONLY");
const issuer: Guard<string> = (value, field) => {
  const parsed = text(512)(value, field); let url: URL;
  try { url = new URL(parsed); } catch { return fail("INVALID_DOCUMENT", field); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.hostname.length > 253) return fail("INVALID_DOCUMENT", field);
  return parsed; // Never normalize/relabel an existing authority.
};
// Mirrors the existing WorkspaceResourceScope tuple; C1 verifies scopeKey and current generation.
const scope = form({ schemaVersion: version, workspaceId, authority: tagged("kind", {
  local: form({ kind: literal("local"), localAuthorityId: uuid }),
  account: form({ kind: literal("account"), accountRegion: choices(["CN", "GLOBAL"]), issuer, realmId: uuid }),
}) });
const context = form({
  scope, resourceBinding: form({ schemaVersion: version, scopeKey: digest, generation: uuid }),
  humanSubjectId: id, nodeId: id, deviceId: nullable(id),
  localGrant: form({ grantId: id, grantRevision: revision, humanSubjectId: id, nodeId: id }),
  collaboration: form({ organizationId: future, membershipId: future, membershipVersion: future, role: future, delegation: future }),
});
export type AgentBoundaryContext = Immutable<Value<typeof context>>;
function checkContext(value: AgentBoundaryContext): void {
  if (value.humanSubjectId !== value.localGrant.humanSubjectId || value.nodeId !== value.localGrant.nodeId) fail("CONTEXT_MISMATCH", "context.localGrant");
}
const base = { schemaVersion: version, mode: personal, context };
const tool = form({ toolId: id, connectorId: nullable(id), catalogRevision: revision });
const duty = form({ ...base, kind: literal("duty-profile"), agentId: id, dutyRevision: revision,
  publicProfile: form({ title: text(160), description: prose, owns: list(text(256)), rejects: list(text(256)) }),
});
export type AgentDutyProfile = Immutable<Value<typeof duty>>;
const boundary = form({ ...base, kind: literal("execution-boundary"), agentId: id, boundaryRevision: revision,
  // Opaque resource registry references, never a renderer-supplied filesystem root or wildcard grant.
  resources: list(form({ resourceId: id, access: list(choices(["read", "write", "execute"]), 3) })),
  tools: form({ allow: list(tool), deny: list(tool), readOnly: bool }),
  budget: form({ budgetRef: id, maxModelCalls: epoch, maxToolEffects: epoch }),
  approvalRequired: list(choices(["write", "execute", "external_send", "paid", "publish", "credentials", "policy_expand"]), 7),
  runtimeRequirements: list(choices(["resource_isolation", "effect_journal", "current_grant_check"]), 3),
});
export type AgentExecutionBoundary = Immutable<Value<typeof boundary>>;
const operation = tagged("action", {
  "task.dispatch": form({ action: literal("task.dispatch"), taskId: id, conversationId: id, messageDigest: digest }),
  "task.stop": form({ action: literal("task.stop"), taskId: id, runId: id, claimRevision: revision }),
  "duty.update": form({ action: literal("duty.update"), proposedDutyDigest: digest }),
  "boundary.update": form({ action: literal("boundary.update"), proposedBoundaryDigest: digest }),
  "agent.pause": form({ action: literal("agent.pause"), reason: choices(["human_request", "policy_change"]) }),
  "agent.resume": form({ action: literal("agent.resume"), holdId: id }),
  "agent.dismiss": form({ action: literal("agent.dismiss"), retention: literal("keep_records_and_recovery") }),
});
const timestamp: Guard<string> = (value, field) => {
  const parsed = text(24, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)(value, field);
  const date = new Date(parsed);
  return Number.isFinite(date.getTime()) && date.toISOString() === parsed ? parsed : fail("INVALID_DOCUMENT", field);
};
const command = form({ ...base, kind: literal("command"), commandId: id, rootRequestId: id, agentId: id,
  actorChain: form({ requestedBy: id, actingAgent: id, approvedBy: future, executingNode: id }),
  provenance: form({ channel: choices(["local_human", "signed_device"]), proofRef: id }),
  expected: form({ dutyRevision: revision, boundaryRevision: revision, controlEpoch: epoch }),
  issuedAt: timestamp, notAfter: timestamp, operation, intentDigest: digest,
});
export type AgentBoundaryCommand = Immutable<Value<typeof command>>;
const errorCodes = Object.keys(AGENT_BOUNDARY_ERRORS) as AgentBoundaryErrorCode[];
const wireError = form({ code: choices(errorCodes), retry: choices(["upgrade_contract", "never", "refresh_state", "original_receipt_only", "confirm_migration"]) });
const receipt = form({ ...base, kind: literal("command-receipt"), commandId: id, rootRequestId: id, agentId: id, intentDigest: digest,
  status: choices(["rejected", "accepted", "queued", "applying", "applied", "draining", "drained", "unknown"]),
  control: form({ epoch, holdId: nullable(id) }),
  execution: form({ drain: choices(["not_requested", "pending", "observed", "unknown"]), drainProofRef: nullable(id),
    effect: choices(["none", "accepted", "completed", "unknown"]), effectId: nullable(id) }),
  error: nullable(wireError),
});
export type AgentBoundaryReceipt = Immutable<Value<typeof receipt>>;
const claim = form({ ...base, kind: literal("work-claim"), rootRequestId: id, taskId: id, agentId: id,
  claimRevision: revision, attemptId: id, effect: choices(["none", "accepted", "completed", "unknown"]), effectId: nullable(id),
});
export type AgentBoundaryWorkClaim = Immutable<Value<typeof claim>>;
const routing = form({ ...base, kind: literal("owner-decision"), rootRequestId: id, dutyRevision: revision,
  state: choices(["owned", "needs_owner", "blocked"]), ownerAgentId: nullable(id),
  reason: choices(["current_owner", "explicit_human", "business_mapping", "no_match", "ambiguous", "classification_unavailable", "scope_denied", "unknown_effect"]),
});
export type AgentBoundaryOwnerDecision = Immutable<Value<typeof routing>>;
const migration = form({ ...base, kind: literal("migration-draft"), sourceFormat: literal("legacy-workspace"),
  sourceRef: id, sourceDigest: digest, state: literal("confirmation_required"),
  runnable: literal(false), issuedGrant: literal(null), reason: literal("BOUNDARY_CONFIRMATION_REQUIRED"),
});
export type AgentBoundaryMigrationDraft = Immutable<Value<typeof migration>>;
export type AgentBoundaryDocument = AgentDutyProfile | AgentExecutionBoundary | AgentBoundaryCommand
  | AgentBoundaryReceipt | AgentBoundaryWorkClaim | AgentBoundaryOwnerDecision | AgentBoundaryMigrationDraft;
const document = tagged("kind", { "duty-profile": duty, "execution-boundary": boundary, command,
  "command-receipt": receipt, "work-claim": claim, "owner-decision": routing, "migration-draft": migration });

/** Produces immutable syntax-checked wire data only. Still no authority, signature or grant validation. */
export function parseAgentBoundaryDocument(raw: unknown): Readonly<AgentBoundaryDocument> {
  jsonOnly(raw);
  if (!plain(raw)) return fail("INVALID_DOCUMENT", "document");
  version(raw.schemaVersion, "document.schemaVersion"); personal(raw.mode, "document.mode");
  if (raw.kind === "command" && plain(raw.operation) && typeof raw.operation.action === "string"
    && Object.prototype.hasOwnProperty.call(AGENT_BOUNDARIES_ACTION_PHASE, raw.operation.action)
    && AGENT_BOUNDARIES_ACTION_PHASE[raw.operation.action as AgentBoundaryAction] !== "1.3.0") return fail("ACTION_DEFERRED", "command.operation.action");
  const value = document(raw, "document"); checkContext(value.context);
  if (value.kind === "execution-boundary") {
    const unique = (keys: string[]) => { if (new Set(keys).size !== keys.length) fail("INVALID_DOCUMENT", "boundary.resourcesOrTools"); };
    unique(value.resources.map(resource => resource.resourceId));
    for (const tools of [value.tools.allow, value.tools.deny]) unique(tools.map(tool => JSON.stringify([tool.connectorId, tool.toolId])));
  }
  if (value.kind === "command") {
    const a = value.actorChain;
    if (a.requestedBy !== value.context.humanSubjectId || a.executingNode !== value.context.nodeId || a.actingAgent !== value.agentId) fail("CONTEXT_MISMATCH", "command.actorChain");
    if (value.provenance.channel === "signed_device" && value.context.deviceId === null) fail("INVALID_DOCUMENT", "command.provenance");
    if (value.notAfter <= value.issuedAt) fail("INVALID_DOCUMENT", "command.notAfter");
  }
  if (value.kind === "command-receipt") {
    if ((value.error && !["rejected", "unknown"].includes(value.status))
      || (value.error && AGENT_BOUNDARY_ERRORS[value.error.code] !== value.error.retry)
      || (value.status === "rejected" && value.error === null)) fail("INVALID_DOCUMENT", "receipt.error");
    if (value.execution.drain === "observed" && value.execution.drainProofRef === null) fail("INVALID_DOCUMENT", "receipt.execution");
    if ((value.execution.effect === "none") !== (value.execution.effectId === null)) fail("INVALID_DOCUMENT", "receipt.execution");
    if (value.execution.effect === "unknown" && (value.status !== "unknown" || value.error?.code !== "EFFECT_OUTCOME_UNKNOWN")) fail("INVALID_DOCUMENT", "receipt.execution");
    if (value.status === "drained" && value.execution.drain !== "observed") fail("INVALID_DOCUMENT", "receipt.execution");
  }
  if (value.kind === "work-claim" && (value.effect === "none") !== (value.effectId === null)) fail("INVALID_DOCUMENT", "claim.effect");
  if (value.kind === "owner-decision") {
    const owned = value.state === "owned";
    if (owned !== (value.ownerAgentId !== null) || (owned && !["current_owner", "explicit_human", "business_mapping"].includes(value.reason))
      || (!owned && ["current_owner", "explicit_human", "business_mapping"].includes(value.reason))
      || (value.reason === "unknown_effect" && value.state !== "blocked")) fail("INVALID_DOCUMENT", "routing.owner");
  }
  return freeze(value);
}
/** A namespace comparison, not verification that expected came from a trusted Host/Account. */
export function assertAgentBoundaryContext(value: AgentBoundaryDocument, expected: AgentBoundaryContext): void {
  jsonOnly(expected); const parsed = context(expected, "context"); checkContext(parsed);
  const parsedValue = parseAgentBoundaryDocument(value);
  if (canonical(parsedValue.context) !== canonical(parsed)) fail("CONTEXT_MISMATCH", "context");
}
/** Exact UTF-8 signing input: domain NUL + recursively key-sorted compact JSON, excluding intentDigest.
 * No Unicode/URL/whitespace normalization. C1 must compute SHA-256 and verify the genuine source proof.
 * This function neither signs, verifies a signature nor records/authorizes/replays a command. */
export function agentBoundaryCommandSigningText(value: AgentBoundaryCommand): string {
  const parsed = parseAgentBoundaryDocument(value);
  if (parsed.kind !== "command") return fail("INVALID_DOCUMENT", "command");
  const { intentDigest: _digest, ...intent } = parsed;
  return "hara-agent-boundaries-command-v1\0" + canonical(intent);
}
/** Non-destructive proposal only: never read HOME, map owns to resources or issue a grant.
 * C1 must compare the original bytes/digest under its source lock, current generation and live authority before separately confirming.
 * Broken legacy input is refused; this function never rewrites or deletes its source. */
export async function draftAgentBoundaryMigration(sourceText: string, sourceRef: string, expected: AgentBoundaryContext): Promise<Readonly<AgentBoundaryMigrationDraft>> {
  if (typeof sourceText !== "string" || sourceText.length > 1048576) return fail("INVALID_DOCUMENT", "migration.source");
  let legacy: unknown; try { legacy = JSON.parse(sourceText); } catch { return fail("INVALID_DOCUMENT", "migration.source"); }
  jsonOnly(legacy);
  if (!plain(legacy) || !Number.isSafeInteger(legacy.schemaVersion) || ![1, 2].includes(Number(legacy.schemaVersion))) return fail("INVALID_DOCUMENT", "migration.source");
  if (!globalThis.crypto?.subtle) return fail("RUNTIME_UNSUPPORTED", "migration.digest");
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourceText));
  const sourceDigest = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  const value = parseAgentBoundaryDocument({ schemaVersion: 1, mode: "personal", context: expected, kind: "migration-draft",
    sourceFormat: "legacy-workspace", sourceRef, sourceDigest, state: "confirmation_required", runnable: false,
    issuedGrant: null, reason: "BOUNDARY_CONFIRMATION_REQUIRED" });
  if (value.kind !== "migration-draft") return fail("INVALID_DOCUMENT", "migration");
  return value;
}


/** Agent Hub display/transport data is deliberately NOT an AgentBoundaryDocument.
 * No human context, actorChain, grant, command action or execution state is implied. */
const hubBinding = form({ schemaVersion: version, scopeKey: digest, generation: uuid });
export type HubResourceBindingV1 = Immutable<Value<typeof hubBinding>>;
const hubBase = { schemaVersion: version, mode: personal, binding: hubBinding };
const hubActor = form({ kind: literal("external-agent"), externalAgentId: id, instanceId: id });
export type HubExternalActorV1 = Immutable<Value<typeof hubActor>>;
const externalSource = form({ ...hubBase, kind: literal("external-agent-source"), actor: hubActor,
  identityBasis: literal("registered-credential"), humanPrincipal: future,
  contentTrust: literal("untrusted-reference"), use: literal("display-only"),
});
export type ExternalAgentSourceV1 = Immutable<Value<typeof externalSource>>;
/** These are recovery hints, never authority to auto-send or replay a message. */
export const AGENT_HUB_ERRORS = Object.freeze({
  invalid_request: "none", unauthorized: "none", conflict: "query_original",
  quota_exceeded: "explicit_user_only", unsupported_attachment: "none",
  registry_unavailable: "same_request_only", store_unavailable: "same_request_only",
  draft_present: "explicit_user_only", target_unavailable: "explicit_user_only",
  transport_unavailable: "explicit_user_only", dispatch_unknown: "query_original",
} as const);
export type HubErrorCodeV1 = keyof typeof AGENT_HUB_ERRORS;
const hubError = form({ code: choices(Object.keys(AGENT_HUB_ERRORS) as HubErrorCodeV1[]),
  retry: choices(["none", "same_request_only", "query_original", "explicit_user_only"]),
});
export type HubErrorV1 = Immutable<Value<typeof hubError>>;
const hubSavedFacts = form({ messageId: id, requestId: id, connectionId: id, seq: revision, savedAt: timestamp });
export type HubSavedFactsV1 = Immutable<Value<typeof hubSavedFacts>>;
const hubSavedReceipt = form({ ...hubBase, kind: literal("hub-ingress-receipt"), status: literal("saved"),
  messageId: id, requestId: id, connectionId: id, seq: revision, savedAt: timestamp,
});
export type HubSavedReceiptV1 = Immutable<Value<typeof hubSavedReceipt>>;
const hubTransportBase = { ...hubBase, kind: literal("hub-transport-receipt"), operationId: id,
  target: form({ externalAgentId: id, instanceId: id }), receiptRevision: revision,
};
const hubTransportReceipt = tagged("status", {
  accepted: form({ ...hubTransportBase, status: literal("accepted"), evidenceRef: literal(null), error: literal(null) }),
  queued: form({ ...hubTransportBase, status: literal("queued"), evidenceRef: id, error: literal(null) }),
  delivered: form({ ...hubTransportBase, status: literal("delivered"), evidenceRef: id, error: literal(null) }),
  rejected: form({ ...hubTransportBase, status: literal("rejected"), evidenceRef: literal(null), error: hubError }),
  unknown: form({ ...hubTransportBase, status: literal("unknown"), evidenceRef: nullable(id),
    error: form({ code: literal("dispatch_unknown"), retry: literal("query_original") }),
  }),
});
export type HubTransportReceiptV1 = Immutable<Value<typeof hubTransportReceipt>>;
export type HubReceiptV1 = HubSavedReceiptV1 | HubTransportReceiptV1;
export type AgentHubDocumentV1 = ExternalAgentSourceV1 | HubReceiptV1;
const hubDocument = tagged("kind", { "external-agent-source": externalSource,
  "hub-ingress-receipt": hubSavedReceipt, "hub-transport-receipt": hubTransportReceipt,
});
/** Syntax only: neither token authentication nor proof of storage/queue/delivery/execution. */
export function parseAgentHubDocument(raw: unknown): AgentHubDocumentV1 {
  jsonOnly(raw);
  if (!plain(raw)) return fail("INVALID_DOCUMENT", "hub.document");
  version(raw.schemaVersion, "hub.schemaVersion"); personal(raw.mode, "hub.mode");
  const value = hubDocument(raw, "hub.document");
  if (value.kind === "hub-transport-receipt" && value.error !== null) {
    if (AGENT_HUB_ERRORS[value.error.code] !== value.error.retry
      || (value.status === "rejected" && value.error.code === "dispatch_unknown")) return fail("INVALID_DOCUMENT", "hub.error");
  }
  return freeze(value);
}
/** Namespace comparison only; expected must come from the trusted Host's fixed Store binding. */
export function assertAgentHubBinding(value: AgentHubDocumentV1, expected: HubResourceBindingV1): void {
  jsonOnly(expected); const binding = hubBinding(expected, "hub.binding");
  const parsed = parseAgentHubDocument(value);
  if (canonical(parsed.binding) !== canonical(binding)) fail("CONTEXT_MISMATCH", "hub.binding");
}
export interface AgentHubBoundaryContractV1 {
  readonly externalSource: (agent: Readonly<{ agentId: string; instanceId: string }>) => ExternalAgentSourceV1;
  readonly isExternalSource: (value: unknown) => value is ExternalAgentSourceV1;
  readonly savedReceipt: (facts: HubSavedFactsV1) => HubSavedReceiptV1;
  readonly isSavedReceipt: (value: unknown) => value is HubSavedReceiptV1;
}
/** Pure adapter for Hub's mandatory factory/validator injection. Captures a copied binding;
 * the Host must authenticate a connection and supply its frozen registered agent/instance.
 * Raw `from` and external request claims must never be passed as the registered identity.
 * savedReceipt may prepare a candidate inside the Store transaction; persist it with
 * the idempotency record and publish/ACK it only after that transaction commits. */
export function createAgentHubBoundaryContract(expected: HubResourceBindingV1): AgentHubBoundaryContractV1 {
  jsonOnly(expected); const binding = freeze(hubBinding(expected, "hub.binding"));
  const matches = <K extends AgentHubDocumentV1["kind"]>(value: unknown, kind: K): value is Extract<AgentHubDocumentV1, { kind: K }> => {
    try {
      const parsed = parseAgentHubDocument(value);
      return parsed.kind === kind && canonical(parsed.binding) === canonical(binding);
    } catch (error) {
      if (error instanceof AgentBoundaryContractError) return false;
      throw error;
    }
  };
  return Object.freeze({
    externalSource(agent) {
      jsonOnly(agent);
      if (!plain(agent)) return fail("INVALID_DOCUMENT", "hub.agent");
      const parsed = parseAgentHubDocument({ schemaVersion: 1, mode: "personal", binding,
        kind: "external-agent-source", actor: { kind: "external-agent", externalAgentId: agent.agentId, instanceId: agent.instanceId },
        identityBasis: "registered-credential", humanPrincipal: null, contentTrust: "untrusted-reference", use: "display-only" });
      if (parsed.kind !== "external-agent-source") return fail("INVALID_DOCUMENT", "hub.source");
      return parsed;
    },
    isExternalSource(value): value is ExternalAgentSourceV1 { return matches(value, "external-agent-source"); },
    savedReceipt(facts) {
      jsonOnly(facts); const parsedFacts = hubSavedFacts(facts, "hub.savedFacts");
      const parsed = parseAgentHubDocument({ schemaVersion: 1, mode: "personal", binding,
        kind: "hub-ingress-receipt", status: "saved", ...parsedFacts });
      if (parsed.kind !== "hub-ingress-receipt") return fail("INVALID_DOCUMENT", "hub.receipt");
      return parsed;
    },
    isSavedReceipt(value): value is HubSavedReceiptV1 { return matches(value, "hub-ingress-receipt"); },
  } satisfies AgentHubBoundaryContractV1);
}
