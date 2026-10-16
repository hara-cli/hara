// Trusted host composition only. Account membership is NOT an Agent, tool, model, or HostGrant.
// This module is deliberately not wired into legacy startup or advertised as an RPC capability.
import { createPublicKey, verify } from "node:crypto";
import { loadMobileState, type MobileCompanionState } from "../mobile/state.js";
import { parseWorkspaceResourceScope, type WorkspaceResourceScope } from "./resource-context.js";
import { WorkspaceResources, type WorkspaceResourceAction } from "./resources.js";
export type { WorkspaceResourceAction } from "./resources.js";

export type WorkspaceAdmissionCode = "AUTH_REQUIRED" | "SCOPE_CHANGED" | "ACCESS_DENIED" | "ACCESS_EXPIRED"
  | "INVALID_ASSERTION" | "AUTHORITY_UNAVAILABLE" | "CANCELLED";
export class WorkspaceAdmissionError extends Error {
  constructor(readonly code: WorkspaceAdmissionCode) { super(code); this.name = "WorkspaceAdmissionError"; }
}
export interface WorkspaceResourcePrincipal {
  readonly accountId: string;
  readonly principalId: string;
  readonly membershipId: string;
  readonly membershipVersion: number;
  readonly policyVersion: number;
  readonly role: "OWNER" | "ADMIN" | "MEMBER";
}
interface Options {
  hostHome: string;
  /** Already enrolled scope from trusted host state, never a renderer/model-supplied authority. */
  scope: WorkspaceResourceScope;
  /** Pinned Account workspace-context audience; never inferred from an unverified token. */
  contextAudience: string;
  /** Host policy is explicit and independent of Account membership. No default-allow role mapping. */
  authorize: (principal: Readonly<WorkspaceResourcePrincipal>, action: WorkspaceResourceAction) => boolean;
  loadState?: () => MobileCompanionState | null;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Test transport only; the signed issuer remains the original canonical HTTPS scope issuer. */
  testTransportOrigin?: string;
}
const ACTIONS = new Set<WorkspaceResourceAction>(["read", "configure", "history-write", "memory-write", "task-binding"]);
const MAX_LEASE_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;
const fail = (code: WorkspaceAdmissionCode): never => { throw new WorkspaceAdmissionError(code); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]): boolean => Object.keys(value).length === fields.length
  && fields.every(field => Object.hasOwn(value, field));
const id = (value: unknown, max = 160): value is string => typeof value === "string" && value.length > 0
  && value.length <= max && !/[\s\p{Cc}\p{Cf}]/u.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function decode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return fail("INVALID_ASSERTION");
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) return fail("INVALID_ASSERTION");
  return bytes;
}

/** Validate Account's existing ES256 workspace_context v1 without adding a second token purpose or
 * using any token-supplied key URL. JWKS is fetched from the pinned issuer, without Account credentials.
 * A signature proves the assertion, not fresh revocation; freshness comes from a new authenticated
 * context request on every operation. Even that is a bounded snapshot, not a distributed transaction. */
