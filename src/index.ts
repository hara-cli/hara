#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { runTui } from "./tui/run.js";
import { readClipboardImage } from "./images.js";
import { describeImages, locateImage, classifyVision, SCREENSHOT_SYSTEM } from "./vision.js";
import { setTheme } from "./tui/theme.js";
import { memoryDigest, memoryDir } from "./memory/store.js";
import { nextMode as cycleMode, type Approval } from "./tui/InputBox.js";
import { stdin, stdout } from "node:process";
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
import { notifyDone } from "./notify.js";
import { startMcpServer, mcpServeToolNames } from "./mcp/server.js";
import { getTools } from "./tools/registry.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { qwenDeviceLogin, getValidQwenAuth } from "./providers/qwen-oauth.js";
import { loadAgentsMd, hasAgentsMd, INIT_PROMPT, findProjectRoot } from "./context/agents-md.js";
import { getEmbedder } from "./search/embed.js";
import { collectRepoChunks, collectDirChunks, buildIndex, indexPath, indexExists, type Chunk } from "./search/semindex.js";
import { searchHybrid } from "./search/hybrid.js";
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
  slugify,
  type SessionMeta,
  type SessionData,
} from "./session/store.js";
import { loadRoles, scaffoldRoles, type Role } from "./org/roles.js";
import { loadSkillIndex, loadSkillBody, scaffoldSkills, globalSkillsDir } from "./skills/skills.js";
import { installPlugin, uninstallPlugin, listInstalled, enabledPlugins, setPluginEnabled, pluginMcpServers, pluginHooks } from "./plugins/plugins.js";
import { routeByKeywords, buildDispatchPrompt, parseRoleId } from "./org/router.js";
import { decompose, topoOrder, topoWaves, savePlan, loadPlan, atomPrompt, verify, runCheck, type Atom, type Plan } from "./org/planner.js";
import { connectMcpServers, closeMcp } from "./mcp/client.js";
import { sandboxSupported, runShell, type SandboxMode } from "./sandbox.js";
import { undoLast } from "./undo.js";
import { searchAssets, scaffoldAssets, assetsDir, assetSearchRoots } from "./recall.js";
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
import "./tools/codebase.js"; // register codebase_search (repo as a knowledge base)
import "./tools/todo.js"; // register todo_write (inline task checklist)
import { computerBackends } from "./tools/computer.js"; // register the computer tool + expose the backend probe

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
  parallel?: boolean; // execute independent atoms (same dependency wave) concurrently
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

/** Run one atom (routed to its role if any), then gate it (its `check` command, else an LLM verify). */
async function executeAtom(atom: Atom, plan: Plan, done: Atom[], roles: Role[], o: OrgOpts): Promise<boolean> {
  atom.status = "running";
  savePlan(o.cwd, plan);
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
      quiet: o.parallel, // concurrent atoms would otherwise interleave their streamed output
    });
  } catch (e: any) {
    atom.status = "failed";
    atom.note = e.message;
    savePlan(o.cwd, plan);
    out(c.red(`  ✗ ${atom.id} errored: ${e.message}\n`));
    return false;
  }
  const v = atom.check ? await runCheck(atom.check, o.cwd, o.sandbox) : await verify(o.baseProvider, atom, lastAssistantText(history));
  atom.status = v.ok ? "done" : "failed";
  atom.note = v.reason;
  savePlan(o.cwd, plan);
  out(v.ok ? c.green(`  ✓ ${atom.id} verified\n`) : c.yellow(`  ⚠ ${atom.id}: ${v.reason}\n`));
  return v.ok;
}

/** Execute a plan's atoms (sequential, or parallel waves with --parallel). Atoms already marked `done`
 *  are skipped — so this doubles as the resume engine. Stops on the first failure. */
