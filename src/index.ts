#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
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
  APPROVAL_MODES,
  SANDBOX_MODES,
  type HaraConfig,
  type ApprovalMode,
} from "./config.js";
import { runAgent } from "./agent/loop.js";
import { getTools } from "./tools/registry.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { qwenDeviceLogin, getValidQwenAuth } from "./providers/qwen-oauth.js";
import { loadAgentsMd, hasAgentsMd, INIT_PROMPT } from "./context/agents-md.js";
import { expandMentions, fileCandidates } from "./context/mentions.js";
import {
  newSessionId,
  saveSession,
  loadSession,
  listSessions,
  latestForCwd,
  titleFrom,
  type SessionMeta,
  type SessionData,
} from "./session/store.js";
import { loadRoles, scaffoldRoles, type Role } from "./org/roles.js";
import { routeByKeywords, buildDispatchPrompt, parseRoleId } from "./org/router.js";
import { decompose, topoOrder, savePlan, atomPrompt, verify, type Atom } from "./org/planner.js";
import { connectMcpServers, closeMcp } from "./mcp/client.js";
import { sandboxSupported, type SandboxMode } from "./sandbox.js";
import type { Provider, NeutralMsg } from "./providers/types.js";
import { c, out, statusLine } from "./ui.js";
import * as bar from "./statusbar.js";
import { nearest } from "./fuzzy.js";
import "./tools/builtin.js"; // register read_file/write_file/bash
import "./tools/edit.js"; // register edit_file
import "./tools/search.js"; // register grep/glob/ls
import "./tools/patch.js"; // register apply_patch

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

async function runInit(provider: Provider, cwd: string, sandbox: SandboxMode = "off"): Promise<void> {
  const history: NeutralMsg[] = [{ role: "user", content: INIT_PROMPT }];
  await runAgent(history, { provider, ctx: { cwd, sandbox }, approval: "full-auto", confirm: async () => true });
}

interface OrgOpts {
  cfg: HaraConfig;
  baseProvider: Provider;
  cwd: string;
  sandbox: SandboxMode;
  approval: ApprovalMode;
  confirm: (q: string) => Promise<boolean>;
  projectContext?: string;
  stats: { input: number; output: number };
  forceRole?: string;
}

/** Dispatch a task to the owning role and run that role's agent (its persona + tool subset + model). */
async function runOrg(task: string, o: OrgOpts): Promise<void> {
  const roles = loadRoles(o.cwd);
  if (!roles.length) {
    out(c.yellow("No roles defined — run ") + c.bold("hara roles init") + c.yellow(" to scaffold some.\n"));
    return;
  }
  let role: Role | undefined;
  if (o.forceRole) {
    role = roles.find((r) => r.id === o.forceRole);
    if (!role) {
      out(c.red(`No role '${o.forceRole}'. Available: ${roles.map((r) => r.id).join(", ")}\n`));
      return;
    }
  } else {
    const kw = routeByKeywords(task, roles);
    if (kw) {
      role = kw.role;
    } else {
      const r = await o.baseProvider.turn({
        system: "You are a task dispatcher. Reply with only a role id.",
        history: [{ role: "user", content: buildDispatchPrompt(task, roles) }],
        tools: [],
        onText: () => {},
      });
      role = parseRoleId(r.text, roles) ?? roles[0];
    }
  }
  out(c.dim(`→ ${role.id} owns this task\n`));

  const roleProvider =
    role.model && role.model !== o.cfg.model
      ? ((await buildProvider({ ...o.cfg, model: role.model })) ?? o.baseProvider)
      : o.baseProvider;
  const toolFilter = role.allowTools
    ? (n: string) => role!.allowTools!.includes(n)
    : role.denyTools
      ? (n: string) => !role!.denyTools!.includes(n)
      : undefined;

  const history: NeutralMsg[] = [{ role: "user", content: expandMentions(task, o.cwd) }];
  await runAgent(history, {
    provider: roleProvider,
    ctx: { cwd: o.cwd, sandbox: o.sandbox },
    approval: o.approval,
    confirm: o.confirm,
    projectContext: o.projectContext,
    stats: o.stats,
    systemOverride: role.system,
    toolFilter,
  });
}

