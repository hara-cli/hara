import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { parseRegistryBinding, registryRecord } from "./registry-contract.js";

export const AGENT_HUB_NATIVE_CONTRACT = "hara.agent-hub-native.v1" as const;
export const NATIVE_HUB_LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  handoffBytes: 16 * 1024,
  challengeMs: 30_000,
  pending: 16,
  terminal: 256,
  connections: 256,
});
export const NATIVE_HUB_ERRORS = [
  "invalid_request", "unauthorized", "scope_changed", "stale_intent", "unsupported",
  "busy", "quota_exceeded", "conflict", "store_unavailable", "outcome_unknown",
] as const;
export type NativeHubErrorCode = typeof NATIVE_HUB_ERRORS[number];
export class NativeHubError extends Error {
  constructor(readonly code: NativeHubErrorCode) {
    super("Agent Hub Native: " + code);
    this.name = "NativeHubError";
  }
}
const invalid = (): never => { throw new NativeHubError("invalid_request"); };

type Schema = Readonly<Record<string, unknown>>;
type Wire<T> = Readonly<{ schema: Schema; parse(value: unknown): T }>;
type Parsed<W> = W extends Wire<infer T> ? T : never;
type Fields = Readonly<Record<string, Wire<unknown>>>;

// Each shape owns both its JSON Schema and its runtime projection. The output of
// parse contains only fresh, immutable JSON data, in the declared key order.
function record<const F extends Fields>(fields: F): Wire<{ readonly [K in keyof F]: Parsed<F[K]> }> {
  const keys = Object.keys(fields);
  return {
    schema: {
      type: "object", additionalProperties: false, required: keys,
      properties: Object.fromEntries(keys.map(key => [key, fields[key]!.schema])),
    },
    parse(value) {
      let row: Record<string, unknown>;
      try { row = registryRecord(value, keys); } catch { return invalid(); }
      const result = Object.fromEntries(keys.map(key => [key, fields[key]!.parse(row[key])]));
      return Object.freeze(result) as { readonly [K in keyof F]: Parsed<F[K]> };
    },
  };
}

function text(pattern: string, maxLength: number): Wire<string> {
  const full = "^(?:" + pattern + ")$(?![\\s\\S])";
  const re = new RegExp(full, "u");
  return { schema: { type: "string", maxLength, pattern: full },
    parse: value => typeof value === "string" && value.length <= maxLength && re.test(value) ? value : invalid() };
}

function integer(minimum: number, maximum = Number.MAX_SAFE_INTEGER): Wire<number> {
  return { schema: { type: "integer", minimum, maximum },
    parse: value => typeof value === "number" && Number.isSafeInteger(value)
      && !Object.is(value, -0) && value >= minimum && value <= maximum ? value : invalid() };
}

function literal<const T extends string | number | null>(marker: T): Wire<T> {
  return { schema: { const: marker }, parse: value => value === marker ? marker : invalid() };
}

function variants<const T extends readonly Wire<unknown>[]>(...options: T): Wire<Parsed<T[number]>> {
  return { schema: { anyOf: options.map(option => option.schema) }, parse(value) {
    for (const wire of options) {
      try { return wire.parse(value) as Parsed<T[number]>; }
      catch (error) {
        if (!(error instanceof NativeHubError) || error.code !== "invalid_request") throw error;
      }
    }
    return invalid();
  } };
}

function list<T>(item: Wire<T>, maxItems: number): Wire<readonly T[]> {
  return {
    schema: { type: "array", items: item.schema, maxItems },
    parse(value) {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maxItems
        || Reflect.ownKeys(value).length !== value.length + 1) return invalid();
      const result: T[] = [];
      for (let index = 0; index < value.length; index++) {
        const slot = Object.getOwnPropertyDescriptor(value, String(index));
        if (!slot?.enumerable || !("value" in slot)) return invalid();
        result.push(item.parse(slot.value));
      }
      return Object.freeze(result);
    },
  };
}

