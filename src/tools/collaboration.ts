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
    "Start a durable child Agent in the background and return its stable id/path immediately. runtime defaults to hara. "
    + "runtime codex or claude starts that coding agent inside a private Git worktree. The root run requires a fresh "
    + "approval; a child Hara Agent may launch only a runtime the user already granted to that Agent. "
    + "Native Hara Agents are READ-ONLY by default. "
    + "Use workspace:'isolated-write' only for an implementation task: Hara gives that child a private Git worktree, "
    + "allows only bounded native file edits, and requires inspect_agent_diff + apply_agent_diff before source files change. "
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
      runtime: {
        type: "string",
        enum: ["hara", "codex", "claude"],
        description: "execution runtime; codex/claude automatically require isolated-write",
      },
      workspace: {
        type: "string",
        enum: ["read-only", "isolated-write"],
        description: "default read-only; isolated-write creates an Agent-owned Git worktree",
      },
    },
    required: ["task_name", "message"],
  },
  kind: "read",
  concurrencySafe: false,
  classify: (input, ctx) => (
    (input?.runtime === "codex" || input?.runtime === "claude")
    && ctx.spaceId === "personal"
  )
    ? {
        effect: "exec" as const,
        concurrencySafe: false,
        approvalKind: "exec" as const,
        ...(ctx.agentTeam?.path === "/root" ? { requiresExplicitApproval: true } : {}),
      }
    : stateOperation(),
  async run(input, ctx) {
    const team = unavailable(ctx);
    if (typeof team === "string") return team;
    if (typeof input.task_name !== "string" || typeof input.message !== "string") {
      return "Error: spawn_agent needs task_name and message.";
    }
    const runtime = typeof input.runtime === "string" ? input.runtime : "hara";
    if (runtime !== "hara" && runtime !== "codex" && runtime !== "claude") {
      return "Error: runtime must be hara, codex, or claude.";
    }
    if (runtime !== "hara" && ctx.spaceId !== "personal") {
      return "Error: local Codex and Claude coding runtimes are available only in Personal Space.";
    }
    if (runtime !== "hara" && !team.runtimeGrants.includes(runtime)) {
      return `Error: Agent '${team.path}' has not been granted the ${runtime} coding runtime.`;
    }
    try {
      return json(await team.spawn({
        taskName: input.task_name,
        message: input.message,
        ...(typeof input.role === "string" ? { role: input.role } : {}),
        ...(typeof input.workspace === "string" ? { workspace: input.workspace } : {}),
        runtime,
      }, ctx.toolCallId));
    } catch (error) {
      return boundedError(error);
    }
  },
});

registerTool({
  name: "agent_room",
  description:
    "Create or use a small durable Agent group room. A room keeps one ordered, auditable transcript while "
    + "delivering each post to the other Agent participants' mailboxes. Idle Agents are not auto-restarted, "
    + "which prevents unbounded chat loops; use followup_task when an idle participant must act. "
    + "Actions: create, post, list, read, close.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "post", "list", "read", "close"] },
      room: { type: "string", description: "room id or name for post/read/close" },
      name: { type: "string", description: "lowercase room name for create" },
      members: {
        type: "array",
        items: { type: "string" },
        maxItems: 8,
        description: "Agent ids, full paths, or unambiguous task names for create",
      },
      message: { type: "string", description: "message for post" },
      limit: { type: "number", minimum: 1, maximum: 50, description: "recent messages for read" },
    },
    required: ["action"],
  },
  kind: "read",
  concurrencySafe: false,
  classify: stateOperation,
  async run(input, ctx) {
    const team = unavailable(ctx);
    if (typeof team === "string") return team;
    const action = typeof input.action === "string" ? input.action : "";
    try {
      if (action === "list") return json({ rooms: team.listRooms() });
      if (action === "create") {
        if (typeof input.name !== "string" || !Array.isArray(input.members)) {
          return "Error: agent_room create needs name and members.";
        }
        return json(await team.createRoom({
          name: input.name,
          members: input.members.filter((member: unknown): member is string => typeof member === "string"),
        }, ctx.toolCallId));
      }
      if (action === "post") {
        if (typeof input.room !== "string" || typeof input.message !== "string") {
          return "Error: agent_room post needs room and message.";
        }
        return json(await team.postRoom({ room: input.room, message: input.message }, ctx.toolCallId));
      }
      if (action === "read") {
        if (typeof input.room !== "string") return "Error: agent_room read needs room.";
        return json(team.readRoom(input.room, typeof input.limit === "number" ? input.limit : undefined));
      }
      if (action === "close") {
        if (typeof input.room !== "string") return "Error: agent_room close needs room.";
        return json(await team.closeRoom(input.room));
      }
      return "Error: agent_room action must be create, post, list, read, or close.";
    } catch (error) {
      return boundedError(error);
    }
  },
});

registerTool({
  name: "inspect_agent_diff",
  description:
    "Read the current owned Diff from a settled isolated-write Agent. Returns exact base commit, changed paths, "
    + "patch hash, and reviewable patch text. Inspection never changes the user's source checkout.",
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
    if (typeof input.target !== "string") return "Error: inspect_agent_diff needs target.";
    try {
      return json(await team.inspectDiff(input.target));
    } catch (error) {
      return boundedError(error);
    }
  },
});

registerTool({
  name: "apply_agent_diff",
  description:
    "Explicitly apply a previously inspected Agent-owned Diff to the source checkout. Hara refuses if the "
    + "Diff, source HEAD, ownership, or any changed source path no longer matches; it never auto-merges conflicts.",
  input_schema: {
    type: "object",
    properties: {
      target: { type: "string", description: "stable Agent id, full path, or unambiguous task name" },
    },
    required: ["target"],
  },
  kind: "edit",
  concurrencySafe: false,
  requiresProjectWorkspace: true,
  classify: () => ({ effect: "edit", concurrencySafe: false, requiresExplicitApproval: true }),
  async run(input, ctx) {
    const team = unavailable(ctx);
    if (typeof team === "string") return team;
    if (typeof input.target !== "string") return "Error: apply_agent_diff needs target.";
    try {
      return json(await team.applyDiff(input.target));
    } catch (error) {
      return boundedError(error);
    }
  },
});

registerTool({
  name: "reject_agent_diff",
  description:
    "Explicitly reject an unresolved Agent-owned Diff. The source checkout remains unchanged and the durable "
    + "Agent record is marked rejected; start a new Agent for another implementation attempt.",
  input_schema: {
    type: "object",
    properties: {
      target: { type: "string", description: "stable Agent id, full path, or unambiguous task name" },
    },
    required: ["target"],
  },
  kind: "edit",
  concurrencySafe: false,
  classify: () => ({ effect: "edit", concurrencySafe: false, destructive: true }),
  async run(input, ctx) {
    const team = unavailable(ctx);
    if (typeof team === "string") return team;
    if (typeof input.target !== "string") return "Error: reject_agent_diff needs target.";
    try {
      return json(await team.rejectDiff(input.target));
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
