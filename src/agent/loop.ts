import Anthropic from "@anthropic-ai/sdk";
import { getTool, toolDefs, type ToolContext } from "../tools/registry.js";
import { c, out } from "../ui.js";

const system = (cwd: string) =>
  `You are hara, a coding agent running in the user's terminal.
Working directory: ${cwd}
Be concise and direct. Use the provided tools to read files, write files, and run shell
commands. Prefer small, verifiable steps. After completing a task, give a one-line summary.`;

export interface RunOpts {
  client: Anthropic;
  model: string;
  ctx: ToolContext;
  autoApprove: boolean;
  confirm: (q: string) => Promise<boolean>;
}

/** Streaming manual agentic loop. Mutates `history` in place. */
export async function runAgent(history: Anthropic.MessageParam[], opts: RunOpts): Promise<void> {
  const { client, model, ctx } = opts;

  while (true) {
    const stream = client.messages.stream({
      model,
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      system: system(ctx.cwd),
      tools: toolDefs(),
      messages: history,
    });
    stream.on("text", (delta) => out(delta));

    let message: Anthropic.Message;
    try {
      message = await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        out(c.red(`\n[API error ${e.status ?? ""}] ${e.message}\n`));
        return;
      }
      throw e;
    }
    out("\n");

    history.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "refusal") {
      out(c.yellow("[the model declined this request]\n"));
      return;
    }
    if (message.stop_reason === "pause_turn") continue; // server tool paused; resend
    if (message.stop_reason !== "tool_use") return; // end_turn / stop_sequence / max_tokens

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const tool = getTool(tu.name);
      if (!tool) {
        results.push({ type: "tool_result", tool_use_id: tu.id, content: `Unknown tool: ${tu.name}`, is_error: true });
        continue;
      }
      if (tool.dangerous && !opts.autoApprove) {
        const input = tu.input as Record<string, unknown>;
        const preview = String(input.command ?? input.path ?? "");
        const ok = await opts.confirm(`${c.yellow("⚠")}  ${c.bold(tu.name)} ${c.dim(preview)} — run?`);
        if (!ok) {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "User denied this action.", is_error: true });
          continue;
        }
      }
      out(c.dim(`  ↳ ${tu.name}\n`));
      try {
        const result = await tool.run(tu.input, ctx);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
      } catch (e: any) {
        results.push({ type: "tool_result", tool_use_id: tu.id, content: `Error: ${e.message}`, is_error: true });
      }
    }

    history.push({ role: "user", content: results });
  }
}
