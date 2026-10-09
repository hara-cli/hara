import type { CodingHostMetrics } from "./host.js";

interface ParentUsage {
  input: number;
  output: number;
  providerCalls?: number;
}

/** A per-worker high-water mark, shared by progress and final cancellation accounting. */
export function createCodingUsageAccumulator(parent: ParentUsage): (metrics: CodingHostMetrics) => void {
  let previous = { inputTokens: 0, outputTokens: 0, providerRounds: 0 };
  return (metrics) => {
    for (const value of [metrics.inputTokens, metrics.outputTokens, metrics.providerRounds]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid coding usage counters");
    }
    const next = {
      inputTokens: Math.max(previous.inputTokens, metrics.inputTokens),
      outputTokens: Math.max(previous.outputTokens, metrics.outputTokens),
      providerRounds: Math.max(previous.providerRounds, metrics.providerRounds),
    };
    parent.input += next.inputTokens - previous.inputTokens;
    parent.output += next.outputTokens - previous.outputTokens;
    parent.providerCalls = (parent.providerCalls ?? 0) + next.providerRounds - previous.providerRounds;
    previous = next;
  };
}
