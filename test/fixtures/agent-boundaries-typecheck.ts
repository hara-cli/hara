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
