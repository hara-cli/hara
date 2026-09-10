import { createHash } from "node:crypto";
import { classifyError, type ErrKind } from "../agent/failover.js";
import { contextWindow } from "../statusbar.js";
import { classifyVision } from "../vision.js";
import { providerAccounting, type ProviderAccountingDescriptor } from "./accounting.js";
import { resolvePlatform, type WireApi } from "./registry.js";
import type { ProviderTarget } from "./target.js";
import type { NeutralMsg, Provider, ToolSpec, TurnArgs, TurnResult } from "./types.js";
import {
  isKnownVolcengineAgentPlanModel,
  isVolcengineAgentPlanInteractiveModel,
} from "./volcengine.js";

export type CapabilitySupport = "supported" | "unsupported" | "unknown";
export type ProviderCircuitState = "closed" | "open" | "half_open";
export type ProviderHealthState = "unknown" | "healthy" | "degraded" | "unavailable";

export interface ProviderModelCapabilities {
  wireApi: WireApi;
  imageInput: CapabilitySupport;
  toolCalling: CapabilitySupport;
  reasoning: CapabilitySupport;
  /** Present only for model families whose window is explicitly known by this engine build. */
  contextWindowTokens?: number;
  region: "cn-beijing" | "cn" | "global" | "local" | "managed" | "custom";
  accounting: ProviderAccountingDescriptor;
}

export interface ProviderConnectionDescriptor {
  /** Public saved-connection/profile id. Several models on one account may share it. */
  connectionId: string;
  provider: string;
  model: string;
  capabilities: ProviderModelCapabilities;
  /** Credential/endpoint/model generation. Runtime-only: never serialize or display it. */
  runtimeKey: string;
  /** Credential/endpoint generation without the model. Used only to prevent pointless auth failover. */
  accountRuntimeKey: string;
}

export interface ProviderConnectionHealthSnapshot {
  state: ProviderHealthState;
  circuit: ProviderCircuitState;
  consecutiveFailures: number;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureKind?: ErrKind;
  retryAt?: string;
}

interface MutableHealth {
  state: ProviderHealthState;
  circuit: ProviderCircuitState;
  consecutiveFailures: number;
  lastCheckedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastFailureKind?: ErrKind;
  retryAt?: number;
  probeInFlight: boolean;
}

interface CircuitRuntime {
  now?: () => number;
}

function bareModel(model: string): string {
  return model.trim().toLowerCase().split("/").at(-1) ?? model.trim().toLowerCase();
}

/** A context number must not silently inherit statusbar's conservative 200k fallback. */
function hasKnownContextWindow(model: string): boolean {
  const id = bareModel(model);
  return /(?:haiku|opus|sonnet|fable|claude-4|(?:^|-)1m(?:-|$))/.test(id)
    || /^qwen3\.(?:8-(?:max|flash)|7-(?:max|plus|flash)|6-(?:plus|flash))(?:-|$)/.test(id)
    || /^(?:qwen3-max-2026-01-23|qwen3-coder-(?:next|plus)|kimi-k2\.5)(?:-|$)/.test(id)
    || /^glm-(?:5(?:\.3)?|4\.7)(?:-|$)/.test(id)
    || /^deepseek-v4-(?:flash|pro)(?:-|$)|^kimi-k3(?:-|$)/.test(id)
    || /^doubao-seed-(?:evolving|2\.(?:0-(?:mini|lite)|1-turbo))(?:-|$)/.test(id)
    || /^kimi-k2\.7-code(?:-|$)|^minimax-m(?:3|2\.5)(?:-|$)/.test(id)
    || /qwen3\.6[-:]27b/.test(id);
}

