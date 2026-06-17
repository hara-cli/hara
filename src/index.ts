#!/usr/bin/env node
import { Command } from "commander";
import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { runAgent } from "./agent/loop.js";
import { c, out } from "./ui.js";
import "./tools/builtin.js"; // side-effect: register built-in tools

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };

function helpText(): string {
  return (
    [
      c.bold("Commands:"),
      "  /help          show this help",
      "  /reset, /clear clear conversation context",
      "  /exit, /quit   leave",
      c.dim("  (anything else is sent to the agent)"),
    ].join("\n") + "\n"
  );
}

const program = new Command();
program
  .name("hara")
  .description("A coding agent CLI that runs like an engineering org.")
  .version(pkg.version)
  .option("-p, --print <prompt>", "run a single prompt non-interactively, then exit")
  .option("-y, --yes", "auto-approve tool actions (skip confirmations)")
  .option("-m, --model <model>", "model id (overrides config)")
  .action(async (opts) => {
    const cfg = loadConfig();
    const model = opts.model ?? cfg.model;

    if (!cfg.apiKey) {
      out(c.red("No API key found.\n"));
      out(
        `Set ${c.bold("ANTHROPIC_API_KEY")} in your environment, or create ${c.dim(
          "~/.hara/config.json",
        )} with ${c.dim('{ "apiKey": "sk-ant-..." }')}.\n`,
      );
      process.exit(1);
    }

    const client = new Anthropic({ apiKey: cfg.apiKey });
    const ctx = { cwd: cfg.cwd };
    const history: Anthropic.MessageParam[] = [];

    // One-shot mode
    if (opts.print) {
      history.push({ role: "user", content: String(opts.print) });
      await runAgent(history, { client, model, ctx, autoApprove: opts.yes ?? true, confirm: async () => true });
      return;
    }

    // Interactive REPL
    out(c.bold(`hara ${pkg.version}`) + c.dim(`  ·  ${model}  ·  ${ctx.cwd}\n`));
    out(c.dim("Type a task. /help for commands, /exit to quit.\n\n"));

    const rl = createInterface({ input: stdin, output: stdout });
    const confirm = async (q: string) =>
      (await rl.question(`${q} ${c.dim("[y/N]")} `)).trim().toLowerCase().startsWith("y");

    for (;;) {
      let line: string;
      try {
        line = (await rl.question(c.cyan("hara> "))).trim();
      } catch {
        break; // Ctrl-D / closed stream
      }
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/help") {
        out(helpText());
        continue;
      }
      if (line === "/reset" || line === "/clear") {
        history.length = 0;
        out(c.dim("(context cleared)\n"));
        continue;
      }
      history.push({ role: "user", content: line });
      try {
        await runAgent(history, { client, model, ctx, autoApprove: opts.yes ?? false, confirm });
      } catch (e: any) {
        out(c.red(`\n[error] ${e.message}\n`));
      }
      out("\n");
    }
    rl.close();
  });

program.parseAsync().catch((e) => {
  out(c.red(`\n[fatal] ${e?.message ?? e}\n`));
  process.exit(1);
});