const definitions: Record<string, Schema> = {};
function named<T>(name: string, wire: Wire<T>): Wire<T> {
  definitions[name] = wire.schema;
  return { schema: { $ref: "#/$defs/" + name }, parse: wire.parse };
}

const version = literal(1);
const digest = named("digest", text("[a-f0-9]{64}", 64));
const uuidPattern = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const uuid = named("uuid", text(uuidPattern, 36));
const workspaceId = text("ws_" + uuidPattern, 39);
const agentId = named("agentId", text("ext_(codex|claude|opencode|runtime)_[a-f0-9]{24}", 40));
const resourceId = text("[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", 160);
const label = named("label", text("[^\\x00-\\x1f\\x7f-\\x9f\\u202a-\\u202e\\u2066-\\u2069\\ud800-\\udfff]+", 160));
const engine = variants(literal("codex"), literal("claude"), literal("opencode"));
const positive = integer(1);
const revision = integer(0);
const bytes = integer(0, 128 * 1024 * 1024);
const noValue = literal(null);
const binding = named("binding", record({ schemaVersion: version, scopeKey: digest, generation: uuid }));
const view = { workspaceId, viewEpoch: revision };
const action = { operationId: uuid, intentDigest: digest };
const selection = named("view", record(view));

const hostFields = { installId: uuid, hostInstanceId: uuid, port: integer(1, 65_535) };
const attachHello = named("attachHello", record({ ...hostFields, clientNonce: digest }));
const attachFinish = named("attachFinish", record({
  ...hostFields, clientNonce: digest, serverNonce: digest, clientProof: digest,
}));
const attachProof = named("attachProof", record({ serverNonce: digest, serverProof: digest }));
const attached = named("attached", record({ sessionToken: digest }));

const launch = { kind: literal("launch"), engine, resourceId };
const target = named("target", variants(
  record({ ...launch, label: variants(label, noValue) }),
  record(launch),
  record({ kind: literal("grant"), agentId, instanceId: uuid }),
  record({ kind: literal("rotate"), connectionId: uuid }),
  record({ kind: literal("revoke"), connectionId: uuid }),
  record({ kind: literal("cleanup"), targetBytes: integer(1, 128 * 1024 * 1024) }),
));

const message = { ...view, connectionId: uuid, messageId: uuid };
const parameters = {
  "attach.hello": attachHello,
  "attach.finish": attachFinish,
  detach: record({}),
  describe: selection,
  "registry.list": selection,
  "messages.list": record({ ...view, connectionId: uuid, afterSeq: revision, limit: integer(1, 50) }),
  "message.read": record(message),
  "attachment.read": record({ ...message, attachmentId: uuid }),
  "read.mark": record({ ...view, connectionId: uuid, throughSeq: revision }),
  "control.prepare": record({ ...view, target }),
  "control.cancel": record(action),
  "control.status": record(action),
  "control.commit": record({ ...action, challenge: digest }),
} as const;

type Method = keyof typeof parameters;
export type NativeRequest<M extends Method = Method> = {
  [K in M]: Readonly<{ schemaVersion: 1; method: K; params: Parsed<typeof parameters[K]> }>
}[M];
const wireMethods = Object.keys(parameters) as Method[];
const requests = Object.fromEntries(wireMethods.map(method =>
  [method, record({ schemaVersion: version, method: literal(method), params: parameters[method] })])) as
    { [M in Method]: Wire<NativeRequest<M>> };
const request = named("request", variants(...wireMethods.map(method => requests[method])));