function lastAssistantText(history: NeutralMsg[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i] as { role: string; text?: string };
    if (m.role === "assistant" && typeof m.text === "string") return m.text;
  }
  return "";
}

/** Decompose a task into atoms, sequence them (DAG), and execute each with a verify gate. */
async function runPlan(task: string, o: OrgOpts): Promise<void> {
  const roles = loadRoles(o.cwd);
  out(c.dim("Planning…\n"));
  const plan = await decompose(o.baseProvider, task, roles);
  if (!plan.atoms.length) {
    out(c.red("Planner returned no atoms — try rephrasing the task.\n"));
    return;
  }
  const ord = topoOrder(plan.atoms);
  if ("error" in ord) {
    out(c.red(`${ord.error}\n`));
    return;
  }
  const ordered = ord.ok;
  out(c.bold(`\nPlan (${ordered.length} atoms):\n`));
  for (const a of ordered) {
    out(`  ${c.cyan(a.id)} ${a.title}${a.deps.length ? c.dim(" ←" + a.deps.join(",")) : ""}${a.role ? c.dim(" @" + a.role) : ""}\n`);
  }
  if (o.approval !== "full-auto") {
    const ok = await o.confirm(`${c.yellow("▶")} Execute this ${ordered.length}-atom plan?`);
    if (!ok) return void out(c.dim("(cancelled)\n"));
  }
  savePlan(o.cwd, plan);
  const done: Atom[] = [];
  for (const atom of ordered) {
    atom.status = "running";
    savePlan(o.cwd, plan);
    out(c.cyan(`\n▶ ${atom.id} ${atom.title}\n`));
    const role = atom.role ? roles.find((r) => r.id === atom.role) : undefined;
    const roleProvider =
      role?.model && role.model !== o.cfg.model ? ((await buildProvider({ ...o.cfg, model: role.model })) ?? o.baseProvider) : o.baseProvider;
    const toolFilter = role?.allowTools
      ? (n: string) => role.allowTools!.includes(n)
      : role?.denyTools
        ? (n: string) => !role.denyTools!.includes(n)
        : undefined;
    const history: NeutralMsg[] = [{ role: "user", content: atomPrompt(atom, plan, done) }];
    try {
      await runAgent(history, {
        provider: roleProvider,
        ctx: { cwd: o.cwd, sandbox: o.sandbox },
        approval: o.approval,
        confirm: o.confirm,
        projectContext: o.projectContext,
        stats: o.stats,
        systemOverride: role?.system,
        toolFilter,
      });
    } catch (e: any) {
      atom.status = "failed";
      atom.note = e.message;
      savePlan(o.cwd, plan);
      out(c.red(`  ✗ ${atom.id} errored: ${e.message}\n`));
      break;
    }
    const v = await verify(o.baseProvider, atom, lastAssistantText(history));
    atom.status = v.ok ? "done" : "failed";
    atom.note = v.reason;
    savePlan(o.cwd, plan);
    if (v.ok) {
      out(c.green(`  ✓ ${atom.id} verified\n`));
      done.push(atom);
    } else {
      out(c.yellow(`  ⚠ ${atom.id}: ${v.reason}\n`) + c.dim("Stopping — inspect .hara/org/plan.json, then refine & re-run.\n"));
      break;
    }
  }
  out(c.bold(`\nPlan: ${plan.atoms.filter((a) => a.status === "done").length}/${plan.atoms.length} atoms done.\n`));
}

function mentionCompleter(line: string, cwd: string): [string[], string] {
  const m = /@([^\s@]*)$/.exec(line);
  if (!m) return [[], line];
  return [fileCandidates(cwd, m[1]).map((f) => "@" + f), "@" + m[1]];
}