function knownToolCalling(provider: string, model: string): CapabilitySupport {
  const id = bareModel(model);
  // Ark's Agent Plan route is itself a Codex/Responses tool endpoint. Its `auto` and
  // `ark-code-latest` routers do not expose one fixed model family, but they still support the
  // function-calling contract Hara uses. Keep image/context unknown for those routers because the
  // selected backing model can change; only the endpoint-level tool capability is stable.
  if (provider === "hara-gateway") return "supported";
  if (provider === "volcengine-agent-plan") {
    if (!isVolcengineAgentPlanInteractiveModel(model)) return "unsupported";
    return isKnownVolcengineAgentPlanModel(model) ? "supported" : "unknown";
  }
  if (
    provider === "anthropic"
    || /^(?:claude|gpt-|o[134](?:-|$)|qwen|qwq|glm|deepseek|minimax|kimi|moonshot|doubao|gemini|grok|llama|mistral|mixtral|codestral)/.test(id)
  ) return "supported";
  return "unknown";
}

function routeRegion(provider: string, baseURL: string | undefined): ProviderModelCapabilities["region"] {
  if (provider === "hara-gateway") return "managed";
  if (provider === "ollama" || provider === "lmstudio") return "local";
  try {
    const endpoint = new URL(baseURL ?? "");
    if (/cn-beijing/i.test(endpoint.hostname)) return "cn-beijing";
    if (/\.cn$/i.test(endpoint.hostname) || endpoint.hostname === "api.minimaxi.com") return "cn";
    return "global";
  } catch {
    return baseURL ? "custom" : "global";
  }
}

export function providerModelCapabilities(target: { provider: string; baseURL?: string; model: string }): ProviderModelCapabilities {
  const platform = resolvePlatform(target.provider, target.baseURL, undefined, target.model);
  const vision = classifyVision(target.provider, target.model);
  return {
    wireApi: platform.wireApi,
    imageInput: vision === "vision" ? "supported" : vision === "text" ? "unsupported" : "unknown",
    toolCalling: knownToolCalling(target.provider, target.model),
    reasoning: platform.reasoning === "none" ? "unsupported" : "supported",
    ...(hasKnownContextWindow(target.model) ? { contextWindowTokens: contextWindow(target.model) } : {}),
    region: routeRegion(target.provider, target.baseURL),
    accounting: providerAccounting(target.provider),
  };
}

function boundedIdentity(value: string): string {
  const normalized = value.trim();
  return normalized && normalized.length <= 128 ? normalized : "unscoped";
}

/** The digest separates credentials and edited endpoints without ever persisting or exposing either. */
export function providerConnectionDescriptor(
  connectionId: string,
  target: ProviderTarget,
): ProviderConnectionDescriptor {
  const accountMaterial = JSON.stringify({
    provider: target.provider,
    baseURL: target.baseURL ?? "",
    credential: target.apiKey ?? "",
  });
  const accountRuntimeKey = createHash("sha256").update(accountMaterial).digest("hex");
  return {
    connectionId: boundedIdentity(connectionId),
    provider: target.provider,
    model: target.model,
    capabilities: providerModelCapabilities(target),
    runtimeKey: createHash("sha256").update(`${accountRuntimeKey}\u0000${target.model}`).digest("hex"),
    accountRuntimeKey,
  };
}

function iso(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function publicSnapshot(value: MutableHealth | undefined, now: number): ProviderConnectionHealthSnapshot {
  if (!value) return { state: "unknown", circuit: "closed", consecutiveFailures: 0 };
  let circuit = value.circuit;
  if (circuit === "open" && value.retryAt !== undefined && value.retryAt <= now) circuit = "half_open";
  return {
    state: value.state,
    circuit,
    consecutiveFailures: value.consecutiveFailures,
    ...(iso(value.lastCheckedAt) ? { lastCheckedAt: iso(value.lastCheckedAt) } : {}),
    ...(iso(value.lastSuccessAt) ? { lastSuccessAt: iso(value.lastSuccessAt) } : {}),
    ...(iso(value.lastFailureAt) ? { lastFailureAt: iso(value.lastFailureAt) } : {}),
    ...(value.lastFailureKind ? { lastFailureKind: value.lastFailureKind } : {}),
    ...(iso(value.retryAt) ? { retryAt: iso(value.retryAt) } : {}),
  };
}

function openThreshold(kind: ErrKind): number | undefined {
  if (kind === "auth" || kind === "quota_exhausted" || kind === "region_unavailable") return 1;
  if (kind === "rate_limit") return 2;
  if (kind === "overloaded" || kind === "timeout" || kind === "transient" || kind === "circuit_open") return 3;
  return undefined;
}

function openDurationMs(kind: ErrKind, failures: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.max(1_000, Math.min(30 * 60_000, retryAfterMs));
  if (kind === "auth") return 5 * 60_000;
  if (kind === "quota_exhausted") return 10 * 60_000;
  if (kind === "region_unavailable") return 2 * 60_000;
  return Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, failures - 1));
}