const subject = record({ agentId, instanceId: uuid });
const launchWitness = record({ launchRef: uuid, handoffLocationDigest: digest, materialRootIdentityDigest: digest });
const cleanupWitness = record({ planId: uuid, planDigest: digest });
const summary = record({ label, details: list(label, 32), count: integer(0, 4096), bytes });
const factsFields = {
  registryRevision: revision, grantEpoch: variants(positive, noValue), catalogDigest: digest,
  policyDigest: digest, selectionDigest: digest,
  subject: variants(subject, noValue), launch: variants(launchWitness, noValue), cleanup: variants(cleanupWitness, noValue),
  summary,
};
const facts = named("facts", record(factsFields));
const intent = named("intent", record({
  schemaVersion: version, operationId: uuid, hostInstanceId: uuid, nativeSessionId: uuid,
  ...view, binding, admissionEpoch: revision, target, facts,
}));
const prepared = named("prepared", record({
  intent, intentDigest: digest, challenge: digest, expiresInMs: literal(NATIVE_HUB_LIMITS.challengeMs),
}));
const effect = named("effect", variants(
  record({ kind: literal("launch"), agentId, instanceId: uuid }),
  record({ kind: literal("grant"), connectionId: uuid, grantEpoch: positive }),
  record({ kind: literal("rotate"), connectionId: uuid, grantEpoch: positive }),
  record({ kind: literal("revoke"), connectionId: uuid, handoff: variants(literal("removed"), literal("unknown")) }),
  record({ kind: literal("cleanup"), planId: uuid, complete: variants(literal("complete"), literal("partial")), removedBytes: bytes }),
));
const safeError = variants(...NATIVE_HUB_ERRORS.map(code => literal(code)));
const operationResult = named("operationResult", variants(
  record({ ...action, status: literal("applied"), effect, error: noValue }),
  record({ ...action, status: literal("pending"), effect: noValue, error: noValue }),
  record({ ...action, status: literal("rejected"), effect: noValue, error: safeError }),
  record({ ...action, status: literal("unknown"), effect: noValue, error: literal("outcome_unknown") }),
));

const identity = named("fileIdentity", variants(
  record({ platform: literal("posix"), device: text("0|[1-9][0-9]{0,19}", 20), inode: text("[1-9][0-9]{0,19}", 20) }),
  record({ platform: literal("win32"), volume: text("[a-f0-9]{16}", 16), fileId: text("[a-f0-9]{32}", 32) }),
));
const pathText = text("[^\\x00-\\x1f\\x7f-\\x9f\\ud800-\\udfff]+", 4096);
const endpoint = text("http://127\\.0\\.0\\.1:[1-9][0-9]{0,4}", 24);
const handoff = named("handoff", record({
  schemaVersion: literal(2), endpoint, scopeKey: digest, generation: uuid, hostInstanceId: uuid,
  agentId, instanceId: uuid, launchRef: uuid, policyDigest: digest, connectionId: uuid,
  from: text("agent-ext_(codex|claude|opencode|runtime)_[a-f0-9]{24}", 46), grantEpoch: positive,
  materialRoot: record({ resourceId, revision: positive, path: pathText, fileIdentity: identity }),
  recoveryRoot: record({ path: pathText, fileIdentity: identity }),
  token: digest,
}));

export type NativeAttachHello = Parsed<typeof attachHello>;
export type NativeAttachFinish = Parsed<typeof attachFinish>;
export type NativeAttachProof = Parsed<typeof attachProof>;
export type NativeAttached = Parsed<typeof attached>;
export type NativeControlTarget = Parsed<typeof target>;
export type NativeControlFacts = Parsed<typeof facts>;
export type NativeControlIntent = Parsed<typeof intent>;
export type PreparedNativeControl = Parsed<typeof prepared>;
export type NativeControlEffect = Parsed<typeof effect>;
export type NativeControlResult = Parsed<typeof operationResult>;
export type NativeHandoff = Parsed<typeof handoff>;

export const parseNativeRequest = request.parse;
export const parseNativeView = selection.parse;
export const parseNativePrepareParams = parameters["control.prepare"].parse;
export const parseNativeActionRef = parameters["control.status"].parse;
export const parseNativeCommitParams = parameters["control.commit"].parse;
export const parseNativeAttachHello = attachHello.parse;
export const parseNativeAttachFinish = attachFinish.parse;
export const parseNativeAttachProof = attachProof.parse;
export const parseNativeAttached = attached.parse;
export const parseNativeControlFacts = facts.parse;
export const parseNativeControlEffect = effect.parse;
export const parseNativeControlResult = operationResult.parse;