interface Slash {
  name: string;
  aliases?: string[];
  desc: string;
  run: (args: string) => Promise<"exit" | void> | ("exit" | void);
}

function helpText(commands: Slash[]): string {
  const lines = commands.map((cmd) => `  /${cmd.name.padEnd(13)} ${c.dim(cmd.desc)}`);
  return c.bold("Commands:\n") + lines.join("\n") + "\n" + c.dim("  @path          attach a file's contents (Tab to complete)\n");
}

const program = new Command();
program
  .name("hara")
  .description("A coding agent CLI that runs like an engineering org.")
  .version(pkg.version)
  .option("-p, --print <prompt>", "run a single prompt non-interactively, then exit")
  .option("-y, --yes", "auto-approve all tool actions (= --approval full-auto)")
  .option("-m, --model <model>", "model id (overrides config)")
  .option("--approval <mode>", "approval mode: suggest | auto-edit | full-auto")
  .option("--profile <name>", "use a named profile from ~/.hara/config.json")
  .option("-c, --continue", "resume the most recent session in this directory")
  .option("--resume <id>", "resume a specific session by id")
  .option("--sandbox <mode>", "sandbox the shell: off | workspace-write | read-only");

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
    await runInit(provider, cfg.cwd, cfg.sandbox);
  });

program
  .command("sessions")
  .description("list saved sessions")
  .action(() => {
    const metas = listSessions();
    if (!metas.length) {
      out(c.dim("No sessions yet.\n"));
      return;
    }
    for (const m of metas) {
      out(`${c.bold(m.id)}  ${c.dim(m.updatedAt.slice(0, 16).replace("T", " "))}  ${m.provider}:${m.model}  ${m.title}\n`);
    }
  });

program
  .command("org <task...>")
  .description("dispatch a task to the owning role and run it")
  .option("--role <id>", "force a specific role")
  .action(async (taskParts: string[], opts2: { role?: string }) => {
    const cfg = loadConfig();
    const provider = await buildProvider(cfg);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    const stats = { input: 0, output: 0, lastInput: 0 };
    await runOrg(taskParts.join(" "), {
      cfg,
      baseProvider: provider,
      cwd: cfg.cwd,
      sandbox: cfg.sandbox,
      approval: "full-auto",
      confirm: async () => true,
      projectContext: loadAgentsMd(cfg.cwd) || undefined,
      stats,
      forceRole: opts2.role,
    });
    if (stats.input || stats.output) out(statusLine(cfg.model, stats.input, stats.output) + "\n");
  });

program
  .command("plan <task...>")
  .description("decompose a task into atoms, sequence them (DAG), and execute each with a verify gate")
  .action(async (taskParts: string[]) => {
    const cfg = loadConfig();
    const provider = await buildProvider(cfg);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    const stats = { input: 0, output: 0, lastInput: 0 };
    await runPlan(taskParts.join(" "), {
      cfg,
      baseProvider: provider,
      cwd: cfg.cwd,
      sandbox: cfg.sandbox,
      approval: "full-auto",
      confirm: async () => true,
      projectContext: loadAgentsMd(cfg.cwd) || undefined,
      stats,
    });
    if (stats.input || stats.output) out(statusLine(cfg.model, stats.input, stats.output) + "\n");
  });

const rolesCmd = program.command("roles").description("manage org roles (.hara/roles)");
rolesCmd
  .command("init")
  .description("scaffold example roles")
  .action(() => {
    const written = scaffoldRoles(process.cwd());
    out(
      written.length
        ? c.green(`Created ${written.length} file(s) in .hara/roles/: ${written.join(", ")}\n`)
        : c.dim("Roles already exist in .hara/roles/.\n"),
    );
  });
rolesCmd.action(() => {
  const roles = loadRoles(process.cwd());
  if (!roles.length) {
    out(c.dim("No roles. Run `hara roles init`.\n"));
    return;
  }
  for (const r of roles) {
    out(`${c.bold(r.id)}${r.model ? c.dim(` (${r.model})`) : ""}  ${c.dim("owns: " + r.owns.join(", "))}\n  ${r.description}\n`);
  }
});

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

