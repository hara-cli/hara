#!/usr/bin/env node
import { Command } from "commander";
import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, configPath, readRawConfig, writeConfigValue } from "./config.js";
import { runAgent } from "./agent/loop.js";
import { getTools } from "./tools/registry.js";
import { c, out } from "./ui.js";
import "./tools/builtin.js"; // side-effect: register built-in tools

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };

const maskKey = (v?: string) => (v ? `${v.slice(0, 7)}…${v.slice(-4)}` : "(unset)");

function helpText(): string {
  return (
    [
      c.bold("Commands:"),
      "  /help           show this help",
      "  /tools          list available tools",
      "  /model [id]     show or switch the model for this session",
      "  /reset, /clear  clear conversation context",
      "  /exit, /quit    leave",
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
  .option("-m, --model <model>", "model id (overrides config)");

// `hara config …`
const config = program.command("config").description("manage ~/.hara/config.json");
config
  .command("set <key> <value>")
  .description("set a config value (key: apiKey | model)")
  .action((key: string, value: string) => {
    if (key !== "apiKey" && key !== "model") {
      out(c.red(`Unknown key '${key}'. Valid keys: apiKey, model.\n`));
      process.exit(1);
    }
    writeConfigValue(key, value);
    out(c.green(`Set ${key} → ${configPath()}\n`));
  });
config
  .command("get [key]")
  .description("show config (apiKey masked)")
  .action((key?: string) => {
    const raw = readRawConfig();
    if (key) {
      out((key === "apiKey" ? maskKey(raw.apiKey) : raw[key] ?? "(unset)") + "\n");
    } else {
      out(`path:   ${configPath()}\nmodel:  ${raw.model ?? "(default claude-opus-4-8)"}\napiKey: ${maskKey(raw.apiKey)}\n`);
    }
  });
config
  .command("path")
  .description("print the config file path")
  .action(() => out(configPath() + "\n"));

// default action (interactive REPL / one-shot)
program.action(async (opts) => {
  const cfg = loadConfig();
  let model = opts.model ?? cfg.model;

  if (!cfg.apiKey) {
    out(c.red("No API key found.\n"));
    out(
      `Set ${c.bold("ANTHROPIC_API_KEY")}, or run ${c.bold("hara config set apiKey sk-ant-...")} ` +
        `(writes ${c.dim("~/.hara/config.json")}).\n`,
    );
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: cfg.apiKey });
  const ctx = { cwd: cfg.cwd };
  const history: Anthropic.MessageParam[] = [];

  if (opts.print) {
    history.push({ role: "user", content: String(opts.print) });
    await runAgent(history, { client, model, ctx, autoApprove: opts.yes ?? true, confirm: async () => true });
    return;
  }

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
    if (line === "/tools") {
      out(c.bold("Tools:\n"));
      for (const t of getTools()) out(`  ${t.name}${t.dangerous ? c.yellow(" *") : ""}  ${c.dim(t.description)}\n`);
      out(c.dim("  * requires confirmation (use -y to auto-approve)\n"));
      continue;
    }
    if (line === "/model" || line.startsWith("/model ")) {
      const m = line.slice("/model".length).trim();
      if (m) {
        model = m;
        out(c.dim(`(model → ${m})\n`));
      } else {
        out(`model: ${model}\n`);
      }
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
