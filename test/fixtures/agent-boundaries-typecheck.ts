import type { AgentBoundaryCommand, AgentBoundaryContext, AgentBoundaryDocument, AgentExecutionBoundary } from "../../src/workspace/agent-boundaries-contract.js";
export function consume(value: AgentBoundaryDocument, ctx: AgentBoundaryContext, policy: AgentExecutionBoundary) {
  const personal: "personal" = value.mode;
  const reserved: null = ctx.collaboration.role;
  // @ts-expect-error Parsed wire data must not expose an execution permit.
  value.permit.execute();
  // @ts-expect-error Phase one cannot enable a team by changing a role.
  ctx.collaboration.role = "owner";
  // @ts-expect-error Contract documents are deeply immutable, including policy lists.
  policy.resources.push({ resourceId: "forged", access: ["execute"] });
  return [personal, reserved];
}
export function stopInput(command: AgentBoundaryCommand) {
  if (command.operation.action === "task.stop") {
    const run: string = command.operation.runId;
    const revision: number = command.operation.claimRevision;
    return [run, revision];
  }
  // @ts-expect-error A stop requires its precise run and claim revision.
  const incomplete: AgentBoundaryCommand["operation"] = { action: "task.stop", taskId: "fixture" };
  return incomplete;
}

import { createAgentHubBoundaryContract } from "../../src/workspace/agent-boundaries-contract.js";
import type { ExternalAgentSourceV1, HubTransportReceiptV1, HubResourceBindingV1, HubSavedReceiptV1 } from "../../src/workspace/agent-boundaries-contract.js";
export function hubPorts(binding: HubResourceBindingV1, source: ExternalAgentSourceV1, receipt: HubTransportReceiptV1) {
  const contract = createAgentHubBoundaryContract(binding);
  const registered = { agentId: "fixture-agent", instanceId: "fixture-instance", alias: "display-only" };
  const external: ExternalAgentSourceV1 = contract.externalSource(registered);
  const saved: HubSavedReceiptV1 = contract.savedReceipt({ messageId: "m", requestId: "r", connectionId: "c", seq: 1, savedAt: "2026-11-11T00:00:00.000Z" });
  // @ts-expect-error External identity cannot become a human command.
  const command: AgentBoundaryCommand = source;
  // @ts-expect-error No human principal can be supplied for this external source.
  const principal: ExternalAgentSourceV1["humanPrincipal"] = "human";
  // @ts-expect-error Saving/transport cannot claim execution applied.
  const applied: HubTransportReceiptV1["status"] = "applied";
  if (receipt.status === "delivered" || receipt.status === "queued") {
    const proof: string = receipt.evidenceRef;
    const noError: null = receipt.error;
    return [external, saved, proof, noError];
  }
  return [command, principal, applied];
}