async function executePlan(plan: Plan, roles: Role[], o: OrgOpts): Promise<void> {
  const done: Atom[] = plan.atoms.filter((a) => a.status === "done");
  const doneIds = new Set(done.map((a) => a.id));

  if (o.parallel) {
    const waved = topoWaves(plan.atoms);
    if ("error" in waved) return void out(c.red(`${waved.error}\n`));
    out(c.dim(`Parallel mode — ${waved.ok.length} wave(s).\n`));
    for (const wave of waved.ok) {
      const todo = wave.filter((a) => !doneIds.has(a.id));
      if (!todo.length) continue; // whole wave already complete (resume)
      out(c.cyan(`\n▶ wave [${todo.map((a) => a.id).join(", ")}] — ${todo.length} in parallel\n`));
      const results = await Promise.all(todo.map((atom) => executeAtom(atom, plan, done, roles, o)));
      todo.forEach((atom, i) => {
        if (results[i]) {
          done.push(atom);
          doneIds.add(atom.id);
        }
      });
      if (results.some((r) => !r)) {
        out(c.dim("Stopping — a wave atom failed. Inspect .hara/org/plan.json, then fix & `hara plan resume`.\n"));
        break;
      }
    }
  } else {
    const ord = topoOrder(plan.atoms);
    if ("error" in ord) return void out(c.red(`${ord.error}\n`));
    for (const atom of ord.ok) {
      if (doneIds.has(atom.id)) continue; // resume: skip completed atoms
      out(c.cyan(`\n▶ ${atom.id} ${atom.title}\n`));
      if (await executeAtom(atom, plan, done, roles, o)) {
        done.push(atom);
        doneIds.add(atom.id);
      } else {
        out(c.dim("Stopping — inspect .hara/org/plan.json, then fix & `hara plan resume`.\n"));
        break;
      }
    }
  }
  out(c.bold(`\nPlan: ${plan.atoms.filter((a) => a.status === "done").length}/${plan.atoms.length} atoms done.\n`));
}

/** Decompose a task into atoms, sequence them (DAG), and execute each with a verify gate.
 *  With `parallel`, independent atoms (the same dependency wave) run concurrently. */
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
  out(c.bold(`\nPlan (${ord.ok.length} atoms):\n`));
  for (const a of ord.ok) {
    out(`  ${c.cyan(a.id)} ${a.title}${a.deps.length ? c.dim(" ←" + a.deps.join(",")) : ""}${a.role ? c.dim(" @" + a.role) : ""}${a.check ? c.dim(" ✓" + a.check) : ""}\n`);
  }
  if (o.approval !== "full-auto") {
    const ok = await o.confirm(`${c.yellow("▶")} Execute this ${ord.ok.length}-atom plan?`);
    if (!ok) return void out(c.dim("(cancelled)\n"));
  }
  savePlan(o.cwd, plan);
  await executePlan(plan, roles, o);
}

/** Resume the saved plan (.hara/org/plan.json): re-run atoms that aren't done; completed atoms are skipped. */
async function runResume(o: OrgOpts): Promise<void> {
  const roles = loadRoles(o.cwd);
  const plan = loadPlan(o.cwd);
  if (!plan) return void out(c.red('No saved plan at .hara/org/plan.json — run `hara plan "<task>"` first.\n'));
  const remaining = plan.atoms.filter((a) => a.status !== "done");
  if (!remaining.length) return void out(c.green(`Plan already complete — ${plan.atoms.length}/${plan.atoms.length} done.\n`));
  out(c.bold(`Resuming: ${plan.task}\n`) + c.dim(`${plan.atoms.length - remaining.length}/${plan.atoms.length} done · ${remaining.length} to go\n`));
  for (const a of remaining) out(`  ${c.cyan(a.id)} ${a.title} ${c.dim("(" + a.status + ")")}\n`);
  if (o.approval !== "full-auto") {
    const ok = await o.confirm(`${c.yellow("▶")} Resume the ${remaining.length} remaining atom(s)?`);
    if (!ok) return void out(c.dim("(cancelled)\n"));
  }
  for (const a of plan.atoms) if (a.status === "failed" || a.status === "running") a.status = "pending"; // retry interrupted
  savePlan(o.cwd, plan);
  await executePlan(plan, roles, o);
}

