// The `skill` tool — load a skill's full instructions on demand. The system prompt lists available
// skills (id + description); the model calls this to pull the body before doing a task the skill covers.
// Returning the body as a tool RESULT (not editing the system prompt) keeps the cached prefix stable.
import { dirname } from "node:path";
import { registerTool } from "./registry.js";
import { loadSkillIndex, loadSkillBody } from "../skills/skills.js";
import { scanMemory } from "../memory/guard.js";

registerTool({
  name: "skill",
  description:
    "Load the full instructions for a skill by id. The system prompt's Skills list shows what's available; " +
    "call this to get a skill's steps before performing a task it covers, then follow them.",
  input_schema: { type: "object", properties: { id: { type: "string", description: "the skill id from the Skills list" } }, required: ["id"] },
  kind: "read",
  concurrencySafe: true,
  async run(input, ctx) {
    const id = String(input.id ?? "").trim();
    const sk = loadSkillIndex(ctx.cwd).find((s) => s.id === id);
    if (!sk) return `No skill '${id}'. See the Skills list in the system prompt for available ids.`;
    const body = loadSkillBody(sk);
    if (!body) return `Skill '${id}' has no instructions.`;
    const scan = scanMemory(body); // skills may come from plugins (untrusted) — guard at load time
    if (!scan.ok) return `Skill '${id}' blocked: its content looks unsafe (${scan.hits.join(", ")}).`;
    // Tell the model where this skill lives so it can read sibling files (assets/, references/) by absolute
    // path — relying on "~" or cwd-relative guessing is unreliable across tools/sandboxes.
    const located = `Skill directory (absolute): ${dirname(sk.file)}\nRead any sibling files this skill mentions (e.g. references/…, assets/…) from under that directory.\n\n${body}`;
    if (sk.context === "fork" && ctx.spawn) {
      // fork: run the skill as a delegated sub-agent rather than inlining it into this turn
      return await ctx.spawn(`Follow this skill to complete the current task:\n\n${located}`, undefined, ctx.signal);
    }
    return located; // inline (default): the body enters the conversation as this tool's result
  },
});
