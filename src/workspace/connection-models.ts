import { listModelsWithSource } from "../providers/models.js";
import { resolvePlatform } from "../providers/registry.js";
import { alibabaReasoningEffortLevels, openAIReasoningEffortLevels, supportsReasoningStyle } from "../providers/reasoning.js";
import { isDeepSeekResponsesModel } from "../providers/deepseek.js";
import { MINIMAX_TOKEN_PLAN_MODELS } from "../providers/minimax.js";
import { isVolcengineAgentPlanInteractiveModel, isVolcengineCodingPlanInteractiveModel, volcengineAgentPlanCanDisableThinking } from "../providers/volcengine.js";
import { CODING_PLAN_FALLBACK_MODELS } from "../providers/models.js";
import type { ScopedConnection } from "./scoped-connections.js";

/** Return only levels whose wire behavior is defined by the existing provider registry. */
export function connectionModelEfforts(connection: Pick<ScopedConnection, "provider" | "baseURL">, modelId: string): string[] {
  const style = resolvePlatform(connection.provider, connection.baseURL, undefined, modelId).reasoning;
  if (style === "reasoning_effort" || style === "reasoning_object") return openAIReasoningEffortLevels(modelId);
  if (style === "thinking_budget" && /^(?:claude-)?(?:opus|sonnet|haiku|fable)-/i.test(modelId))
    return /(?:opus-4-7|opus-4-8|fable)/i.test(modelId)
      ? ["off", "medium"]
      : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (style === "alibaba_responses" || style === "qwen_responses") return alibabaReasoningEffortLevels(modelId);
  if (style === "deepseek_responses" && isDeepSeekResponsesModel(connection.provider, connection.baseURL, modelId)) return ["off", "low", "high", "max"];
  if (style === "volcengine_responses" && (isVolcengineAgentPlanInteractiveModel(modelId) || isVolcengineCodingPlanInteractiveModel(modelId)))
    return [...(volcengineAgentPlanCanDisableThinking(modelId) ? ["off"] : []), "low", "medium", "high"];
  if (style === "minimax_responses" && MINIMAX_TOKEN_PLAN_MODELS.includes(modelId as typeof MINIMAX_TOKEN_PLAN_MODELS[number])) return ["off", "high"];
  if (style === "enable_thinking" && CODING_PLAN_FALLBACK_MODELS.includes(modelId) && supportsReasoningStyle(style, modelId)) return ["off", "high"];
  return [];
}

export async function connectionModels(connection: ScopedConnection, apiKey: string) {
  const result = await listModelsWithSource(connection.baseURL, apiKey, undefined, connection.defaultModel);
  const safe = result.models.filter(id => id.length <= 200 && /^[^\s\x00-\x1f\x7f]+$/.test(id) && !id.includes(apiKey));
  if (!safe.length) throw new Error("Model list unavailable; this endpoint has no documented model catalog");
  return { source: result.source, models: safe.map(id => ({ id, label: id, supportedReasoningEfforts: connectionModelEfforts(connection, id) })) };
}