const READONLY_TOOLS = new Set(["read_file", "grep", "glob", "ls", "web_fetch", "web_search", "codebase_search", "todo_write"]);
const REVIEW_SYSTEM =
  "You are a senior code reviewer. Review the git diff the user provides for: correctness bugs, security " +
  "issues, missing error handling, unclear naming, and missing/weak tests. You may read files (read-only) " +
  "for context. Be concise and specific — cite file:line and the concrete fix. Group findings by severity: " +
  "**Blocker**, **Should-fix**, **Nit**. If nothing material is wrong, say the diff looks good. Never edit files.";
const COMMIT_SYSTEM =
  "Write a git commit message for the staged diff. A concise imperative subject (≤72 chars; an optional " +
  "conventional-commits prefix like feat:/fix:/refactor:/docs:/test:/chore: is welcome). If the change is " +
  "non-trivial, add a blank line then a short body (a few bullets or sentences) on what changed and why. " +
  "Output ONLY the commit message — no code fences, no preamble, no surrounding quotes.";
const SESSION_NAME_SYSTEM =
  "Name this coding session as a SHORT slug: 2–4 English words, lowercase, hyphen-separated, ASCII only " +
  "(e.g. add-semantic-search, fix-login-redirect). If the conversation is in another language, translate the " +
  "gist to English (use pinyin only if a term is untranslatable). Output ONLY the slug.";

/** One short model call → a 2–4 word English kebab-case session name summarizing the work.
 *  Always ASCII (translates non-English gist). Falls back to the lexical title on any failure. */