export class ProviderConnectionCircuitRegistry {
  readonly #states = new Map<string, MutableHealth>();
  readonly #now: () => number;

  constructor(runtime: CircuitRuntime = {}) {
    this.#now = runtime.now ?? (() => Date.now());
  }

  snapshot(runtimeKey: string): ProviderConnectionHealthSnapshot {
    return publicSnapshot(this.#states.get(runtimeKey), this.#now());
  }

  begin(runtimeKey: string): { allowed: true } | { allowed: false; retryAt?: string } {
    const current = this.#states.get(runtimeKey);
    if (!current || current.circuit === "closed") return { allowed: true };
    const now = this.#now();
    if (current.circuit === "open" && (current.retryAt === undefined || current.retryAt > now)) {
      return { allowed: false, ...(iso(current.retryAt) ? { retryAt: iso(current.retryAt) } : {}) };
    }
    if (current.probeInFlight) {
      return { allowed: false, ...(iso(current.retryAt) ? { retryAt: iso(current.retryAt) } : {}) };
    }
    current.circuit = "half_open";
    current.probeInFlight = true;
    return { allowed: true };
  }

  success(runtimeKey: string): ProviderConnectionHealthSnapshot {
    const now = this.#now();
    const next: MutableHealth = {
      state: "healthy",
      circuit: "closed",
      consecutiveFailures: 0,
      lastCheckedAt: now,
      lastSuccessAt: now,
      probeInFlight: false,
    };
    this.#states.set(runtimeKey, next);
    return publicSnapshot(next, now);
  }

  failure(runtimeKey: string, kind: ErrKind, retryAfterMs?: number): ProviderConnectionHealthSnapshot {
    const now = this.#now();
    const previous = this.#states.get(runtimeKey);
    if (kind === "interrupted" || kind === "context_overflow") {
      if (previous) previous.probeInFlight = false;
      return publicSnapshot(previous, now);
    }
    const failures = (previous?.consecutiveFailures ?? 0) + 1;
    const threshold = openThreshold(kind);
    const opened = threshold !== undefined && failures >= threshold;
    const next: MutableHealth = {
      state: opened ? "unavailable" : "degraded",
      circuit: opened ? "open" : "closed",
      consecutiveFailures: failures,
      lastCheckedAt: now,
      lastFailureAt: now,
      lastFailureKind: kind,
      ...(previous?.lastSuccessAt !== undefined ? { lastSuccessAt: previous.lastSuccessAt } : {}),
      ...(opened ? { retryAt: now + openDurationMs(kind, failures, retryAfterMs) } : {}),
      probeInFlight: false,
    };
    this.#states.set(runtimeKey, next);
    return publicSnapshot(next, now);
  }

  clear(): void {
    this.#states.clear();
  }
}

export const providerConnectionCircuits = new ProviderConnectionCircuitRegistry();

function hasImages(history: readonly NeutralMsg[]): boolean {
  return history.some((message) => message.role === "user" && Boolean(message.images?.length));
}

export interface ProviderTurnRequirements {
  imageInput: boolean;
  toolCalling: boolean;
  minimumContextWindowTokens?: number;
  /** A context-overflow route cannot prove that another model is larger when the failed model's window
   * is dynamic or undocumented. This deliberately blocks automatic switching instead of guessing. */
  contextWindowComparisonUnavailable?: boolean;
}

export function providerTurnRequirements(
  history: readonly NeutralMsg[],
  tools: readonly ToolSpec[],
  failedProvider?: Provider,
  kind?: ErrKind,
): ProviderTurnRequirements {
  const failedContextWindow = failedProvider?.connection?.capabilities.contextWindowTokens;
  return {
    imageInput: hasImages(history),
    toolCalling: tools.length > 0,
    ...(kind === "context_overflow"
      ? failedContextWindow
        ? { minimumContextWindowTokens: failedContextWindow + 1 }
        : { contextWindowComparisonUnavailable: true }
      : {}),
  };
}

export function providerCompatibility(
  provider: Provider,
  requirements: ProviderTurnRequirements,
): { ok: true } | { ok: false; reason: "image_input" | "tool_calling" | "context_window" | "circuit_open" } {
  // Production providers built by Hara always carry a connection descriptor. The fallback keeps direct
  // embedders/tests source-compatible; those callers already supplied an executable Provider object and
  // therefore own its tool contract, while image/context claims still stay conservative.
  const capabilities = provider.connection?.capabilities ?? {
    ...providerModelCapabilities({ provider: provider.id, model: provider.model }),
    toolCalling: "supported" as const,
  };
  if (requirements.imageInput && capabilities?.imageInput !== "supported") {
    return { ok: false, reason: "image_input" };
  }
  if (requirements.toolCalling && capabilities?.toolCalling !== "supported") {
    return { ok: false, reason: "tool_calling" };
  }
  if (requirements.contextWindowComparisonUnavailable) {
    return { ok: false, reason: "context_window" };
  }
  if (
    requirements.minimumContextWindowTokens !== undefined
    && (!capabilities?.contextWindowTokens || capabilities.contextWindowTokens < requirements.minimumContextWindowTokens)
  ) {
    return { ok: false, reason: "context_window" };
  }
  if (provider.connection && (provider.connectionHealth?.() ?? providerConnectionCircuits.snapshot(provider.connection.runtimeKey)).circuit === "open") {
    return { ok: false, reason: "circuit_open" };
  }
  return { ok: true };
}

export function sameProviderConnection(left: Provider, right: Provider): boolean {
  return Boolean(left.connection && right.connection && left.connection.runtimeKey === right.connection.runtimeKey);
}

export function sameProviderAccount(left: Provider, right: Provider): boolean {
  return Boolean(
    left.connection
    && right.connection
    && left.connection.accountRuntimeKey === right.connection.accountRuntimeKey,
  );
}

/** Attach one process-local circuit to the final policy-bound provider. Only terminal turn results affect
 * health; provider SDK retries remain inside the wrapped provider and never create duplicate circuit counts. */
export function withProviderConnectionCircuit(
  provider: Provider,
  descriptor: ProviderConnectionDescriptor,
  registry: ProviderConnectionCircuitRegistry = providerConnectionCircuits,
): Provider {
  return {
    ...provider,
    connection: descriptor,
    connectionHealth: () => registry.snapshot(descriptor.runtimeKey),
    async turn(args: TurnArgs): Promise<TurnResult> {
      const gate = registry.begin(descriptor.runtimeKey);
      if (!gate.allowed) {
        return {
          text: "",
          toolUses: [],
          stop: "error",
          errorMsg: `provider connection circuit open${gate.retryAt ? ` until ${gate.retryAt}` : ""}`,
          errorMetadata: { code: "HARA_CIRCUIT_OPEN" },
        };
      }
      let result: TurnResult;
      try {
        result = await provider.turn(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        registry.failure(descriptor.runtimeKey, classifyError(message));
        throw error;
      }
      if (result.stop !== "error") {
        registry.success(descriptor.runtimeKey);
      } else {
        const kind = classifyError(result.errorMsg ?? "", result.errorMetadata?.status, result.errorMetadata?.code);
        registry.failure(descriptor.runtimeKey, kind, result.errorMetadata?.retryAfterMs);
      }
      return result;
    },
  };
}
