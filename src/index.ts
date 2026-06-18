#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadConfig,
  configPath,
  readRawConfig,
  writeConfigValue,
  providerEnvKey,
  CONFIG_KEYS,
  type HaraConfig,
} from "./config.js";
import { runAgent } from "./agent/loop.js";
import { getTools } from "./tools/registry.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { qwenDeviceLogin, getValidQwenAuth } from "./providers/qwen-oauth.js";
import { loadAgentsMd, hasAgentsMd, INIT_PROMPT } from "./context/agents-md.js";
import { expandMentions, fileCandidates } from "./context/mentions.js";
import type { Provider, NeutralMsg } from "./providers/types.js";
import { c, out } from "./ui.js";
import "./tools/builtin.js"; // side-effect: register read_file/write_file/bash
import "./tools/edit.js"; // side-effect: register edit_file

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };

const maskKey = (v?: string) => (v ? `${v.slice(0, 7)}…${v.slice(-4)}` : "(unset)");

async function buildProvider(cfg: HaraConfig): Promise<Provider | null> {
  if (cfg.provider === "qwen-oauth") {
    const auth = await getValidQwenAuth();
    if (!auth) return null;
    return createOpenAIProvider({ apiKey: auth.accessToken, baseURL: auth.baseURL, model: cfg.model, label: "qwen-oauth" });
  }
  if (!cfg.apiKey) return null;
  if (cfg.provider === "anthropic") {
    return createAnthropicProvider({ apiKey: cfg.apiKey, model: cfg.model, baseURL: cfg.baseURL });
  }
  return createOpenAIProvider({ apiKey: cfg.apiKey, model: cfg.model, baseURL: cfg.baseURL, label: cfg.provider });
}

function authHint(cfg: HaraConfig): string {
  if (cfg.provider === "qwen-oauth") return `Run ${c.bold("hara login qwen")} to authenticate.`;
  return `Set ${c.bold(providerEnvKey(cfg.provider))} (or ${c.bold("HARA_API_KEY")}), or run ${c.bold("hara config set apiKey <key>")}.`;
}

/** Run hara against itself to analyze the repo and write AGENTS.md. */
async function runInit(provider: Provider, cwd: string): Promise<void> {
  const history: NeutralMsg[] = [{ role: "user", content: INIT_PROMPT }];
  await runAgent(history, { provider, ctx: { cwd }, autoApprove: true, confirm: async () => true });
}

/** readline completer: complete `@path` tokens from tracked files. */
function mentionCompleter(line: string, cwd: string): [string[], string] {
  const m = /@([^\s@]*)$/.exec(line);
  if (!m) return [[], line];
  const hits = fileCandidates(cwd, m[1]).map((f) => "@" + f);
  return [hits, "@" + m[1]];
}

