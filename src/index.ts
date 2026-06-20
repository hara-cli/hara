#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { runTui } from "./tui/run.js";
import { readClipboardImage } from "./images.js";
import { describeImages, classifyVision } from "./vision.js";
import { setTheme } from "./tui/theme.js";
import { memoryDigest } from "./memory/store.js";
import { nextMode as cycleMode, type Approval } from "./tui/InputBox.js";
import { stdin, stdout } from "node:process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadConfig,
  configPath,
  readRawConfig,
  writeConfigValue,
  setModelVisionOverride,
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
  shortId,
  resolveSessionId,
  saveSession,
  loadSession,
  listSessions,
  latestForCwd,
  titleFrom,
  type SessionMeta,
  type SessionData,
} from "./session/store.js";
import { loadRoles, scaffoldRoles, type Role } from "./org/roles.js";
import { loadSkillIndex, loadSkillBody, scaffoldSkills } from "./skills/skills.js";
import { installPlugin, uninstallPlugin, listInstalled, enabledPlugins, setPluginEnabled, pluginMcpServers } from "./plugins/plugins.js";
import { routeByKeywords, buildDispatchPrompt, parseRoleId } from "./org/router.js";
import { decompose, topoOrder, savePlan, atomPrompt, verify, runCheck, type Atom } from "./org/planner.js";
import { connectMcpServers, closeMcp } from "./mcp/client.js";
import { sandboxSupported, type SandboxMode } from "./sandbox.js";
import { undoLast } from "./undo.js";
import { searchAssets, scaffoldAssets, assetsDir } from "./recall.js";
import type { Provider, NeutralMsg, ImageAttachment } from "./providers/types.js";
import { c, out, statusLine } from "./ui.js";
import * as bar from "./statusbar.js";
import { nearest } from "./fuzzy.js";
import "./tools/builtin.js"; // register read_file/write_file/bash
import "./tools/edit.js"; // register edit_file
import "./tools/search.js"; // register grep/glob/ls
import "./tools/patch.js"; // register apply_patch
import "./tools/web.js"; // register web_fetch
import "./tools/agent.js"; // register agent (subagent spawn)
import "./tools/memory.js"; // register memory_search/get/write/forget/skill_create
import "./tools/skill.js"; // register the skill loader tool

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
    memory: memoryDigest(o.cwd),
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
    out(`  ${c.cyan(a.id)} ${a.title}${a.deps.length ? c.dim(" ←" + a.deps.join(",")) : ""}${a.role ? c.dim(" @" + a.role) : ""}${a.check ? c.dim(" ✓" + a.check) : ""}\n`);
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
        memory: memoryDigest(o.cwd),
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
    if (atom.check) out(c.dim(`  check: ${atom.check}\n`));
    const v = atom.check ? await runCheck(atom.check, o.cwd, o.sandbox) : await verify(o.baseProvider, atom, lastAssistantText(history));
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

const READONLY_TOOLS = new Set(["read_file", "grep", "glob", "ls", "web_fetch"]);
const PLAN_SYSTEM =
  "You are in PLAN MODE. Investigate read-only (read_file / grep / glob / ls / web_fetch) and think, " +
  "then propose a concise step-by-step plan for the task. Do NOT edit files or run commands yet — only plan. " +
  "End your message with the plan as a short numbered list.";
const DISTILL_SYSTEM =
  "The session is ending. Reflect and persist only durable, reusable learnings: memory_write for facts / " +
  "conventions / the user's preferences, skill_create for reusable how-tos. Be selective — skip the trivial. Then reply DONE.";
const COMPACT_SYSTEM =
  "Summarize the conversation so far into a concise but complete brief so the assistant can " +
  "continue seamlessly: the user's goal, key decisions, files changed, current state, and open next steps. " +
  "Be specific. Output only the summary.";
const workingSetFromSummary = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
    .filter((l) => l.length > 3)
    .slice(0, 12)
    .map((l) => l.slice(0, 140));

/** Run a (read-only by default) sub-agent to completion, quietly, and return its final text. */
async function runSubagent(
  cfg: HaraConfig,
  baseProvider: Provider,
  cwd: string,
  sandbox: SandboxMode,
  projectContext: string | undefined,
  stats: { input: number; output: number; lastInput?: number },
  task: string,
  roleId?: string,
): Promise<string> {
  const roles = loadRoles(cwd);
  const role = roleId ? roles.find((r) => r.id === roleId) : undefined;
  const provider =
    role?.model && role.model !== cfg.model ? ((await buildProvider({ ...cfg, model: role.model })) ?? baseProvider) : baseProvider;
  const toolFilter = role?.allowTools
    ? (n: string) => role.allowTools!.includes(n)
    : role?.denyTools
      ? (n: string) => !role.denyTools!.includes(n)
      : (n: string) => READONLY_TOOLS.has(n); // default sub-agent = read-only (safe to parallelize)
  const subHistory: NeutralMsg[] = [{ role: "user", content: task }];
  await runAgent(subHistory, {
    provider,
    ctx: { cwd, sandbox }, // no `spawn` here → sub-agents can't recurse
    approval: "full-auto", // read-only tools, so no prompts (can't prompt in parallel)
    confirm: async () => true,
    projectContext,
    memory: memoryDigest(cwd),
    stats,
    systemOverride: role?.system,
    toolFilter,
    quiet: true,
  });
  for (let i = subHistory.length - 1; i >= 0; i--) {
    const m = subHistory[i] as { role: string; text?: string };
    if (m.role === "assistant" && typeof m.text === "string" && m.text.trim()) return m.text.trim();
  }
  return "(sub-agent produced no output)";
}

