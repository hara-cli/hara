import { syncOrganizationRoleBundleForProfile } from "../org-fleet/enroll.js";
import {
  assertOrganizationModelAllowed,
  loadOrganizationExecutionPolicy,
  type OrganizationExecutionPolicy,
} from "../org/roles.js";
import {
  getProfile,
  spaceIdForProfile,
  type Profile,
} from "../profile/profile.js";
import type { Provider } from "./types.js";

export type OrganizationProfileResolver = () => Profile | null | undefined;

function sameEnrollment(left: Profile, right: Profile): boolean {
  return left.kind === "gateway"
    && right.kind === "gateway"
    && left.id === right.id
    && left.gatewayUrl === right.gatewayUrl
    && left.deviceId === right.deviceId
    && left.deviceToken === right.deviceToken
    && left.enrolledAt === right.enrolledAt;
}

export function assertOrganizationProviderAudience(
  enrollment: Profile,
  expectedSpaceId: string,
  resolveCurrent: OrganizationProfileResolver = () => getProfile(enrollment.id),
): Profile {
  const current = resolveCurrent();
  if (!current || current.kind !== "gateway") {
    throw new Error(`organization connection '${enrollment.id}' is unavailable; refusing company inference`);
  }
  const currentSpaceId = spaceIdForProfile(current);
  if (currentSpaceId !== expectedSpaceId || !sameEnrollment(current, enrollment)) {
    throw new Error(
      `organization connection '${enrollment.id}' changed after this execution was bound; refusing to send history across enrollment generations`,
    );
  }
  return current;
}

/** Acquire one fresh authenticated Control policy for a frozen organization enrollment. */
export async function refreshOrganizationExecutionPolicy(
  enrollment: Profile,
  expectedSpaceId = spaceIdForProfile(enrollment),
  resolveCurrent: OrganizationProfileResolver = () => getProfile(enrollment.id),
  signal?: AbortSignal,
): Promise<OrganizationExecutionPolicy> {
  assertOrganizationProviderAudience(enrollment, expectedSpaceId, resolveCurrent);
  const snapshot = await syncOrganizationRoleBundleForProfile(enrollment, signal, { required: true });
  assertOrganizationProviderAudience(enrollment, expectedSpaceId, resolveCurrent);
  if (!snapshot) throw new Error("organization execution policy is unavailable; refusing company inference");
  return snapshot.policy;
}

/** Last-mile company boundary shared by CLI, Serve sidecars, and gateway flow/judge calls. Every actual
 * provider request refreshes Control, validates the frozen Space/enrollment/model, and intersects tool
 * schemas with the current organization floor. */
export function bindOrganizationProvider(
  provider: Provider,
  enrollment: Profile,
  resolveCurrent: OrganizationProfileResolver = () => getProfile(enrollment.id),
  options: { requirePersonalModelConnections?: boolean } = {},
): Provider {
  if (enrollment.kind !== "gateway") throw new Error("only gateway providers can be organization-bound");
  const expectedSpaceId = spaceIdForProfile(enrollment);
  const prepare = async (signal?: AbortSignal): Promise<OrganizationExecutionPolicy> => {
    const policy = await refreshOrganizationExecutionPolicy(enrollment, expectedSpaceId, resolveCurrent, signal);
    if (options.requirePersonalModelConnections && policy.allowPersonalModelConnections !== true) {
      throw new Error(
        "company policy does not allow personal model connections for this Space; choose a managed company model or ask an administrator",
      );
    }
    assertOrganizationModelAllowed(policy, provider.model);
    return policy;
  };
  return {
    id: provider.id,
    model: provider.model,
    async prepareTurn(_history, signal) {
      const policy = await prepare(signal);
      return { organizationPolicyVersion: policy.version, organizationPolicy: policy };
    },
    async turn(args) {
      const policy = await prepare(args.signal);
      if (
        args.organizationPolicyVersion !== undefined
        && policy.version !== args.organizationPolicyVersion
      ) {
        throw new Error(
          `organization role bundle changed from version ${args.organizationPolicyVersion} to ${policy.version}; retry this turn so persona and policy use one snapshot`,
        );
      }
      assertOrganizationProviderAudience(enrollment, expectedSpaceId, resolveCurrent);
      const denied = new Set(policy.toolDeny ?? []);
      const result = await provider.turn({
        ...args,
        tools: args.tools.filter((tool) => !denied.has(tool.name)),
      });
      assertOrganizationProviderAudience(enrollment, expectedSpaceId, resolveCurrent);
      const currentPolicy = loadOrganizationExecutionPolicy(expectedSpaceId);
      if (!currentPolicy || currentPolicy.version !== policy.version) {
        throw new Error("organization execution policy changed during inference; retry this turn");
      }
      assertOrganizationModelAllowed(currentPolicy, provider.model);
      return result;
    },
  };
}