export function parseNativeControlIntent(value: unknown): NativeControlIntent {
  const parsed = intent.parse(value);
  const { target: selection, facts: witness } = parsed;
  parseRegistryBinding(parsed.binding);
  if (selection.kind === "launch" || selection.kind === "cleanup") {
    if (witness.subject || witness.launch || witness.grantEpoch !== null
      || (selection.kind === "cleanup") !== (witness.cleanup !== null)) return invalid();
  } else {
    if (!witness.subject || !witness.launch || witness.cleanup
      || (selection.kind === "grant") !== (witness.grantEpoch === null)) return invalid();
    if (selection.kind === "grant" && (selection.agentId !== witness.subject.agentId
      || selection.instanceId !== witness.subject.instanceId)) return invalid();
  }
  return parsed;
}

export function parsePreparedNativeControl(value: unknown): PreparedNativeControl {
  const parsed = prepared.parse(value);
  if (nativeIntentDigest(parsed.intent) !== parsed.intentDigest) return invalid();
  return parsed;
}

export function parseNativeHandoff(value: unknown): NativeHandoff {
  const parsed = handoff.parse(value);
  if (Number(parsed.endpoint.slice("http://127.0.0.1:".length)) > 65_535 || parsed.from !== "agent-" + parsed.agentId
    || parsed.materialRoot.fileIdentity.platform !== parsed.recoveryRoot.fileIdentity.platform
    || Buffer.byteLength(JSON.stringify(parsed)) > NATIVE_HUB_LIMITS.handoffBytes) return invalid();
  for (const root of [parsed.materialRoot, parsed.recoveryRoot]) {
    const p = root.fileIdentity.platform === "posix" ? path.posix : path.win32;
    if (!p.isAbsolute(root.path) || p.parse(root.path).root === root.path || p.normalize(root.path) !== root.path) return invalid();
    if (p === path.win32 && (!/^[A-Za-z]:\\/.test(root.path) || root.path.slice(2).includes(":"))) return invalid();
  }
  return parsed;
}

function readUtf8Json(bytes: Uint8Array, limit: number): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > limit) return invalid();
  const input = Buffer.from(bytes), text = input.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(input)) return invalid();
  try { return JSON.parse(text); } catch { return invalid(); }
}

export function decodeNativeRequest(bytes: Uint8Array): NativeRequest {
  return parseNativeRequest(readUtf8Json(bytes, NATIVE_HUB_LIMITS.requestBytes));
}

export function decodeNativeHandoff(bytes: Uint8Array): NativeHandoff {
  return parseNativeHandoff(readUtf8Json(bytes, NATIVE_HUB_LIMITS.handoffBytes));
}

export const nativeSha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
export const nativeIntentDigest = (value: NativeControlIntent): string =>
  nativeSha256(JSON.stringify([AGENT_HUB_NATIVE_CONTRACT, "control.intent", parseNativeControlIntent(value)]));

/** A fixed directional tuple. Workspace token bytes and owner secret are never part of the tuple. */
export function nativeAttachProof(ownerCredential: string, direction: "attach.server" | "attach.client",
  hello: NativeAttachHello, serverNonce: string, workspaceTokenDigest: string): string {
  digest.parse(ownerCredential);
  if (direction !== "attach.server" && direction !== "attach.client") return invalid();
  const fields = attachHello.parse(hello);
  const tuple = [AGENT_HUB_NATIVE_CONTRACT, direction, fields.installId, fields.hostInstanceId, fields.port,
    fields.clientNonce, digest.parse(serverNonce), digest.parse(workspaceTokenDigest)];
  return createHmac("sha256", Buffer.from(ownerCredential, "hex")).update(JSON.stringify(tuple), "utf8").digest("hex");
}

export const nativeControlSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:hara:agent-hub-native:v1",
  anyOf: [request.schema, attachProof.schema, attached.schema, prepared.schema, operationResult.schema, handoff.schema],
  $defs: definitions,
});