/** Check the hara setup and print a health summary (provider/auth/model/node/assets/roles). */
function runDoctor(cfg: HaraConfig): string {
  const ok = (b: boolean): string => (b ? c.green("✓") : c.red("✗"));
  const dot = c.dim("·");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const hasKey = !!(cfg.apiKey || process.env[providerEnvKey(cfg.provider)] || process.env.HARA_API_KEY);
  const oauthOk = cfg.provider === "qwen-oauth" && existsSync(join(homedir(), ".hara", "qwen-oauth.json"));
  const authed = hasKey || oauthOk;
  const ad = assetsDir();
  const roles = loadRoles(cfg.cwd);
  const vcap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
  const vdesc = vcap === "vision" ? c.dim("sees images (inline)") : vcap === "text" ? c.dim("text-only") : c.yellow("capability unknown — asks on first image");
  const lines = [
    c.bold("hara doctor"),
    `${ok(nodeMajor >= 20)} node ${process.versions.node} ${c.dim("(need ≥20)")}`,
    `${dot} provider ${c.bold(cfg.provider)} · model ${c.bold(cfg.model)}${cfg.baseURL ? c.dim(" · " + cfg.baseURL) : ""}`,
    `${ok(authed)} auth ${authed ? c.dim("configured") : c.yellow("missing — " + authHint(cfg))}`,
    `${ok(existsSync(configPath()))} config ${c.dim(configPath())}`,
    `${dot} code-assets ${existsSync(ad) ? c.dim(ad) : c.dim("none — run: hara recall --init")}`,
    `${dot} roles ${roles.length ? c.dim(roles.map((r) => r.id).join(", ")) : c.dim("none — run: hara roles init")}`,
    `${dot} skills ${(() => { const n = loadSkillIndex(cfg.cwd).length; return n ? c.dim(`${n} (${loadSkillIndex(cfg.cwd).map((s) => s.id).slice(0, 6).join(", ")})`) : c.dim("none — run: hara skills init"); })()}`,
    `${dot} memory ${existsSync(join(homedir(), ".hara", "memory")) ? c.dim("~/.hara/memory + project") : c.dim("none yet (created on first write)")} ${c.dim("· evolve")} ${c.bold(cfg.evolve)}`,
    `${dot} vision · ${c.bold(cfg.model)} ${vdesc}${cfg.visionModel ? c.dim(" · describer ") + c.bold(cfg.visionModel) : vcap === "text" ? c.yellow(" · set /vision <model>") : ""}`,
    `${dot} plugins ${(() => { const inst = listInstalled(); const on = enabledPlugins().length; return inst.length ? c.dim(`${on}/${inst.length} enabled: ${inst.map((p) => p.name).slice(0, 6).join(", ")}`) : c.dim("none — hara plugin add <source>"); })()}`,
    `${dot} mcp servers ${c.dim(String(Object.keys({ ...pluginMcpServers(), ...cfg.mcpServers }).length))}`,
  ];
  return lines.join("\n");
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

program
  .command("recall [query...]")
  .description("search your code-asset library (~/.hara/code-assets) for snippets/playbooks")
  .option("--init", "scaffold the code-assets directory with an example")
  .action((parts: string[], opts2: { init?: boolean }) => {
    if (opts2.init) {
      const w = scaffoldAssets();
      out(w.length ? c.green(`Scaffolded ${assetsDir()}: ${w.join(", ")}\n`) : c.dim(`Assets already exist at ${assetsDir()}\n`));
      return;
    }
    const q = (parts ?? []).join(" ");
    if (!q) return void out(c.dim("usage: hara recall <query>   (or: hara recall --init)\n"));
    const hits = searchAssets(q);
    if (!hits.length) return void out(c.dim(`No matches in ${assetsDir()} (add .md files, or run: hara recall --init)\n`));
    for (const h of hits) out(`${c.cyan(h.path)}  ${c.dim(h.title)}\n`);
  });

program
  .command("doctor")
  .description("check your hara setup (provider / auth / model / node / assets / roles)")
  .action(() => out(runDoctor(loadConfig()) + "\n"));

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

const skillsCmd = program.command("skills").description("manage skills (.hara/skills/<name>/SKILL.md)");
skillsCmd
  .command("init")
  .description("scaffold an example skill")
  .action(() => {
    const written = scaffoldSkills(process.cwd());
    out(
      written.length
        ? c.green(`Created an example skill: ${written.join(", ")}\n`)
        : c.dim("Skills already exist in .hara/skills/.\n"),
    );
  });
skillsCmd.action(() => {
  const skills = loadSkillIndex(process.cwd());
  if (!skills.length) {
    out(c.dim("No skills. Run `hara skills init`, or the agent saves them with skill_create.\n"));
    return;
  }
  for (const s of skills) {
    out(`${c.bold(s.id)}${s.context === "fork" ? c.dim(" (fork)") : ""}  ${c.dim(s.source)}\n  ${s.description}\n`);
  }
});

const pluginCmd = program.command("plugin").description("manage plugins (bundle skills/roles/MCP servers)");
pluginCmd
  .command("add <source>")
  .description("install a plugin from file:<path> | github:<owner/repo> | git:<url>")
  .action((source: string) => {
    try {
      const p = installPlugin(source);
      setPluginEnabled(p.name, true);
      const m = p.manifest;
      const parts = [
        m.skills?.length ? `${m.skills.length} skill dir(s)` : "",
        m.agents?.length ? `${m.agents.length} role dir(s)` : "",
        m.mcpServers ? `${Object.keys(m.mcpServers).length} mcp server(s)` : "",
      ].filter(Boolean);
      out(c.green(`Installed ${p.name}@${p.version}${parts.length ? c.dim(" — " + parts.join(", ")) : ""}\n`));
    } catch (e: any) {
      out(c.red(`Install failed: ${e.message}\n`));
    }
  });
pluginCmd
  .command("remove <name>")
  .alias("uninstall")
  .description("uninstall a plugin")
  .action((name: string) => out(uninstallPlugin(name) ? c.green(`Removed ${name}\n`) : c.dim(`(no plugin '${name}')\n`)));
pluginCmd
  .command("enable <name>")
  .description("enable an installed plugin")
  .action((name: string) => (setPluginEnabled(name, true), out(c.green(`Enabled ${name}\n`))));
pluginCmd
  .command("disable <name>")
  .description("disable an installed plugin (keeps it installed)")
  .action((name: string) => (setPluginEnabled(name, false), out(c.green(`Disabled ${name}\n`))));
pluginCmd.action(() => {
  const installed = listInstalled();
  if (!installed.length) return void out(c.dim("No plugins. Install with `hara plugin add <source>`.\n"));
  const on = new Set(enabledPlugins().map((p) => p.name));
  for (const p of installed) {
    out(`${on.has(p.name) ? c.green("●") : c.dim("○")} ${c.bold(p.name)}@${p.version}${p.manifest.description ? c.dim("  " + p.manifest.description) : ""}\n`);
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
  const autoApprove = new Set<string>(); // tools the user chose "don't ask again" for, this session
  let recalledContext = ""; // snippets queued by /recall, prepended to the next message
  const sandbox: SandboxMode = (opts.sandbox as SandboxMode) || cfg.sandbox;
  if (sandbox !== "off" && !sandboxSupported()) {
    out(c.yellow(`(sandbox '${sandbox}' is macOS-only; shell runs unsandboxed here)\n`));
  }
  const stats = { input: 0, output: 0, lastInput: 0 };

  const mcpAll = { ...pluginMcpServers(), ...cfg.mcpServers }; // user config wins over plugin-contributed servers
  if (Object.keys(mcpAll).length) {
    await connectMcpServers(mcpAll, (m) => out(c.dim(m + "\n")));
  }

  // one-shot
  if (opts.print) {
    const projectContext = loadAgentsMd(cwd) || undefined;
    const history: NeutralMsg[] = [{ role: "user", content: expandMentions(String(opts.print), cwd) }];
    await runAgent(history, {
      provider,
      ctx: { cwd, sandbox, spawn: (t, role) => runSubagent(cfg, provider, cwd, sandbox, projectContext, stats, t, role) },
      approval: "full-auto",
      confirm: async () => true,
      projectContext,
      memory: memoryDigest(cwd),
      stats,
    });
    if (stats.input || stats.output) out(statusLine(cfg.model, stats.input, stats.output) + "\n");
    await closeMcp();
    return;
  }

  // interactive REPL — ink TUI by default on a real terminal; HARA_TUI=0 forces the classic readline path
  const useTui = stdin.isTTY && stdout.isTTY && process.env.HARA_TUI !== "0";
  out(c.bold(`hara ${pkg.version}`) + c.dim(`  ·  ${cfg.provider}:${cfg.model}  ·  ${approval}${sandbox !== "off" ? `  ·  sandbox:${sandbox}` : ""}  ·  ${cwd}\n`));
  const rl = createInterface({
    input: stdin,
    output: stdout,
    completer: (line: string): [string[], string] => {
      const sm = /^\/(\w*)$/.exec(line); // `/<partial>` → complete command names
      if (sm) {
        const q = sm[1].toLowerCase();
        return [[...byName.keys()].filter((n) => n.startsWith(q)).sort().map((n) => "/" + n), line];
      }
      return mentionCompleter(line, cwd);
    },
  });
  const confirm = async (q: string) => (await rl.question(`${q} ${c.dim("[y/N]")} `)).trim().toLowerCase().startsWith("y");
  // shift+tab cycles the approval mode (classic REPL only; the TUI handles its own keys).
  // Bare /approval is the reliable fallback everywhere.
  if (stdin.isTTY && !useTui) {
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
  const spawn = (t: string, role?: string) => runSubagent(cfg, provider, cwd, sandbox, projectContext, stats, t, role);

  // session: --resume <id> / --continue (latest in this cwd) / new
  let resumed: SessionData | null = null;
  if (opts.resume) {
    const rid = resolveSessionId(opts.resume); // accept a full UUID or a unique prefix (short id)
    resumed = rid ? loadSession(rid) : null;
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
  const memorySnap = memoryDigest(cwd); // durable memory, read once (frozen snapshot)
  const buildMemory = (): string =>
    (meta.workingSet?.length ? `## Working memory (this task)\n${meta.workingSet.map((w) => `- ${w}`).join("\n")}\n\n` : "") + memorySnap;
  if (resumed) out(c.dim(`(resumed ${shortId(meta.id)} · ${history.length} msgs)\n`));

  // Vision describer state — shared by the `/vision` command (both REPLs) and the TUI image pipeline.
  let visionProvider: Provider | null | undefined;
  let remindedVision = false;
  /** `/vision <model>` sets the describer; `/vision main yes|no|auto` sets the current model's capability. */
  const applyVision = (arg: string): string => {
    const parts = arg.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      const cap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
      return `vision — main ${cfg.model}: ${cap}${cap === "unknown" ? " (asks on first image)" : ""} · describer: ${cfg.visionModel || "(none — /vision <model>)"}`;
    }
    if (parts[0] === "main") {
      const v = parts[1];
      if (!v || !["yes", "no", "auto"].includes(v)) return "usage: /vision main yes|no|auto";
      if (v === "auto") {
        const m = { ...cfg.modelVision };
        delete m[cfg.model];
        cfg.modelVision = m;
        setModelVisionOverride(cfg.model, null);
      } else {
        cfg.modelVision = { ...cfg.modelVision, [cfg.model]: v as "yes" | "no" };
        setModelVisionOverride(cfg.model, v as "yes" | "no");
      }
      return `(${cfg.model} vision = ${v})`;
    }
    const model = parts.join(" ");
    cfg.visionModel = model;
    visionProvider = undefined; // rebuild the describer with the new model
    writeConfigValue("visionModel", model);
    const warn = classifyVision(cfg.provider, model, cfg.modelVision) !== "vision" ? `  ⚠ ${model} isn't a known vision model — if it can't read images, pick a *-vl / vision model.` : "";
    return `(visionModel → ${model}; text-only main models describe pasted images with it)${warn}`;
  };

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
          visionProvider = undefined;
          remindedVision = false;
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
      name: "vision",
      desc: "vision describer: /vision <model> · /vision main yes|no|auto",
      run: (a) => void out(applyVision(a || "") + "\n"),
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
        bar.update({ approval });
        out(c.dim(`(approval → ${approval})\n`));
      },
    },
    { name: "usage", desc: "show token usage this session", run: () => void out(statusLine(cfg.model, stats.input, stats.output) + "\n") },
    { name: "doctor", desc: "check your hara setup", run: () => void out(runDoctor(cfg) + "\n") },
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
      name: "skills",
      desc: "list available skills",
      run: () => {
        const ss = loadSkillIndex(cwd);
        if (!ss.length) return void out(c.dim("No skills. Run `hara skills init`.\n"));
        for (const s of ss) out(`  ${s.id}  ${c.dim(s.description)}\n`);
      },
    },
    {
      name: "skill",
      desc: "load a skill's instructions into your next message: /skill <id>",
      run: (a) => {
        if (!a) return void out(c.dim("usage: /skill <id>\n"));
        const sk = loadSkillIndex(cwd).find((s) => s.id === a.trim());
        if (!sk) return void out(c.dim(`(no skill '${a.trim()}')\n`));
        recalledContext += (recalledContext ? "\n\n" : "") + `Skill \`${sk.id}\`:\n${loadSkillBody(sk)}`;
        out(c.green(`↗ loaded skill ${sk.id} (added to your next message)\n`));
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
        for (const m of ms) out(`  ${shortId(m.id)}  ${c.dim(m.updatedAt.slice(0, 16).replace("T", " "))}  ${m.title || "(untitled)"}\n`);
      },
    },
    {
      name: "undo",
      desc: "revert the last file change(s) made this session",
      run: async () => {
        const r = await undoLast();
        if ("error" in r) return void out(c.dim(`(${r.error})\n`));
        out(c.green(`↩ reverted: ${r.files.join(", ")}\n`));
      },
    },
    {
      name: "compact",
      desc: "summarize the conversation so far to free up context",
      run: async () => {
        if (history.length < 2) return void out(c.dim("(nothing to compact)\n"));
        out(c.dim("Compacting…\n"));
        const r = await provider.turn({
          system: COMPACT_SYSTEM,
          history: [...history, { role: "user", content: "Summarize our conversation so far per the instructions." }],
          tools: [],
          onText: () => {},
        });
        if (r.stop === "error") return void out(c.red(`(compact failed: ${r.errorMsg})\n`));
        const summary = r.text.trim();
        if (!summary) return void out(c.dim("(compact produced nothing)\n"));
        meta.workingSet = workingSetFromSummary(summary); // survives the history wipe + injects next turns
        history.length = 0;
        history.push({ role: "user", content: `Summary of our conversation so far (continue from here):\n\n${summary}` });
        stats.input += r.usage?.input ?? 0;
        stats.output += r.usage?.output ?? 0;
        saveSession(meta, history);
        out(c.green(`(compacted — ${summary.length} chars; context replaced with the summary)\n`));
      },
    },
    {
      name: "recall",
      desc: "pull snippets from your code-asset library into context: /recall <query>",
      run: (a) => {
        if (!a) return void out(c.dim("usage: /recall <query>\n"));
        const hits = searchAssets(a, 3);
        if (!hits.length) return void out(c.dim(`(no matches in ${assetsDir()})\n`));
        const block = hits.map((h) => `Recalled \`${h.path}\` (${h.title}):\n${h.snippet}`).join("\n\n");
        recalledContext += (recalledContext ? "\n\n" : "") + block;
        out(c.green(`↗ recalled ${hits.length}: ${hits.map((h) => h.path).join(", ")} (added to your next message)\n`));
      },
    },
    {
      name: "name",
      desc: "rename this session: /name <name>",
      run: (a) => {
        if (!a) return void out(c.dim(`session: ${meta.title || "(untitled)"} · ${meta.id}\n`));
        meta.title = a.slice(0, 32);
        if (bar.isActive()) bar.update({ sessionName: meta.title });
        saveSession(meta, history);
        out(c.green(`(renamed → ${meta.title})\n`));
      },
    },
    { name: "reset", aliases: ["clear"], desc: "clear conversation context", run: () => void ((history.length = 0), (recalledContext = ""), out(c.dim("(context cleared)\n"))) },
    { name: "exit", aliases: ["quit"], desc: "leave", run: () => "exit" },
  ];
  const byName = new Map<string, Slash>();
  for (const cmd of commands) {
    byName.set(cmd.name, cmd);
    for (const a of cmd.aliases ?? []) byName.set(a, cmd);
  }

  if (useTui) {
    rl.close(); // hand stdin over to ink
    setTheme(cfg.theme);
    // Vision: a text-only main model routes pasted images through a describer (`visionModel`); a
    // vision-capable main model gets them inline (describer auto-suspended). Unknown models are asked
    // once and remembered per-model in cfg.modelVision. See classifyVision for the capability map.
    const getVisionProvider = async (): Promise<Provider | null> => {
      if (visionProvider !== undefined) return visionProvider;
      visionProvider = await buildProvider({ ...cfg, model: cfg.visionModel!, baseURL: cfg.visionBaseURL ?? cfg.baseURL, apiKey: cfg.visionApiKey ?? cfg.apiKey });
      return visionProvider;
    };
    const remindVision = (sink: { notice: (s: string) => void }): void => {
      if (remindedVision) return void sink.notice(`⚠ image skipped — ${cfg.model} is text-only. Add a vision model: /vision <model>`);
      remindedVision = true;
      sink.notice(
        `⚠ ${cfg.model} is text-only and can't see images, so your image was skipped.\n` +
          `  Add a vision model to read images for it:\n` +
          `      /vision qwen-vl-max     ← sets it now (uses your current plan/key) and remembers it\n` +
          `  It OCRs/describes each pasted image into text the model can act on.`,
      );
    };
    const resolveImages = async (
      imgs: ImageAttachment[] | undefined,
      h: { sink: { notice: (s: string) => void }; select: (t: string, o: { label: string; value: string }[]) => Promise<string>; signal?: AbortSignal },
    ): Promise<{ extraText?: string; attach?: ImageAttachment[]; skip?: boolean }> => {
      if (!imgs?.length) return {};
      let cap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
      if (cap === "unknown") {
        const ans = await h.select(`Can your model "${cfg.model}" understand images (vision)?`, [
          { label: "Yes — send images to it directly", value: "yes" },
          { label: "No — describe them with a vision model first", value: "no" },
          { label: "Skip the image this time", value: "skip" },
        ]);
        if (ans === "skip") return { skip: true };
        cap = ans === "yes" ? "vision" : "text";
        cfg.modelVision = { ...cfg.modelVision, [cfg.model]: ans as "yes" | "no" };
        setModelVisionOverride(cfg.model, ans as "yes" | "no");
        h.sink.notice(`(remembered: ${cfg.model} ${ans === "yes" ? "supports images" : "is text-only"})`);
      }
      if (cap === "vision") return { attach: imgs }; // native vision — describer suspended
      if (!cfg.visionModel) {
        remindVision(h.sink);
        return { skip: true };
      }
      const vp = await getVisionProvider();
      if (!vp) {
        h.sink.notice(`(visionModel ${cfg.visionModel} unavailable — check visionApiKey/visionBaseURL)`);
        return { skip: true };
      }
      h.sink.notice(`✻ reading ${imgs.length} image${imgs.length === 1 ? "" : "s"} with ${cfg.visionModel}…`);
      try {
        const desc = await describeImages(vp, imgs, { signal: h.signal });
        return { extraText: `\n\n[Image description — via ${cfg.visionModel}]\n${desc}` };
      } catch (e) {
        const msg = h.signal?.aborted ? "image describe cancelled" : `image describe failed: ${e instanceof Error ? e.message : String(e)}`;
        h.sink.notice(`(${msg})`);
        return { skip: true };
      }
    };
    const mainCap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
    const visionLine =
      mainCap === "vision"
        ? `${cfg.model} reads images directly`
        : cfg.visionModel
          ? `${cfg.model} is text-only → images read by ${cfg.visionModel}`
          : mainCap === "text"
            ? `${cfg.model} is text-only — /vision <model> to read pasted images`
            : `${cfg.model} image support unknown — asked on first paste`;
    await runTui({
      initialStatus: { sessionName: meta.title || shortId(meta.id), approval, input: stats.input, output: stats.output, ctxPct: 0, agents: 0 },
      model: cfg.model,
      cwd,
      header: { version: pkg.version, model: `${cfg.provider}:${cfg.model}`, cwd, vision: visionLine, session: meta.id, tip: `/help · @file attaches · shift+tab cycles modes · esc interrupts${projectContext ? " · AGENTS.md loaded" : ""}` },
      cycleApproval: (m) => cycleMode(m),
      onClipboardImage: readClipboardImage,
      onSubmit: async (line, h, images) => {
        if (line.startsWith("/")) {
          const [nm, ...rest] = line.slice(1).split(/\s+/);
          const arg = rest.join(" ").trim();
          if (nm === "exit" || nm === "quit") {
            if (cfg.evolve === "proactive" && history.length >= 4) {
              h.sink.notice("✻ distilling session learnings…");
              try {
                await runAgent(history, {
                  provider,
                  ctx: { cwd, sandbox, spawn, ui: { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice } },
                  approval: "full-auto",
                  confirm: h.confirm,
                  toolFilter: (n) => n === "memory_write" || n === "skill_create" || READONLY_TOOLS.has(n),
                  systemOverride: DISTILL_SYSTEM,
                  memory: buildMemory(),
                  stats,
                  signal: h.signal,
                });
                saveSession(meta, history);
              } catch {
                /* exit anyway */
              }
            }
            return void h.exit();
          }
          if (nm === "help") return void h.sink.notice(commands.map((x) => `/${x.name} — ${x.desc}`).join("\n"));
          if (nm === "tools")
            return void h.sink.notice(getTools().map((t) => `${t.name}${t.kind !== "read" ? " *" : ""} — ${t.description}`).join("\n"));
          if (nm === "reset" || nm === "clear") {
            history.length = 0;
            recalledContext = "";
            return void h.sink.notice("(context cleared)");
          }
          if (nm === "undo") {
            const r = await undoLast();
            return void h.sink.notice("error" in r ? `(${r.error})` : `↩ reverted: ${r.files.join(", ")}`);
          }
          if (nm === "model") {
            if (!arg) return void h.sink.notice(`model: ${cfg.provider}:${cfg.model}`);
            cfg.model = arg;
            visionProvider = undefined; // new model may resolve a different describer / capability
            remindedVision = false;
            const p = await buildProvider(cfg);
            if (p) {
              provider = p;
              return void h.sink.notice(`(model → ${cfg.provider}:${arg})`);
            }
            return void h.sink.notice("(could not rebuild provider)");
          }
          if (nm === "recall") {
            if (!arg) return void h.sink.notice("usage: /recall <query>");
            const hits = searchAssets(arg, 3);
            if (!hits.length) return void h.sink.notice(`(no matches in ${assetsDir()})`);
            recalledContext += (recalledContext ? "\n\n" : "") + hits.map((x) => `Recalled \`${x.path}\` (${x.title}):\n${x.snippet}`).join("\n\n");
            return void h.sink.notice(`↗ recalled ${hits.length}: ${hits.map((x) => x.path).join(", ")} (added to your next message)`);
          }
          if (nm === "name") {
            if (!arg) return void h.sink.notice(`session: ${meta.title || "(untitled)"} · ${meta.id}`);
            meta.title = arg.slice(0, 32);
            h.sink.session(meta.title);
            saveSession(meta, history);
            return void h.sink.notice(`(renamed → ${meta.title})`);
          }
          if (nm === "compact") {
            if (history.length < 2) return void h.sink.notice("(nothing to compact)");
            h.sink.notice("✻ compacting…");
            const cui = { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice };
            if (cfg.evolve !== "off") {
              try {
                await runAgent(history, {
                  provider,
                  ctx: { cwd, sandbox, spawn, ui: cui },
                  approval: "full-auto",
                  confirm: h.confirm,
                  toolFilter: (n) => n === "memory_write" || n === "skill_create" || READONLY_TOOLS.has(n),
                  systemOverride: DISTILL_SYSTEM,
                  memory: buildMemory(),
                  stats,
                  signal: h.signal,
                });
              } catch {
                /* flush is best-effort */
              }
            }
            const cr = await provider.turn({
              system: COMPACT_SYSTEM,
              history: [...history, { role: "user", content: "Summarize our conversation so far per the instructions." }],
              tools: [],
              onText: () => {},
            });
            if (cr.stop === "error") return void h.sink.notice(`(compact failed: ${cr.errorMsg})`);
            const summary = cr.text.trim();
            if (!summary) return void h.sink.notice("(compact produced nothing)");
            meta.workingSet = workingSetFromSummary(summary);
            history.length = 0;
            history.push({ role: "user", content: `Summary of our conversation so far (continue from here):\n\n${summary}` });
            stats.input += cr.usage?.input ?? 0;
            stats.output += cr.usage?.output ?? 0;
            h.sink.usage(cr.usage?.input ?? 0, cr.usage?.output ?? 0);
            saveSession(meta, history);
            return void h.sink.notice(`(compacted — kept ${meta.workingSet.length} working-memory notes)`);
          }
          if (nm === "sessions") {
            const ms = listSessions();
            return void h.sink.notice(
              ms.length ? ms.slice(0, 12).map((m) => `  ${shortId(m.id)}  ${m.updatedAt.slice(0, 16).replace("T", " ")}  ${m.title || "(untitled)"}`).join("\n") : "No sessions yet.",
            );
          }
          if (nm === "usage") return void h.sink.notice(`tokens — ↑${stats.input} ↓${stats.output}`);
          if (nm === "doctor") return void h.sink.notice(runDoctor(cfg).replace(/\[[0-9;]*m/g, ""));
          if (nm === "vision") return void h.sink.notice(applyVision(arg));
          if (nm === "roles") {
            const rs = loadRoles(cwd);
            return void h.sink.notice(rs.length ? rs.map((r) => `  ${r.id} — owns: ${r.owns.join(", ")}`).join("\n") : "No roles. Run `hara roles init`.");
          }
          if (nm === "skills") {
            const ss = loadSkillIndex(cwd);
            return void h.sink.notice(ss.length ? ss.map((s) => `  ${s.id} — ${s.description}`).join("\n") : "No skills. Run `hara skills init`.");
          }
          if (nm === "skill") {
            if (!arg) return void h.sink.notice("usage: /skill <id>");
            const sk = loadSkillIndex(cwd).find((s) => s.id === arg.trim());
            if (!sk) return void h.sink.notice(`(no skill '${arg.trim()}')`);
            recalledContext += (recalledContext ? "\n\n" : "") + `Skill \`${sk.id}\`:\n${loadSkillBody(sk)}`;
            return void h.sink.notice(`↗ loaded skill ${sk.id} (added to your next message)`);
          }
          if (nm === "approval") {
            const all = ["suggest", "auto-edit", "full-auto", "plan"];
            if (arg && !all.includes(arg)) return void h.sink.notice(`Invalid mode. One of: ${all.join(", ")}`);
            const m = (arg || cycleMode(h.approval)) as Approval;
            h.setApproval(m);
            return void h.sink.notice(`(approval → ${m})`);
          }
          if (byName.has(nm))
            return void h.sink.notice(`/${nm} isn't wired into the TUI yet — use \`hara ${nm} …\` as a subcommand, or HARA_TUI=0.`);
          const near = nearest(nm, [...byName.keys()]);
          return void h.sink.notice(`Unknown command /${nm}.${near.length ? " Did you mean " + near.map((n) => "/" + n).join(", ") + "?" : ""}`);
        }
        const ui = { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice };
        const appr = h.approval;
        if (appr === "plan") {
          // PLAN MODE: read-only investigate → propose a plan → selectable proceed → execute.
          const planImg = await resolveImages(images, h);
          if (planImg.skip) return;
          history.push({ role: "user", content: (recalledContext ? `${recalledContext}\n\n---\n\n` : "") + expandMentions(line, cwd) + (planImg.extraText ?? ""), ...(planImg.attach?.length ? { images: planImg.attach } : {}) });
          recalledContext = "";
          const pin = stats.input;
          const pout = stats.output;
          await runAgent(history, {
            provider,
            ctx: { cwd, sandbox, spawn, ui },
            approval: "suggest",
            confirm: h.confirm,
            toolFilter: (n) => READONLY_TOOLS.has(n),
            systemOverride: PLAN_SYSTEM,
            memory: buildMemory(),
            projectContext,
            stats,
            signal: h.signal,
          });
          if (!meta.title) {
            meta.title = titleFrom(history);
            h.sink.session(meta.title);
          }
          h.sink.usage(stats.input - pin, stats.output - pout);
          saveSession(meta, history);
          const choice = await h.select("hara has a plan — proceed?", [
            { label: "Yes, and auto-apply edits", value: "auto-edit" },
            { label: "Yes, approve each edit", value: "suggest" },
            { label: "No, keep planning  (esc)", value: "no" },
          ]);
          if (choice !== "no") {
            h.setApproval(choice as "auto-edit" | "suggest");
            history.push({ role: "user", content: "Proceed: execute the plan above." });
            const xin = stats.input;
            const xout = stats.output;
            await runAgent(history, {
              provider,
              ctx: { cwd, sandbox, spawn, ui },
              approval: choice as ApprovalMode,
              memory: buildMemory(),
              confirm: h.confirm,
              autoApprove,
              projectContext,
              stats,
              signal: h.signal,
            });
            h.sink.usage(stats.input - xin, stats.output - xout);
            saveSession(meta, history);
          }
          return;
        }
        const ri = await resolveImages(images, h);
        if (ri.skip) return;
        const userContent = (recalledContext ? `${recalledContext}\n\n---\n\n` : "") + expandMentions(line, cwd) + (ri.extraText ?? "");
        recalledContext = "";
        history.push({ role: "user", content: userContent, ...(ri.attach?.length ? { images: ri.attach } : {}) });
        const beforeIn = stats.input;
        const beforeOut = stats.output;
        await runAgent(history, {
          provider,
          ctx: { cwd, sandbox, spawn, ui },
          approval: appr,
          memory: buildMemory(),
          confirm: h.confirm,
          autoApprove,
          projectContext,
          stats,
          signal: h.signal,
        });
        if (!meta.title) {
          meta.title = titleFrom(history);
          h.sink.session(meta.title);
        }
        h.sink.usage(stats.input - beforeIn, stats.output - beforeOut);
        saveSession(meta, history);
      },
    });
    await closeMcp();
    process.exit(0); // TUI done — exit cleanly (ink can leave stdin referenced)
  }

  out(c.dim(`Type a task. /help · @path attaches a file · shift+tab cycles mode · Esc interrupts · /exit to quit.${projectContext ? "  (AGENTS.md loaded)" : ""}\n\n`));

  bar.install({ sessionName: meta.title || shortId(meta.id), model: cfg.model, approval, input: stats.input, output: stats.output });
  process.on("exit", () => {
    try {
      bar.uninstall();
    } catch {
      /* best-effort terminal reset */
    }
  });

  for (;;) {
    bar.renderTop(); // top border + session name
    let line: string;
    try {
      line = (await rl.question(c.cyan("› "))).trim();
    } catch {
      break;
    }
    bar.renderBottom(); // bottom border + modes/usage
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
    const userContent = (recalledContext ? `${recalledContext}\n\n---\n\n` : "") + expandMentions(line, cwd);
    recalledContext = "";
    history.push({ role: "user", content: userContent });
    currentTurn = new AbortController();
    try {
      await runAgent(history, { provider, ctx: { cwd, sandbox, spawn }, approval, confirm, autoApprove, projectContext, memory: buildMemory(), stats, signal: currentTurn.signal });
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
    const ctxPct = bar.ctxPctFor(cfg.model, stats.lastInput ?? 0);
    if (ctxPct >= 80) out(c.yellow(`  ⚠ context ${ctxPct}% full — /compact to summarize, or /reset to clear\n`));
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
