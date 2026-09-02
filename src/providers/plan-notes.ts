// Subscription-plan cost shape, in the one place a user will actually read it: the end of `hara setup`.
//
// Both Token Plans bill on a shape that surprises people who expect per-token pay-as-you-go — output
// pricing that includes the thinking chain, a fixed window whose unused quota never carries over, and a
// service pause rather than an overage bill. None of that is visible from a model list, and getting it
// wrong looks like "Hara is slow" or "Hara stopped working". Pure and provider-keyed so a new plan is a
// new entry, not new code at the call site.
import type { ProviderId } from "../config.js";

export interface PlanNote {
  /** What the plan charges for, phrased as the thing that surprises people. */
  billing: string;
  /** The one throughput/availability fact that explains a bad session before blaming the client. */
  limits: string;
  /** Which model to start on and when to move, when the catalog makes that a real decision. */
  models?: string;
}

const NOTES: Partial<Record<ProviderId, PlanNote>> = {
  "token-plan": {
    billing: "Output pricing includes the thinking chain, so a high thinking level is billed, not free.",
    limits: "Quota runs on a fixed window; unused quota does not carry over, and the service pauses when it is spent.",
    models: "qwen3.8-flash is the cheapest daily driver and stays flat-rate to 1M context; qwen3.8-max is half price 22:00–08:00. Switch any time with /model.",
  },
  "minimax-token-plan": {
    billing: "Output pricing includes the thinking chain, so a high thinking level is billed, not free.",
    limits: "Quota runs on 5-hour and weekly windows that do not carry over. MiniMax also throttles dynamically at peak (weekdays 15:00–17:30) and caps how many agents one plan tier may run, so a slow turn is usually the tier rather than the client.",
  },
  "volcengine-agent-plan": {
    billing: "Agent Fuel Points are shared across every supported Agent Plan tool; model and Harness usage draw from the same subscription allowance.",
    limits: "The plan uses a 5-hour cycle plus weekly and monthly limits. When an allowance is exhausted, service pauses unless overage billing is enabled in Ark.",
    models: "ark-code-latest follows the model selected in the Ark console. Use an explicit model id when a session must stay pinned to one model.",
  },
};

export function planNote(provider: ProviderId | string | undefined): PlanNote | undefined {
  return provider ? NOTES[provider as ProviderId] : undefined;
}

/** Render the note as the closing lines of an interactive setup. Empty when the provider has no plan. */
export function planNoteLines(provider: ProviderId | string | undefined): string[] {
  const note = planNote(provider);
  if (!note) return [];
  return [note.billing, note.limits, ...(note.models ? [note.models] : [])];
}