const config = program.command("config").description("manage ~/.hara/config.json");
config
  .command("set <key> <value>")
  .description(`set a config value (keys: ${CONFIG_KEYS.join(" | ")})`)
  .action((key: string, value: string) => {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      out(c.red(`Unknown key '${key}'. Valid keys: ${CONFIG_KEYS.join(", ")}.\n`));
      process.exit(1);
    }
    if (key === "approval" && !APPROVAL_MODES.includes(value as ApprovalMode)) {
      out(c.red(`Invalid approval mode. One of: ${APPROVAL_MODES.join(", ")}.\n`));
      process.exit(1);
    }
    if (key === "sandbox" && !SANDBOX_MODES.includes(value as SandboxMode)) {
      out(c.red(`Invalid sandbox mode. One of: ${SANDBOX_MODES.join(", ")}.\n`));
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
          `approval: ${raw.approval ?? "(default suggest)"}\n` +
          `sandbox:  ${raw.sandbox ?? "(default off)"}\n` +
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
  const cfg = loadConfig({ profile: opts.profile });
  if (opts.model) cfg.model = opts.model;
  const provider0 = await buildProvider(cfg);
  if (!provider0) {
    out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
    process.exit(1);
  }
  let provider: Provider = provider0;
  const cwd = cfg.cwd;
  let approval: ApprovalMode = opts.yes ? "full-auto" : ((opts.approval as ApprovalMode) || cfg.approval);
  let currentTurn: AbortController | null = null; // set during a running turn so Esc can abort it
  const sandbox: SandboxMode = (opts.sandbox as SandboxMode) || cfg.sandbox;
  if (sandbox !== "off" && !sandboxSupported()) {
    out(c.yellow(`(sandbox '${sandbox}' is macOS-only; shell runs unsandboxed here)\n`));
  }
  const stats = { input: 0, output: 0, lastInput: 0 };

  if (Object.keys(cfg.mcpServers).length) {
    await connectMcpServers(cfg.mcpServers, (m) => out(c.dim(m + "\n")));
  }

  // one-shot
  if (opts.print) {
    const projectContext = loadAgentsMd(cwd) || undefined;
    const history: NeutralMsg[] = [{ role: "user", content: expandMentions(String(opts.print), cwd) }];
    await runAgent(history, { provider, ctx: { cwd, sandbox }, approval: "full-auto", confirm: async () => true, projectContext, stats });
    if (stats.input || stats.output) out(statusLine(cfg.model, stats.input, stats.output) + "\n");
    await closeMcp();
    return;
  }

  // interactive REPL
  out(c.bold(`hara ${pkg.version}`) + c.dim(`  ·  ${cfg.provider}:${cfg.model}  ·  ${approval}${sandbox !== "off" ? `  ·  sandbox:${sandbox}` : ""}  ·  ${cwd}\n`));
  const rl = createInterface({ input: stdin, output: stdout, completer: (line: string) => mentionCompleter(line, cwd) });
  const confirm = async (q: string) => (await rl.question(`${q} ${c.dim("[y/N]")} `)).trim().toLowerCase().startsWith("y");
  // shift+tab cycles the approval mode (TTY only — emitKeypressEvents would eat piped stdin).
  // Bare /approval is the reliable fallback everywhere.
  if (stdin.isTTY) {
    try {
      emitKeypressEvents(stdin);
      stdin.on("keypress", (_s: string, key: { name?: string; shift?: boolean } | undefined) => {
        if (key && key.shift && key.name === "tab") {
          approval = bar.nextMode(approval);
          if (bar.isActive()) bar.update({ approval });
        } else if (key?.name === "escape" && currentTurn) {
          currentTurn.abort(); // interrupt the running turn
        }
      });
    } catch {
      /* keypress unavailable; /approval still works */
    }
  }

  if (!hasAgentsMd(cwd)) {
    const ans = (await rl.question(`${c.dim("No AGENTS.md here — analyze this project and create one?")} ${c.dim("[Y/n]")} `)).trim().toLowerCase();
    if (ans === "" || ans.startsWith("y")) {
      out(c.dim("Analyzing project…\n"));
      try {
        await runInit(provider, cwd, sandbox);
      } catch (e: any) {
        out(c.red(`[init error] ${e.message}\n`));
      }
    }
  }
  let projectContext = loadAgentsMd(cwd) || undefined;

  // session: --resume <id> / --continue (latest in this cwd) / new
  let resumed: SessionData | null = null;
  if (opts.resume) {
    resumed = loadSession(opts.resume);
    if (!resumed) out(c.yellow(`(no session '${opts.resume}'; starting fresh)\n`));
  } else if (opts.continue) {
    resumed = latestForCwd(cwd);
    if (!resumed) out(c.dim("(no prior session in this directory; starting fresh)\n"));
  }
  const meta: SessionMeta = resumed?.meta ?? {
    id: newSessionId(),
    cwd,
    provider: cfg.provider,
    model: cfg.model,
    title: "",
    createdAt: new Date().toISOString(),
    updatedAt: "",
  };
  const history: NeutralMsg[] = resumed?.history ? [...resumed.history] : [];
  if (resumed) out(c.dim(`(resumed ${meta.id} · ${history.length} msgs)\n`));

  const commands: Slash[] = [
    { name: "help", desc: "show this help", run: () => void out(helpText(commands)) },
    {
      name: "init",
      desc: "analyze project & regenerate AGENTS.md",
      run: async () => {
        out(c.dim("Analyzing project…\n"));
        try {
          await runInit(provider, cwd, sandbox);
          projectContext = loadAgentsMd(cwd) || undefined;
          out(c.green("AGENTS.md updated.\n"));
        } catch (e: any) {
          out(c.red(`[init error] ${e.message}\n`));
        }
      },
    },
    {
      name: "tools",
      desc: "list available tools",
      run: () => {
        out(c.bold("Tools:\n"));
        for (const t of getTools()) out(`  ${t.name}${t.kind !== "read" ? c.yellow(" *") : ""}  ${c.dim(t.description)}\n`);
        out(c.dim("  * may prompt for confirmation (depends on approval mode)\n"));
      },
    },
    {
      name: "model",
      desc: "show or switch model: /model [id]",
      run: async (a) => {
        if (a) {
          cfg.model = a;
          const p = await buildProvider(cfg);
          if (p) {
            provider = p;
            if (bar.isActive()) bar.update({ model: a });
            out(c.dim(`(model → ${cfg.provider}:${a})\n`));
          } else out(c.red("(could not rebuild provider)\n"));
        } else out(`${cfg.provider}:${cfg.model}\n`);
      },
    },
    {
      name: "approval",
      desc: `cycle/set approval: /approval [${APPROVAL_MODES.join("|")}]`,
      run: (a) => {
        if (a) {
          if (APPROVAL_MODES.includes(a as ApprovalMode)) approval = a as ApprovalMode;
          else return void out(c.red(`Invalid mode. One of: ${APPROVAL_MODES.join(", ")}\n`));
        } else {
          approval = bar.nextMode(approval); // bare /approval cycles
        }
        if (bar.isActive()) bar.update({ approval });
        else out(c.dim(`(approval → ${approval})\n`));
      },
    },
    { name: "usage", desc: "show token usage this session", run: () => void out(statusLine(cfg.model, stats.input, stats.output) + "\n") },
    {
      name: "roles",
      desc: "list org roles",
      run: () => {
        const rs = loadRoles(cwd);
        if (!rs.length) return void out(c.dim("No roles. Run `hara roles init`.\n"));
        for (const r of rs) out(`  ${r.id}  ${c.dim("owns: " + r.owns.join(", "))}\n`);
      },
    },
    {
      name: "org",
      desc: "dispatch a task to the owning role: /org <task>",
      run: async (a) => {
        if (!a) return void out(c.dim("usage: /org <task>\n"));
        await runOrg(a, { cfg, baseProvider: provider, cwd, sandbox, approval, confirm, projectContext, stats });
        out(statusLine(cfg.model, stats.input, stats.output) + "\n");
      },
    },
    {
      name: "plan",
      desc: "decompose + execute a task as atoms (DAG + verify): /plan <task>",
      run: async (a) => {
        if (!a) return void out(c.dim("usage: /plan <task>\n"));
        await runPlan(a, { cfg, baseProvider: provider, cwd, sandbox, approval, confirm, projectContext, stats });
        if (bar.isActive()) bar.update({ input: stats.input, output: stats.output, ctxPct: bar.ctxPctFor(cfg.model, stats.lastInput ?? 0) });
        else out(statusLine(cfg.model, stats.input, stats.output) + "\n");
      },
    },
    {
      name: "sessions",
      desc: "list saved sessions",
      run: () => {
        const ms = listSessions();
        if (!ms.length) return void out(c.dim("No sessions yet.\n"));
        for (const m of ms) out(`  ${m.id}  ${c.dim(m.updatedAt.slice(0, 16).replace("T", " "))}  ${m.title}\n`);
      },
    },
    { name: "reset", aliases: ["clear"], desc: "clear conversation context", run: () => void ((history.length = 0), out(c.dim("(context cleared)\n"))) },
    { name: "exit", aliases: ["quit"], desc: "leave", run: () => "exit" },
  ];
  const byName = new Map<string, Slash>();
  for (const cmd of commands) {
    byName.set(cmd.name, cmd);
    for (const a of cmd.aliases ?? []) byName.set(a, cmd);
  }

  out(c.dim(`Type a task. /help · @path attaches a file · shift+tab cycles mode · Esc interrupts · /exit to quit.${projectContext ? "  (AGENTS.md loaded)" : ""}\n\n`));

  bar.install({ sessionName: meta.title || "new session", model: cfg.model, approval, input: stats.input, output: stats.output });
  process.on("exit", () => {
    try {
      bar.uninstall();
    } catch {
      /* best-effort terminal reset */
    }
  });

  for (;;) {
    let line: string;
    try {
      line = (await rl.question(c.cyan("hara> "))).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (line.startsWith("/")) {
      const [name, ...rest] = line.slice(1).split(/\s+/);
      const cmd = byName.get(name);
      if (!cmd) {
        const near = nearest(name, [...byName.keys()]);
        const hint = near.length ? c.dim(` Did you mean ${near.map((n) => "/" + n).join(", ")}?`) : "";
        out(c.red(`Unknown command /${name}.`) + hint + c.dim(" — /help for the list.\n"));
        continue;
      }
      const res = await cmd.run(rest.join(" "));
      if (res === "exit") break;
      continue;
    }
    history.push({ role: "user", content: expandMentions(line, cwd) });
    currentTurn = new AbortController();
    try {
      await runAgent(history, { provider, ctx: { cwd, sandbox }, approval, confirm, projectContext, stats, signal: currentTurn.signal });
    } catch (e: any) {
      out(c.red(`\n[error] ${e.message}\n`));
    } finally {
      currentTurn = null;
    }
    if (!meta.title) meta.title = titleFrom(history);
    if (bar.isActive()) {
      bar.update({
        sessionName: meta.title,
        input: stats.input,
        output: stats.output,
        ctxPct: bar.ctxPctFor(cfg.model, stats.lastInput ?? 0),
      });
    } else {
      out(statusLine(cfg.model, stats.input, stats.output) + "\n\n");
    }
    saveSession(meta, history);
  }
  bar.uninstall();
  rl.close();
  await closeMcp();
});

program.parseAsync().catch((e) => {
  try {
    bar.uninstall();
  } catch {
    /* ignore */
  }
  out(c.red(`\n[fatal] ${e?.message ?? e}\n`));
  process.exit(1);
});