function principal(token: unknown, jwks: unknown, scope: WorkspaceResourceScope, audience: string,
  accountId: string, now: number, requestedAt: number): { value: Readonly<WorkspaceResourcePrincipal>; expiresAt: number } {
  try {
    if (typeof token !== "string" || token.length > 16_384 || scope.authority.kind !== "account") return fail("INVALID_ASSERTION");
    const parts = token.split(".");
    if (parts.length !== 3) return fail("INVALID_ASSERTION");
    const header: unknown = JSON.parse(decode(parts[0]!).toString("utf8"));
    const claims: unknown = JSON.parse(decode(parts[1]!).toString("utf8"));
    const signature = decode(parts[2]!);
    if (!object(header) || !exact(header, ["alg", "kid", "typ"]) || header.alg !== "ES256"
      || header.typ !== "JWT" || !id(header.kid) || signature.length !== 64 || !object(claims)
      || !object(jwks) || !exact(jwks, ["keys"]) || !Array.isArray(jwks.keys)
      || jwks.keys.length < 1 || jwks.keys.length > 8) return fail("INVALID_ASSERTION");
    const keyIds = new Set<string>();
    for (const key of jwks.keys) {
      if (!object(key) || !exact(key, ["alg", "crv", "kid", "kty", "use", "x", "y"])
        || key.alg !== "ES256" || key.crv !== "P-256" || key.kty !== "EC" || key.use !== "sig"
        || !id(key.kid) || keyIds.has(key.kid) || typeof key.x !== "string" || typeof key.y !== "string"
        || decode(key.x).length !== 32 || decode(key.y).length !== 32) return fail("INVALID_ASSERTION");
      keyIds.add(key.kid);
    }
    const key = jwks.keys.find(value => value.kid === header.kid);
    if (!key || !verify("sha256", Buffer.from(parts[0] + "." + parts[1]),
      { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" }, signature)) return fail("INVALID_ASSERTION");
    const required = ["iss", "aud", "sub", "iat", "exp", "jti", "token_use", "workspace_context_version", "workspace_id",
      "account_id", "account_region", "principal_id", "realm_id", "realm_role", "membership_id", "membership_version", "policy_version"];
    if (!required.every(field => Object.hasOwn(claims, field))
      || !Object.keys(claims).every(field => required.includes(field) || field === "organization_id")
      || claims.iss !== scope.authority.issuer || claims.aud !== audience || claims.sub !== accountId
      || claims.account_id !== accountId || claims.account_region !== scope.authority.accountRegion
      || claims.workspace_id !== scope.workspaceId || claims.realm_id !== scope.authority.realmId
      || claims.token_use !== "workspace_context" || claims.workspace_context_version !== 1
      || !id(claims.principal_id, 128) || !id(claims.membership_id)
      || !positive(claims.membership_version) || !positive(claims.policy_version)
      || !["OWNER", "ADMIN", "MEMBER"].includes(String(claims.realm_role))
      || !id(claims.jti) || claims.jti.length < 8 || !positive(claims.iat) || !positive(claims.exp)
      || claims.iat > Math.floor(now / 1000) + 5 || claims.iat < Math.floor(requestedAt / 1000) - 5
      || claims.exp * 1000 <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 600
      || (claims.organization_id !== undefined && claims.organization_id !== null && !id(claims.organization_id, 128))) return fail("INVALID_ASSERTION");
    return { value: Object.freeze({ accountId, principalId: claims.principal_id, membershipId: claims.membership_id,
      membershipVersion: claims.membership_version, policyVersion: claims.policy_version,
      role: claims.realm_role as WorkspaceResourcePrincipal["role"] }), expiresAt: claims.exp * 1000 };
  } catch (error) { if (error instanceof WorkspaceAdmissionError) throw error; return fail("INVALID_ASSERTION"); }
}

interface Login { accountId: string; accountRegion: "cn" | "global"; desktopId: string; token: string; expiresAt: number }

/** One explicit hosted resource scope, owned by trusted host composition. Each run performs fresh
 * Account admission and host policy, then lends real bound stores only for that callback. invalidate()
 * must be called on foreground selection/logout/disconnect, including A -> B -> A. Background runs
 * need their own future Host/run authority, not this foreground resource-operation lease.
 * Neither callbacks nor private store results may be exposed as an RPC/model API. */
export class AccountWorkspaceResources {
  readonly scope: WorkspaceResourceScope;
  private readonly hostHome: string;
  private readonly audience: string;
  private readonly origin: string;
  private readonly loadState: () => MobileCompanionState | null;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly authorize: Options["authorize"];
  private generation = 0;
  private readonly pending = new Set<AbortController>();

  constructor(options: Options) {
    this.scope = parseWorkspaceResourceScope(options.scope);
    if (this.scope.authority.kind !== "account" || !id(options.contextAudience)
      || typeof options.authorize !== "function") throw new Error("hosted Workspace resources require pinned Account authority and explicit policy");
    this.origin = this.scope.authority.issuer;
    if (options.testTransportOrigin !== undefined) {
      const url = new URL(options.testTransportOrigin);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || url.origin !== options.testTransportOrigin || url.username || url.password) throw new Error("invalid test Account transport");
      this.origin = url.origin;
    }
    this.hostHome = options.hostHome;
    this.audience = options.contextAudience;
    this.loadState = options.loadState ?? loadMobileState;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.authorize = options.authorize;
  }
  invalidate(): void {
    if (this.generation >= Number.MAX_SAFE_INTEGER) throw new Error("Workspace resource admission generation exhausted");
    this.generation++;
    for (const controller of this.pending) controller.abort();
  }
  private login(now: number): Login {
    const state = this.loadState();
    if (!state || !id(state.account?.id) || !id(state.desktop?.id) || !id(state.accessToken, 12_000)
      || !positive(state.accessTokenExpiresAt) || state.accessTokenExpiresAt <= now
      || !["cn", "global"].includes(state.account.region)) return fail("AUTH_REQUIRED");
    if (this.scope.authority.kind !== "account"
      || state.account.region.toUpperCase() !== this.scope.authority.accountRegion) return fail("SCOPE_CHANGED");
    return Object.freeze({ accountId: state.account.id, accountRegion: state.account.region,
      desktopId: state.desktop.id, token: state.accessToken, expiresAt: state.accessTokenExpiresAt });
  }
  private async json(path: string, signal: AbortSignal, check: () => void,
    revoke: (code: WorkspaceAdmissionCode) => WorkspaceAdmissionError, login?: Login): Promise<unknown> {
    check();
    try {
      const response = await this.fetcher(this.origin + path, { method: login ? "POST" : "GET", redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]), cache: "no-store",
        headers: { Accept: "application/json", "Cache-Control": "no-store", ...(login
          ? { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" } : {}) },
        ...(login ? { body: "{}" } : {}) });
      try { check(); } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
      if (!response.ok) {
        // Revoke at observation, before cleanup can yield. A stalled body cancellation must not
        // leave another already admitted local callback writable after a known Account denial.
        const error = revoke(response.status === 401 ? "AUTH_REQUIRED"
          : [403, 404, 409].includes(response.status) ? "ACCESS_DENIED" : "AUTHORITY_UNAVAILABLE");
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      const reader = response.body?.getReader();
      if (!reader) return fail("AUTHORITY_UNAVAILABLE");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); check();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 65_536) throw revoke("AUTHORITY_UNAVAILABLE");
          chunks.push(part.value);
        }
      } catch (error) { void reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      check();
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      check(); // Selection/login drift outranks a response/network failure.
      if (error instanceof WorkspaceAdmissionError) throw error;
      throw revoke("AUTHORITY_UNAVAILABLE");
    }
  }
  async run<T>(action: WorkspaceResourceAction, operation: (resources: WorkspaceResources) => T | Promise<T>,
    signal?: AbortSignal): Promise<T> {
    if (!ACTIONS.has(action) || typeof operation !== "function") throw new Error("invalid host resource operation");
    let clock = this.now();
    if (!positive(clock)) return fail("AUTHORITY_UNAVAILABLE");
    const initial = this.login(clock), generation = this.generation, requestedAt = clock;
    const controller = new AbortController();
    this.pending.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let active = true, expiresAt = Math.min(initial.expiresAt, requestedAt + MAX_LEASE_MS);
    let denial: WorkspaceAdmissionError | undefined, admitted: Readonly<WorkspaceResourcePrincipal> | undefined;
    const actions = new Set<WorkspaceResourceAction>([action]);
    const deny = (code: WorkspaceAdmissionCode): never => {
      denial ??= new WorkspaceAdmissionError(code);
      if (code === "SCOPE_CHANGED" && generation === this.generation) this.invalidate();
      throw denial;
    };
    const revoke = (code: WorkspaceAdmissionCode): WorkspaceAdmissionError => {
      denial ??= new WorkspaceAdmissionError(code);
      this.invalidate();
      return denial;
    };
    const expiryTimer = setTimeout(() => {
      denial ??= new WorkspaceAdmissionError("ACCESS_EXPIRED");
      controller.abort();
    }, MAX_LEASE_MS);
    const check = (): void => {
      if (denial) throw denial;
      if (!active || generation !== this.generation) return deny("SCOPE_CHANGED");
      if (signal?.aborted) return deny("CANCELLED");
      const time = this.now();
      if (!positive(time) || time < clock) return deny("ACCESS_EXPIRED");
      clock = time;
      let current: Login;
      try { current = this.login(clock); } catch { return deny("SCOPE_CHANGED"); }
      if (current.accountId !== initial.accountId || current.accountRegion !== initial.accountRegion
        || current.desktopId !== initial.desktopId || current.token !== initial.token
        || current.expiresAt !== initial.expiresAt) return deny("SCOPE_CHANGED");
      if (clock >= expiresAt) return deny("ACCESS_EXPIRED");
      if (admitted) for (const used of actions) if (this.authorize(admitted, used) !== true) return deny("ACCESS_DENIED");
    };
    try {
      check();
      const envelope = await this.json(`/v1/workspaces/${this.scope.workspaceId}/context`, combined, check, revoke, initial);
      if (!object(envelope) || !exact(envelope, ["workspaceId", "token", "tokenType", "expiresInSeconds"])
        || envelope.workspaceId !== this.scope.workspaceId || envelope.tokenType !== "Bearer"
        || !positive(envelope.expiresInSeconds) || envelope.expiresInSeconds > 600) return fail("INVALID_ASSERTION");
      const keys = await this.json("/.well-known/jwks.json", combined, check, revoke);
      const verified = principal(envelope.token, keys, this.scope, this.audience, initial.accountId, clock, requestedAt);
      if (verified.expiresAt - clock > (envelope.expiresInSeconds + 5) * 1000) return fail("INVALID_ASSERTION");
      check();
      admitted = verified.value;
      expiresAt = Math.min(expiresAt, verified.expiresAt);
      const resources = new WorkspaceResources(this.hostHome, this.scope, { assertCurrent: check, assertAction: (used, lifecycle) => {
        check();
        // Long-lived SessionHub locks need an original-owner cleanup receipt after revocation.
        // This bounded lane must not acquire one, including delete's implicit acquire path.
        if (lifecycle !== undefined || (used !== "read" && used !== action)) return deny("ACCESS_DENIED");
        actions.add(used); check();
      } });
      check(); resources.initialize(); check();
      const result = await operation(resources);
      check();
      return result;
    } catch (error) {
      if (error instanceof WorkspaceAdmissionError) {
        denial ??= error;
        if (["AUTH_REQUIRED", "ACCESS_DENIED", "INVALID_ASSERTION", "AUTHORITY_UNAVAILABLE"].includes(error.code)) this.invalidate();
      }
      check(); throw error;
    }
    finally { active = false; clearTimeout(expiryTimer); controller.abort(); this.pending.delete(controller); }
  }
}
