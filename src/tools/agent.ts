// agent — delegate a self-contained sub-task to a fresh sub-agent. Several `agent` calls in one
// turn run in PARALLEL (kind "read" → concurrent), making the footer's ⛁ count real. Sub-agents are
// read-only by default (safe to parallelize); the actual spawn is provided via ctx.spawn.
import { registerTool } from "./registry.js";

registerTool({
  name: "agent",
  description:
    "Delegate an independent sub-task to a fresh sub-agent and get its result. Spawn SEVERAL in one " +
    "turn to run them in parallel (e.g. analyze/search/review N things at once). Sub-agents are " +
    "read-only by default; pass a `role` id to use that role's persona + tools. Not for edits.",
  input_schema: {
    type: "object",
    properties: {
      task: { type: "string", description: "the self-contained sub-task to delegate" },
      role: { type: "string", description: "optional role id (uses its persona + tool subset)" },
    },
    required: ["task"],
  },
  kind: "read", // parallel-safe: multiple agent() calls in a turn run concurrently
  async run(input, ctx) {
    if (!ctx.spawn) return "Error: sub-agents are not available in this context.";
    if (typeof input.task !== "string" || !input.task.trim()) return "Error: agent needs a `task`.";
    return await ctx.spawn(input.task, input.role ? String(input.role) : undefined);
  },
});
