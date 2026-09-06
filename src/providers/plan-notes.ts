// Subscription-plan authority, in the one place a user will actually read it: the end of `hara setup`.
//
// Each provider and plan can use different units, coefficients, windows, tools, seats and overage rules.
// These notes therefore explain where truth comes from instead of freezing a pricing formula into Hara.
import type { ProviderId } from "../config.js";

export interface PlanNote {
  /** Who owns the subscription calculation and entitlement decision. */
  metering: string;
  /** Where the user can see an authoritative remaining allowance. */
  visibility: string;
  /** Stable selection guidance only; live key-scoped discovery remains authoritative. */
  models?: string;
}

const NOTES: Partial<Record<ProviderId, PlanNote>> = {
  "token-plan": {
    metering: "Alibaba Cloud is authoritative for this account's subscription units, coefficients, windows, and exhaustion state; Hara request tokens are context telemetry, not a billing calculation.",
    visibility: "Check remaining allowance and reset state in the Alibaba Cloud console. Hara will show unavailable rather than estimate them when no authenticated usage adapter is available.",
    models: "Choose from the live key-scoped model list; available models and entitlements can differ by account and plan. Switch any time with /model.",
  },
  "minimax-token-plan": {
    metering: "MiniMax is authoritative for this account's subscription units, coefficients, windows, and exhaustion state; Hara request tokens are context telemetry, not a billing calculation.",
    visibility: "Check remaining allowance and reset state through MiniMax's account usage surface. Hara will show unavailable rather than estimate them when no authenticated usage adapter is available.",
  },
  "volcengine-agent-plan": {
    metering: "Volcengine Ark is authoritative for this account's Agent Plan units, coefficients, windows, and exhaustion state; Hara request tokens are context telemetry, not a Fuel Point or billing calculation.",
    visibility: "Check remaining allowance and reset state in Ark. Hara will show unavailable rather than estimate them when no authenticated usage adapter is available.",
    models: "Use auto for Ark-managed routing, or choose an entitled explicit model when a session must stay pinned; the live account catalog is authoritative.",
  },
};

export function planNote(provider: ProviderId | string | undefined): PlanNote | undefined {
  return provider ? NOTES[provider as ProviderId] : undefined;
}

/** Render the note as the closing lines of an interactive setup. Empty when the provider has no plan. */
export function planNoteLines(provider: ProviderId | string | undefined): string[] {
  const note = planNote(provider);
  if (!note) return [];
  return [note.metering, note.visibility, ...(note.models ? [note.models] : [])];
}
