import { createHash } from "node:crypto";
// New scoped execution uses this store, never the compatibility profileId-only resolver below.
export { WorkspaceConnectionStoreV2 } from "./scoped-connections.js";
import { isValidProfileId, spaceIdForProfile, type Profile } from "../profile/profile.js";
import type { Provider } from "../providers/types.js";
import {
  parseWorkspaceRegistry,
  validWorkspaceLabel,
  type LegacyWorkspaceConnection,
  type WorkspaceConnection,
  type WorkspaceRegistry,
} from "./registry.js";

/** Hashes stay in owner-only host state. They are not credentials or public identifiers. */
export function workspaceRouteFingerprint(profile: Profile): string {
  if (!isValidProfileId(profile.id) || (profile.kind !== "byok" && profile.kind !== "gateway")) {
    throw new Error("invalid model connection identity");
  }
  const fields = [
    profile.id, profile.kind, profile.provider, profile.apiKey, profile.baseURL,
    profile.gatewayUrl, profile.deviceId, profile.deviceToken, profile.tenantId,
    profile.enrollmentAudience, profile.enrolledAt, profile.visionModel, profile.visionSource,
    profile.visionProvider, profile.visionBaseURL, profile.visionApiKey,
  ];
  if (fields.some((value) => value !== undefined && typeof value !== "string")) {
    throw new Error("invalid model connection route");
  }
  return createHash("sha256").update("hara-workspace-connection-v1\0")
    .update(JSON.stringify(fields.map((value) => value ?? null))).digest("hex");
}

function legacyLabel(value: unknown, fallback: string): string {
  return validWorkspaceLabel(value) ? value : fallback;
}

/** Explicit migration input only; this function does not load, mutate, or select a live profile. */
export function legacyWorkspaceConnection(profile: Profile): LegacyWorkspaceConnection {
  return {
    profileId: profile.id,
    legacySpaceId: spaceIdForProfile(profile),
    source: profile.kind === "gateway" ? "managed" : "direct",
    label: legacyLabel(profile.label, profile.id),
    workspaceLabel: profile.kind === "byok" ? "我的空間" : legacyLabel(profile.tenantName, legacyLabel(profile.label, "工作空間")),
    routeFingerprint: workspaceRouteFingerprint(profile),
  };
}

export interface WorkspaceRunConnection {
  workspaceId: string;
  connectionId: string;
  profileId: string;
  credentialGeneration: string;
  connectionRevision: number;
  /** Chosen once for this run, not looked up again from mutable profile/default settings. */
  model: string;
}

export type WorkspaceProfileResolver = (profileId: string) => Profile | null | undefined;

function liveProfile(
  registry: WorkspaceRegistry,
  connection: WorkspaceConnection,
  resolveProfile: WorkspaceProfileResolver,
  nowMs: number,
): Profile {
  const profile = resolveProfile(connection.profileId);
  if (!profile || profile.id !== connection.profileId || (profile.kind === "gateway") !== (connection.source === "managed")
    || workspaceRouteFingerprint(profile) !== connection.routeFingerprint) {
    throw new Error("Workspace model connection changed or is unavailable; explicit reauthorization is required");
  }
  if (profile.kind === "gateway") {
    const owner = registry.workspaces.find((row) => row.id === connection.workspaceId);
    if (owner?.legacySpaceId !== spaceIdForProfile(profile)) throw new Error("managed connection belongs to a different Workspace audience");
    if (profile.tokenExpiresAt !== undefined) {
      if (typeof profile.tokenExpiresAt !== "string") throw new Error("managed Workspace connection has invalid expiry metadata");
      const expires = Date.parse(profile.tokenExpiresAt);
      if (!Number.isFinite(expires) || expires <= nowMs) throw new Error("managed Workspace connection expired; no fallback was selected");
    }
  }
  return profile;
}

function runModel(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** Trusted host only. Membership, model policy and tool authority must be checked separately. */
export function captureWorkspaceRunConnection(
  registry: WorkspaceRegistry,
  workspaceId: string,
  connectionId: string,
  model: string,
  resolveProfile: WorkspaceProfileResolver,
  nowMs = Date.now(),
): Readonly<WorkspaceRunConnection> {
  const valid = parseWorkspaceRegistry(registry);
  const connection = valid.connections.find((row) => row.id === connectionId && row.workspaceId === workspaceId && row.status === "active");
  if (!connection || !runModel(model) || !Number.isFinite(nowMs)) throw new Error("model connection or run is unavailable in this Workspace");
  liveProfile(valid, connection, resolveProfile, nowMs);
  return Object.freeze({
    workspaceId, connectionId, model, profileId: connection.profileId,
    credentialGeneration: connection.credentialGeneration, connectionRevision: connection.revision,
  });
}

/** Resolve the exact frozen connection; NEVER use the active Workspace/profile or a fallback. */
export function assertWorkspaceRunConnection(
  registry: WorkspaceRegistry,
  binding: Readonly<WorkspaceRunConnection>,
  resolveProfile: WorkspaceProfileResolver,
  nowMs = Date.now(),
): Profile {
  const valid = parseWorkspaceRegistry(registry);
  const connection = valid.connections.find((row) => row.id === binding.connectionId && row.workspaceId === binding.workspaceId);
  if (!connection || connection.status !== "active" || connection.profileId !== binding.profileId
    || connection.credentialGeneration !== binding.credentialGeneration || connection.revision !== binding.connectionRevision
    || !runModel(binding.model) || !Number.isFinite(nowMs)) throw new Error("Workspace run binding is unavailable or revoked; no fallback was selected");
  return liveProfile(valid, connection, resolveProfile, nowMs);
}

/** Additional last-mile guard, not a replacement for organization-bound Control policy or membership.
 * Compose outside the existing provider. No callers are switched to this module until workspace.v2's
 * storage, membership, runtime and protocol migration is ready. Registry reads fail closed. */
export function bindWorkspaceProvider(
  provider: Provider,
  binding: Readonly<WorkspaceRunConnection>,
  readRegistry: () => WorkspaceRegistry,
  resolveProfile: WorkspaceProfileResolver,
): Provider {
  // Copy persisted/caller-owned run metadata so a later UI mutation cannot redirect an existing guard.
  const pinned = Object.freeze({ ...binding });
  const check = () => {
    if (provider.model !== pinned.model) throw new Error("provider model does not match the Workspace run binding");
    assertWorkspaceRunConnection(readRegistry(), pinned, resolveProfile);
  };
  check();
  return {
    id: provider.id,
    model: pinned.model,
    supportsToolImages: provider.supportsToolImages,
    trailingTurnContext: provider.trailingTurnContext,
    connection: provider.connection,
    connectionHealth: provider.connectionHealth?.bind(provider),
    async prepareTurn(history, signal) {
      check();
      const snapshot = await provider.prepareTurn?.(history, signal);
      check();
      return snapshot;
    },
    async turn(args) {
      check();
      const result = await provider.turn(args);
      check();
      return result;
    },
  };
}
