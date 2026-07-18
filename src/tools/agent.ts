// agent — delegate a self-contained sub-task to a fresh sub-agent. Several `agent` calls in one
// turn run in PARALLEL (kind "read" → concurrent), making the footer's ⛁ count real. Sub-agents are
// read-only by default (safe to parallelize); the actual spawn is provided via ctx.spawn.
import { registerTool } from "./registry.js";

/** Built-in persona for `role: "explore"` (no setup needed — index.ts falls back to this when the
 *  user hasn't defined an explore role). Claude-Code's Explore-agent playbook: read-only, parallel,
 *  excerpts-not-files, conclusions-not-dumps. */
export const EXPLORE_SYSTEM =
  "You are a fast, READ-ONLY codebase explorer. Navigate with grep/glob/ls/read_file and be quick: " +
  "issue your searches and file reads as MULTIPLE PARALLEL tool calls in one round whenever they are " +
  "independent — never one-per-turn. Read targeted excerpts, not whole files. You cannot modify anything. " +
  "Answer with CONCLUSIONS: the finding, the relevant paths with line references, and what they mean for " +
  "the question — never dump raw file contents. Match your depth to the task: a quick lookup stays quick; " +
  "an architecture question deserves a thorough sweep across naming conventions and directories.";

registerTool({
  name: "agent",
  description:
    "Delegate an independent sub-task to a fresh READ-ONLY sub-agent and get its conclusions. " +
    "Specialist role ids and descriptions appear under `# Specialist roles` in the system context; pass one " +
    "only when its distinct expertise helps, and give it a minimal self-contained brief instead of conversation dumps. " +
    "WHEN TO USE: open-ended exploration ('how does X work across the codebase', 'find everything that touches Y') " +
    "that would take more than ~3 searches — pass role \"explore\" for a fast search specialist; and spawning " +
    "SEVERAL agents in ONE response for independent questions (they run in parallel). " +
    "WHEN NOT TO USE: reading a specific known file (read_file), finding one symbol (grep), or searching " +
    "within 2-3 known files — direct tools are faster. Never for edits. " +
    "Pass a `role` id to use that role's persona + tools.",
  input_schema: {
    type: "object",
    properties: {
      task: { type: "string", description: "the self-contained sub-task to delegate" },
      role: { type: "string", description: "optional role id (uses its persona + tool subset)" },
    },
    required: ["task"],
  },
  kind: "read", // parallel-safe: multiple agent() calls in a turn run concurrently
  concurrencySafe: true,
  async run(input, ctx) {
    if (!ctx.spawn) return "Error: sub-agents are not available in this context.";
    if (typeof input.task !== "string" || !input.task.trim()) return "Error: agent needs a `task`.";
    return await ctx.spawn(input.task, input.role ? String(input.role) : undefined, ctx.signal);
  },
});