function helpText(): string {
  return (
    [
      c.bold("Commands:"),
      "  /help           show this help",
      "  /init           analyze the project & (re)generate AGENTS.md",
      "  /tools          list available tools",
      "  /model [id]     show or switch the model for this session",
      "  /reset, /clear  clear conversation context",
      "  /exit, /quit    leave",
      c.dim("  @path           attach a file's contents to your message (Tab to complete)"),
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

// `hara init` — analyze repo & write AGENTS.md
program
  .command("init")
  .description("analyze the project and (re)generate AGENTS.md")
  .action(async () => {
    const cfg = loadConfig();
    const provider = await buildProvider(cfg);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    out(c.dim("Analyzing project to generate AGENTS.md…\n"));
    await runInit(provider, cfg.cwd);
  });

// `hara login qwen`
const login = program.command("login").description("authenticate a provider");
login
  .command("qwen")
  .description("Qwen OAuth device login (free 'Qwen Code' tier — same as OpenClaw)")
  .action(async () => {
    try {
      await qwenDeviceLogin((m) => out(m + "\n"));
      writeConfigValue("provider", "qwen-oauth");
      writeConfigValue("model", "coder-model");
      out(c.green("\n✓ Qwen OAuth complete — provider set to qwen-oauth (model coder-model).\n"));
    } catch (e: any) {
      out(c.red(`\nQwen OAuth failed: ${e.message}\n`));
      process.exit(1);
    }
  });

// `hara config …`
const config = program.command("config").description("manage ~/.hara/config.json");
config
  .command("set <key> <value>")
  .description(`set a config value (keys: ${CONFIG_KEYS.join(" | ")})`)
  .action((key: string, value: string) => {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      out(c.red(`Unknown key '${key}'. Valid keys: ${CONFIG_KEYS.join(", ")}.\n`));
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
      out(
        `path:     ${configPath()}\n` +
          `provider: ${raw.provider ?? "(default anthropic)"}\n` +
          `model:    ${raw.model ?? "(provider default)"}\n` +
          `baseURL:  ${raw.baseURL ?? "(provider default)"}\n` +
          `apiKey:   ${maskKey(raw.apiKey)}\n`,
      );
    }
  });
config
  .command("path")
  .description("print the config file path")
  .action(() => out(configPath() + "\n"));

// default action (interactive REPL / one-shot)
program.action(async (opts) => {
  const cfg = loadConfig();
  if (opts.model) cfg.model = opts.model;
  let provider = await buildProvider(cfg);
  if (!provider) {
    out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
    process.exit(1);
  }
  const cwd = cfg.cwd;

  // one-shot
  if (opts.print) {
    const projectContext = loadAgentsMd(cwd) || undefined;
    const history: NeutralMsg[] = [{ role: "user", content: expandMentions(String(opts.print), cwd) }];
    await runAgent(history, { provider, ctx: { cwd }, autoApprove: opts.yes ?? true, confirm: async () => true, projectContext });
    return;
  }

  // interactive REPL
  out(c.bold(`hara ${pkg.version}`) + c.dim(`  ·  ${cfg.provider}:${cfg.model}  ·  ${cwd}\n`));
  const rl = createInterface({
    input: stdin,
    output: stdout,
    completer: (line: string) => mentionCompleter(line, cwd),
  });
  const confirm = async (q: string) =>
    (await rl.question(`${q} ${c.dim("[y/N]")} `)).trim().toLowerCase().startsWith("y");

  // auto-init AGENTS.md on first run in a project
  if (!hasAgentsMd(cwd)) {
    const ans = (await rl.question(`${c.dim("No AGENTS.md here — analyze this project and create one?")} ${c.dim("[Y/n]")} `)).trim().toLowerCase();
    if (ans === "" || ans.startsWith("y")) {
      out(c.dim("Analyzing project…\n"));
      try {
        await runInit(provider, cwd);
      } catch (e: any) {
        out(c.red(`[init error] ${e.message}\n`));
      }
    }
  }
  let projectContext = loadAgentsMd(cwd) || undefined;

  out(c.dim(`Type a task. /help · @path attaches a file · /exit to quit.${projectContext ? "  (AGENTS.md loaded)" : ""}\n\n`));
  const history: NeutralMsg[] = [];

  for (;;) {
    let line: string;
    try {
      line = (await rl.question(c.cyan("hara> "))).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") {
      out(helpText());
      continue;
    }
    if (line === "/init") {
      out(c.dim("Analyzing project…\n"));
      try {
        await runInit(provider, cwd);
        projectContext = loadAgentsMd(cwd) || undefined;
        out(c.green("AGENTS.md updated.\n"));
      } catch (e: any) {
        out(c.red(`[init error] ${e.message}\n`));
      }
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
        cfg.model = m;
        const p = await buildProvider(cfg);
        if (p) {
          provider = p;
          out(c.dim(`(model → ${cfg.provider}:${m})\n`));
        } else {
          out(c.red("(could not rebuild provider)\n"));
        }
      } else {
        out(`${cfg.provider}:${cfg.model}\n`);
      }
      continue;
    }
    if (line === "/reset" || line === "/clear") {
      history.length = 0;
      out(c.dim("(context cleared)\n"));
      continue;
    }
    history.push({ role: "user", content: expandMentions(line, cwd) });
    try {
      await runAgent(history, { provider, ctx: { cwd }, autoApprove: opts.yes ?? false, confirm, projectContext });
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
