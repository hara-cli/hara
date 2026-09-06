/**
 * Provider accounting is deliberately separate from request token telemetry.
 *
 * Hara can present a common shape, but the provider (or an organization Control
 * plane) remains authoritative for subscription units, coefficients, windows,
 * resets, overage and exhaustion. Never derive billing or entitlement from a
 * model response's input/output token counters.
 */

export type MeteringAuthority = "provider" | "organization" | "local";
export type AccountingMode = "subscription" | "provider-defined" | "managed" | "local";
export type UsageReadMethod = "provider-api" | "organization-control" | "provider-console" | "not-applicable";

export interface ProviderAccountingDescriptor {
  authority: MeteringAuthority;
  mode: AccountingMode;
  /** Where an authoritative remaining allowance can be read today. */
  usageReadMethod: UsageReadMethod;
  /** Hara never turns response token counters into a provider bill or subscription balance. */
  haraMayInferBillingFromTransportTokens: false;
  /** Automatic switching is safe only after an authoritative adapter reports exhaustion. */
  failoverPolicy: "authoritative-exhaustion-only" | "not-applicable";
}

export type NativeMeterValue = number | string;

/**
 * A provider adapter may expose its own meters without converting them to a
 * made-up cross-provider currency. `unit` is intentionally provider-defined.
 */
export interface ProviderNativeMeter {
  id: string;
  label: string;
  unit: string;
  used?: NativeMeterValue;
  remaining?: NativeMeterValue;
  limit?: NativeMeterValue;
  resetAt?: string;
  window?: string;
}

export interface ProviderUsageSnapshot {
  provider: string;
  connectionId: string;
  authority: Exclude<MeteringAuthority, "local">;
  source: "provider-api" | "organization-control";
  fetchedAt: string;
  /** Adapter decision in the vendor's native semantics; Hara does not recompute it from meters. */
  availability: "available" | "exhausted" | "unknown";
  /** Required for an exhaustion decision to trigger unattended failover. */
  authoritative: boolean;
  /** Adapter-owned freshness boundary. Missing/expired snapshots are display-only. */
  validUntil?: string;
  meters: ProviderNativeMeter[];
}

const SUBSCRIPTION_PROVIDERS = new Set([
  "token-plan",
  "minimax-token-plan",
  "volcengine-agent-plan",
]);

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio"]);

/** Static capability metadata only. It contains no price, quota, or reset assumptions. */
export function providerAccounting(provider: string): ProviderAccountingDescriptor {
  if (provider === "hara-gateway") {
    return {
      authority: "organization",
      mode: "managed",
      usageReadMethod: "organization-control",
      haraMayInferBillingFromTransportTokens: false,
      failoverPolicy: "authoritative-exhaustion-only",
    };
  }
  if (LOCAL_PROVIDERS.has(provider)) {
    return {
      authority: "local",
      mode: "local",
      usageReadMethod: "not-applicable",
      haraMayInferBillingFromTransportTokens: false,
      failoverPolicy: "not-applicable",
    };
  }
  return {
    authority: "provider",
    mode: SUBSCRIPTION_PROVIDERS.has(provider) ? "subscription" : "provider-defined",
    // Until a provider-specific authenticated adapter exists, the console is
    // authoritative. Do not silently estimate a value from response tokens.
    usageReadMethod: "provider-console",
    haraMayInferBillingFromTransportTokens: false,
    failoverPolicy: "authoritative-exhaustion-only",
  };
}

/**
 * Routing may consume only a fresh, explicit provider/Control decision. Meter
 * values themselves remain opaque because every subscription can calculate
 * them differently.
 */
export function permitsAutomaticUsageFailover(
  snapshot: ProviderUsageSnapshot | undefined,
  nowMs = Date.now(),
): boolean {
  if (!snapshot?.authoritative || snapshot.availability !== "exhausted" || !snapshot.validUntil) return false;
  const validUntilMs = Date.parse(snapshot.validUntil);
  return Number.isFinite(validUntilMs) && validUntilMs >= nowMs;
}
