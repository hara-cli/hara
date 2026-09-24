import { createModelFetch } from "../network/model-fetch.js";
import { redactSensitiveText } from "../security/secrets.js";

export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

export type DecisionMode = "shadow" | "advisory" | "enforce";
export type ActionDecision = "allow" | "review" | "block";

export interface TypeSafeDecisionConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  mode: DecisionMode;
  proxy?: string;
}

export interface ActionDecisionInput {
  task: string;
  tool: string;
  category: string;
  classifierReason: string;
  detail: string;
}

export interface TypeSafeActionJudgment {
  choice: ActionDecision;
  decision: ActionDecision;
  confidence: number;
  probabilities: Partial<Record<ActionDecision, number>>;
  model: string;
  elapsedMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ChoiceAnswer {
  choice?: unknown;
  confidence?: unknown;
  probabilities?: unknown;
}

interface SystemOneResponse {
  model?: unknown;
  answers?: {
    action_guard?: ChoiceAnswer;
  };
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
}

function boundedText(value: string, max: number): string {
  return redactSensitiveText(value.replace(/\s+/gu, " ").trim()).text.slice(0, max);
}

export function normalizeTypeSafeBaseURL(value: string | undefined): string {
  const candidate = value?.trim() || TYPESAFE_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("TypeSafe decision endpoint is invalid");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("TypeSafe decision endpoint must be an HTTP(S) origin or path without credentials, query, or fragment");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new Error("TypeSafe decision endpoint must use HTTPS except on loopback");
  }
  return url.href.replace(/\/+$/u, "");
}

function probabilityMap(value: unknown): Partial<Record<ActionDecision, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Partial<Record<ActionDecision, number>> = {};
  for (const key of ["allow", "review", "block"] as const) {
    const raw = (value as Record<string, unknown>)[key];
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = Math.max(0, Math.min(1, raw));
  }
  return out;
}

function numericConfidence(answer: ChoiceAnswer, probabilities: Partial<Record<ActionDecision, number>>, choice: ActionDecision): number {
  const raw = answer.confidence;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.min(1, raw));
  return probabilities[choice] ?? 0;
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response limit exceeded").catch(() => {});
        throw new Error("TypeSafe decision response exceeded the 1 MB limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Convert one Jev choice into a conservative Hara action decision. Jev supplies the judgment, while the
 * thresholds and authority remain ordinary code: a low-confidence allow becomes review and Jev can never
 * bypass Hara's deterministic policy or human approval boundary.
 */
export function parseTypeSafeActionJudgment(value: unknown, model = TYPESAFE_DEFAULT_MODEL): TypeSafeActionJudgment {
  const response = value as SystemOneResponse | undefined;
  const answer = response?.answers?.action_guard;
  if (!answer || typeof answer !== "object") throw new Error("TypeSafe decision response omitted action_guard");
  const rawChoice = typeof answer.choice === "string" ? answer.choice.trim().toLowerCase() : "";
  if (rawChoice !== "allow" && rawChoice !== "review" && rawChoice !== "block") {
    throw new Error("TypeSafe decision response contained an unknown choice");
  }
  const choice = rawChoice as ActionDecision;
  const probabilities = probabilityMap(answer.probabilities);
  const confidence = numericConfidence(answer, probabilities, choice);
  // Confidence is uncertainty, not authority. An uncertain allow must not silently execute and an uncertain
  // block must not hard-deny a legitimate action; both converge on the human-review path.
  const decision: ActionDecision = choice !== "review" && confidence < 0.6 ? "review" : choice;
  const responseModel = typeof response?.model === "string" && response.model.trim()
    ? response.model.trim().slice(0, 128)
    : model;
  return { choice, decision, confidence, probabilities, model: responseModel };
}

/** One bounded System One call. The state is structured, secret-redacted and deliberately omits account,
 * recipient and chat identifiers. Callers decide whether shadow/advisory/enforce changes execution. */
export async function judgeActionWithTypeSafe(
  config: TypeSafeDecisionConfig,
  input: ActionDecisionInput,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    fetch?: FetchLike;
  } = {},
): Promise<TypeSafeActionJudgment> {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) throw new Error("TypeSafe decision key is not configured");
  const model = config.model?.trim() || TYPESAFE_DEFAULT_MODEL;
  const endpoint = `${normalizeTypeSafeBaseURL(config.baseURL)}/v1/systemone`;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 6_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const request = options.fetch ?? createModelFetch(config.proxy);
  const startedAt = performance.now();
  const response = await request(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      state: {
        task: boundedText(input.task, 700),
        action: {
          tool: boundedText(input.tool, 80),
          category: boundedText(input.category, 80),
          classifier_reason: boundedText(input.classifierReason, 240),
          detail: boundedText(input.detail, 900),
        },
      },
      questions: {
        action_guard: {
          type: "choice",
          instructions:
            "Decide whether this exact pending computer or agent action is authorized by and aligned with "
            + "the user's current task. Judge only the pending action; do not generate text or instructions.",
          criteria: {
            allow:
              "Clearly requested or a necessary, bounded step toward the task; recipient, target, and effect are unambiguous.",
            review:
              "Potentially useful but ambiguous, broader than requested, externally visible, or consequential enough to need a human check.",
            block:
              "Clearly unrelated, unauthorized, deceptive, credential-exposing, prohibited, or destructive beyond the user's request.",
          },
        },
      },
    }),
    signal,
    redirect: "error",
  });
  if (!response.ok) throw new Error(`TypeSafe decision request failed with HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredSize) && declaredSize > 1_000_000) {
    throw new Error("TypeSafe decision response exceeded the 1 MB limit");
  }
  const raw = await boundedResponseText(response, 1_000_000);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("TypeSafe decision response was not JSON");
  }
  const parsed = parseTypeSafeActionJudgment(payload, model);
  const usage = (payload as SystemOneResponse).usage;
  const inputTokens = typeof usage?.input_tokens === "number" && Number.isFinite(usage.input_tokens)
    ? Math.max(0, Math.trunc(usage.input_tokens))
    : undefined;
  const outputTokens = typeof usage?.output_tokens === "number" && Number.isFinite(usage.output_tokens)
    ? Math.max(0, Math.trunc(usage.output_tokens))
    : undefined;
  return {
    ...parsed,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    ...((inputTokens !== undefined || outputTokens !== undefined)
      ? { usage: { inputTokens, outputTokens } }
      : {}),
  };
}