async function nameSession(provider: Provider, history: NeutralMsg[]): Promise<string> {
  const text = (m: NeutralMsg | undefined): string => {
    if (!m) return "";
    if (m.role === "assistant") return typeof m.text === "string" ? m.text : "";
    if (m.role === "user") return typeof m.content === "string" ? m.content : "";
    return "";
  };
  const basis =
    `User: ${text(history.find((m) => m.role === "user")).slice(0, 800)}\n` +
    `Assistant: ${text(history.find((m) => m.role === "assistant")).slice(0, 800)}`;
  try {
    const r = await provider.turn({ system: SESSION_NAME_SYSTEM, history: [{ role: "user", content: basis }], tools: [], onText: () => {} });
    return slugify(r.text) || titleFrom(history);
  } catch {
    return titleFrom(history);
  }
}
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
    `${dot} memory ${existsSync(join(homedir(), ".hara", "memory")) ? c.dim("~/.hara/memory + project") : c.dim("none yet (created on first write)")} ${c.dim("· evolve")} ${c.bold(cfg.evolve)} ${c.dim("· capture")} ${c.bold(cfg.assetCapture)}`,
    `${dot} search ${c.dim("lexical (always on)")}${cfg.embedProvider === "off" ? c.dim(" · semantic off (hara config set embedProvider ollama|qwen)") : c.dim(" · semantic ") + c.bold(cfg.embedProvider) + (() => { const idx = ["repo", "assets", "memory"].filter((n) => indexExists(n, cfg.cwd)); return c.dim(" · indexed: ") + (idx.length ? c.green(idx.join(", ")) : c.yellow("none — run: hara index --all")); })()}`,
    `${dot} vision · ${c.bold(cfg.model)} ${vdesc}${cfg.visionModel ? c.dim(" · describer ") + c.bold(cfg.visionModel) : vcap === "text" ? c.yellow(" · set /vision <model>") : ""}`,
    `${dot} screen ${cfg.computerUse === "off" ? c.dim("off (hara config set computerUse read|click|full)") : c.bold(cfg.computerUse) + c.dim(` · ${computerBackends()}${cfg.computerApps.length ? " · apps: " + cfg.computerApps.join(", ") : " · no app allowlist"}`)}`,
    `${dot} plugins ${(() => { const inst = listInstalled(); const on = enabledPlugins().length; return inst.length ? c.dim(`${on}/${inst.length} enabled: ${inst.map((p) => p.name).slice(0, 6).join(", ")}`) : c.dim("none — hara plugin add <source>"); })()}`,
    `${dot} mcp ${c.dim(`client: ${Object.keys({ ...pluginMcpServers(), ...cfg.mcpServers }).length} server(s) · serve: ${mcpServeToolNames().length} read tools via \`hara mcp\``)}`,
    `${dot} hooks ${(() => { const ph = pluginHooks(); const pre = (cfg.hooks.PreToolUse ?? []).length + (ph.PreToolUse ?? []).length; const post = (cfg.hooks.PostToolUse ?? []).length + (ph.PostToolUse ?? []).length; return pre + post ? c.dim(`${pre} pre · ${post} post`) : c.dim("none — config.json \"hooks\""); })()}`,
    `${dot} notify ${cfg.notify === "off" ? c.dim("off — hara config set notify bell|system") : c.bold(cfg.notify)}`,
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
  .command("plan [task...]")
  .description("decompose a task into atoms, sequence them (DAG), and execute each with a verify gate")
  .option("--parallel", "run independent atoms (same dependency wave) concurrently")
  .action(async (taskParts: string[], opts: { parallel?: boolean }) => {
    const cfg = loadConfig();
    const provider = await buildProvider(cfg);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    const stats = { input: 0, output: 0, lastInput: 0 };
    const o: OrgOpts = {
      cfg,
      baseProvider: provider,
      cwd: cfg.cwd,
      sandbox: cfg.sandbox,
      approval: "full-auto",
      confirm: async () => true,
      projectContext: loadAgentsMd(cfg.cwd) || undefined,
      stats,
      parallel: opts.parallel,
    };
    const task = (taskParts ?? []).join(" ").trim();
    if (task === "resume") await runResume(o);
    else if (!task) out(c.dim('usage: hara plan "<task>"   (or: hara plan resume)\n'));
    else await runPlan(task, o);
    if (stats.input || stats.output) out(statusLine(cfg.model, stats.input, stats.output) + "\n");
  });

program
  .command("recall [query...]")
  .description("search your code-asset library (~/.hara/code-assets) for snippets/playbooks")
  .option("--init", "scaffold the code-assets directory with an example")
  .action(async (parts: string[], opts2: { init?: boolean }) => {
    if (opts2.init) {
      const w = scaffoldAssets();
      out(w.length ? c.green(`Scaffolded ${assetsDir()}: ${w.join(", ")}\n`) : c.dim(`Assets already exist at ${assetsDir()}\n`));
      return;
    }
    const q = (parts ?? []).join(" ");
    if (!q) return void out(c.dim("usage: hara recall <query>   (or: hara recall --init)\n"));
    const hits = await searchHybrid(q, process.cwd(), { indexName: "assets", roots: assetSearchRoots(process.cwd()) });
    if (!hits.length) return void out(c.dim(`No matches in ${assetsDir()} (add .md files, or run: hara recall --init)\n`));
    for (const h of hits) out(`${c.cyan(h.path)}  ${c.dim(h.title)}\n`);
  });

program
  .command("index")
  .description("build the semantic index (opt-in; needs an embedding provider)")
  .option("--repo", "index the current project — for codebase_search (default)")
  .option("--assets", "index your global code-assets, skills & memory — for recall / memory_search")
  .option("--all", "index everything")
  .action(async (opts: { repo?: boolean; assets?: boolean; all?: boolean }) => {
    const cfg = loadConfig();
    const embed = getEmbedder(cfg);
    if (!embed) {
      out(c.yellow("Semantic search is off — search stays lexical (which still works).\n"));
      out(c.dim("Turn it on with an embedding provider, then re-run `hara index`:\n"));
      out(c.dim("  hara config set embedProvider ollama   # local & offline (needs Ollama + an embed model)\n"));
      out(c.dim("  hara config set embedProvider qwen     # DashScope text-embedding-v3 (uses your key)\n"));
      return;
    }
    const cwd = process.cwd();
    const model = `${cfg.embedProvider}:${cfg.embedModel ?? "default"}`;
    const doRepo = opts.all || opts.repo || (!opts.assets && !opts.all);
    const doAssets = opts.all || opts.assets;
    const build = async (name: string, chunks: Chunk[], blurb: string): Promise<void> => {
      if (!chunks.length) return void out(c.dim(`Nothing to index for ${name}.\n`));
      out(c.dim(`Indexing ${chunks.length} ${name} chunks with ${cfg.embedProvider}…\n`));
      try {
        const r = await buildIndex(name, chunks, embed, cwd, model);
        const detail = r.reused ? `${r.embedded} embedded, ${r.reused} reused` : `${r.embedded} embedded`;
        out(c.green(`Indexed ${r.total} chunks`) + c.dim(` (${detail}) → ${indexPath(name, cwd)} · ${blurb}`) + "\n");
      } catch (e) {
        out(c.red(`Indexing ${name} failed: ${(e as Error).message}\n`));
        out(c.dim("Check the embedding endpoint/key; search still works lexically.\n"));
      }
    };
    if (doRepo) await build("repo", collectRepoChunks(findProjectRoot(cwd)), "codebase_search");
    if (doAssets) {
      await build("assets", [...collectDirChunks(assetsDir(), "code-assets"), ...collectDirChunks(globalSkillsDir(), "skills")], "recall");
      await build("memory", collectDirChunks(memoryDir("global", cwd), "memory"), "memory_search");
    }
  });

program
  .command("doctor")
  .description("check your hara setup (provider / auth / model / node / assets / roles)")
  .action(() => out(runDoctor(loadConfig()) + "\n"));

program
  .command("mcp")
  .description("run hara as an MCP server (stdio) — expose its read/search tools (incl. codebase_search) to other MCP clients")
  .action(async () => {
    const cfg = loadConfig();
    // stdout is the JSON-RPC transport — diagnostics MUST go to stderr only.
    process.stderr.write(c.dim(`hara mcp · serving over stdio · cwd ${cfg.cwd}\n  tools: ${mcpServeToolNames().join(", ") || "(none)"}\n  (read-only by default; set HARA_MCP_TOOLS to override)\n`));
    await startMcpServer(pkg.version, { cwd: cfg.cwd, sandbox: "read-only" });
  });

program
  .command("review")
  .description("review your uncommitted changes (git diff) for bugs, security, and missing tests")
  .option("--staged", "review only staged changes")
  .option("--base <ref>", "review against a base ref (e.g. main) instead of just the working tree")
  .action(async (opts: { staged?: boolean; base?: string }) => {
    const cfg = loadConfig();
    const provider = await buildProvider(cfg);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    const cmd = opts.base ? `git diff ${opts.base}` : opts.staged ? "git diff --staged" : "git diff HEAD";
    let diff = "";
    try {
      diff = (await runShell(cmd, cfg.cwd, "off", { timeout: 30_000, maxBuffer: 8_000_000 })).stdout;
    } catch (e) {
      return void out(c.red(`\`${cmd}\` failed: ${e instanceof Error ? e.message : String(e)}\n`) + c.dim("(is this a git repo?)\n"));
    }
    if (!diff.trim()) return void out(c.dim(`No changes to review (${cmd}).\n`));
    out(c.dim(`Reviewing \`${cmd}\` (${diff.split("\n").length} diff lines)…\n\n`));
    const stats = { input: 0, output: 0, lastInput: 0 };
    await runAgent([{ role: "user", content: `Review this diff:\n\n\`\`\`diff\n${diff.slice(0, 120_000)}\n\`\`\`` }], {
      provider,
      ctx: { cwd: cfg.cwd, sandbox: cfg.sandbox },
      approval: "full-auto",
      confirm: async () => true,
      systemOverride: REVIEW_SYSTEM,
      toolFilter: (n) => READONLY_TOOLS.has(n), // read-only: the reviewer can inspect, never edit
      projectContext: loadAgentsMd(cfg.cwd) || undefined,
      memory: memoryDigest(cfg.cwd),
      stats,
    });
    if (stats.input || stats.output) out("\n" + statusLine(cfg.model, stats.input, stats.output) + "\n");
  });

