import { redactSensitiveText } from "../security/secrets.js";
import type { AgentTeamController, AgentTeamWaitResult } from "../subagent/team.js";
import { registerTool, type ToolContext } from "./registry.js";

const stateOperation = () => ({ effect: "state" as const, concurrencySafe: false });

function unavailable(ctx: ToolContext): AgentTeamController | string {
  return ctx.agentTeam ?? "Error: durable Agent teams are unavailable in this run.";
}

function boundedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return "Error: " + redactSensitiveText(raw).text.slice(0, 1_000);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

registerTool({
  name: "spawn_agent",
  description:
    "Start a durable READ-ONLY child Agent in the background and return its stable id/path immediately. "
    + "Use a short lowercase task_name unique under the current Agent. Use list_agents/wait_agent for progress; "
    + "use send_message for in-flight guidance and followup_task for another generation.",
  input_schema: {
    type: "object",
    properties: {
      task_name: {
        type: "string",
        description: "stable lowercase name: letters/digits/_/-; must start with a letter",
        maxLength: 48,
      },
      message: { type: "string", description: "bounded self-contained assignment" },
      role: { type: "string", description: "optional Hara specialist role id" },
    },
    required: ["task_name", "message"],
  },
  kind: "read",
  concurrencySafe: false,
  classify: stateOperation,
  async run(input, ctx) {
    const team = unavailable(ctx);
    if (typeof team === "string") return team;
    if (typeof input.task_name !== "string" || typeof input.message !== "string") {
      return "Error: spawn_agent needs task_name and message.";
    }
    try {
      return json(await team.spawn({
        taskName: input.task_name,
        message: input.message,
        ...(typeof input.role === "string" ? { role: input.role } : {}),
      }));
    } catch (error) {
      return boundedError(error);
    }
  },
});

registerTool({
  name: "send_message",
  description:
    "Queue a durable message for an existing Agent. A working Agent receives it at the next model boundary; "
    + "an idle Agent keeps it for an explicit follow-up or resume.",
  input_schema: {
    type: "object",
    properties: {
      target: { type: "string", description: "stable Agent id, full path, or unambiguous task name" },
      message: { type: "string", description: "guidance or additional context" },
    },
    required: ["target", "message"],
  },
  kind: "read",
  concurrencySafe: false,
  classify: stateOperation,
  async run(input, ctx) {
    const team = unavailable(ctx);
    if (typeof team === "string") return team;
    if (typeof input.target !== "string" || typeof input.message !== "string") {
      return "Error: send_message needs target and message.";
    }
    try {
      return json(await team.sendMessage(input.target, input.message, ctx.toolCallId));
    } catch (error) {
      return boundedError(error);
    }
  },
});

registerTool({
  name: "followup_task",
  description:
    "Send follow-up work to a stable Agent. If it is idle, start a new read-only generation; if it is working, "
    + "deliver the follow-up at the next model boundary and start another generation only if delivery was too late.",
  input_schema: {
    type: "object",
    properties: {
      target: { type: "string", description: "stable Agent id, full path, or unambiguous task name" },
      message: { type: "string", description: "the follow-up assignment" },
    },
    required: ["target", "message"],
  },
  kind: "read",
  concurrencySafe: false,
  classify: stateOperation,
  async run(input, ctx) {
    const team = unavailable(ctx);
    if (typeof team === "string") return team;
    if (typeof input.target !== "string" || typeof input.message !== "string") {
      return "Error: followup_task needs target and message.";
    }
    try {
      return json(await team.followup(input.target, input.message, ctx.toolCallId));
    } catch (error) {
      return boundedError(error);
    }
  },
});

registerTool({
  name: "interrupt_agent",
  description:
    "Cooperatively interrupt a queued or working child Agent. Its stable record and accepted mailbox remain durable.",
  input_schema: {
    type: "object",
    properties: {
      target: { type: "string", description: "stable Agent id, full path, or unambiguous task name" },
    },
    required: ["target"],
  },
  kind: "read",
  concurrencySafe: false,
  classify: stateOperation,
  async run(input, ctx) {
    const team = unavailable(ctx);
    if (typeof team === "string") return team;
    if (typeof input.target !== "string") return "Error: interrupt_agent needs target.";
    try {
      return json(await team.interrupt(input.target));
    } catch (error) {
      return boundedError(error);
    }
  },
});

registerTool({
  name: "resume_agent",
  description:
    "Resume an Agent whose previous Hara runtime stopped. The stable id/path and accepted instructions are retained.",
  input_schema: {
    type: "object",
    properties: {
      target: { type: "string", description: "stable Agent id, full path, or unambiguous task name" },
    },
    required: ["target"],
  },
  kind: "read",
  concurrencySafe: false,
  classify: stateOperation,
  async run(input, ctx) {
    const team = unavailable(ctx);
    if (typeof team === "string") return team;
    if (typeof input.target !== "string") return "Error: resume_agent needs target.";
    try {
      return json(await team.resume(input.target));
    } catch (error) {
      return boundedError(error);
    }
  },
});

registerTool({
  name: "list_agents",
  description:
    "List safe metadata for every durable Agent in this session tree. Prompts, mailbox bodies, credentials and "
    + "results are omitted; wait_agent returns a selected Agent's terminal result.",
  input_schema: { type: "object", properties: {} },
  kind: "read",
  concurrencySafe: false,
  classify: stateOperation,
  async run(_input, ctx) {
    const team = unavailable(ctx);
    if (typeof team === "string") return team;
    try {
      return json({ agents: team.list() });
    } catch (error) {
      return boundedError(error);
    }
  },
});

registerTool({
  name: "wait_agent",
  description:
    "Wait briefly for one durable Agent, or for any currently active Agent when target is omitted. "
    + "Returns safe state plus the selected terminal result/error; waiting never changes the Agent.",
  input_schema: {
    type: "object",
    properties: {
      target: { type: "string", description: "optional stable Agent id/path/name" },
      timeout_ms: {
        type: "number",
        minimum: 0,
        maximum: 300000,
        description: "bounded wait; default 30000",
      },
    },
  },
  kind: "read",
  concurrencySafe: false,
  classify: stateOperation,
  async run(input, ctx) {
    const team = unavailable(ctx);
    if (typeof team === "string") return team;
    const timeoutMs = typeof input.timeout_ms === "number" ? input.timeout_ms : 30_000;
    try {
      if (typeof input.target === "string" && input.target.trim()) {
        return json(await team.wait(input.target, timeoutMs));
      }
      const active = team.list().filter((agent) =>
        agent.status === "queued" || agent.status === "working" || agent.status === "stopping");
      if (!active.length) return json({ settled: true, agents: team.list() });
      const first = await Promise.race<AgentTeamWaitResult>(
        active.map((agent) => team.wait(agent.id, timeoutMs)),
      );
      return json(first);
    } catch (error) {
      return boundedError(error);
    }
  },
});