program
  .command("commit")
  .description("generate a commit message from staged changes and commit (-y to skip the confirm)")
  .option("-a, --all", "stage all tracked changes first (git add -u)")
  .action(async (opts: { all?: boolean }) => {
    const skipConfirm = !!program.opts().yes; // reuse the global -y/--yes (auto-approve)
    const cfg = loadConfig();
    const provider = await buildProvider(cfg);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    if (opts.all) {
      try {
        await runShell("git add -u", cfg.cwd, "off", { timeout: 30_000, maxBuffer: 1_000_000 });
      } catch {
        /* report below if nothing is staged */
      }
    }
    let diff = "";
    try {
      diff = (await runShell("git diff --staged", cfg.cwd, "off", { timeout: 30_000, maxBuffer: 8_000_000 })).stdout;
    } catch (e) {
      return void out(c.red(`git diff failed: ${e instanceof Error ? e.message : String(e)}\n`) + c.dim("(is this a git repo?)\n"));
    }
    if (!diff.trim()) return void out(c.dim("Nothing staged. Stage changes with `git add`, or use `hara commit -a`.\n"));
    out(c.dim("Writing a commit message…\n"));
    const r = await provider.turn({
      system: COMMIT_SYSTEM,
      history: [{ role: "user", content: `Write a commit message for these staged changes:\n\n\`\`\`diff\n${diff.slice(0, 120_000)}\n\`\`\`` }],
      tools: [],
      onText: () => {},
    });
    if (r.stop === "error") return void out(c.red(`message generation failed: ${r.errorMsg ?? "provider error"}\n`));
    const msg = r.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    if (!msg) return void out(c.red("No commit message produced — commit manually or retry.\n"));
    out("\n" + c.bold("Proposed commit message:\n") + c.dim("─".repeat(48) + "\n") + msg + "\n" + c.dim("─".repeat(48)) + "\n\n");
    if (!skipConfirm) {
      const rl = createInterface({ input: stdin, output: stdout });
      const ans = (await rl.question(`Commit with this message? ${c.dim("[Y/n]")} `)).trim().toLowerCase();
      rl.close();
      if (ans === "n" || ans === "no") return void out(c.dim("(cancelled — nothing committed)\n"));
    }
    const tmp = join(tmpdir(), `hara-commit-${process.pid}.txt`);
    writeFileSync(tmp, msg + "\n", "utf8");
    try {
      const res = await runShell(`git commit -F ${JSON.stringify(tmp)}`, cfg.cwd, "off", { timeout: 30_000, maxBuffer: 1_000_000 });
      out(c.green("✓ committed ") + c.dim(((res.stdout || "").trim().split("\n")[0] || "").slice(0, 100)) + "\n");
    } catch (e) {
      out(c.red(`git commit failed: ${e instanceof Error ? e.message : String(e)}\n`));
    } finally {
      try {
        rmSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
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
      run: async (a) => {
        if (!a) return void out(c.dim("usage: /recall <query>\n"));
        const hits = await searchHybrid(a, cwd, { indexName: "assets", roots: assetSearchRoots(cwd), limit: 3 });
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
    // lets the computer tool return a screenshot as text (describe via the vision sidecar / a vision main model).
    // Uses the screenshot-tuned prompt (actionable UI elements + positions) + an optional focus hint, so a
    // text-only main model gets something it can click on rather than a generic transcription.
    const describeScreenshot = async (path: string, hint?: string): Promise<string> => {
      const cap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
      const vp = cfg.visionModel ? await getVisionProvider() : cap === "vision" ? provider : null;
      if (!vp) return "";
      try {
        return await describeImages(vp, [{ path, mediaType: "image/png" }], { system: SCREENSHOT_SYSTEM, hint });
      } catch {
        return "";
      }
    };
    // grounding for accurate RPA: ask the vision model WHERE an element is (0..1 fractions) so the computer
    // tool can click it precisely instead of guessing pixels from a text description.
    const locateScreenshot = async (path: string, target: string): Promise<{ x: number; y: number } | null> => {
      const cap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
      const vp = cfg.visionModel ? await getVisionProvider() : cap === "vision" ? provider : null;
      if (!vp) return null;
      try {
        return await locateImage(vp, { path, mediaType: "image/png" }, target);
      } catch {
        return null;
      }
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
                  approval: cfg.assetCapture === "auto" ? "full-auto" : "suggest", // ask → prompt before each save; auto → silent
                  confirm: h.confirm,
                  toolFilter: (n) => n === "memory_write" || (cfg.assetCapture !== "off" && n === "skill_create") || READONLY_TOOLS.has(n),
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
            const hits = await searchHybrid(arg, cwd, { indexName: "assets", roots: assetSearchRoots(cwd), limit: 3 });
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
                  approval: cfg.assetCapture === "auto" ? "full-auto" : "suggest", // ask → prompt before each save; auto → silent
                  confirm: h.confirm,
                  toolFilter: (n) => n === "memory_write" || (cfg.assetCapture !== "off" && n === "skill_create") || READONLY_TOOLS.has(n),
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
        // Type-ahead steering: fold messages typed mid-turn into the next model call (codex-style) so a
        // clarification/addition course-corrects the live task, rather than waiting for a fresh turn.
        // Shared by every turn below (plan investigate, plan execute, and the regular turn).
        const pendingInput = async (): Promise<NeutralMsg[]> => {
          const out: NeutralMsg[] = [];
          for (const it of h.drainQueue()) {
            const r2 = await resolveImages(it.images, h);
            const body = expandMentions(it.line, cwd) + (r2.skip ? "" : (r2.extraText ?? ""));
            const attach = !r2.skip && r2.attach?.length ? r2.attach : undefined;
            if (!body.trim() && !attach) continue; // image-only message whose image was skipped → nothing to add
            out.push({ role: "user", content: `[I sent this while you were working on the above]\n\n${body}`, ...(attach ? { images: attach } : {}) });
          }
          return out;
        };
        const turnStart = Date.now(); // for the task-done notification (gated on elapsed)
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
            ctx: { cwd, sandbox, spawn, ui, describeImage: describeScreenshot, locate: locateScreenshot },
            approval: "suggest",
            confirm: h.confirm,
            toolFilter: (n) => READONLY_TOOLS.has(n),
            systemOverride: PLAN_SYSTEM,
            memory: buildMemory(),
            projectContext,
            stats,
            signal: h.signal,
            pendingInput,
          });
          if (!meta.title) {
            meta.title = await nameSession(provider, history);
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
              ctx: { cwd, sandbox, spawn, ui, describeImage: describeScreenshot, locate: locateScreenshot },
              approval: choice as ApprovalMode,
              memory: buildMemory(),
              confirm: h.confirm,
              autoApprove,
              projectContext,
              stats,
              signal: h.signal,
              pendingInput,
            });
            h.sink.usage(stats.input - xin, stats.output - xout);
            saveSession(meta, history);
          }
          notifyDone(cfg.notify, { message: meta.title || "plan turn complete", elapsedMs: Date.now() - turnStart });
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
          ctx: { cwd, sandbox, spawn, ui, describeImage: describeScreenshot, locate: locateScreenshot },
          approval: appr,
          memory: buildMemory(),
          confirm: h.confirm,
          autoApprove,
          projectContext,
          stats,
          signal: h.signal,
          pendingInput,
        });
        if (!meta.title) {
          meta.title = await nameSession(provider, history);
          h.sink.session(meta.title);
        }
        h.sink.usage(stats.input - beforeIn, stats.output - beforeOut);
        notifyDone(cfg.notify, { message: meta.title || "turn complete", elapsedMs: Date.now() - turnStart });
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
    const t0 = Date.now();
    try {
      await runAgent(history, { provider, ctx: { cwd, sandbox, spawn }, approval, confirm, autoApprove, projectContext, memory: buildMemory(), stats, signal: currentTurn.signal });
    } catch (e: any) {
      out(c.red(`\n[error] ${e.message}\n`));
    } finally {
      currentTurn = null;
    }
    notifyDone(cfg.notify, { message: meta.title || "turn complete", elapsedMs: Date.now() - t0 });
    if (!meta.title) meta.title = await nameSession(provider, history);
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
