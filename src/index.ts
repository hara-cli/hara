#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { runTui, askConfirm } from "./tui/run.js";
import { readClipboardImage, mediaTypeFor } from "./images.js";
import { describeImages, locateImage, classifyVision, SCREENSHOT_SYSTEM } from "./vision.js";
import { setTheme } from "./tui/theme.js";
import { memoryDigest, memoryDir, readRecentLogs, scaffoldMemory, type Scope } from "./memory/store.js";
import { nextMode as cycleMode, type Approval } from "./tui/InputBox.js";
import { stdin, stdout } from "node:process";
import { readFileSync, existsSync, realpathSync, statSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import {
  loadConfig,
  configPath,
  readRawConfig,
  writeConfigValue,
  setModelVisionOverride,
  providerEnvKey,
  providerDefaultBaseURL,
  CONFIG_KEYS,
  APPROVAL_MODES,
  SANDBOX_MODES,
  REASONING_EFFORTS,
  type HaraConfig,
  type ApprovalMode,
  type ProviderId,
} from "./config.js";
import { runAgent, type RunOutcome } from "./agent/loop.js";
import {
  formatAgentDuration,
  parseAgentRunTimeoutMs,
  MIN_AGENT_RUN_TIMEOUT_MS,
  MAX_AGENT_RUN_TIMEOUT_MS,
  MAX_AGENT_MAX_ROUNDS,
} from "./agent/limits.js";
import { parseSchemaArg, structuredOutputTool, STRUCTURED_INSTRUCTION, STRUCTURED_NUDGE } from "./agent/structured.js";
import { notifyDone } from "./notify.js";
import { startMcpServer, mcpServeToolNames } from "./mcp/server.js";
import { completionScript } from "./completions.js";
import { renderSessionMarkdown } from "./export.js";
import { loadEnrollment, clearEnrollment, enrollDevice, heartbeat, gatewayBaseURL, syncOrgRoles } from "./org-fleet/enroll.js";
import {
  loadActiveProfile,
  listProfiles,
  useProfile,
  addProfile,
  upsertProfile,
  removeProfile,
  setModel as setProfileModel,
  resetModel as resetProfileModel,
  getProfile,
  effectiveModel,
  routingLabel,
  routeHost,
  activeId,
  resolveActive,
  setFlagOverride,
  writePin,
  removePin,
  pinFilePath,
  DEFAULT_ORG_ID,
  PERSONAL_ID,
  type Profile,
  type ActiveResolution,
} from "./profile/profile.js";
import { loadPermissionRules, scaffoldPermissions, globalPermissionsPath, projectPermissionsPath } from "./security/permissions.js";
import { routingProvider } from "./agent/route.js";
import {
  shouldAutoCompact,
  shouldAutoCompactTokens,
  AUTO_COMPACT_TOKEN_CAP,
  COMPACT_SYSTEM,
  buildFileRestore,
  compactedConversationHistory,
  compactedHistoryTokenEstimate,
  compactionSourceHistory,
  normalizeCompactionSummary,
  recentHistoryForCompaction,
  workingSetFromSummary,
} from "./agent/compact.js";
import { recentTouched, clearTouched } from "./agent/touched.js";
import { INTERJECT_PREFIX, disposeReminderScope } from "./agent/reminders.js";
import { checkForUpdate } from "./update-check.js";
import { formatContextReport } from "./agent/context-report.js";
import { userTurnPreviews, rewindTo } from "./agent/rewind.js";
import { checkpoint, listCheckpoints, restoreCheckpoint } from "./checkpoints.js";
import { mapLimit, maxParallel } from "./concurrency.js";
import {
  parseVerdict,
  captureChanges,
  reviewPrompt,
  fixPrompt,
  REVIEWER_SYSTEM,
  isTreeClean,
  stripCommitFence,
  commitMessageInput,
  protectedStagedPaths,
  protectedTrackedWorkingTreePaths,
  protectedWorkingTreePaths,
  type CapturedChanges,
} from "./org/review-chain.js";
import { parseSchedule, describeSchedule, nextRun, validTz } from "./cron/schedule.js";
import { parseDeliver } from "./cron/deliver.js";
import { addJob, removeJob, setEnabled, resolveJob, loadJobs, logPath, type CronJob } from "./cron/store.js";
import { runTick, runJobTracked, runSelfAttached, selfArgv } from "./cron/runner.js";
import { installScheduler, uninstallScheduler, isInstalled } from "./cron/install.js";
import { getTools, type Tool, type ToolContext } from "./tools/registry.js";
import { resetReachability } from "./tools/net-reachability.js";
import { resetRepeatGuard } from "./agent/repeat-guard.js";
import { allowsEvolutionTool, EVOLUTION_SYSTEM, evolutionStatus, shouldAutoEvolve } from "./agent/evolution.js";
import { EXPLORE_SYSTEM } from "./tools/agent.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { resolvePlatform } from "./providers/registry.js";
import { boundedProviderTurn } from "./providers/bounded-turn.js";
import { levelsFor } from "./tui/model-picker.js";
import { listModels } from "./providers/models.js";
import { listJobs, tailJob, killJob } from "./exec/jobs.js";
import { readModelContextFileSync } from "./fs-read.js";
import { MIN_NODE_VERSION, unsupportedNodeMessage } from "./runtime.js";

/** Render the background-job list for /jobs (user-facing view of what the agent has running in the
 *  background — dev servers, watchers, long tasks). Mirrors codex/Claude-Code process visibility. */
function renderBgJobs(): string {
  const js = listJobs();
  if (!js.length) return "(no background jobs — the agent starts them with bash {background:true})";
  const age = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);
  const rows = js.map((j) => {
    const st = j.status === "running" ? "▶ running" : j.status === "killed" ? "✕ killed" : `● exited${j.code != null ? ` (${j.code})` : ""}`;
    const cmd = j.command.length > 64 ? j.command.slice(0, 64) + "…" : j.command;
    return `  ${j.id}  ${st}  ${age(j.ageMs).padStart(4)}  ${cmd}`;
  });
  return `Background jobs — /jobs tail <id> · /jobs kill <id>:\n${rows.join("\n")}`;
}
import { qwenDeviceLogin, getValidQwenAuth, loadQwenToken } from "./providers/qwen-oauth.js";
import { loadAgentContext, hasAgentsMd, INIT_PROMPT, findProjectRoot } from "./context/agents-md.js";
import {
  homeWorkspaceActionError,
  isUnsafeProjectWorkspace,
  resolveWorkspaceSwitch,
} from "./context/workspace-scope.js";
import { getEmbedder } from "./search/embed.js";
import { collectRepoChunksAsync, collectDirChunksAsync, buildIndex, indexPath, indexExists, type Chunk, type ChunkCollectionResult } from "./search/semindex.js";
import { searchHybrid } from "./search/hybrid.js";
import { expandMentionsAsync, fileCandidates, isSlashCommand, inlineLeadingPath } from "./context/mentions.js";
import {
  newSessionId,
  shortId,
  resolveSessionId,
  validSessionId,
  sessionFileExists,
  saveSession,
  loadSession,
  acquireSessionLock,
  releaseSessionLock,
  listSessions,
  latestForCwd,
  titleFrom,
  sessionSourceFromEnv,
  automatedTitle,
  slugify,
  type SessionMeta,
  type SessionData,
} from "./session/store.js";
import {
  consumePendingTaskSteering,
  continueTaskExecution,
  createTaskExecution,
  finishTaskExecution,
  formatTaskExecution,
  hasPendingTaskSteering,
  newSteerInteraction,
  newTurnInteraction,
  recordTaskSteering,
  recoverTaskExecution,
  requestsTaskContinuation,
  taskExecutionContext,
  type TaskExecution,
  type TaskInteraction,
} from "./session/task.js";
import { setSessionForceModel, isSessionForceModel, effectiveRoleModel } from "./session/session-model.js";
import { loadGlobalRoles, loadRoles, roleToolFilter, scaffoldRoles, subagentToolFilter, type Role } from "./org/roles.js";
import { buildAgentsIndex, canonicalProjectPath, resolveAgent, loadProjects, addProject, removeProject, type AgentIndexEntry } from "./org/projects.js";
import { loadSkillIndex, loadSkillBody, scaffoldSkills, globalSkillsDir } from "./skills/skills.js";
import { installPlugin, uninstallPlugin, listInstalled, enabledPlugins, setPluginEnabled, pluginMcpServers, pluginHooks, haraBinDir } from "./plugins/plugins.js";
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
import { clearTodos, disposeTodoScope, restoreTodos, onTodosChange } from "./tools/todo.js"; // scoped session todo persistence
import "./tools/task.js"; // register task (project-level durable task pool)
import "./tools/send.js"; // register send_file (self-gates on HARA_GATEWAY — pushes a file to the chat)
import "./tools/external_agent.js"; // register external_agent (delegate to claude-code / codex headless)
import "./tools/ask_user.js"; // register ask_user (pause mid-turn to ask the user a structured question)
import "./tools/cron.js"; // register cronjob (model-facing scheduler — "remind me every morning" just works)
import { computerBackends } from "./tools/computer.js"; // register the computer tool + expose the backend probe

const here = dirname(fileURLToPath(import.meta.url));
// Version: from a build-time define in the compiled single-binary (no package.json on its virtual FS),
// else read package.json (npm install / `node dist`). The read is wrapped so the binary never hits it.
const pkg = {
  version:
    process.env.HARA_BUILD_VERSION ??
    (((): string => {
      try {
        return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string }).version;
      } catch {
        return "0.0.0";
      }
    })()),
};

const maskKey = (v?: string) => (v ? `${v.slice(0, 7)}…${v.slice(-4)}` : "(unset)");

async function buildProvider(cfg: HaraConfig): Promise<Provider | null> {
  // Identity-profile is the source of truth for routing. `cfg` is the *merged* HaraConfig (env +
  // project + global) and still drives non-routing concerns (model overrides, baseURL fallbacks
  // for things like vision/route/fallback sidecars). The active profile decides "where to send
  // requests" — gateway (deviceToken at the gateway) vs BYOK (user's key direct to the provider).
  const ap = loadActiveProfile();
  // CFG-OVERRIDE PATH: when a sidecar (vision / route / fallback) calls buildProvider with a tweaked
  // cfg that explicitly carries an apiKey + baseURL, honor those over the profile — they're the
  // sidecar's intended target. Detected by "cfg.apiKey present + cfg.baseURL present and we're not
  // routing to a gateway." This keeps `withRouting`/vision unchanged.
  const isSidecarOverride = !!cfg.apiKey && !!cfg.baseURL && ap.kind === "byok" && cfg.apiKey !== ap.apiKey;

  if (ap.kind === "gateway" && !isSidecarOverride) {
    if (!ap.gatewayUrl || !ap.deviceToken) return null;
    const baseURL = ap.baseURL || `${ap.gatewayUrl.replace(/\/$/, "")}/v1`;
    const model = cfg.model || effectiveModel(ap);
    return createOpenAIProvider({ apiKey: ap.deviceToken, baseURL, model, label: "hara-gateway", reasoningEffort: cfg.reasoningEffort });
  }

  // BYOK paths — use the active profile's provider/key/baseURL by default, but let the merged cfg
  // override (so `--profile`/`HARA_PROFILE`-overridden values flow + sidecar provider builds work).
  const provider: ProviderId = (cfg.provider && cfg.provider !== "hara-gateway" ? cfg.provider : ap.provider) || "anthropic";
  const apiKey = cfg.apiKey ?? ap.apiKey;
  // Resolve base URL: explicit (cfg → profile) wins; otherwise fall back to the provider's preset
  // (GLM/DeepSeek/OpenRouter). This keeps `profile add --byok --provider glm` working even when the
  // user didn't pass --base-url (anthropic/openai stay undefined → their SDK defaults).
  const baseURL = cfg.baseURL ?? ap.baseURL ?? providerDefaultBaseURL(provider);
  const model = cfg.model || effectiveModel(ap);

  if (provider === "qwen-oauth") {
    const auth = await getValidQwenAuth();
    if (!auth) return null;
    return createOpenAIProvider({ apiKey: auth.accessToken, baseURL: auth.baseURL, model, label: "qwen-oauth", reasoningEffort: cfg.reasoningEffort });
  }
  if (!apiKey) return null;
  // Transport is chosen from the provider REGISTRY (the dictionary) by wire protocol — so a custom
  // baseURL Just Works: a vendor's `.../anthropic` endpoint (DeepSeek/Kimi/GLM/MiniMax/Aliyun) speaks the
  // Anthropic wire (gets cache_control + thinking budget), DashScope/Ollama/OpenAI speak chat, etc.
  const wire = resolvePlatform(provider, baseURL).wireApi;
  if (wire === "anthropic") {
    return createAnthropicProvider({ apiKey, model, baseURL, reasoningEffort: cfg.reasoningEffort });
  }
  if (wire === "responses") {
    // The OpenAI Responses API (e.g. Aliyun Token Plan's newest models) — a distinct wire hara doesn't
    // speak yet. Fail with guidance instead of sending a chat body it will reject. (Tracked for when a
    // Token-Plan key is available to build + verify against; the chat + anthropic endpoints work today.)
    return {
      id: provider,
      model,
      async turn() {
        return { text: "", toolUses: [], stop: "error" as const, errorMsg: `This endpoint uses the OpenAI Responses API, which hara doesn't speak yet. Point hara at the plan's OpenAI-compatible chat endpoint (…/compatible-mode/v1 or …/v1) or its Anthropic-compatible endpoint (…/apps/anthropic) instead.` };
      },
    };
  }
  return createOpenAIProvider({ apiKey, model, baseURL, label: provider, reasoningEffort: cfg.reasoningEffort });
}

/** Wrap the main provider with per-turn model routing when `routeModel` is configured: trivial/non-coding
 *  turns go to the alternate (cheap/general) model, real coding/action work stays on the primary. No-op when
 *  routeModel is unset or equals the primary model. routeBaseURL/routeApiKey default to the primary's. */
async function withRouting(primary: Provider | null, cfg: HaraConfig): Promise<Provider | null> {
  if (!primary || !cfg.routeModel || cfg.routeModel === cfg.model) return primary;
  const alt = await buildProvider({ ...cfg, model: cfg.routeModel, baseURL: cfg.routeBaseURL ?? cfg.baseURL, apiKey: cfg.routeApiKey ?? cfg.apiKey });
  return alt ? routingProvider(primary, alt) : primary;
}

/** Guardian veto model: the CHEAP tier if `routeModel` is configured (a small classifier call, not real
 *  work), else the primary provider. Never blocks startup — any build failure just yields the fallback (and
 *  the guardian fails open when even that is absent). Returns the `{ provider, enabled }` shape runAgent wants,
 *  or undefined when guardian is off in config/env. */
async function buildGuardian(cfg: HaraConfig, primary: Provider | null): Promise<{ provider: Provider | null; enabled: boolean } | undefined> {
  if (cfg.guardian === "off") return undefined;
  let gp: Provider | null = primary;
  if (cfg.routeModel && cfg.routeModel !== cfg.model) {
    gp = (await buildProvider({ ...cfg, model: cfg.routeModel, baseURL: cfg.routeBaseURL ?? cfg.baseURL, apiKey: cfg.routeApiKey ?? cfg.apiKey })) ?? primary;
  }
  return { provider: gp, enabled: true };
}

function authHint(cfg: HaraConfig): string {
  const ap = loadActiveProfile();
  if (ap.kind === "gateway") return `Active profile '${ap.id}' is a gateway profile but is missing deviceToken — re-enroll with \`hara profile add ${ap.id} --gateway <url> --code <code>\`.`;
  const provider = ap.provider ?? cfg.provider;
  if (provider === "qwen-oauth") return `Run ${c.bold("hara login qwen")} to authenticate.`;
  return `Set ${c.bold(providerEnvKey(provider))} (or ${c.bold("HARA_API_KEY")}), or run ${c.bold("hara setup")}.`;
}

const SETUP_DEFAULT_MODEL: Record<string, string> = { anthropic: "claude-opus-4-8", qwen: "qwen-plus", openai: "gpt-4o-mini", glm: "glm-4.6", deepseek: "deepseek-chat", openrouter: "openai/gpt-4o-mini", "qwen-oauth": "coder-model" };

/** Numbered provider menu for `hara setup`. Order is the displayed order; `id` maps to a ProviderId
 *  (or the special "custom"/"qwen-oauth" routes). GLM/DeepSeek carry a preset base URL so the user
 *  never types one; "custom" prompts for an OpenAI-compatible base URL. */
const SETUP_MENU: { label: string; id: ProviderId | "custom" }[] = [
  { label: "Anthropic", id: "anthropic" },
  { label: "OpenAI", id: "openai" },
  { label: "GLM (Zhipu)", id: "glm" },
  { label: "DeepSeek", id: "deepseek" },
  { label: "Qwen (DashScope key)", id: "qwen" },
  { label: "OpenAI-compatible (custom base URL)", id: "custom" },
  { label: "Qwen — free, no key (browser sign-in)", id: "qwen-oauth" },
];

/** Read a secret from the TTY without echoing it (shows `*` per char). Falls back to a plain
 *  readline question when stdin isn't a raw-capable TTY (piped input / odd terminals) so scripted
 *  `printf 'key\n' | hara setup` still works. Handles backspace, Enter, and Ctrl-C/Ctrl-D. */
function readSecret(prompt: string, rl: ReturnType<typeof createInterface>): Promise<string> {
  const input = stdin;
  if (!input.isTTY || typeof (input as any).setRawMode !== "function") {
    // Non-TTY (piped/scripted): can't suppress echo at the terminal level; read it plainly.
    return rl.question(prompt);
  }
  return new Promise<string>((resolve, reject) => {
    stdout.write(prompt);
    let buf = "";
    const prevRaw = (input as any).isRaw ?? false;
    // Pause the readline interface so it doesn't also consume keystrokes / echo while we read raw.
    // We restore it in cleanup() before the next rl.question() runs.
    rl.pause();
    (input as any).setRawMode(true);
    input.resume();
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(buf);
          return;
        } else if (code === 3) {
          // Ctrl-C → abort the wizard (mirror readline's SIGINT behavior).
          cleanup();
          stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        } else if (code === 4) {
          // Ctrl-D → end of input; resolve with whatever we have.
          cleanup();
          stdout.write("\n");
          resolve(buf);
          return;
        } else if (code === 127 || code === 8) {
          // Backspace/Delete.
          if (buf.length) {
            buf = buf.slice(0, -1);
            stdout.write("\b \b");
          }
        } else if (code >= 32) {
          buf += ch;
          stdout.write("*");
        }
      }
    };
    const cleanup = (): void => {
      input.removeListener("data", onData);
      try {
        (input as any).setRawMode(prevRaw);
      } catch {
        /* best-effort */
      }
      // Hand control back to readline for the next prompt (model question).
      rl.resume();
    };
    input.on("data", onData);
  });
}

/** One-shot validation ping: build the provider exactly as the runtime would (anthropic vs the
 *  OpenAI-compatible path with the resolved base URL) and send a tiny prompt with a short timeout.
 *  Never throws — returns true on a clean turn, false on any error/timeout. Used only to print a
 *  friendly "connected" hint; the wizard saves config regardless. */
async function pingProvider(args: { provider: ProviderId; apiKey: string; model: string; baseURL?: string }): Promise<boolean> {
  const { provider, apiKey, model, baseURL } = args;
  if (!apiKey || !model) return false;
  const prov =
    provider === "anthropic"
      ? createAnthropicProvider({ apiKey, model, baseURL })
      : createOpenAIProvider({ apiKey, model, baseURL, label: provider });
  try {
    const r = await boundedProviderTurn(prov, {
      system: "Reply with the single word: ok",
      history: [{ role: "user", content: "ping" }],
      tools: [],
      onText: () => {},
    }, { timeoutMs: 12_000, label: "provider connectivity check" });
    return r.stop !== "error";
  } catch {
    return false;
  }
}

/** Interactive first-run setup: pick a provider (numbered menu), API key (masked), and model →
 *  ~/.hara/config.json. GLM/DeepSeek/OpenRouter and "custom" route through the OpenAI-compatible
 *  path; "Qwen free" routes to the device-login flow. Storage model is unchanged (config.json 0600). */
async function runSetup(): Promise<void> {
  if (!stdin.isTTY) {
    out(c.yellow("`hara setup` is interactive — run it in a terminal, or use `hara config set <key> <value>` in scripts.\n"));
    return;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    out(c.bold("hara setup") + c.dim(" — configure a provider, key, and model (Ctrl-C to cancel)\n\n"));
    SETUP_MENU.forEach((m, i) => out(`  ${c.bold(String(i + 1))}) ${m.label}\n`));
    out("\n");
    const pick = (await rl.question(`Provider [1]: `)).trim() || "1";
    const idx = Number.parseInt(pick, 10);
    const choice = Number.isInteger(idx) && idx >= 1 && idx <= SETUP_MENU.length ? SETUP_MENU[idx - 1] : SETUP_MENU[0];

    // Route 7: Qwen free device login — no key, no model prompt. Reuse the existing flow + config writes.
    if (choice.id === "qwen-oauth") {
      try {
        await qwenDeviceLogin((m) => out(m + "\n"));
        writeConfigValue("provider", "qwen-oauth");
        writeConfigValue("model", "coder-model");
        out(c.green("\n✓ Qwen OAuth complete — provider set to qwen-oauth (model coder-model).\n") + c.dim(`Check it with ${c.bold("hara doctor")}, then just run ${c.bold("hara")}.\n`));
      } catch (e: any) {
        out(c.red(`\nQwen OAuth failed: ${e?.message ?? e}\n`));
      }
      return;
    }

    // Resolve the concrete provider id + base URL. "custom" = OpenAI-compatible: ask for the base
    // URL and store the chosen provider as "openai" (the generic OpenAI-compatible dispatch).
    let provider: ProviderId;
    let baseURL = "";
    if (choice.id === "custom") {
      provider = "openai";
      baseURL = (await rl.question(`Base URL ${c.dim("(OpenAI-compatible endpoint, e.g. https://your-host/v1)")}: `)).trim();
    } else {
      provider = choice.id;
      // GLM/DeepSeek/OpenRouter carry a preset base URL (PROVIDER_DEFAULTS) — written explicitly so
      // the personal profile is self-contained. anthropic/openai use their built-in defaults.
      baseURL = providerDefaultBaseURL(provider) ?? "";
    }

    const envKey = providerEnvKey(provider);
    const apiKey = (await readSecret(`API key ${c.dim(`(masked; blank = use the ${envKey} env var)`)}: `, rl)).trim();
    const defaultModel = SETUP_DEFAULT_MODEL[choice.id === "custom" ? "openai" : provider] ?? "";
    const model = (await rl.question(`Model [${defaultModel || "?"}]: `)).trim() || defaultModel;

    writeConfigValue("provider", provider);
    if (baseURL) writeConfigValue("baseURL", baseURL);
    if (apiKey) writeConfigValue("apiKey", apiKey);
    if (model) writeConfigValue("model", model);

    // One-shot validation ping (best-effort; never blocks saving). Only when we have a key + model.
    if (apiKey && model) {
      out(c.dim("\nChecking connection… "));
      const ok = await pingProvider({ provider, apiKey, model, baseURL: baseURL || undefined });
      out(ok ? c.green("✓ connected\n") : c.yellow(`⚠ couldn't reach ${provider} (saved anyway)\n`));
    }

    out(c.green(`\n✓ saved to ${configPath()}\n`) + c.dim(`Check it with ${c.bold("hara doctor")}, then just run ${c.bold("hara")}.\n`));
  } catch (e: any) {
    if (e?.message === "cancelled") out(c.dim("\n(cancelled)\n"));
    else throw e;
  } finally {
    rl.close();
  }
}

function agentRunLimits(cfg: Pick<HaraConfig, "runTimeoutMs" | "maxAgentRounds">): { timeoutMs: number; maxRounds: number } {
  return { timeoutMs: cfg.runTimeoutMs, maxRounds: cfg.maxAgentRounds };
}

async function runInit(provider: Provider, cwd: string, sandbox: SandboxMode = "off", cfg?: HaraConfig): Promise<void> {
  if (isUnsafeProjectWorkspace(cwd)) throw new Error(homeWorkspaceActionError("initialize AGENTS.md"));
  const history: NeutralMsg[] = [{ role: "user", content: INIT_PROMPT }];
  await runAgent(history, { provider, ctx: { cwd, sandbox }, approval: "full-auto", confirm: async () => true, ...(cfg ? agentRunLimits(cfg) : {}) });
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
  review?: boolean; // after implementing, loop a reviewer role until it approves (implement → review → fix)
  rounds?: number; // max review rounds (default 3)
  commit?: boolean; // commit the result (with --review: only after approval) — guarded to a clean start tree
}

/** Stage everything and commit with an AI-written message. Returns a one-line summary or "error: …".
 *  Used by `hara org --commit`; the caller guards on a clean start tree so this only captures the run's work. */
async function autoCommit(provider: Provider, cwd: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return "error: commit interrupted before staging";
  const before = protectedWorkingTreePaths(cwd);
  if (before.length) return `error: refusing to stage protected path(s): ${before.map((p) => JSON.stringify(p)).join(", ")}`;
  try {
    await runShell("git add -A", cwd, "off", { timeout: 30_000, maxBuffer: 1_000_000, signal });
  } catch {
    /* fall through — empty diff is reported below */
  }
  const protectedAfterStage = protectedStagedPaths(cwd);
  if (signal?.aborted) return "error: commit interrupted after staging; nothing was committed";
  if (protectedAfterStage.length) {
    return `error: refusing to inspect or commit protected staged path(s): ${protectedAfterStage.map((p) => JSON.stringify(p)).join(", ")}`;
  }
  const staged = captureChanges(cwd, 120_000, { staged: true, includeUntracked: false });
  if (staged.error) return `error: git diff failed closed (${staged.error})`;
  if (staged.skippedFiles.length) {
    return `error: refusing to inspect or commit protected staged path(s): ${staged.skippedFiles.map((p) => JSON.stringify(p)).join(", ")}`;
  }
  const changeInput = commitMessageInput(staged);
  if (!changeInput.trim()) return "nothing to commit";
  const r = await boundedProviderTurn(provider, {
    system: COMMIT_SYSTEM,
    history: [{ role: "user", content: `Write a commit message for these staged changes:\n\n${changeInput.slice(0, 120_000)}` }],
    tools: [],
    onText: () => {},
  }, { timeoutMs: 30_000, label: "commit message generation", signal });
  if (signal?.aborted) return "error: commit interrupted; nothing was committed";
  if (r.stop === "error") return `error: commit message generation failed (${r.errorMsg ?? "provider error"})`;
  const msg = stripCommitFence(r.text);
  if (!msg) return "error: no commit message produced";
  const tmp = join(tmpdir(), `hara-org-commit-${process.pid}.txt`);
  writeFileSync(tmp, msg + "\n", "utf8");
  try {
    const protectedBeforeCommit = protectedStagedPaths(cwd);
    if (signal?.aborted) return "error: commit interrupted; nothing was committed";
    if (protectedBeforeCommit.length) {
      return `error: staged paths changed while writing the message; protected path(s) will not be committed: ${protectedBeforeCommit.map((p) => JSON.stringify(p)).join(", ")}`;
    }
    const res = await runShell(`git commit -F ${JSON.stringify(tmp)}`, cwd, "off", { timeout: 30_000, maxBuffer: 1_000_000, signal });
    return (res.stdout || "").trim().split("\n")[0] || "committed";
  } catch (e) {
    return `error: git commit failed (${e instanceof Error ? e.message : String(e)})`;
  } finally {
    try {
      rmSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** Format an autoCommit result + emit it. */
async function commitStep(provider: Provider, cwd: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const r = await autoCommit(provider, cwd, signal);
  if (r.startsWith("error:")) out(c.red(`✗ ${r}\n`));
  else if (r === "nothing to commit") out(c.dim("(nothing to commit)\n"));
  else out(c.green(`✓ committed · ${r.slice(0, 100)}\n`));
}

/** Dispatch a task to the owning role and run that role's agent (its persona + tool subset + model). */
function runFailureDetail(outcome: RunOutcome): string | null {
  if (outcome.status === "completed") return null;
  if (outcome.error?.trim()) return outcome.error.trim();
  if (outcome.status === "empty") return "the model returned an empty response";
  if (outcome.status === "halted") return "the run was halted by safety controls";
  return "the agent run failed";
}

async function runOrg(task: string, o: OrgOpts): Promise<RunOutcome> {
  const roles = loadRoles(o.cwd);
  if (!roles.length) {
    out(c.yellow("No roles defined — run ") + c.bold("hara roles init") + c.yellow(" to scaffold some.\n"));
    return { status: "error", error: "no roles are defined" };
  }
  let role: Role | undefined;
  if (o.forceRole) {
    role = roles.find((r) => r.id === o.forceRole);
    if (!role) {
      out(c.red(`No role '${o.forceRole}'. Available: ${roles.map((r) => r.id).join(", ")}\n`));
      return { status: "error", error: `no role '${o.forceRole}' is available` };
    }
  } else {
    const kw = routeByKeywords(task, roles);
    if (kw) {
      role = kw.role;
    } else {
      const r = await boundedProviderTurn(o.baseProvider, {
        system: "You are a task dispatcher. Reply with only a role id.",
        history: [{ role: "user", content: buildDispatchPrompt(task, roles) }],
        tools: [],
        onText: () => {},
      }, { timeoutMs: 20_000, label: "role dispatch" });
      if (r.stop === "error") out(c.yellow(`(role dispatch unavailable — using ${roles[0].id})\n`));
      role = parseRoleId(r.text, roles) ?? roles[0];
    }
  }
  out(c.dim(`→ ${role.id} owns this task\n`));

  // Role-model resolution: respect role.model by default; --force collapses everything to cfg.model.
  const __roleModel = effectiveRoleModel(role.model, o.cfg.model);
  const roleProvider = __roleModel
    ? ((await buildProvider({ ...o.cfg, model: __roleModel })) ?? o.baseProvider)
    : o.baseProvider;
  const toolFilter = roleToolFilter(role);

  const history: NeutralMsg[] = [{ role: "user", content: await expandMentionsAsync(task, o.cwd) }];
  const runImplementer = async (): Promise<RunOutcome> => {
    return runAgent(history, {
      provider: roleProvider,
      ctx: { cwd: o.cwd, sandbox: o.sandbox },
      approval: o.approval,
      confirm: o.confirm,
      projectContext: o.projectContext,
      memory: memoryDigest(o.cwd),
      stats: o.stats,
      systemOverride: role.system,
      toolFilter,
      ...agentRunLimits(o.cfg),
      ...(role.readOnly ? { hooks: false } : {}),
    });
  };
  const wasClean = o.commit ? isTreeClean(o.cwd) : false; // capture BEFORE the implementer edits anything
  const doCommit = async (ok: boolean): Promise<void> => {
    if (!o.commit) return;
    if (!ok) return void out(c.yellow("(not committing — review didn't approve; changes left in your working tree)\n"));
    if (!wasClean) return void out(c.yellow("(not auto-committing — the tree wasn't clean before this run; commit manually)\n"));
    await commitStep(o.baseProvider, o.cwd);
  };
  let implementerOutcome = await runImplementer();
  if (implementerOutcome.status !== "completed") return implementerOutcome;

  if (!o.review) {
    await doCommit(true);
    return implementerOutcome;
  }

  // Review chain: a reviewer role inspects the diff and APPROVES or sends it back, looping until clean.
  const reviewer = roles.find((r) => r.id === "reviewer");
  const __revModel = effectiveRoleModel(reviewer?.model, o.cfg.model);
  const revProvider = __revModel ? ((await buildProvider({ ...o.cfg, model: __revModel })) ?? o.baseProvider) : o.baseProvider;
  const revSystem = reviewer?.system ?? REVIEWER_SYSTEM;
  const revTools = roleToolFilter(reviewer ? { ...reviewer, readOnly: true } : undefined) ?? ((n: string) => READONLY_TOOLS.has(n));
  const maxRounds = Math.max(1, o.rounds ?? 3);
  for (let round = 1; round <= maxRounds; round++) {
    const changes = captureChanges(o.cwd);
    if (changes.error) {
      out(c.red(`(review change capture failed closed: ${changes.error})\n`));
      await doCommit(false);
      return { status: "halted", error: `review change capture failed: ${changes.error}` };
    }
    if (!changes.diff && !changes.newFiles.length && !changes.skippedFiles.length && !changes.omittedDeletions.length) {
      out(c.dim("(no changes to review)\n"));
      return implementerOutcome;
    }
    out(c.dim(`🔍 reviewer · round ${round}/${maxRounds}\n`));
    const rHist: NeutralMsg[] = [{ role: "user", content: reviewPrompt(task, changes) }];
    const reviewerOutcome = await runAgent(rHist, {
      provider: revProvider,
      ctx: { cwd: o.cwd, sandbox: o.sandbox },
      approval: "full-auto", // reviewer is read-only via revTools, so nothing to confirm
      confirm: o.confirm,
      projectContext: o.projectContext,
      memory: memoryDigest(o.cwd),
      stats: o.stats,
      systemOverride: revSystem,
      toolFilter: revTools,
      hooks: false,
      ...agentRunLimits(o.cfg),
    });
    if (reviewerOutcome.status !== "completed") return reviewerOutcome;
    const verdict = parseVerdict(lastAssistantText(rHist));
    if (verdict.approved) {
      out(c.green(`✓ reviewer approved after ${round} round(s)\n`));
      await doCommit(true);
      return implementerOutcome;
    }
    if (round === maxRounds) {
      out(c.yellow(`⚠ stopped after ${maxRounds} round(s) — reviewer still wants changes.\n`));
      await doCommit(false);
      return { status: "halted", error: `reviewer did not approve after ${maxRounds} round(s)` };
    }
    out(c.yellow(`✗ changes requested — back to ${role.id} (round ${round})\n`));
    history.push({ role: "user", content: fixPrompt(verdict.issues) });
    implementerOutcome = await runImplementer();
    if (implementerOutcome.status !== "completed") return implementerOutcome;
  }
  return implementerOutcome;
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
  await savePlan(o.cwd, plan);
  const role = atom.role ? roles.find((r) => r.id === atom.role) : undefined;
  const __atomModel = effectiveRoleModel(role?.model, o.cfg.model);
  const roleProvider = __atomModel ? ((await buildProvider({ ...o.cfg, model: __atomModel })) ?? o.baseProvider) : o.baseProvider;
  const toolFilter = roleToolFilter(role);
  const history: NeutralMsg[] = [{ role: "user", content: atomPrompt(atom, plan, done) }];
  try {
    const outcome = await runAgent(history, {
      provider: roleProvider,
      ctx: { cwd: o.cwd, sandbox: o.sandbox },
      approval: o.approval,
      confirm: o.confirm,
      projectContext: o.projectContext,
      memory: memoryDigest(o.cwd),
      stats: o.stats,
      systemOverride: role?.system,
      toolFilter,
      ...(role?.readOnly ? { hooks: false } : {}),
      quiet: o.parallel, // concurrent atoms would otherwise interleave their streamed output
      ...agentRunLimits(o.cfg),
    });
    const failure = runFailureDetail(outcome);
    if (failure) {
      atom.status = "failed";
      atom.note = failure;
      await savePlan(o.cwd, plan);
      out(c.red(`  ✗ ${atom.id} agent ${outcome.status}: ${failure}\n`));
      return false;
    }
  } catch (e: any) {
    atom.status = "failed";
    atom.note = e.message;
    await savePlan(o.cwd, plan);
    out(c.red(`  ✗ ${atom.id} errored: ${e.message}\n`));
    return false;
  }
  const v = atom.check ? await runCheck(atom.check, o.cwd, o.sandbox) : await verify(o.baseProvider, atom, lastAssistantText(history));
  atom.status = v.ok ? "done" : "failed";
  atom.note = v.reason;
  await savePlan(o.cwd, plan);
  out(v.ok ? c.green(`  ✓ ${atom.id} verified\n`) : c.yellow(`  ⚠ ${atom.id}: ${v.reason}\n`));
  return v.ok;
}

/** Execute a plan's atoms (sequential, or parallel waves with --parallel). Atoms already marked `done`
 *  are skipped — so this doubles as the resume engine. Stops on the first failure. */
async function executePlan(plan: Plan, roles: Role[], o: OrgOpts): Promise<RunOutcome> {
  const done: Atom[] = plan.atoms.filter((a) => a.status === "done");
  const doneIds = new Set(done.map((a) => a.id));
  let failed = false;

  if (o.parallel) {
    const waved = topoWaves(plan.atoms);
    if ("error" in waved) {
      out(c.red(`${waved.error}\n`));
      return { status: "error", error: waved.error };
    }
    out(c.dim(`Parallel mode — ${waved.ok.length} wave(s).\n`));
    for (const wave of waved.ok) {
      const todo = wave.filter((a) => !doneIds.has(a.id));
      if (!todo.length) continue; // whole wave already complete (resume)
      out(c.cyan(`\n▶ wave [${todo.map((a) => a.id).join(", ")}] — ${todo.length} in parallel\n`));
      const results = await mapLimit(todo, maxParallel(), (atom) => executeAtom(atom, plan, done, roles, o)); // bounded
      todo.forEach((atom, i) => {
        if (results[i]) {
          done.push(atom);
          doneIds.add(atom.id);
        }
      });
      if (results.some((r) => !r)) {
        failed = true;
        out(c.dim("Stopping — a wave atom failed. Inspect .hara/org/plan.json, then fix & `hara plan resume`.\n"));
        break;
      }
    }
  } else {
    const ord = topoOrder(plan.atoms);
    if ("error" in ord) {
      out(c.red(`${ord.error}\n`));
      return { status: "error", error: ord.error };
    }
    for (const atom of ord.ok) {
      if (doneIds.has(atom.id)) continue; // resume: skip completed atoms
      out(c.cyan(`\n▶ ${atom.id} ${atom.title}\n`));
      if (await executeAtom(atom, plan, done, roles, o)) {
        done.push(atom);
        doneIds.add(atom.id);
      } else {
        failed = true;
        out(c.dim("Stopping — inspect .hara/org/plan.json, then fix & `hara plan resume`.\n"));
        break;
      }
    }
  }
  out(c.bold(`\nPlan: ${plan.atoms.filter((a) => a.status === "done").length}/${plan.atoms.length} atoms done.\n`));
  if (failed || plan.atoms.some((atom) => atom.status === "failed")) {
    const first = plan.atoms.find((atom) => atom.status === "failed");
    return { status: "error", error: first ? `atom ${first.id} failed${first.note ? `: ${first.note}` : ""}` : "plan execution failed" };
  }
  if (plan.atoms.some((atom) => atom.status !== "done")) {
    return { status: "halted", error: "plan stopped before every atom completed" };
  }
  return { status: "completed" };
}

/** Decompose a task into atoms, sequence them (DAG), and execute each with a verify gate.
 *  With `parallel`, independent atoms (the same dependency wave) run concurrently. */
async function runPlan(task: string, o: OrgOpts): Promise<RunOutcome> {
  const roles = loadRoles(o.cwd);
  out(c.dim("Planning…\n"));
  const plan = await decompose(o.baseProvider, task, roles);
  if (!plan.atoms.length) {
    out(c.red("Planner returned no atoms — try rephrasing the task.\n"));
    return { status: "error", error: "planner returned no atoms" };
  }
  const ord = topoOrder(plan.atoms);
  if ("error" in ord) {
    out(c.red(`${ord.error}\n`));
    return { status: "error", error: ord.error };
  }
  out(c.bold(`\nPlan (${ord.ok.length} atoms):\n`));
  for (const a of ord.ok) {
    out(`  ${c.cyan(a.id)} ${a.title}${a.deps.length ? c.dim(" ←" + a.deps.join(",")) : ""}${a.role ? c.dim(" @" + a.role) : ""}${a.check ? c.dim(" ✓" + a.check) : ""}\n`);
  }
  if (o.approval !== "full-auto") {
    const ok = await o.confirm(`${c.yellow("▶")} Execute this ${ord.ok.length}-atom plan?`);
    if (!ok) {
      out(c.dim("(cancelled)\n"));
      return { status: "halted", error: "plan execution was cancelled" };
    }
  }
  await savePlan(o.cwd, plan);
  return executePlan(plan, roles, o);
}

/** Resume the saved plan (.hara/org/plan.json): re-run atoms that aren't done; completed atoms are skipped. */
async function runResume(o: OrgOpts): Promise<RunOutcome> {
  const roles = loadRoles(o.cwd);
  const plan = loadPlan(o.cwd);
  if (!plan) {
    out(c.red('No saved plan at .hara/org/plan.json — run `hara plan "<task>"` first.\n'));
    return { status: "error", error: "no saved plan" };
  }
  const remaining = plan.atoms.filter((a) => a.status !== "done");
  if (!remaining.length) {
    out(c.green(`Plan already complete — ${plan.atoms.length}/${plan.atoms.length} done.\n`));
    return { status: "completed" };
  }
  out(c.bold(`Resuming: ${plan.task}\n`) + c.dim(`${plan.atoms.length - remaining.length}/${plan.atoms.length} done · ${remaining.length} to go\n`));
  for (const a of remaining) out(`  ${c.cyan(a.id)} ${a.title} ${c.dim("(" + a.status + ")")}\n`);
  if (o.approval !== "full-auto") {
    const ok = await o.confirm(`${c.yellow("▶")} Resume the ${remaining.length} remaining atom(s)?`);
    if (!ok) {
      out(c.dim("(cancelled)\n"));
      return { status: "halted", error: "plan resume was cancelled" };
    }
  }
  for (const a of plan.atoms) if (a.status === "failed" || a.status === "running") a.status = "pending"; // retry interrupted
  await savePlan(o.cwd, plan);
  return executePlan(plan, roles, o);
}

const READONLY_TOOLS = new Set(["read_file", "grep", "glob", "ls", "web_fetch", "web_search", "codebase_search", "todo_write"]);
const REVIEW_SYSTEM =
  "You are a senior code reviewer. Review the safe Git status metadata the user provides for: correctness bugs, security " +
  "issues, missing error handling, unclear naming, and missing/weak tests. You may read files (read-only) " +
  "to inspect their current contents; historical patch lines are intentionally unavailable. Be concise and specific — cite file:line and the concrete fix. Group findings by severity: " +
  "**Blocker**, **Should-fix**, **Nit**. If nothing material is wrong, say the diff looks good. Never edit files.";

function standaloneReviewPrompt(changes: CapturedChanges): string {
  const parts = ["Review these changes:"];
  if (changes.diff) parts.push(`Change metadata only (status + path; no historical patch contents):\n\`\`\`text\n${changes.diff}\n\`\`\``);
  if (changes.newFiles.length) parts.push(`New files (inspect with read_file): ${changes.newFiles.map((p) => JSON.stringify(p)).join(", ")}`);
  if (changes.skippedFiles.length) {
    parts.push(
      "Protected paths were omitted and MUST NOT be opened during this review: " +
      changes.skippedFiles.map((p) => JSON.stringify(p)).join(", "),
    );
  }
  if (changes.omittedDeletions.length) {
    parts.push(
      "Tracked deletions were detected; their historical contents were omitted because old filesystem " +
      "identity cannot be verified safely: " + changes.omittedDeletions.map((p) => JSON.stringify(p)).join(", "),
    );
  }
  return parts.join("\n\n");
}
const COMMIT_SYSTEM =
  "Write a git commit message for the staged change metadata. A concise imperative subject (≤72 chars; an optional " +
  "conventional-commits prefix like feat:/fix:/refactor:/docs:/test:/chore: is welcome). If the change is " +
  "non-trivial, add a blank line then a short body (a few bullets or sentences) on what changed and why. " +
  "Output ONLY the commit message — no code fences, no preamble, no surrounding quotes.";
const SESSION_NAME_SYSTEM =
  "Name this coding session as a SHORT slug: 2–4 English words, lowercase, hyphen-separated, ASCII only " +
  "(e.g. add-semantic-search, fix-login-redirect). If the conversation is in another language, translate the " +
  "gist to English (use pinyin only if a term is untranslatable). Output ONLY the slug.";

/** One short model call → a 2–4 word English kebab-case session name summarizing the work.
 *  Always ASCII (translates non-English gist). Falls back to the lexical title on any failure. */
async function nameSession(provider: Provider, history: NeutralMsg[], signal?: AbortSignal): Promise<string> {
  const text = (m: NeutralMsg | undefined): string => {
    if (!m) return "";
    if (m.role === "assistant") return typeof m.text === "string" ? m.text : "";
    if (m.role === "user") return typeof m.content === "string" ? m.content : "";
    return "";
  };
  const basis =
    `User: ${text(history.find((m) => m.role === "user")).slice(0, 800)}\n` +
    `Assistant: ${text(history.find((m) => m.role === "assistant")).slice(0, 800)}`;
  const fallback = titleFrom(history);
  if (signal?.aborted) return fallback;
  try {
    const r = await boundedProviderTurn(
      provider,
      { system: SESSION_NAME_SYSTEM, history: [{ role: "user", content: basis }], tools: [], onText: () => {} },
      { timeoutMs: 10_000, label: "session naming", signal },
    );
    if (signal?.aborted || r.stop === "error") return fallback;
    return slugify(r.text) || fallback;
  } catch {
    return fallback;
  }
}
/** Render a proposed plan as a bordered block for the transcript (codex ProposedPlanCell-style).
 *  Left-border-only frame — right-edge alignment against variable-width content is brittle, and the
 *  open right side lets long lines wrap naturally. Emitted via the diff sink channel (renders verbatim,
 *  not dimmed like notice). */
const renderPlanBlock = (plan: string): string => {
  const lines = plan.replace(/\n+$/, "").split("\n");
  const top = c.cyan("╭─ ") + c.bold(c.cyan("Plan")) + c.cyan(" " + "─".repeat(42));
  const body = lines.map((l) => c.cyan("│ ") + l).join("\n");
  return `${top}\n${body}\n${c.cyan("╰" + "─".repeat(48))}`;
};

// Plan mode's contract (Claude-Code style handshake): the MODEL decides when the plan is ready by
// calling `exit_plan` — we never nag with a proceed-prompt after turns that were just investigation
// or Q&A. codex's equivalent is the plan streaming to a dedicated cell + Enter-to-implement.
const PLAN_SYSTEM =
  "You are in PLAN MODE — a read-only investigation phase. Explore with read_file / grep / glob / ls / " +
  "web tools and think. Do NOT edit files or run mutating commands — only investigate and plan. " +
  "When (and only when) you have a complete, actionable plan, call the `exit_plan` tool with the full plan " +
  "(concise markdown, short numbered steps), then stop and wait for the user's decision. " +
  "If the user is asking a question, or the plan isn't ready yet, just answer normally WITHOUT calling exit_plan.";
const MEMORY_DISTILL_SYSTEM =
  "You consolidate an agent's short-term daily memory logs into its durable long-term memory. You're given " +
  "the current durable memory and recent daily logs. Extract ONLY durable, reusable facts / decisions / " +
  "conventions / user preferences from the logs that are NOT already captured, and persist each with " +
  "memory_write (target=memory, or target=user for preferences; pick the right scope=project|global). " +
  "Skip the ephemeral, the one-off, and anything already known. Be terse and de-duplicated. Then reply DONE.";

async function curateSessionLearning(
  provider: Provider,
  history: NeutralMsg[],
  cfg: HaraConfig,
  options: {
    cwd: string;
    sandbox: SandboxMode;
    spawn?: ToolContext["spawn"];
    ui?: ToolContext["ui"];
    confirm: (question: string, signal?: AbortSignal) => Promise<boolean | "always">;
    memory: string;
    stats: { input: number; output: number; lastInput?: number };
    signal?: AbortSignal;
  },
): Promise<RunOutcome> {
  // Curation gets a private transcript branch: its DONE/tool chatter must not become task conversation or
  // create assistant→assistant role adjacency. Memory/skill writes remain the only durable side effects.
  const curationHistory: NeutralMsg[] = [
    ...history,
    { role: "user", content: "Run the evidence-gated self-evolution curation now. If nothing qualifies, write nothing." },
  ];
  return runAgent(curationHistory, {
    provider,
    ctx: { cwd: options.cwd, sandbox: options.sandbox, spawn: options.spawn, ui: options.ui },
    approval: cfg.assetCapture === "auto" ? "full-auto" : "suggest",
    confirm: options.confirm,
    toolFilter: (name) => allowsEvolutionTool(name, cfg.assetCapture),
    systemOverride: EVOLUTION_SYSTEM,
    memory: options.memory,
    stats: options.stats,
    signal: options.signal,
    ...agentRunLimits(cfg),
  });
}
// The bounded checkpoint contract + recent-turn preservation live in agent/compact.ts so CLI and serve
// cannot drift into different context semantics.

/** Summarize the conversation and replace history with the summary (keeping working-memory notes). Shared by
 *  /compact (manual) and auto-compaction. Returns the summary, or null on failure / nothing to do. */
async function compactConversation(provider: Provider, history: NeutralMsg[], meta: SessionMeta, stats: { input: number; output: number; lastInput?: number }, signal?: AbortSignal, task?: TaskExecution): Promise<string | null> {
  if (history.length < 2 || signal?.aborted) return null;
  const recent = recentHistoryForCompaction(history);
  const r = await boundedProviderTurn(provider, {
    system: COMPACT_SYSTEM,
    history: [...compactionSourceHistory(history), { role: "user", content: "Create the bounded execution checkpoint now." }],
    tools: [],
    onText: () => {},
  }, { timeoutMs: 60_000, label: "conversation compaction", signal });
  if (signal?.aborted || r.stop === "error") return null;
  const rawSummary = r.text.trim();
  if (!rawSummary) return null;
  const summary = normalizeCompactionSummary(rawSummary);
  const workingSet = workingSetFromSummary(summary);
  // TW5-style file restore: the summary alone loses the working set's ACTUAL content — re-attach the
  // most recently touched files (current on-disk state, byte-capped) so work continues without re-reads.
  const restore = buildFileRestore(recentTouched(5), (p) => {
    if (signal?.aborted) return null;
    try {
      return readModelContextFileSync(p, 32 * 1024);
    } catch {
      return null;
    }
  });
  // Cancellation during the file snapshot must leave the original conversation untouched.
  if (signal?.aborted) return null;
  meta.workingSet = workingSet; // survives the history wipe + injects into the next turns
  const compacted = compactedConversationHistory(summary, recent, restore);
  history.length = 0;
  history.push(...compacted);
  stats.input += r.usage?.input ?? 0;
  stats.output += r.usage?.output ?? 0;
  stats.lastInput = compactedHistoryTokenEstimate(compacted); // reflect replacement, not the large summarizer request
  saveSession(meta, history, task);
  return summary;
}

/** Auto-compact (à la Claude Code) when the last turn filled the context past the threshold, so the NEXT turn
 *  doesn't overflow. Opt-out via `autoCompact: false` / `HARA_AUTO_COMPACT=0`. Best-effort; `notify` surfaces
 *  a one-line status. Returns true if it compacted. */
async function maybeAutoCompact(provider: Provider, history: NeutralMsg[], meta: SessionMeta, stats: { input: number; output: number; lastInput?: number }, cfg: HaraConfig, notify: (m: string) => void, signal?: AbortSignal, task?: TaskExecution): Promise<boolean> {
  if (signal?.aborted) return false;
  const lastInput = stats.lastInput ?? 0;
  const pct = bar.ctxPctFor(cfg.model, lastInput);
  // Two triggers, whichever hits first: % of window (small-window models) OR an absolute token cap
  // (huge-window models, where 85% is an unreachable 850k). Cap is overridable via env.
  const cap = Number(process.env.HARA_AUTO_COMPACT_TOKENS) || AUTO_COMPACT_TOKEN_CAP;
  const overPct = shouldAutoCompact(pct, history.length, cfg.autoCompact);
  const overCap = shouldAutoCompactTokens(lastInput, history.length, cfg.autoCompact, cap);
  if (!overPct && !overCap) return false;
  if (signal?.aborted) return false;
  notify(`✻ Auto-compacting conversation (context ${pct}% full, ~${Math.round(lastInput / 1000)}k tok)…`);
  const summary = await compactConversation(provider, history, meta, stats, signal, task);
  if (signal?.aborted) return false;
  notify(summary ? `(auto-compacted — context replaced with a summary; ${meta.workingSet?.length ?? 0} notes kept)` : "(auto-compact failed — use /compact or /clear)");
  return !!summary;
}

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
  signal?: AbortSignal,
): Promise<string> {
  const roles = loadRoles(cwd);
  const roleRef = roleId?.trim();
  if (roleId !== undefined && !roleRef) return "Error: sub-agent role cannot be blank.";
  let role: Role | undefined;
  if (roleRef?.includes(":")) {
    const hit = resolveAgent(roleRef, cwd);
    if (hit && "ambiguous" in hit) {
      return `Error: sub-agent role '${roleRef}' is ambiguous; use one of: ${hit.ambiguous.map((entry) => `${entry.project}:${entry.name}`).join(", ")}.`;
    }
    if (hit?.project && resolve(hit.home) !== resolve(cwd)) {
      return `Error: sub-agent role '${roleRef}' belongs to ${hit.home}; nested read-only agents stay in their parent home (${cwd}).`;
    }
    if (hit && !("ambiguous" in hit)) {
      role = hit.project
        ? roles.find((candidate) => candidate.id === hit.name)
        : loadGlobalRoles().find((candidate) => candidate.id === hit.name);
    }
  } else if (roleRef) {
    role = roles.find((candidate) => candidate.id === roleRef);
  }
  // Built-in explore persona: `agent(role:"explore")` works with ZERO user setup (a user-defined
  // explore role still wins — it was found above and carries its own system).
  const builtinSystem = !role && roleRef === "explore" ? EXPLORE_SYSTEM : undefined;
  if (roleRef && !role && !builtinSystem) {
    return `Error: no sub-agent role '${roleRef}' is available in ${cwd}. Use a local role id, global:<name>, or role "explore".`;
  }
  const __subModel = effectiveRoleModel(role?.model, baseProvider.model);
  const provider = __subModel && __subModel !== baseProvider.model
    ? ((await buildProvider({ ...cfg, model: __subModel })) ?? baseProvider)
    : baseProvider;
  // A sub-agent runs full-auto + UNCONFIRMED + parallel, so it is ALWAYS read-only — a role may narrow
  // further but can never GRANT write/exec to a fan-out sub-agent (that would bypass the approval gate).
  // Write-capable roles run in the main loop via `hara org`, behind the user's gate.
  const toolFilter = subagentToolFilter(role, (n: string) => READONLY_TOOLS.has(n));
  const subHistory: NeutralMsg[] = [{ role: "user", content: task }];
  const todoScope = `subagent:${randomUUID()}`;
  let outcome: RunOutcome;
  try {
    outcome = await runAgent(subHistory, {
      provider,
      ctx: { cwd, sandbox, todoScope }, // isolated checklist; no spawn → no recursion
      approval: "full-auto", // read-only tools, so no prompts (can't prompt in parallel)
      confirm: async () => true,
      projectContext,
      memory: memoryDigest(cwd),
      stats,
      systemOverride: role?.system ?? builtinSystem,
      toolFilter,
      hooks: false,
      quiet: true,
      signal,
      timeoutMs: Math.min(cfg.runTimeoutMs, 8 * 60_000),
      maxRounds: Math.min(cfg.maxAgentRounds, 24),
    });
  } finally {
    disposeTodoScope(todoScope);
    disposeReminderScope(todoScope);
    resetRepeatGuard(todoScope);
    clearTouched(todoScope);
  }
  if (outcome.status !== "completed") {
    const reason = outcome.error?.trim()
      || (outcome.status === "empty"
        ? "the model returned an empty response"
        : outcome.stopReason
          ? `the run stopped (${outcome.stopReason})`
          : `the run ended with status ${outcome.status}`);
    return `Error: sub-agent ${reason}`;
  }
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
  const nodeSupported = unsupportedNodeMessage() === null;
  const hasKey = !!(cfg.apiKey || process.env[providerEnvKey(cfg.provider)] || process.env.HARA_API_KEY);
  const oauthOk = cfg.provider === "qwen-oauth" && loadQwenToken() !== null;
  const authed = hasKey || oauthOk;
  const ad = assetsDir();
  const roles = loadRoles(cfg.cwd);
  const vcap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
  const vdesc = vcap === "vision" ? c.dim("sees images (inline)") : vcap === "text" ? c.dim("text-only") : c.yellow("capability unknown — asks on first image");
  const lines = [
    c.bold("hara doctor"),
    `${ok(nodeSupported)} node ${process.versions.node} ${c.dim(`(need ≥${MIN_NODE_VERSION})`)}`,
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
    `${dot} run-limits ${c.bold(formatAgentDuration(cfg.runTimeoutMs))}${c.dim(" total · ")}${c.bold(String(cfg.maxAgentRounds))}${c.dim(" rounds · sub-agents ≤8m/24")}`,
    `${dot} notify ${cfg.notify === "off" ? c.dim("off — hara config set notify bell|system") : c.bold(cfg.notify)}`,
    `${dot} cron ${(() => { try { const n = loadJobs().length; return n ? `${n} job(s) · ${isInstalled() ? c.green("scheduler installed") : c.yellow("scheduler off — hara cron install")}` : c.dim("no jobs — hara cron add"); } catch { return c.red("job store invalid — run hara cron list"); } })()}`,
    `${dot} input ${cfg.vimMode ? c.bold("vim") + c.dim(" (modal)") : c.dim("default — hara config set vimMode true for vim keys")}`,
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
  .option("--schema <json|file>", "(with -p) force a schema-shaped result: the model must call structured_output; stdout = that JSON")
  .option("--role <id>", "(with -p) run as a local, global:name, or project:name role (qualified projects run at their registered home)")
  .option("-y, --yes", "auto-approve all tool actions (= --approval full-auto)")
  .option("-m, --model <model>", "model id (overrides config)")
  .option("--approval <mode>", "approval mode: suggest | auto-edit | full-auto")
  .option("--profile <id>", "use this identity profile for this run (personal / org id) — see `hara profile list`")
  .option("--overlay <name>", "apply a named config overlay from ~/.hara/config.json (legacy: --profile)")
  .option("--cwd <dir>", "run from this explicit project directory (alternative to cd)")
  .option("-c, --continue", "resume the most recent session in this directory")
  .option("--resume <id>", "resume a specific session by id")
  .option("--sandbox <mode>", "sandbox the shell: off | workspace-write | read-only");

// Wire the global `--profile <id>` flag into the resolution chain BEFORE any subcommand
// action runs. resolveActive() consults setFlagOverride() at the top of the priority chain,
// so this single hook covers `hara whoami`, `hara profile list`, `hara model …`, and the
// default REPL action — without each subcommand having to reach into program.opts() itself.
// Validation: unknown id is a hard fail (don't silently fall through to default; the user
// asked for a specific identity, surface the mistake).
program.hook("preAction", (thisCmd) => {
  const cwdFlag = thisCmd.opts().cwd as string | undefined;
  if (cwdFlag) {
    try {
      const target = realpathSync.native(resolve(cwdFlag));
      if (!statSync(target).isDirectory()) throw new Error("not a directory");
      process.chdir(target);
    } catch (error) {
      out(c.red(`Cannot use --cwd '${cwdFlag}': ${error instanceof Error ? error.message : String(error)}.\n`));
      process.exit(2);
    }
  }
  const flag = thisCmd.opts().profile as string | undefined;
  if (!flag) return;
  if (!getProfile(flag)) {
    out(c.red(`No identity profile '${flag}'.\n`) + c.dim("List: `hara profile list`\n"));
    process.exit(1);
  }
  setFlagOverride(flag);
});

program
  .command("init")
  .description("analyze the project and (re)generate AGENTS.md")
  .action(async () => {
    const cfg = loadConfig();
    if (isUnsafeProjectWorkspace(cfg.cwd)) {
      out(c.red(homeWorkspaceActionError("initialize AGENTS.md")) + "\n");
      process.exitCode = 2;
      return;
    }
    const provider = await buildProvider(cfg);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    out(c.dim("Analyzing project to generate AGENTS.md…\n"));
    await runInit(provider, cfg.cwd, cfg.sandbox, cfg);
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
      out(`${c.bold(shortId(m.id))}  ${c.dim(m.updatedAt.slice(0, 16).replace("T", " "))}  ${c.dim(m.provider + ":" + m.model)}  ${m.title || c.dim("(untitled)")}\n`);
    }
    out(c.dim("\nResume:  hara resume <id>\n"));
  });

program
  .command("resume [id]")
  .description("resume a session — no id resumes the most recent here (list ids with `hara sessions`)")
  .action(async (id?: string) => {
    let full: string | undefined;
    if (id) {
      full = resolveSessionId(id) ?? undefined;
      if (!full) {
        out(c.red(`No session matching '${id}'.`) + c.dim(" Run `hara sessions` to list.\n"));
        process.exit(1);
      }
    } else {
      const latest = latestForCwd(process.cwd());
      if (!latest) {
        out(c.dim("No sessions for this directory yet — `hara sessions` lists all.\n"));
        process.exit(0);
      }
      full = latest.meta.id;
    }
    out(c.dim(`↩ resuming ${shortId(full)}…\n`));
    // Reuse the existing --resume path exactly (one engine), inheriting this terminal. selfArgv() inside
    // runSelfAttached distinguishes node+entry from a Bun-compiled binary (whose argv[1] is a user arg).
    try {
      const result = await runSelfAttached(["--resume", full]);
      if (result.signal) {
        out(c.yellow(`Resumed Hara process stopped by ${result.signal}.\n`));
        process.exitCode = 1;
      } else if (result.code) {
        process.exitCode = result.code;
      }
    } catch (error) {
      out(c.red(`Could not start the resumed Hara process: ${error instanceof Error ? error.message : String(error)}\n`));
      process.exitCode = 1;
    }
  });

program
  .command("org <task...>")
  .description("dispatch a task to the owning role and run it (--review loops a reviewer until it approves)")
  .option("--role <id>", "force a specific role")
  .option("--review", "after implementing, loop a reviewer role until it approves (implement → review → fix)")
  .option("--rounds <n>", "max review rounds with --review (default 3)", (v) => parseInt(v, 10))
  .option("--commit", "commit the result with an AI message (with --review: only after approval; needs a clean start tree)")
  .action(async (
    taskParts: string[],
    _localOpts: { role?: string; review?: boolean; rounds?: number; commit?: boolean },
    command: Command,
  ) => {
    // The root headless command and `org` both expose --role. Commander stores that shared flag on the
    // parent command, while review/rounds/commit stay local; optsWithGlobals is the supported merged view.
    // Without it, flow-approved `hara org --role ...` children silently fell back to model dispatching.
    const opts2 = command.optsWithGlobals() as { role?: string; review?: boolean; rounds?: number; commit?: boolean };
    let cfg = loadConfig();
    // Home dispatch (globally addressable, executes at home): a --role of "project:name" — or a bare name
    // that only exists in a REGISTERED project — resolves via the global agent index and runs with cwd =
    // that project (its AGENTS.md/data context), instead of failing or running context-blind here.
    let orgCwd = cfg.cwd;
    let forceRole = opts2.role;
    if (opts2.role && (opts2.role.includes(":") || !loadRoles(cfg.cwd).some((r) => r.id === opts2.role))) {
      const hit = resolveAgent(opts2.role);
      if (hit && "ambiguous" in hit) {
        out(c.yellow(`'${opts2.role}' exists in several projects — qualify it:\n`) + hit.ambiguous.map((e) => `  ${e.project}:${e.name}`).join("\n") + "\n");
        process.exit(1);
      }
      if (hit?.home) {
        orgCwd = hit.home;
        forceRole = hit.name;
        cfg = loadConfig({ cwd: hit.home });
        out(c.dim(`(dispatching to ${hit.project}:${hit.name} · home ${hit.home})\n`));
      } else if (hit) {
        // Explicit `global:name` is an address, not the literal role id. Global roles intentionally run
        // in the caller's current project so they retain that project's AGENTS.md and tool context.
        forceRole = hit.name;
        out(c.dim(`(dispatching to global:${hit.name} · current home ${orgCwd})\n`));
      } else if (!hit) {
        out(c.red(`No agent '${opts2.role}' was found here or in the registered project index.\n`));
        process.exit(1);
      }
    }
    const provider = await buildProvider(cfg);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}' at ${orgCwd}.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    const stats = { input: 0, output: 0, lastInput: 0 };
    const outcome = await runOrg(taskParts.join(" "), {
      cfg,
      baseProvider: provider,
      cwd: orgCwd,
      sandbox: cfg.sandbox,
      approval: "full-auto",
      confirm: async () => true,
      projectContext: loadAgentContext(orgCwd) || undefined,
      stats,
      forceRole,
      review: opts2.review,
      rounds: opts2.rounds,
      commit: opts2.commit,
    });
    const failure = runFailureDetail(outcome);
    if (failure) {
      process.stderr.write(`hara: org run failed (${outcome.status}) — ${failure}\n`);
      process.exitCode = 2;
    }
    if (stats.input || stats.output) out(statusLine(cfg.model, stats.input, stats.output) + "\n");
  });

program
  .command("agents")
  .description("global agent index — every addressable agent (global roles + registered projects) and its home")
  .action(() => {
    const idx = buildAgentsIndex();
    if (!idx.length) {
      out(c.dim("(no agents — add roles to ~/.hara/roles, or register projects: hara projects add <name> <path>)\n"));
      return;
    }
    for (const e of idx) {
      out(c.bold(e.project ? `${e.project}:${e.name}` : `global:${e.name}`) + c.dim(e.home ? `  · ${e.home}` : "  · current project") + "\n");
      if (e.description) out(c.dim(`  ${e.description.slice(0, 120)}\n`));
    }
    out(c.dim(`\n${idx.length} agent(s). Run one: hara org --role <global:name|project:name> "<task>"\n`));
  });

const projectsCmd = program.command("projects").description("register project homes for the global agent index (see `hara agents`)");
projectsCmd.command("list").action(() => {
  const list = loadProjects();
  out(list.length ? list.map((p) => `${c.bold(p.name)}  ${c.dim(p.path)}`).join("\n") + "\n" : c.dim("(none — hara projects add <name> <path>)\n"));
});
projectsCmd.command("add <name> <path>").action((name: string, path: string) => {
  const err = addProject(name, resolve(path));
  out(err ? c.red(`${err}\n`) : c.green(`✓ registered ${name} → ${resolve(path)}\n`));
  if (err) process.exit(1);
});
projectsCmd.command("remove <name>").action((name: string) => {
  out(removeProject(name) ? c.green(`✓ removed ${name}\n`) : c.yellow(`no project '${name}'\n`));
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
      projectContext: loadAgentContext(cfg.cwd) || undefined,
      stats,
      parallel: opts.parallel,
    };
    const task = (taskParts ?? []).join(" ").trim();
    let outcome: RunOutcome | undefined;
    if (task === "resume") outcome = await runResume(o);
    else if (!task) out(c.dim('usage: hara plan "<task>"   (or: hara plan resume)\n'));
    else outcome = await runPlan(task, o);
    if (outcome) {
      const failure = runFailureDetail(outcome);
      if (failure) {
        process.stderr.write(`hara: plan run failed (${outcome.status}) — ${failure}\n`);
        process.exitCode = 2;
      }
    }
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
    const cwd = process.cwd();
    let doRepo = !!(opts.all || opts.repo || (!opts.assets && !opts.all));
    const doAssets = !!(opts.all || opts.assets);
    if (doRepo && isUnsafeProjectWorkspace(cwd)) {
      if (!doAssets) {
        out(c.red(homeWorkspaceActionError("build a repository index")) + "\n");
        process.exitCode = 2;
        return;
      }
      out(c.yellow(homeWorkspaceActionError("build the repository part of --all")) + c.dim(" Global assets/memory will still be indexed.\n"));
      doRepo = false;
    }
    const embed = getEmbedder(cfg);
    if (!embed) {
      out(c.yellow("Semantic search is off — search stays lexical (which still works).\n"));
      out(c.dim("Turn it on with an embedding provider, then re-run `hara index`:\n"));
      out(c.dim("  hara config set embedProvider ollama   # local & offline (needs Ollama + an embed model)\n"));
      out(c.dim("  hara config set embedProvider qwen     # DashScope text-embedding-v3 (uses your key)\n"));
      return;
    }
    const model = `${cfg.embedProvider}:${cfg.embedModel ?? "default"}`;
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
    const collectionOptions = {
      maxFiles: 50_000,
      maxDirectories: 100_000,
      maxEntries: 500_000,
      timeoutMs: 60_000,
      yieldEvery: 128,
    };
    const noteTruncation = (name: string, collection: ChunkCollectionResult): void => {
      if (collection.truncated) {
        out(c.yellow(`Index collection for ${name} stopped at its ${collection.reason?.replace("_", " ") ?? "safety limit"}; the partial index is not being published.\n`));
      }
    };
    if (doRepo) {
      const repo = await collectRepoChunksAsync(findProjectRoot(cwd), collectionOptions);
      noteTruncation("repo", repo);
      if (!repo.truncated) await build("repo", repo.chunks, "codebase_search");
    }
    if (doAssets) {
      const [assets, skills, memory] = await Promise.all([
        collectDirChunksAsync(assetsDir(), "code-assets", collectionOptions),
        collectDirChunksAsync(globalSkillsDir(), "skills", collectionOptions),
        collectDirChunksAsync(memoryDir("global", cwd), "memory", collectionOptions),
      ]);
      noteTruncation("assets", assets);
      noteTruncation("skills", skills);
      noteTruncation("memory", memory);
      if (!assets.truncated && !skills.truncated) {
        await build("assets", [...assets.chunks, ...skills.chunks], "recall");
      }
      if (!memory.truncated) await build("memory", memory.chunks, "memory_search");
    }
  });

program
  .command("doctor")
  .description("check your hara setup (provider / auth / model / node / assets / roles)")
  .action(() => out(runDoctor(loadConfig()) + "\n"));

program
  .command("setup")
  .description("interactive first-run setup — pick a provider, API key, and model")
  .action(runSetup);

// ────────────────────────────────────────────────────────────────────────────────
// Identity profiles — the single switch for "who am I as right now" (personal vs each
// org I belong to). Switching a profile flips provider, key/token, base URL, AND the
// default model the gateway / setup chose. See src/profile/profile.ts.
// ────────────────────────────────────────────────────────────────────────────────

function fmtProfile(p: Profile, mark = ""): string {
  const kindBadge = p.kind === "gateway" ? c.bold(c.cyan("ORG")) : c.bold(c.dim("PERSONAL"));
  const label = p.label ? `${c.bold(p.label)} ` : "";
  const model = effectiveModel(p) || c.dim("(unset)");
  const route = routingLabel(p);
  return `${mark} ${kindBadge}  ${label}${c.dim("[" + p.id + "]")}  ${c.dim("· model")} ${model}  ${c.dim("· →")} ${route}`;
}

/** Human-readable suffix for the active row: "(active · <where it came from>)".
 *  pin gets a relative file path; flag/env/default each get their own tag. */
function activeSuffix(r: ActiveResolution): string {
  switch (r.source) {
    case "flag":
      return c.dim("(active · ") + c.bold("--profile flag") + c.dim(")");
    case "env":
      return c.dim("(active · ") + c.bold("HARA_PROFILE env") + c.dim(")");
    case "pin": {
      const rel = r.pinFile ? relPath(r.pinFile) : ".hara-profile";
      return c.dim("(active · ") + c.bold("pinned by " + rel) + c.dim(")");
    }
    case "default":
      return c.dim("(active · ") + c.bold("global default") + c.dim(")");
    case "fallback":
      return c.dim("(active · fallback)");
  }
}

/** Render an absolute path relative to cwd. Same-dir paths get `./` for clarity
 *  ("pinned by ./.hara-profile" reads better than "pinned by .hara-profile" because
 *  the leading `.` of the filename is otherwise hard to spot). Parent-dir pins keep
 *  their relative form (`../../.hara-profile`) — still way more readable than absolute. */
function relPath(abs: string): string {
  try {
    const r = relative(process.cwd(), abs);
    if (!r) return ".";
    // r could be: ".hara-profile", "sub/.hara-profile", "../.hara-profile".
    // For the same-cwd hit we want `./.hara-profile` — start with "./" unless it already
    // navigates with ".." (which speaks for itself).
    if (r.startsWith("..")) return r;
    return "./" + r;
  } catch {
    return abs;
  }
}

/** Stable "▶ active" line — first thing printed at startup so the user always sees where requests
 *  are going. Tests look for this prefix; keep the format. */
export function activeProfileLine(p: Profile): string {
  const route = routingLabel(p);
  const model = effectiveModel(p) || "(unset)";
  return `▶ ${p.label || p.id} · ${model} · ${route}`;
}

/** Shared whoami body so the `profile current` alias reuses the same output exactly. */
function printWhoami(): void {
  const r = resolveActive();
  const p = loadActiveProfile();
  out(c.bold("active profile") + "  " + activeSuffix(r) + "\n" + fmtProfile(p, " ") + "\n");
  if (p.kind === "gateway") {
    out(c.dim(`  gateway:  ${p.gatewayUrl}\n`));
    if (p.deviceId) out(c.dim(`  device:   ${p.deviceId.length > 8 ? "…" + p.deviceId.slice(-8) : p.deviceId}\n`));
    if (p.availableModels?.length) out(c.dim(`  available: ${p.availableModels.join(", ")}\n`));
  } else {
    out(c.dim(`  provider: ${p.provider}\n`));
    if (p.baseURL) out(c.dim(`  baseURL:  ${p.baseURL}\n`));
    out(c.dim(`  key:      ${p.apiKey ? maskKey(p.apiKey) : "(env / unset)"}\n`));
  }
}

program
  .command("whoami")
  .description("show the active identity profile (label · model · routing target · source)")
  .action(printWhoami);

const profileCmd = program.command("profile").description("manage identity profiles (personal / org A / org B…)");

// `profile current` — nvm muscle-memory ("nvm current" → "hara profile current"). Same as `hara whoami`.
profileCmd
  .command("current")
  .description("alias of `hara whoami` — print the active identity profile (with source)")
  .action(printWhoami);

// ── `profile list` (alias `ls`) ────────────────────────────────────────────────
// Layout: profiles grouped by kind (PERSONAL above ORG), one line per profile, columns
// aligned across the whole table (so id/model/routing visually stack). Active row is
// prefixed with `→ *` (so you can read it at a glance even in copy-pasted output) and
// suffixed with the source tag. Footer is a 2-line hint pointing at the two switching
// gestures: `profile use <id>` (write the default), `profile pin <id>` (lock this dir).
function renderProfileList(): string {
  const r = resolveActive();
  const ps = listProfiles();
  const lines: string[] = [];
  // Group by kind so the "where am I in the world" stratification is visible.
  const groups: Array<{ kind: "byok" | "gateway"; title: string; rows: Profile[] }> = [
    { kind: "byok", title: "PERSONAL", rows: ps.filter((p) => p.kind === "byok") },
    { kind: "gateway", title: "ORG", rows: ps.filter((p) => p.kind === "gateway") },
  ];
  // Column widths from raw (un-styled) strings — styling never participates in padding.
  const idW = Math.max(2, ...ps.map((p) => p.id.length));
  const labelW = Math.max(0, ...ps.map((p) => (p.label || "").length));
  const modelW = Math.max(5, ...ps.map((p) => (effectiveModel(p) || "(unset)").length));
  for (const g of groups) {
    if (!g.rows.length) continue;
    if (lines.length) lines.push(""); // blank between groups
    lines.push(c.dim(g.title));
    for (const p of g.rows) {
      const isActive = p.id === r.id;
      const mark = isActive ? c.green("→ *") : "   ";
      const id = p.id.padEnd(idW, " ");
      const label = (p.label || "").padEnd(labelW, " ");
      const model = (effectiveModel(p) || "(unset)").padEnd(modelW, " ");
      const route = routingLabel(p);
      const tail = isActive ? "  " + activeSuffix(r) : "";
      const cols = `${mark}  ${c.dim("[")}${c.bold(id)}${c.dim("]")}  ${label}  ${c.dim("· model")} ${model}  ${c.dim("· →")} ${route}${tail}`;
      lines.push(cols);
    }
  }
  // Tail hint — nudge users toward the two everyday gestures.
  lines.push("");
  lines.push(c.dim("💡 use ") + "`hara profile use <id>`" + c.dim(" to switch · ") + "`hara profile pin <id>`" + c.dim(" to lock to this dir"));
  return lines.join("\n");
}

profileCmd
  .command("list")
  .alias("ls")
  .description("list all profiles (active marked with → *) — alias: `ls`")
  .action(() => {
    out(renderProfileList() + "\n");
  });

profileCmd
  .command("use <id>")
  .description("switch the active profile (echoes the diff: profile / model / routing)")
  .option("-y, --yes", "skip confirmation when switching INTO a gateway profile from BYOK")
  .action(async (id: string, opts: { yes?: boolean }) => {
    const before = loadActiveProfile();
    const target = getProfile(id);
    if (!target) {
      out(c.red(`No profile '${id}'.\n`) + c.dim("List: `hara profile list`\n"));
      process.exit(1);
    }
    // Safety: BYOK → gateway is the direction that changes where your traffic goes (from your own
    // key to a controlled gateway). Confirm unless -y. The reverse direction is allowed silently
    // but the diff is still echoed.
    if (before.kind === "byok" && target.kind === "gateway" && !opts.yes) {
      const ok = await askConfirm(`Switch to gateway profile '${id}' (${target.gatewayUrl})? Traffic will route through the org gateway.`);
      if (!ok) {
        out(c.dim("(unchanged)\n"));
        return;
      }
    }
    const r = useProfile(id);
    if (!r.ok) {
      out(c.red(r.reason + "\n"));
      process.exit(1);
    }
    const after = r.profile;
    const modelBefore = effectiveModel(before) || "(unset)";
    const modelAfter = effectiveModel(after) || "(unset)";
    const routeBefore = routingLabel(before);
    const routeAfter = routingLabel(after);
    out(c.green("✓ switched\n"));
    out(`  profile:  ${c.dim(before.id)} ${c.dim("→")} ${c.bold(after.id)}\n`);
    out(`  model:    ${c.dim(modelBefore)} ${c.dim("→")} ${c.bold(modelAfter)}\n`);
    out(`  routing:  ${c.dim(routeBefore)} ${c.dim("→")} ${c.bold(routeAfter)}\n`);
  });

profileCmd
  .command("add <id>")
  .description("add a new identity profile (gateway = `hara enroll`; byok = your own key)")
  .option("--gateway <url>", "(gateway) join this hara-control gateway")
  .option("--code <code>", "(gateway) enrollment code from your admin")
  .option("--label <label>", "human-friendly label for the profile")
  .option("--byok", "(byok) BYOK profile — bring your own provider key")
  .option("--provider <id>", "(byok) anthropic | openai | glm | deepseek | openrouter | qwen | qwen-oauth")
  .option("--key <key>", "(byok) API key (else read from the provider's env var at use-time)")
  .option("--base-url <url>", "(byok) override the provider base URL (OpenAI-compatible endpoints)")
  .option("--model <model>", "(byok) default model for this profile")
  .action(async (id: string, opts: { gateway?: string; code?: string; label?: string; byok?: boolean; provider?: string; key?: string; baseUrl?: string; model?: string }) => {
    if (opts.gateway) {
      if (!opts.code) return void out(c.red("gateway profile add needs --code <code> from your hara-control admin\n"));
      try {
        const e = await enrollDevice(opts.gateway, opts.code);
        const p: Profile = {
          id,
          kind: "gateway",
          label: opts.label || id,
          gatewayUrl: e.gatewayUrl,
          deviceId: e.deviceId,
          deviceToken: e.deviceToken,
          baseURL: e.baseURL,
          defaultModel: e.model || "",
          availableModels: e.model ? [e.model] : [],
          enrolledAt: e.enrolledAt,
        };
        upsertProfile(p); // upsert: re-enrolling the same id rotates the token
        const r = useProfile(id);
        if (r.ok) {
          out(c.green(`✓ enrolled and switched to '${id}' (${e.gatewayUrl})`) + c.dim(` · model ${p.defaultModel || "(gateway default)"}\n`));
          const nRoles = await syncOrgRoles();
          if (nRoles > 0) out(c.dim(`  ↳ synced ${nRoles} org role${nRoles === 1 ? "" : "s"} → ~/.hara/org-roles/\n`));
        }
      } catch (err) {
        out(c.red(`Enroll failed: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exit(1);
      }
      return;
    }
    if (opts.byok || opts.provider) {
      const provider = (opts.provider || "anthropic") as ProviderId;
      if (provider === "hara-gateway") return void out(c.red("`--provider hara-gateway` is retired — use --gateway <url> --code <code> instead.\n"));
      const p: Profile = {
        id,
        kind: "byok",
        label: opts.label || id,
        provider,
        apiKey: opts.key,
        baseURL: opts.baseUrl,
        defaultModel: opts.model,
      };
      const r = addProfile(p);
      if (!r.ok) {
        out(c.red(r.reason + "\n"));
        process.exit(1);
      }
      out(c.green(`✓ added BYOK profile '${id}'`) + c.dim(` · provider ${provider}${opts.model ? " · model " + opts.model : ""}\n`));
      out(c.dim(`Switch to it with \`hara profile use ${id}\`.\n`));
      return;
    }
    out(c.red("usage:\n") + c.dim("  hara profile add <id> --gateway <url> --code <code> [--label …]\n") + c.dim("  hara profile add <id> --byok --provider anthropic|openai|glm|deepseek|openrouter|qwen|qwen-oauth [--key … --base-url … --model …]\n"));
    process.exit(1);
  });

profileCmd
  .command("remove <id>")
  .alias("rm")
  .alias("uninstall")
  .description("remove a profile (active falls back to personal) — aliases: `rm`, `uninstall`")
  .action((id: string) => {
    // Capture the profile before removal so we can mention the gateway host in the token-hint
    // line (5 below). After removeProfile, getProfile(id) is gone.
    const before = getProfile(id);
    const r = removeProfile(id);
    if (!r.ok) {
      out(c.red(r.reason + "\n"));
      process.exit(1);
    }
    if (r.activeChanged) {
      // Single line that reads naturally: "removed 'X' · active → personal".
      out(c.green(`✓ removed '${id}'`) + c.dim(` · active → ${PERSONAL_ID}\n`));
    } else {
      out(c.green(`✓ removed '${id}'\n`));
    }
    // For gateway profiles: we deliberately do NOT phone the control plane to revoke the device
    // token (that's a privileged operation that needs admin auth + we don't want a stale CLI
    // calling production). Print a one-line hint so the user knows the *server-side* identity
    // outlives this local removal — and who to ask if they want it gone there too.
    if (r.removedKind === "gateway") {
      const host = (() => {
        try {
          return before?.gatewayUrl ? new URL(before.gatewayUrl).host : (before?.gatewayUrl || "the gateway");
        } catch {
          return before?.gatewayUrl || "the gateway";
        }
      })();
      out(c.dim(`💡 token left registered at ${host}; ask your admin to revoke if needed\n`));
    }
  });

// ── `.hara-profile` project pin (like .nvmrc but personal — keep it out of repos) ─────
profileCmd
  .command("pin [id]")
  .description("write `.hara-profile` in this dir to lock the active profile here (omit id = pin current active)")
  .action(async (id?: string) => {
    const target = (id && id.trim()) || activeId();
    if (!getProfile(target)) {
      out(c.red(`No profile '${target}'.\n`) + c.dim("List: `hara profile list`\n"));
      process.exit(1);
    }
    try {
      const { file } = await writePin(process.cwd(), target);
      out(c.green(`✓ pinned ${target} to ${relPath(file)}\n`));
      // .hara-profile carries personal identity (which org you're as), unlike .nvmrc which
      // is project-level. Nudge user toward GLOBAL gitignore so they don't accidentally
      // commit it. We intentionally do NOT modify .gitignore — that's user space.
      out(c.dim("💡 .hara-profile is personal identity — add it to your global gitignore (unlike .nvmrc, don't commit it)\n"));
    } catch (err) {
      out(c.red(`pin failed: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exit(1);
    }
  });

profileCmd
  .command("unpin")
  .description("remove `.hara-profile` from this dir")
  .action(() => {
    const file = pinFilePath(process.cwd());
    const ok = removePin(process.cwd());
    if (ok) out(c.green(`✓ unpinned`) + c.dim(` · removed ${relPath(file)}\n`));
    else out(c.dim(`(no ${relPath(file)} here — nothing to unpin)\n`));
  });

// ── per-profile model switching ──────────────────────────────────────────────────
const modelCmd = program.command("model").description("manage the model on the active profile");
modelCmd
  .command("list")
  .description("list models for the active profile (gateway profiles list what the control plane advertised)")
  .action(() => {
    const p = loadActiveProfile();
    const cur = effectiveModel(p);
    if (p.kind === "gateway") {
      const list = p.availableModels?.length ? p.availableModels : (p.defaultModel ? [p.defaultModel] : []);
      if (!list.length) {
        out(c.dim("(gateway didn't advertise any models — use the gateway default; `hara model use <id>` to override locally)\n"));
        return;
      }
      for (const m of list) out(`${m === cur ? c.green("*") : " "} ${m}\n`);
    } else {
      // BYOK has no constrained list — show the current effective + suggestion.
      out(`${c.green("*")} ${cur || c.dim("(unset)")}\n`);
      out(c.dim("(BYOK profiles accept any model id the provider supports — `hara model use <id>` to switch)\n"));
    }
  });
modelCmd
  .command("use <model>")
  .description("override the model on the active profile (validated against availableModels on gateway profiles)")
  .action((model: string) => {
    const id = activeId();
    const r = setProfileModel(id, model);
    if (!r.ok) {
      out(c.red(r.reason + "\n"));
      process.exit(1);
    }
    out(c.green(`✓ model → ${model}`) + c.dim(` (profile ${id})\n`));
  });
modelCmd
  .command("reset")
  .description("clear the per-profile model override → fall back to defaultModel")
  .action(() => {
    const id = activeId();
    const r = resetProfileModel(id);
    if (!r.ok) {
      out(c.red(r.reason + "\n"));
      process.exit(1);
    }
    const p = loadActiveProfile();
    out(c.green(`✓ reset`) + c.dim(` · effective model → ${effectiveModel(p) || "(unset)"}\n`));
  });

// ── `hara enroll` — kept as a convenience alias mapping to the default-org gateway profile.
program
  .command("enroll [gateway-url]")
  .description("alias of `hara profile add default-org --gateway <url> --code <code>` (B-end: join a fleet)")
  .option("--code <code>", "enrollment code from your hara-control admin")
  .option("--status", "alias of `hara whoami`")
  .option("--clear", "switch active profile back to personal (does NOT delete the gateway profile)")
  .action(async (gatewayUrl: string | undefined, opts: { code?: string; status?: boolean; clear?: boolean }) => {
    if (opts.status) {
      const p = loadActiveProfile();
      return void out(p.kind === "gateway" ? c.green("enrolled") + c.dim(` · ${p.gatewayUrl} · device ${p.deviceId || "?"} · model ${effectiveModel(p) || "(gateway default)"} · since ${p.enrolledAt || "?"}\n`) : c.dim("Not enrolled — `hara enroll <gateway-url> --code <code>`.\n"));
    }
    if (opts.clear) {
      // Behavior change: don't *delete* the gateway profile (keeps the token around for re-use);
      // just switch active back to personal. Legacy clearEnrollment() also called to remove any
      // stray org.json file from pre-migration installs.
      clearEnrollment();
      const r = useProfile(PERSONAL_ID);
      return void out(r.ok ? c.green("✓ active → personal") + c.dim(" — gateway profile preserved (remove with `hara profile remove default-org`)\n") : c.dim("(no change)\n"));
    }
    if (!gatewayUrl) return void out(c.red("usage: hara enroll <gateway-url> --code <code>   (or --status / --clear)\n"));
    if (!opts.code) return void out(c.red("Need --code <code> — ask your hara-control admin to issue an enrollment code.\n"));
    try {
      const e = await enrollDevice(gatewayUrl, opts.code);
      const p: Profile = {
        id: DEFAULT_ORG_ID,
        kind: "gateway",
        label: "Default Org",
        gatewayUrl: e.gatewayUrl,
        deviceId: e.deviceId,
        deviceToken: e.deviceToken,
        baseURL: e.baseURL,
        defaultModel: e.model || "",
        availableModels: e.model ? [e.model] : [],
        enrolledAt: e.enrolledAt,
      };
      upsertProfile(p);
      useProfile(DEFAULT_ORG_ID);
      out(c.green(`✓ enrolled with ${e.gatewayUrl}`) + c.dim(` · device ${e.deviceId || "?"} · model ${e.model || "(gateway default)"} · profile ${DEFAULT_ORG_ID}\n`) + c.dim("hara routes through the gateway now — the real provider key stays server-side.\n"));
      const nRoles = await syncOrgRoles();
      if (nRoles > 0) out(c.dim(`  ↳ synced ${nRoles} org role${nRoles === 1 ? "" : "s"} → ~/.hara/org-roles/\n`));
    } catch (err) {
      out(c.red(`Enroll failed: ${err instanceof Error ? err.message : String(err)}\n`));
    }
  });

program
  .command("permissions")
  .description("show or scaffold command permission rules (bash allow/ask/deny + read-only autorun)")
  .option("--init", "write a starter permissions.json")
  .option("--project", "with --init, write it in this project (.hara/permissions.json) instead of globally")
  .action((opts: { init?: boolean; project?: boolean }) => {
    if (opts.init) {
      const p = scaffoldPermissions(process.cwd(), opts.project ? "project" : "global");
      return void out(p ? c.green(`✓ wrote ${p}\n`) : c.dim("(permissions file already exists — edit it directly)\n"));
    }
    const r = loadPermissionRules(process.cwd());
    const pp = projectPermissionsPath(process.cwd());
    out(
      c.bold("Command permissions") +
        c.dim(" (bash) — deny blocks even in full-auto; allow / read-only auto-runs even in suggest\n") +
        `  ${c.dim("global: ")} ${globalPermissionsPath()}\n` +
        `  ${c.dim("project:")} ${pp ?? "(none)"}\n` +
        `  ${c.dim("read-only autorun:")} ${r.readonlyAutorun ? c.green("on") : "off"}\n` +
        `  ${c.green("allow")}: ${r.allow.length ? r.allow.join(", ") : c.dim("(none)")}\n` +
        `  ${c.red("deny")} : ${r.deny.length ? r.deny.join(", ") : c.dim("(none)")}\n` +
        c.dim("  edit the JSON to customize, or `hara permissions --init` for a starter.\n"),
    );
  });

program
  .command("gateway")
  .description("run a supported chat gateway so you can drive your local hara from your phone — opt-in daemon")
  .option("--platform <name>", "chat platform: telegram | weixin | discord | feishu | slack | mattermost | matrix | dingtalk | wecom | signal", "telegram")
  .option("--login", "(weixin) scan a QR to log in and save credentials, then exit")
  .option("--recover-outcome <message-id>", "recover exactly one interrupted/terminal run marker by its original platform message id")
  .option("--confirm-recovery <action:message-id>", "required exact confirmation: terminalize:<id> or delete-terminal:<id>")
  .option("--cwd <dir>", "directory hara operates in per message (default: ~/.hara/workspace)")
  .action(async (opts) => {
    const mod = await import("./gateway/serve.js");
    if (opts.recoverOutcome !== undefined || opts.confirmRecovery !== undefined) {
      if (typeof opts.recoverOutcome !== "string" || typeof opts.confirmRecovery !== "string") {
        throw new Error("gateway outcome recovery requires both --recover-outcome <message-id> and --confirm-recovery <action:message-id>");
      }
      const result = await mod.recoverGatewayRunOutcome({
        platform: opts.platform,
        messageId: opts.recoverOutcome,
        confirmation: opts.confirmRecovery,
      });
      if (result === "missing") out(c.yellow("No outcome marker exists for that message id and gateway credential.\n"));
      else if (result === "terminalized") {
        out(c.green("✓ interrupted marker converted to terminal; one active slot is free and coding remains blocked from rerun.\n"));
      } else if (result === "already-terminal") {
        out(c.yellow("Marker is already terminal. Delete it only after platform redelivery is impossible, using delete-terminal:<same-message-id>.\n"));
      } else {
        out(c.yellow("✓ terminal marker removed. This message id is no longer protected if the platform redelivers it later.\n"));
      }
      return;
    }
    if (opts.platform === "weixin" && opts.login) {
      await mod.weixinLogin();
      return;
    }
    const cwd = opts.cwd ? (await import("node:path")).resolve(opts.cwd) : undefined; // undefined → ~/.hara/workspace
    await mod.runGateway({ cwd, platform: opts.platform });
  });

program
  .command("serve")
  .description("run the local hara server (WebSocket JSON-RPC) that desktop shells / IDE clients drive — persistent sessions, streaming events, approval round-trips")
  .option("--host <host>", "bind address — keep it loopback unless you know what you're doing", "127.0.0.1")
  .option("--port <n>", "port to listen on", "8790")
  .option("--token <token>", "auth token (default: generated; written to ~/.hara/serve.json for clients to discover)")
  .option("--cwd <dir>", "default working directory for new sessions (default: current directory)")
  .option("--approval <mode>", "default approval mode for sessions: suggest | auto-edit | full-auto", "auto-edit")
  .action(async (o) => {
    const cfg = loadConfig();
    const provider0 = await withRouting(await buildProvider(cfg), cfg);
    if (!provider0) {
      out(c.red(`Not authenticated for '${cfg.provider}' — run \`hara setup\` first.\n`));
      process.exit(1);
    }
    const guardianOpt = await buildGuardian(cfg, provider0);
    const cwd = o.cwd ? (await import("node:path")).resolve(o.cwd) : process.cwd();
    const sandbox = (process.env.HARA_SANDBOX ?? cfg.sandbox ?? "off") as SandboxMode;
    const approval = (APPROVAL_MODES as readonly string[]).includes(o.approval) ? (o.approval as ApprovalMode) : "auto-edit";
    const { startServe } = await import("./serve/server.js");
    const handle = await startServe(
      { host: o.host, port: Number(o.port) || 8790, token: o.token, cwd },
      {
        version: pkg.version,
        providerId: cfg.provider,
        model: cfg.model,
        // `hara serve` is persistent, but config.json is user-editable at any time. Re-read it for every
        // new/resumed session and model operation so a repaired/rotated key takes effect without restarting
        // the desktop server (and, critically, never ask for a key that is already on disk).
        buildSessionProvider: async (targetCwd) => {
          const live = loadConfig({ cwd: targetCwd ?? cwd });
          return withRouting(await buildProvider(live), live);
        },
        buildProviderFor: async (model, effort, targetCwd) => {
          const live = loadConfig({ cwd: targetCwd ?? cwd });
          return withRouting(
            await buildProvider({ ...live, model, reasoningEffort: (effort as HaraConfig["reasoningEffort"]) ?? live.reasoningEffort }),
            live,
          );
        },
        listModels: (targetCwd) => {
          const live = loadConfig({ cwd: targetCwd ?? cwd });
          return listModels(live.baseURL ?? providerDefaultBaseURL(live.provider), live.apiKey ?? "");
        },
        effortLevels: levelsFor(resolvePlatform(cfg.provider, cfg.baseURL ?? providerDefaultBaseURL(cfg.provider)).reasoning).filter((e): e is NonNullable<typeof e> => !!e),
        runtimeInfo: (targetCwd) => {
          const live = loadConfig({ cwd: targetCwd ?? cwd });
          return {
            providerId: live.provider,
            model: live.model,
            effortLevels: levelsFor(resolvePlatform(live.provider, live.baseURL ?? providerDefaultBaseURL(live.provider)).reasoning).filter((e): e is NonNullable<typeof e> => !!e),
          };
        },
        runLimits: (targetCwd) => agentRunLimits(loadConfig({ cwd: targetCwd ?? cwd })),
        spawnSubagent: (provider, scwd, projectContext, stats, task, role, signal) => {
          const live = loadConfig({ cwd: scwd });
          return runSubagent(live, provider, scwd, sandbox, projectContext, stats, task, role, signal);
        },
        guardian: guardianOpt,
        buildGuardian: async (targetCwd) => {
          const live = loadConfig({ cwd: targetCwd ?? cwd });
          const base = await withRouting(await buildProvider(live), live);
          return buildGuardian(live, base);
        },
        sandbox,
        approval,
      },
    );
    out(c.bold("hara serve") + c.dim(`  ·  ws://${o.host}:${handle.port}  ·  ${cfg.provider}:${cfg.model}  ·  approval ${approval}  ·  token → ~/.hara/serve.json\n`));
    const bye = async (): Promise<void> => {
      await handle.close();
      process.exit(0);
    };
    process.on("SIGINT", bye);
    process.on("SIGTERM", bye);
  });

program
  .command("remote [action] [text]")
  .description("drive THIS tmux session from chat: register the pane so WeChat replies inject back into it. actions: ask \"<q>\" | bind | back | status")
  .action(async (action = "status", text?: string) => {
    const { registerTmuxRoute, unbindPane, listRoutes } = await import("./gateway/tmux-routes.js");
    const pane = process.env.TMUX_PANE; // set by tmux inside every pane
    const needPane = (): void => {
      if (!pane) {
        out(c.red("`hara remote` must run inside tmux ($TMUX_PANE unset) — it injects chat replies into a tmux pane.\n"));
        process.exit(2);
      }
    };
    if (action === "status") {
      const rs = listRoutes();
      out(rs.length ? rs.map((r) => `${r.pane}  [${r.mode ?? "once"}]  ${r.cwd ?? ""}`).join("\n") + "\n" : "(no panes registered)\n");
      return;
    }
    if (action === "unbind" || action === "back") {
      needPane();
      out(unbindPane(pane!) ? `✓ ${action === "back" ? "back from remote — unbound" : "unbound"} ${pane}\n` : `${pane} was not registered\n`);
      return;
    }
    if (action === "bind") {
      needPane();
      registerTmuxRoute(pane!, undefined, process.cwd(), "bind");
      out(c.green(`🔗 bound ${pane}`) + ` — every WeChat reply now injects here until \`hara remote unbind\` (or send /detach in chat). Daemon must be running.\n`);
      return;
    }
    if (action === "ask") {
      needPane();
      if (!text) return void out(c.red('usage: hara remote ask "<question>"\n'));
      registerTmuxRoute(pane!, undefined, process.cwd(), "once"); // register first — inbound inject works even if the push is throttled
      try {
        const wx = await import("./gateway/weixin.js");
        const creds = wx.loadWeixinCreds();
        if (!creds) return void out(c.yellow(`↩ ${pane} registered, but no WeChat login (run \`hara gateway --platform weixin --login\`). Your next reply to the bot still injects here.\n`));
        let peer = process.env.HARA_WX_PEER;
        if (!peer) {
          const peers = wx.weixinKnownPeers(creds.account_id);
          peer = peers.find((candidate) => candidate.endsWith("@im.wechat")) || peers[0];
        }
        if (peer) await wx.weixinAdapter(creds).send(peer, text);
        out(c.green(`↩ asked on WeChat + registered ${pane}`) + ` — reply on WeChat and it'll be injected here. Daemon must be running.\n`);
      } catch (e: any) {
        out(c.yellow(`↩ ${pane} registered; WeChat push failed (${e.message}) — your next reply to the bot still injects here.\n`));
      }
      return;
    }
    out(c.red(`unknown action '${action}'. use: ask "<q>" | bind | back | status\n`));
  });

program
  .command("export [session]")
  .description("export a session to a Markdown transcript (default: the latest in this directory)")
  .option("--out <file>", "write to a file instead of stdout")
  .action((sessionArg: string | undefined, opts: { out?: string }) => {
    const data = sessionArg ? (() => { const id = resolveSessionId(sessionArg); return id ? loadSession(id) : null; })() : latestForCwd(process.cwd());
    if (!data) return void out(c.red(sessionArg ? `No session matching '${sessionArg}'.\n` : "No session for this directory — pass an id (see `hara sessions`).\n"));
    const md = renderSessionMarkdown(data);
    if (opts.out) {
      writeFileSync(opts.out, md, "utf8");
      out(c.green(`✓ wrote ${opts.out}`) + c.dim(` (${md.length} chars)\n`));
    } else {
      out(md);
    }
  });

program
  .command("completions <shell>")
  .description("print a shell completion script: bash | zsh | fish (eval it in your shell rc)")
  .action((shell: string) => {
    const top = program.commands.map((cmd) => cmd.name()).filter((n) => n && n !== "completions").sort();
    const subs: Record<string, string[]> = {};
    for (const cmd of program.commands) {
      const sub = cmd.commands.map((s) => s.name()).filter(Boolean);
      if (sub.length) subs[cmd.name()] = sub;
    }
    const script = completionScript(shell, { top, subs });
    if (!script) return void out(c.red(`Unsupported shell '${shell}'. Use: bash | zsh | fish\n`));
    out(script);
  });

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
  .description("review your uncommitted changes for bugs, security, and missing tests")
  .option("--staged", "review only staged changes")
  .option("--base <ref>", "review against a base ref (e.g. main) instead of just the working tree")
  .action(async (opts: { staged?: boolean; base?: string }) => {
    const cfg = loadConfig();
    const provider = await buildProvider(cfg);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    const changes = captureChanges(cfg.cwd, 120_000, {
      staged: opts.staged,
      base: opts.base,
      includeUntracked: !opts.staged && !opts.base,
    });
    if (changes.error) return void out(c.red(`Git change capture failed closed: ${changes.error}\n`) + c.dim("(is this a git repo / valid base ref?)\n"));
    if (!changes.diff && !changes.newFiles.length && !changes.skippedFiles.length && !changes.omittedDeletions.length) {
      return void out(c.dim("No changes to review.\n"));
    }
    if (changes.skippedFiles.length) {
      out(c.yellow(`Protected paths omitted: ${changes.skippedFiles.map((p) => JSON.stringify(p)).join(", ")}\n`));
    }
    out(c.dim(`Reviewing ${changes.diff ? changes.diff.split("\n").length : 0} safe change entries…\n\n`));
    const stats = { input: 0, output: 0, lastInput: 0 };
    await runAgent([{ role: "user", content: standaloneReviewPrompt(changes) }], {
      provider,
      ctx: { cwd: cfg.cwd, sandbox: cfg.sandbox },
      approval: "full-auto",
      confirm: async () => true,
      systemOverride: REVIEW_SYSTEM,
      toolFilter: (n) => READONLY_TOOLS.has(n), // read-only: the reviewer can inspect, never edit
      hooks: false,
      projectContext: loadAgentContext(cfg.cwd) || undefined,
      memory: memoryDigest(cfg.cwd),
      stats,
      ...agentRunLimits(cfg),
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
      const protectedTracked = protectedTrackedWorkingTreePaths(cfg.cwd);
      if (protectedTracked.length) {
        return void out(c.red(`Refusing to stage protected path(s): ${protectedTracked.map((p) => JSON.stringify(p)).join(", ")}\n`));
      }
      try {
        await runShell("git add -u", cfg.cwd, "off", { timeout: 30_000, maxBuffer: 1_000_000 });
      } catch {
        /* report below if nothing is staged */
      }
    }
    const protectedStaged = protectedStagedPaths(cfg.cwd);
    if (protectedStaged.length) {
      return void out(c.red(`Refusing to inspect or commit protected staged path(s): ${protectedStaged.map((p) => JSON.stringify(p)).join(", ")}\n`));
    }
    const staged = captureChanges(cfg.cwd, 120_000, { staged: true, includeUntracked: false });
    if (staged.error) return void out(c.red(`git diff failed closed: ${staged.error}\n`) + c.dim("(is this a git repo?)\n"));
    if (staged.skippedFiles.length) {
      return void out(c.red(`Refusing to inspect or commit protected staged path(s): ${staged.skippedFiles.map((p) => JSON.stringify(p)).join(", ")}\n`));
    }
    const changeInput = commitMessageInput(staged);
    if (!changeInput.trim()) return void out(c.dim("Nothing staged. Stage changes with `git add`, or use `hara commit -a`.\n"));
    out(c.dim("Writing a commit message…\n"));
    const r = await boundedProviderTurn(provider, {
      system: COMMIT_SYSTEM,
      history: [{ role: "user", content: `Write a commit message for these staged changes:\n\n${changeInput.slice(0, 120_000)}` }],
      tools: [],
      onText: () => {},
    }, { timeoutMs: 30_000, label: "commit message generation" });
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
      const protectedBeforeCommit = protectedStagedPaths(cfg.cwd);
      if (protectedBeforeCommit.length) {
        return void out(c.red(`Staged paths changed; refusing to commit protected path(s): ${protectedBeforeCommit.map((p) => JSON.stringify(p)).join(", ")}\n`));
      }
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

function renderCronJobs(): string {
  const head = isInstalled() ? c.green("scheduler: installed") : c.yellow("scheduler: NOT installed — run `hara cron install`");
  let jobs: CronJob[];
  try {
    jobs = loadJobs();
  } catch (error) {
    return head + "\n" + c.red(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (!jobs.length) return head + "\n" + c.dim('No jobs. Add one:  hara cron add "every 1h" "<task>"\n');
  const now = Date.now();
  const lines = jobs.map((j) => {
    const nxt = nextRun(j, now);
    const nextLabel = nxt !== null && nxt <= now ? "due now" : nxt !== null ? new Date(nxt).toLocaleString() : "—";
    const elapsed = j.lastDurationMs === undefined ? "" : ` after ${formatAgentDuration(j.lastDurationMs)}`;
    const status = j.lastStatus === "running"
      ? c.yellow(`running since ${new Date(j.runningSince ?? j.lastRunAt ?? now).toLocaleString()}`)
      : j.lastStatus === "timed_out"
        ? c.red(`timed out${elapsed}`)
        : j.lastStatus === "ok"
          ? c.green(`ok${elapsed}`)
          : j.lastStatus === "error"
            ? c.red(`err${elapsed}`)
            : c.dim("—");
    return `${c.bold(j.id)} ${describeSchedule(j.schedule)} ${c.dim(`· ${j.mode} · next ${nextLabel} · last ${status}`)}${j.enabled ? "" : c.dim(" [disabled]")}\n   ${c.dim(j.name)}`;
  });
  return head + "\n" + lines.join("\n") + "\n";
}

const cronCmd = program.command("cron").description("scheduled tasks — run a prompt/org task on a schedule (fired by your OS via `hara cron install`)");
cronCmd
  .command("add <schedule> <task...>")
  .description('schedule a task — schedule = cron expr ("0 9 * * *"), "every 30m", "in 2h", or an ISO timestamp')
  .option("--name <name>", "a label for the job")
  .option("--org", "run via `hara org` (role routing + review) instead of a plain `hara -p` prompt")
  .option("--command", "run the task as a plain SHELL COMMAND — deterministic, no agent, no tokens")
  .option("--tz <zone>", 'IANA timezone for cron exprs (e.g. "Asia/Shanghai"); default = local time')
  .option("--deliver <spec>", "push each run's result: telegram:<chatId> | feishu:<chatId> | webhook:<url>")
  .option("--alert-after <n>", "send a 🚨 after N consecutive failures (1..1000; default 3)")
  .action((schedule: string, taskParts: string[], opts: { name?: string; org?: boolean; command?: boolean; tz?: string; deliver?: string; alertAfter?: string }) => {
    const task = taskParts.join(" ");
    if (opts.org && opts.command) return void out(c.red("--org and --command are mutually exclusive\n"));
    const sched = parseSchedule(schedule, Date.now());
    if ("error" in sched) return void out(c.red(sched.error + "\n"));
    if (opts.tz && !validTz(opts.tz)) return void out(c.red(`invalid timezone "${opts.tz}" (IANA name, e.g. Asia/Shanghai)\n`));
    if (opts.tz && sched.kind !== "cron") return void out(c.red("--tz only applies to cron expressions\n"));
    if (opts.deliver) {
      const d = parseDeliver(opts.deliver);
      if ("error" in d) return void out(c.red(d.error + "\n"));
    }
    const alertAfter = opts.alertAfter === undefined ? undefined : Number(opts.alertAfter);
    if (alertAfter !== undefined && (!Number.isInteger(alertAfter) || alertAfter < 1 || alertAfter > 1_000)) {
      return void out(c.red("--alert-after must be an integer from 1 to 1000\n"));
    }
    const mode = opts.command ? ("command" as const) : opts.org ? ("org" as const) : ("print" as const);
    let job: CronJob;
    try {
      job = addJob({
        name: opts.name || task.slice(0, 48),
        schedule: sched,
        task,
        mode,
        cwd: process.cwd(),
        ...(opts.tz ? { tz: opts.tz } : {}),
        ...(opts.deliver ? { deliver: opts.deliver } : {}),
        ...(alertAfter !== undefined ? { alertAfter } : {}),
        createdAt: Date.now(),
      });
    } catch (error) {
      return void out(c.red(`${error instanceof Error ? error.message : String(error)}\n`));
    }
    out(c.green(`✓ scheduled ${job.id}`) + c.dim(` · ${describeSchedule(sched)}${opts.tz ? ` @ ${opts.tz}` : ""} · ${job.mode}${opts.deliver ? ` · → ${opts.deliver}` : ""}${alertAfter !== undefined ? ` · alert ≥${alertAfter}` : ""} · cwd ${job.cwd}\n`));
    if (!isInstalled()) out(c.yellow("⚠ scheduler not installed yet — run `hara cron install` so jobs actually fire.\n"));
  });
// Resolve an id/prefix to one job, printing a clear error for none / ambiguous (never act on a guess).
const cronResolve = (id: string): CronJob | null => {
  let r: ReturnType<typeof resolveJob>;
  try {
    r = resolveJob(id);
  } catch (error) {
    out(c.red(`${error instanceof Error ? error.message : String(error)}\n`));
    return null;
  }
  if (r === "ambiguous") return void out(c.red(`ambiguous id "${id}" — matches multiple jobs; type more characters\n`)), null;
  if (!r) return void out(c.red(`no such job: ${id}\n`)), null;
  return r;
};
/** Commander actions otherwise inherit Node's default SIGTERM/SIGINT exit, which kills only the tick parent
 * and can orphan its detached job process group. Convert the signal into cooperative cancellation, await
 * tree cleanup + lock release, then retain the conventional shell exit status. */
const withCronCliSignal = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  const stop = (signal: NodeJS.Signals): void => {
    interrupted ??= signal;
    if (!controller.signal.aborted) controller.abort(new Error(`cron command interrupted by ${signal}`));
  };
  const onInt = (): void => stop("SIGINT");
  const onTerm = (): void => stop("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  try {
    return await run(controller.signal);
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
  }
};
cronCmd.command("list").alias("ls").description("list scheduled jobs").action(() => out(renderCronJobs()));
cronCmd
  .command("remove <id>")
  .alias("rm")
  .description("delete a job (by id or unique prefix)")
  .action((id: string) => {
    const j = cronResolve(id);
    if (j) out(removeJob(j.id) ? c.green(`✓ removed ${j.id}\n`) : c.red("no such job\n"));
  });
cronCmd.command("enable <id>").description("enable a job").action((id: string) => {
  const j = cronResolve(id);
  if (j) {
    setEnabled(j.id, true);
    out(c.green(`✓ enabled ${j.id}\n`));
  }
});
cronCmd.command("disable <id>").description("disable a job (keeps it, stops firing)").action((id: string) => {
  const j = cronResolve(id);
  if (j) {
    setEnabled(j.id, false);
    out(c.green(`✓ disabled ${j.id}\n`));
  }
});
cronCmd
  .command("run <id>")
  .description("run a job right now, ignoring its schedule")
  .action(async (id: string) => {
    const job = cronResolve(id);
    if (!job) return;
    out(c.dim(`running ${job.id} (${job.name})…\n`));
    const r = await withCronCliSignal((signal) => runJobTracked(job, { signal }));
    out((r.ok ? c.green("✓ done") : c.red(`✗ ${r.error}`)) + c.dim(` · log: ${logPath(job.id)}\n`));
  });
cronCmd
  .command("tick")
  .description("run all due jobs now (your OS scheduler calls this every minute)")
  .action(async () => {
    const r = await withCronCliSignal((signal) => runTick(Date.now(), undefined, { signal }));
    if (r.skipped) return void out(c.dim(`(skipped — ${r.skipped})\n`));
    if (r.stopped) return void out(c.yellow(`(stopped — ${r.stopped}; ran ${r.ran.length} job(s): ${r.ran.join(", ") || "none"})\n`));
    out(c.dim(r.ran.length ? `ran ${r.ran.length} job(s): ${r.ran.join(", ")}\n` : "(no jobs due)\n"));
  });
cronCmd
  .command("install")
  .description("register the per-minute tick with your OS scheduler (launchd on macOS, crontab on Linux)")
  .action(() => {
    const r = installScheduler(selfArgv());
    out((r.ok ? c.green("✓ ") : c.red("✗ ")) + r.msg + "\n");
  });
cronCmd.command("uninstall").description("remove the OS scheduler entry").action(() => {
  const r = uninstallScheduler();
  out((r.ok ? c.green("✓ ") : c.red("✗ ")) + r.msg + "\n");
});
cronCmd
  .command("logs <id>")
  .description("show a job's recent run output")
  .action((id: string) => {
    const job = cronResolve(id);
    if (!job) return;
    const p = logPath(job.id);
    out(existsSync(p) ? readFileSync(p, "utf8").slice(-4000) + "\n" : c.dim("(no runs yet)\n"));
  });

const memoryCmd = program.command("memory").description("inspect + consolidate hara's durable memory (~/.hara/memory + project .hara/memory)");
memoryCmd.command("show").description("print the memory digest injected at session start").action(() => {
  const d = memoryDigest(process.cwd());
  out(d ? d + "\n" : c.dim("(memory is empty — `hara memory init`, or let the agent write via memory_write)\n"));
});
memoryCmd.command("init").description("scaffold the memory dirs + seed files (global + project)").action(async () => {
  const w = await scaffoldMemory(process.cwd());
  out(w.length ? c.green(`Scaffolded: ${w.join(", ")}\n`) : c.dim("Memory already scaffolded.\n"));
});
memoryCmd
  .command("distill")
  .description("consolidate recent daily logs into durable MEMORY (promote short-term → long-term)")
  .option("--days <n>", "days of logs to consider (default 14)", (v) => parseInt(v, 10))
  .option("--scope <s>", "global | project | all (default all)")
  .action(async (opts: { days?: number; scope?: string }) => {
    const cfg = loadConfig();
    const provider = await buildProvider(cfg);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    const days = opts.days && opts.days > 0 ? opts.days : 14;
    const scopes: Scope[] = opts.scope === "global" ? ["global"] : opts.scope === "project" ? ["project"] : ["project", "global"];
    const logs = scopes
      .map((s) => readRecentLogs(s, cfg.cwd, days))
      .filter(Boolean)
      .join("\n\n");
    if (!logs.trim()) return void out(c.dim(`No daily logs in the last ${days} day(s) to distill. (The agent jots them via memory_write target=log.)\n`));
    out(c.dim(`Distilling ${days}-day logs → durable memory…\n`));
    const stats = { input: 0, output: 0, lastInput: 0 };
    const history: NeutralMsg[] = [{ role: "user", content: `Current durable memory:\n\n${memoryDigest(cfg.cwd) || "(empty)"}\n\n---\n\nRecent daily logs (last ${days} days):\n\n${logs.slice(0, 80_000)}` }];
    await runAgent(history, {
      provider,
      ctx: { cwd: cfg.cwd, sandbox: cfg.sandbox },
      approval: "full-auto",
      confirm: async () => true,
      toolFilter: (n) => allowsEvolutionTool(n, "off"),
      systemOverride: MEMORY_DISTILL_SYSTEM,
      stats,
      ...agentRunLimits(cfg),
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

program
  .command("feedback [description...]")
  .description("file a structured bug/feature report to GitHub (hara-cli/hara) — humans and agents use the same door")
  .option("--session", "append a REDACTED tail of the most recent session (the issue is PUBLIC)")
  .option("--dry-run", "print the issue body without filing")
  .action(async (parts: string[], o: { session?: boolean; dryRun?: boolean }) => {
    // the hara-hub verdict: feedback is a command, not a server — GitHub Issues is the bus
    const { collectEnv, buildIssueBody, issueTitle, FEEDBACK_REPO, NEW_ISSUE_URL } = await import("./feedback.js");
    const desc = (parts ?? []).join(" ").trim();
    if (!desc) {
      out(`Usage: hara feedback "what happened…" [--session] [--dry-run] — files a structured issue to ${FEEDBACK_REPO}\n`);
      return;
    }
    let tail: string | undefined;
    if (o.session) {
      const { listSessions, loadSession } = await import("./session/store.js");
      const metas = listSessions();
      const last = metas[0] ? loadSession(metas[0].id) : null;
      if (last) {
        tail = last.history
          .slice(-8)
          .map((m: any) => (m.role === "user" ? `user: ${m.content}` : m.role === "assistant" && m.text ? `assistant: ${m.text}` : ""))
          .filter(Boolean)
          .join("\n")
          .slice(-3000);
        out(c.yellow("⚠ --session attaches a redacted tail of your last session to a PUBLIC issue.\n"));
      }
    }
    const { readRawConfig } = await import("./config.js");
    const raw = readRawConfig() as { provider?: string; model?: string };
    const modelLabel = raw.provider && raw.model ? `${raw.provider}:${raw.model}` : undefined;
    const body = buildIssueBody(desc, collectEnv(pkg.version, modelLabel), tail);
    if (o.dryRun) {
      out(body + "\n");
      return;
    }
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("gh", ["--version"], { stdio: "ignore" });
      const url = execFileSync("gh", ["issue", "create", "--repo", FEEDBACK_REPO, "--title", issueTitle(desc), "--body", body, "--label", "feedback"], { encoding: "utf8" });
      out(c.green("✓ filed: ") + url.trim() + "\n");
    } catch {
      out(`\n(gh CLI unavailable or filing failed — copy everything below into ${NEW_ISSUE_URL})\n\n# ${issueTitle(desc)}\n\n${body}\n`);
    }
  });

// `hara desk` — connect to a hara-desk coordination server (identity registry + task board).
// The desk is the closed-source enterprise piece; this is the open-source client side.
const deskCmd = program.command("desk").description("coordinate with a hara-desk server (register · post · board · claim · complete)");
deskCmd
  .command("register")
  .description("register this agent with a desk and save credentials to ~/.hara/desk.json")
  .requiredOption("--url <url>", "desk base URL (e.g. http://127.0.0.1:4200)")
  .requiredOption("--key <enrollKey>", "the desk's enroll key")
  .option("--name <name>", "agent name shown in the registry", "hara-cli")
  .option("--owner <owner>", "the human this agent belongs to", "me")
  .action(async (o: { url: string; key: string; name: string; owner: string }) => {
    const { registerAgent } = await import("./desk.js");
    try {
      const creds = await registerAgent(o.url, o.key, o.name, o.owner);
      out(c.green("✓ registered ") + `${creds.agentId} (owner ${creds.owner}) → ${creds.url}\n`);
    } catch (e: any) {
      out(c.red(`register failed: ${e.message}\n`));
    }
  });
deskCmd
  .command("post [title...]")
  .description("post a task or feedback report to the board")
  .option("--dispatch", "a dispatch task (someone does work) instead of a feedback report")
  .option("--high", "high-risk dispatch (needs an owner ack before it can complete)")
  .option("--body <text>", "task body / details", "")
  .action(async (parts: string[], o: { dispatch?: boolean; high?: boolean; body: string }) => {
    const { loadCreds, deskCall } = await import("./desk.js");
    const creds = loadCreds();
    if (!creds) return void out(c.red("not registered — run `hara desk register --url … --key …` first\n"));
    const title = (parts ?? []).join(" ").trim();
    if (!title) return void out("Usage: hara desk post <title> [--dispatch] [--high] [--body …]\n");
    try {
      const r = await deskCall(creds.url, "POST", "/tasks", { token: creds.token, body: { kind: o.dispatch ? "dispatch" : "feedback", risk: o.high ? "high" : "low", title, body: o.body } });
      out(c.green("✓ posted ") + `${r.task.id} (${r.task.kind}/${r.task.state})\n`);
    } catch (e: any) {
      out(c.red(`post failed: ${e.message}\n`));
    }
  });
deskCmd
  .command("board")
  .description("list the board (default: open tasks)")
  .option("--state <state>", "open | claimed | done | cancelled", "open")
  .option("--kind <kind>", "feedback | dispatch")
  .action(async (o: { state: string; kind?: string }) => {
    const { loadCreds, deskCall } = await import("./desk.js");
    const creds = loadCreds();
    if (!creds) return void out(c.red("not registered — run `hara desk register` first\n"));
    try {
      const q = `/tasks?state=${encodeURIComponent(o.state)}${o.kind ? `&kind=${encodeURIComponent(o.kind)}` : ""}`;
      const r = await deskCall(creds.url, "GET", q, { token: creds.token });
      if (!r.tasks.length) return void out(c.dim("(board empty)\n"));
      for (const t of r.tasks) out(`${t.id}  ${c.bold(t.kind)}${t.risk === "high" ? c.red("!") : " "} ${t.state.padEnd(8)} ${t.title}\n`);
    } catch (e: any) {
      out(c.red(`board failed: ${e.message}\n`));
    }
  });
for (const [verb, path, ok] of [
  ["claim", "claim", "claimed"],
  ["complete", "complete", "completed"],
  ["ack", "ack", "acked"],
  ["cancel", "cancel", "cancelled"],
] as const) {
  deskCmd
    .command(`${verb} <taskId>`)
    .description(`${verb} a task`)
    .option("--detail <text>", "note (complete)", "")
    .action(async (taskId: string, o: { detail: string }) => {
      const { loadCreds, deskCall } = await import("./desk.js");
      const creds = loadCreds();
      if (!creds) return void out(c.red("not registered — run `hara desk register` first\n"));
      try {
        const r = await deskCall(creds.url, "POST", `/tasks/${taskId}/${path}`, { token: creds.token, body: verb === "complete" ? { detail: o.detail } : {} });
        out(c.green(`✓ ${ok} `) + `${r.task?.id ?? taskId}${r.task ? ` (${r.task.state})` : ""}\n`);
      } catch (e: any) {
        out(c.red(`${verb} failed: ${e.message}\n`));
      }
    });
}

const skillsCmd = program.command("skills").description("manage skills (.hara/skills/<name>/SKILL.md)");
skillsCmd
  .command("init")
  .description("scaffold an example skill")
  .action(async () => {
    const written = await scaffoldSkills(process.cwd());
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
      // A plugin can ship CLI commands (manifest `bin`); they're linked into ~/.hara/bin. Tell the user to PATH it.
      const bins = Object.keys(m.bin ?? {});
      if (bins.length) {
        const onPath = (process.env.PATH ?? "").split(":").includes(haraBinDir());
        out(c.green(`Linked command(s): ${bins.join(", ")} → ${c.dim(haraBinDir())}\n`));
        if (!onPath) out(c.yellow(`  add to PATH once:  echo 'export PATH="$HOME/.hara/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc\n`));
      }
      // Surface the code-execution surface: a plugin's MCP servers + hooks run shell commands on every
      // hara launch with no prompt. Installing a plugin = trusting its author to run code; show what.
      const execs: string[] = [];
      for (const [name, s] of Object.entries(m.mcpServers ?? {})) execs.push(`mcp ${name}: ${[s.command, ...(s.args ?? [])].join(" ")}`);
      for (const h of [...(m.hooks?.PreToolUse ?? []), ...(m.hooks?.PostToolUse ?? [])]) execs.push(`hook: ${h.command}`);
      if (execs.length) {
        out(
          c.yellow(`⚠ ${p.name} will run these commands on every hara launch (a plugin is code you run — review them):\n`) +
            execs.map((e) => c.dim(`    ${e}`)).join("\n") +
            c.dim(`\n    disable: hara plugin disable ${p.name}\n`),
        );
      }
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
    if (key === "reasoningEffort" && !REASONING_EFFORTS.includes(value as typeof REASONING_EFFORTS[number])) {
      out(c.red(`Invalid reasoning effort. One of: ${REASONING_EFFORTS.join(", ")}.\n`));
      process.exit(1);
    }
    if (key === "runTimeoutMs") {
      const parsed = parseAgentRunTimeoutMs(value);
      if (parsed === undefined || parsed < MIN_AGENT_RUN_TIMEOUT_MS || parsed > MAX_AGENT_RUN_TIMEOUT_MS) {
        out(c.red("Invalid runTimeoutMs. Use 1s..2h, for example `30m`, `90s`, or milliseconds.\n"));
        process.exit(1);
      }
    }
    if (key === "maxAgentRounds") {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_AGENT_MAX_ROUNDS) {
        out(c.red(`Invalid maxAgentRounds. Use an integer from 1 to ${MAX_AGENT_MAX_ROUNDS}.\n`));
        process.exit(1);
      }
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
          `timeout:  ${raw.runTimeoutMs ?? "(default 30m)"}\n` +
          `rounds:   ${raw.maxAgentRounds ?? "(default 64)"}\n` +
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
  // Identity-profile selection (--profile flag) is now handled by the program-level preAction
  // hook above — see setFlagOverride() + resolveActive() in profile.ts. activeId() / loadActiveProfile()
  // pick it up automatically. `HARA_PROFILE` env still works as a transient override (one slot lower
  // in the priority chain than --profile).
  // Resolve addressable headless roles BEFORE loading config/provider/MCP. A qualified project role is
  // an execution-home selection, so every downstream route (credentials, model, AGENTS.md, tools) must be
  // constructed from that home rather than from the shell directory that happened to launch hara.
  let requestedHeadlessAgent: AgentIndexEntry | undefined;
  if (opts.print && opts.role) {
    const ref = String(opts.role).trim();
    const isLocalRole = !ref.includes(":") && loadRoles(process.cwd()).some((role) => role.id === ref);
    if (!isLocalRole) {
      const hit = resolveAgent(ref, process.cwd());
      if (hit && "ambiguous" in hit) {
        process.stderr.write(
          `hara: role '${ref}' is ambiguous; choose one of: ${hit.ambiguous.map((entry) => `${entry.project}:${entry.name}`).join(", ")}\n`,
        );
        process.exitCode = 2;
        return;
      }
      if (!hit) {
        process.stderr.write(`hara: no agent '${ref}' was found locally, globally, or in the registered project index.\n`);
        process.exitCode = 2;
        return;
      }
      requestedHeadlessAgent = hit;
    }
  }
  const cfg = loadConfig({ overlay: opts.overlay, ...(requestedHeadlessAgent?.home ? { cwd: requestedHeadlessAgent.home } : {}) });
  const cwd = cfg.cwd;
  const homeWorkspace = isUnsafeProjectWorkspace(cwd);
  // Resolve the concrete role before constructing any user/plugin MCP transport. MCP servers are arbitrary
  // stdio subprocesses, so a read-only persona must not start them merely by launching a turn. Reusing this
  // object later also closes the resolve→connect→re-resolve race where a role could disappear or change policy.
  let requestedHeadlessRole: Role | undefined;
  if (opts.print && opts.role) {
    const requestedRole = String(opts.role).trim();
    requestedHeadlessRole = requestedHeadlessAgent?.project
      ? loadRoles(requestedHeadlessAgent.home).find((candidate) => candidate.id === requestedHeadlessAgent!.name)
      : requestedHeadlessAgent
        ? loadGlobalRoles().find((candidate) => candidate.id === requestedHeadlessAgent!.name)
        : loadRoles(cwd).find((candidate) => candidate.id === requestedRole);
    if (!requestedHeadlessRole) {
      process.stderr.write(`hara: role '${opts.role}' disappeared from its declared home (${cwd}); refusing to start providers or MCP servers under the wrong persona.\n`);
      process.exitCode = 2;
      return;
    }
  }
  const machineOutput = !!opts.print && !!opts.schema;
  if (opts.model) cfg.model = opts.model;
  const provider0 = await withRouting(await buildProvider(cfg), cfg);
  // Fallback provider, built correctly for CROSS-PROVIDER failover. The old `baseURL: fallbackBaseURL ??
  // baseURL` sent the fallback model to the PRIMARY endpoint when no fallbackBaseURL was set — e.g.
  // deepseek-v4-pro posted to coding.dashscope → 400. Now: `fallbackProvider` routes to that vendor's
  // endpoint + its own key (fallbackBaseURL/fallbackApiKey still override); without it we stay on the
  // primary endpoint (correct only for a same-endpoint fallback).
  let fallbackProv: Provider | null = null;
  if (provider0 && cfg.fallbackModel && cfg.fallbackModel !== cfg.model) {
    const fp = cfg.fallbackProvider;
    const cross = !!fp && fp !== cfg.provider;
    const family = (m: string): string => m.toLowerCase().split(/[-.:/]/)[0];
    if (cross && !cfg.fallbackApiKey && !cfg.apiKey) {
      process.stderr.write(`hara: fallbackProvider '${fp}' needs its own key — set fallbackApiKey. Fallback disabled.\n`);
    } else if (!fp && !cfg.fallbackBaseURL && family(cfg.fallbackModel) !== family(cfg.model)) {
      // A different-looking vendor with no routing set would hit the primary endpoint and 400 on failover.
      process.stderr.write(`hara: fallbackModel '${cfg.fallbackModel}' looks like a different vendor than '${cfg.model}', but no fallbackProvider/fallbackBaseURL is set — it would hit the PRIMARY endpoint (likely 400). Set fallbackProvider (+ fallbackApiKey). Fallback disabled.\n`);
    } else {
      fallbackProv = await buildProvider({
        ...cfg,
        provider: fp ?? cfg.provider,
        model: cfg.fallbackModel,
        baseURL: cfg.fallbackBaseURL ?? (fp ? providerDefaultBaseURL(fp) : cfg.baseURL),
        apiKey: cfg.fallbackApiKey ?? (cross ? undefined : cfg.apiKey),
      });
    }
  }
  const fbOpt = fallbackProv ? { provider: fallbackProv } : undefined; // app-failover for the main chat turns
  const guardianOpt = await buildGuardian(cfg, provider0); // internal safety layer (high-risk actions only)
  if (!provider0) {
    // First-run friendliness: offer the setup wizard instead of just erroring (interactive TTY only).
    if (stdin.isTTY && !opts.print) {
      const rl = createInterface({ input: stdin, output: stdout });
      const ans = (await rl.question(c.yellow(`Not authenticated for '${cfg.provider}'. Run setup now? `) + c.dim("[Y/n] "))).trim().toLowerCase();
      rl.close();
      if (ans === "" || ans === "y" || ans === "yes") {
        await runSetup();
        out(c.dim(`\nThen run ${c.bold("hara")} to start.\n`));
        process.exit(0);
      }
    }
    const message = `Not authenticated for provider '${cfg.provider}'.\n${authHint(cfg)}\n`;
    if (machineOutput) process.stderr.write(message);
    else out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
    process.exit(1);
  }
  let provider: Provider = provider0;
  // Active profile is the source of truth for gateway-side concerns (heartbeat / role sync).
  // Legacy: cfg.provider==='hara-gateway' kept for users still pointing config.json at the old
  // sentinel — but profile.kind is what the rest of the CLI now reasons about.
  const __activeP = loadActiveProfile();
  // Safety UX: first line of stdout = "where am I sending requests right now". Stable, scriptable,
  // and reassuring at the start of every session. Suppressed in pure -p print mode to keep that
  // path clean stdout-only (the user wants the model output, not banner noise). Set HARA_QUIET=1
  // to suppress everywhere.
  if (!opts.print && process.env.HARA_QUIET !== "1") {
    out(c.dim(activeProfileLine(__activeP)) + "\n");
  }
  if (__activeP.kind === "gateway" || cfg.provider === "hara-gateway") {
    void heartbeat(); // fleet visibility — fire-and-forget, never blocks startup
    void syncOrgRoles(); // refresh governed org-role bundle (B3) in the background; best-effort, never blocks
  }
  let approval: ApprovalMode = opts.yes ? "full-auto" : ((opts.approval as ApprovalMode) || cfg.approval);
  let currentTurn: AbortController | null = null; // set during a running turn so Esc can abort it
  const autoApprove = new Set<string>(); // tools the user chose "don't ask again" for, this session
  let recalledContext = ""; // snippets queued by /recall, prepended to the next message
  const sandbox: SandboxMode = (opts.sandbox as SandboxMode) || cfg.sandbox;
  if (sandbox !== "off" && !sandboxSupported()) {
    const message = `(sandbox '${sandbox}' is macOS-only; shell runs unsandboxed here)\n`;
    if (machineOutput) process.stderr.write(message);
    else out(c.yellow(message));
  }
  const stats = { input: 0, output: 0, lastInput: 0 };

  // Connecting to MCP executes configured external commands before an MCP tool is selected, so the ordinary
  // per-tool confirmation is too late. Obtain one explicit startup grant for the named server set. askConfirm
  // uses a short-lived Ink prompt and restores stdin, making it safe before either the main TUI or readline REPL
  // owns the terminal. Non-interactive runs remain closed unless the user opted in before process launch.
  const mcpAll = { ...pluginMcpServers(), ...cfg.mcpServers }; // user config wins over plugin-contributed servers
  const mcpNames = Object.keys(mcpAll);
  if (!requestedHeadlessRole?.readOnly && mcpNames.length) {
    const trustedOptIn = process.env.HARA_ALLOW_TRUSTED_EXTENSIONS === "1";
    const interactiveTerminal = !opts.print && !!stdin.isTTY && !!stdout.isTTY;
    const approved =
      trustedOptIn ||
      (interactiveTerminal &&
        (await askConfirm(
          `Start configured MCP server${mcpNames.length === 1 ? "" : "s"} ${mcpNames
            .slice(0, 8)
            .map((name) => `'${name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80)}'`)
            .join(", ")}${mcpNames.length > 8 ? ` and ${mcpNames.length - 8} more` : ""}? ` +
            "They execute external code outside Hara's protected-file boundary.",
          false,
        )));
    if (approved) {
      await connectMcpServers(
        mcpAll,
        (m) => machineOutput ? process.stderr.write(m + "\n") : out(c.dim(m + "\n")),
        { approved: true },
      );
    } else {
      const message = interactiveTerminal
        ? "hara: MCP server startup declined; no configured MCP command was executed.\n"
        : "hara: MCP servers skipped because this run has no interactive startup approval. " +
          "Set HARA_ALLOW_TRUSTED_EXTENSIONS=1 before launch only for reviewed servers.\n";
      if (machineOutput || !interactiveTerminal) process.stderr.write(message);
      else out(c.dim(message));
    }
  }

  // one-shot
  if (opts.print) {
    let headlessLockId: string | null = null;
    const pendingHeadlessOperations = new Set<Promise<unknown>>();
    const trackHeadlessOperation = (operation: Promise<unknown>): void => {
      pendingHeadlessOperations.add(operation);
      const settled = (): void => { pendingHeadlessOperations.delete(operation); };
      void operation.then(settled, settled);
    };
    try {
    const projectContext = loadAgentContext(cwd) || undefined;
    // Vision sidecar for headless runs (gateway/cron): without it the computer tool's screenshots come back
    // "configure a vision model" even when one is set, leaving a headless agent blind. Mirrors the interactive
    // describeScreenshot — a configured visionModel, else the main model if it's vision-capable.
    const describeImage = async (path: string, hint?: string, signal?: AbortSignal): Promise<string> => {
      const cap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
      const vp = cfg.visionModel
        ? ((await buildProvider({ ...cfg, model: cfg.visionModel, baseURL: cfg.visionBaseURL ?? cfg.baseURL, apiKey: cfg.visionApiKey ?? cfg.apiKey })) ?? null)
        : cap === "vision"
          ? provider
          : null;
      if (!vp) return "";
      try {
        return await describeImages(vp, [{ path, mediaType: "image/png" }], { system: SCREENSHOT_SYSTEM, hint, signal });
      } catch {
        return "";
      }
    };
    // Headless session continuity: --resume <id> / --continue loads the session, appends this prompt, and
    // saves it back — so `hara -p … --resume <id>` continues a thread (used by cron, scripts, the chat gateway).
    // Plain `hara -p` stays stateless. A --resume id with no match is created WITH that id (stable per caller).
    let meta: SessionMeta | null = null;
    let continuationSession = false;
    let task: TaskExecution | undefined;
    const history: NeutralMsg[] = [];
    if (opts.resume || opts.continue) {
      const resumeArg = opts.resume ? String(opts.resume) : undefined;
      if (resumeArg && !validSessionId(resumeArg)) {
        process.stderr.write("hara: --resume contains an invalid session id. Use an id shown by `hara sessions`.\n");
        process.exitCode = 2;
        return;
      }
      const resolvedResume = resumeArg ? resolveSessionId(resumeArg) : null;
      if (resumeArg && !resolvedResume) {
        const prefixMatches = listSessions().filter((session) => session.id.startsWith(resumeArg));
        if (prefixMatches.length > 1) {
          process.stderr.write(`hara: session prefix '${resumeArg}' is ambiguous; use more characters.\n`);
          process.exitCode = 2;
          return;
        }
      }
      const rid = (resumeArg ? (resolvedResume ?? resumeArg) : latestForCwd(cwd)?.meta.id) ?? newSessionId();
      const lock = acquireSessionLock(rid);
      if (!lock.ok) {
        process.stderr.write(`hara: session ${shortId(rid)} is already open in another process (pid ${lock.pid ?? "unknown"}); refusing a concurrent headless resume.\n`);
        process.exitCode = 1;
        await closeMcp();
        return;
      }
      headlessLockId = rid;
      // Re-read only after acquiring the single-writer lock. Loading first would leave a race window where
      // another gateway/cron process appends history that this stale snapshot later overwrites.
      const prior = loadSession(rid);
      continuationSession = Boolean(prior?.history.length);
      task = recoverTaskExecution(prior?.task);
      if (sessionFileExists(rid) && !prior) {
        process.stderr.write(`hara: session ${shortId(rid)} exists but is unreadable or corrupt; refusing to overwrite it. Inspect ~/.hara/sessions/${rid}.json.\n`);
        process.exitCode = 2;
        return;
      }
      if (prior && canonicalProjectPath(prior.meta.cwd) !== canonicalProjectPath(cwd)) {
        process.stderr.write(
          `hara: session ${shortId(rid)} belongs to ${prior.meta.cwd}, but this run is rooted at ${cwd}; refusing to resume across project homes. Run hara from the session's project directory instead.\n`,
        );
        process.exitCode = 2;
        return;
      }
      if (prior && requestedHeadlessAgent?.project) {
        const priorHome = canonicalProjectPath(prior.meta.cwd);
        if (priorHome !== requestedHeadlessAgent.home) {
          process.stderr.write(
            `hara: session ${shortId(rid)} belongs to ${prior.meta.cwd}; refusing to resume it as ${requestedHeadlessAgent.project}:${requestedHeadlessAgent.name} at ${requestedHeadlessAgent.home}. Start a new role session or resume one from that home.\n`,
          );
          process.exitCode = 2;
          return;
        }
      }
      if (prior?.history) history.push(...prior.history);
      // Stamp who created this session (cron runner sets HARA_CRON, gateway sets HARA_GATEWAY) and give
      // automated sessions a "name · time" title UP FRONT — the raw prompt must never become the title.
      const src = sessionSourceFromEnv();
      meta = prior?.meta ?? {
        id: rid,
        cwd,
        provider: cfg.provider,
        model: cfg.model,
        title: src.source === "interactive" ? "" : automatedTitle(src.source, src.sourceName),
        createdAt: new Date().toISOString(),
        updatedAt: "",
        ...(src.source !== "interactive" ? { source: src.source, sourceName: src.sourceName } : { source: "interactive" as const }),
      };
      // Checklist continuity remains in meta; execution identity is restored independently in top-level
      // SessionData.task so transcript/interaction changes cannot silently replace the active objective.
      restoreTodos(meta.todos);
      onTodosChange((list) => {
        if (meta) meta.todos = [...list];
      });
      // Apply per-session pinned model on headless resume (mirrors the interactive path).
      // --model flag wins (already on cfg.model) and is written back; otherwise restore meta.model.
      if (prior) {
        if (opts.model) {
          meta.model = cfg.model;
        } else if (meta.model && meta.model !== cfg.model) {
          const __allowed = __activeP.kind === "gateway" && __activeP.availableModels && __activeP.availableModels.length > 0;
          if (__allowed && !__activeP.availableModels!.includes(meta.model)) {
            const __fb = __activeP.defaultModel || cfg.model;
            // headless: log to stderr so it doesn't pollute the captured stdout reply
            try { process.stderr.write(`hara: resumed session pinned '${meta.model}' not in availableModels — falling back to '${__fb}'.\n`); } catch { /* ignore */ }
            cfg.model = __fb;
            meta.model = __fb;
            const __rb = await buildProvider(cfg);
            if (__rb) provider = __rb;
          } else {
            cfg.model = meta.model;
            const __rb = await buildProvider(cfg);
            if (__rb) provider = __rb;
          }
        }
      }
    }
    // --schema: schema-enforced structured output. The schema (inline JSON or a file path) becomes a run-scoped
    // structured_output tool the model MUST call; stdout is then exactly that JSON (streaming suppressed), so
    // scripts / gateway flows / cron parse a guaranteed shape instead of regex-fishing prose.
    let schemaObj: object | null = null;
    if (opts.schema) {
      const rawArg = String(opts.schema);
      let raw = rawArg;
      if (existsSync(rawArg)) {
        try {
          raw = readModelContextFileSync(rawArg, 1024 * 1024);
        } catch (error) {
          process.stderr.write(`hara: refusing unsafe schema file: ${error instanceof Error ? error.message : String(error)}\n`);
          process.exitCode = 2;
          await closeMcp();
          return;
        }
      }
      const parsed = parseSchemaArg(raw);
      if ("error" in parsed) {
        process.stderr.write(`hara: ${parsed.error}\n`);
        process.exitCode = 2;
        await closeMcp();
        return;
      }
      schemaObj = parsed;
    }
    // Recover any steering that was acknowledged by serve before a crash but had not yet reached a model
    // round. The next session write commits its transcript copy and consumed marker atomically.
    const recoveredHeadlessSteering = consumePendingTaskSteering(task);
    if (recoveredHeadlessSteering) {
      task = recoveredHeadlessSteering.task;
      history.push(...recoveredHeadlessSteering.entries.map((entry): NeutralMsg => ({
        role: "user",
        content: `${INTERJECT_PREFIX}\n\n${entry.content}`,
      })));
    }
    // Inbound images (gateway): the platform downloaded the user's photo(s) and passed their paths via env.
    // Let the agent actually SEE them — attached inline for a vision-capable main model, else described via the
    // visionModel sidecar and folded into the message (text-only models can't take image blocks).
    const userText = await expandMentionsAsync(String(opts.print), cwd) + (schemaObj ? STRUCTURED_INSTRUCTION : "");
    const inboundImgs = (process.env.HARA_GATEWAY_IMAGES ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter((p) => p && existsSync(p))
      .map((p) => ({ path: p, mediaType: mediaTypeFor(p) ?? "image/jpeg" }));
    if (inboundImgs.length && classifyVision(cfg.provider, cfg.model, cfg.modelVision) === "vision") {
      history.push({ role: "user", content: userText, images: inboundImgs }); // native vision → inline
    } else if (inboundImgs.length && cfg.visionModel) {
      let desc = "";
      try {
        const vp = await buildProvider({ ...cfg, model: cfg.visionModel, baseURL: cfg.visionBaseURL ?? cfg.baseURL, apiKey: cfg.visionApiKey ?? cfg.apiKey });
        if (vp) desc = await describeImages(vp, inboundImgs);
      } catch {
        /* describe is best-effort — fall back to the marker-only text */
      }
      const n = inboundImgs.length;
      history.push({
        role: "user",
        content: desc ? `${userText}\n\n[${n} image${n > 1 ? "s" : ""} the user sent — described by ${cfg.visionModel}]\n${desc}` : userText,
      });
    } else {
      history.push({ role: "user", content: userText });
    }
    // A resumed unfinished task keeps its objective; this prompt is a new turn that steers it. A completed
    // task (or a stateless -p run) starts a fresh execution identity. Persist before provider side effects so
    // a crash is recoverable as paused rather than looking like a completed turn.
    const headlessInteraction: TaskInteraction = task && task.status !== "completed" &&
      (recoveredHeadlessSteering !== null || requestsTaskContinuation(String(opts.print)))
      ? newSteerInteraction(task.turnId)
      : newTurnInteraction();
    if (headlessInteraction.kind === "steer") {
      const continued = continueTaskExecution(task, headlessInteraction);
      task = continued.ok ? continued.task : createTaskExecution(String(opts.print), headlessInteraction.turnId);
    } else {
      task = createTaskExecution(String(opts.print), headlessInteraction.turnId);
      clearTodos();
      if (meta) meta.todos = [];
    }
    if (meta) saveSession(meta, history, task);
    // --role: run this headless turn AS an org role/agent persona (the gateway's /agent switch lands here).
    // Local roles resolve at cwd; qualified project agents were resolved before config/provider startup and
    // cwd is already their registered home. Explicit global roles remain portable in the current project.
    let roleOverride: string | undefined;
    let headlessProvider = provider;
    let headlessToolFilter: ((name: string) => boolean) | undefined;
    let headlessHooks = true;
    if (requestedHeadlessRole) {
      roleOverride = requestedHeadlessRole.system;
      headlessToolFilter = roleToolFilter(requestedHeadlessRole);
      if (requestedHeadlessRole.readOnly) headlessHooks = false;
      const roleModel = effectiveRoleModel(requestedHeadlessRole.model, cfg.model);
      if (roleModel && roleModel !== provider.model) {
        const selected = await buildProvider({ ...cfg, model: roleModel });
        if (!selected) {
          process.stderr.write(`hara: role '${opts.role}' requires model '${roleModel}', but that provider is not authenticated.\n`);
          process.exitCode = 2;
          await closeMcp();
          return;
        }
        headlessProvider = selected;
      }
    }
    let structured: unknown;
    let structuredSet = false;
    const printRunOpts = {
      provider: headlessProvider,
      ctx: { cwd, sandbox, spawn: (t: string, role?: string, signal?: AbortSignal) => runSubagent(cfg, headlessProvider, cwd, sandbox, projectContext, stats, t, role, signal), describeImage },
      approval: "full-auto" as const,
      confirm: async () => true,
      projectContext,
      memory: memoryDigest(cwd),
      continuationSession,
      executionContext: taskExecutionContext(task, headlessInteraction, meta?.todos ?? []),
      ...(roleOverride ? { systemOverride: roleOverride } : {}),
      ...(headlessToolFilter ? { toolFilter: headlessToolFilter } : {}),
      hooks: headlessHooks,
      stats,
      guardian: guardianOpt, // safety layer stays on in headless -p (fail-open; breaker aborts, never hangs)
      onProviderTurn: trackHeadlessOperation,
      onToolRun: trackHeadlessOperation,
      ...agentRunLimits(cfg),
      ...(schemaObj
        ? {
            extraTools: [structuredOutputTool(schemaObj, (v: unknown) => ((structured = v), (structuredSet = true)))],
            quiet: true, // stdout must be exactly the JSON — no streamed prose
          }
        : {}),
    };
    let runOutcome = await runAgent(history, printRunOpts);
    if (schemaObj) {
      // The tool call IS the answer — if the model finished without it, nudge and retry (bounded).
      for (let attempt = 0; attempt < 2 && !structuredSet && runOutcome.status === "completed"; attempt++) {
        history.push({ role: "user", content: STRUCTURED_NUDGE });
        runOutcome = await runAgent(history, printRunOpts);
      }
      const failure = runFailureDetail(runOutcome);
      if (failure) {
        // A valid structured_output call is provisional until the whole agent run completes. A later provider
        // error or safety halt must never be hidden behind stale-looking success JSON on stdout.
        process.stderr.write(`hara: structured run failed (${runOutcome.status}) — ${failure}\n`);
        process.exitCode = 2;
      }
      else if (structuredSet) out(JSON.stringify(structured) + "\n");
      else {
        process.stderr.write("hara: model never called structured_output — no result.\n");
        process.exitCode = 2;
      }
    } else {
      const failure = runFailureDetail(runOutcome);
      if (failure) {
        process.stderr.write(`hara: headless run failed (${runOutcome.status}) — ${failure}\n`);
        process.exitCode = 2;
      }
    }
    if (meta) {
      task = finishTaskExecution(task, runOutcome, meta.todos ?? [], false);
      // Long-session safety: auto-compact before saving so a long chat/cron thread never overflows context.
      // Silent (no-op notify) in headless mode so nothing leaks into a captured -p reply. Opt-out via config.
      if (runOutcome.status === "completed") {
        await maybeAutoCompact(headlessProvider, history, meta, stats, cfg, () => {}, undefined, task);
      }
      saveSession(meta, history, task); // persist when resuming/continuing; plain -p stays stateless
    }
    if (!schemaObj && runOutcome.status === "completed" && (stats.input || stats.output)) out(statusLine(headlessProvider.model, stats.input, stats.output) + "\n");
    await closeMcp();
    return;
    } finally {
      if (headlessLockId) {
        const lockId = headlessLockId;
        if (pendingHeadlessOperations.size) {
          // Do not await here: the logical deadline stays hard. A late operation with active handles keeps
          // this process (and therefore its cross-process session lease) alive until physical settlement.
          // A truly inert never-settling Promise has no side effect/handle, so normal process exit makes the
          // PID-backed lease safely reclaimable.
          void Promise.allSettled([...pendingHeadlessOperations]).then(() => releaseSessionLock(lockId));
        } else {
          releaseSessionLock(lockId);
        }
      }
      await closeMcp();
    }
  }

  // interactive REPL — ink TUI by default on a real terminal; HARA_TUI=0 forces the classic readline path
  const useTui = stdin.isTTY && stdout.isTTY && process.env.HARA_TUI !== "0";
  out(c.bold(`hara ${pkg.version}`) + c.dim(`  ·  ${cfg.provider}:${cfg.model}  ·  ${approval}${sandbox !== "off" ? `  ·  sandbox:${sandbox}` : ""}  ·  ${cwd}\n`));
  if (homeWorkspace) {
    out(c.yellow("⚠ Home or a directory containing it is not treated as a project workspace. Switch with `/cd /path/to/project`, or launch with `hara --cwd /path/to/project`; project-scoped execution is disabled here.\n"));
  }
  // Startup update notice — cache-driven (a previous session's background probe), so it costs zero
  // latency; today's probe (if due) fires in the background for the NEXT launch. TTY sessions only.
  if (cfg.updateCheck && stdout.isTTY) {
    const upd = checkForUpdate(pkg.version);
    if (upd) out(c.yellow(`⬆ ${upd}`) + "\n");
  }
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
  const confirm = async (q: string, signal?: AbortSignal) => {
    const prompt = `${q} ${c.dim("[y/N]")} `;
    const answer = signal ? await rl.question(prompt, { signal }) : await rl.question(prompt);
    return answer.trim().toLowerCase().startsWith("y");
  };
  // ask_user (classic REPL): print the question + a numbered menu (matching the setup menu look) and read the
  // answer through the SAME rl.question channel confirm uses. A bare option number selects it; any other text
  // is taken as a free-text answer — so the user can always type their own response.
  const askUser = async (q: string, options?: string[], signal?: AbortSignal): Promise<string> => {
    out(c.bold("\n? ") + q + "\n");
    const opts = (options ?? []).map((o) => o.trim()).filter(Boolean);
    opts.forEach((o, i) => out(`  ${c.bold(String(i + 1))}) ${o}\n`));
    const hint = opts.length ? c.dim(`(1-${opts.length} to pick, or type your own answer) `) : c.dim("(type your answer) ");
    const prompt = `${c.cyan("›")} ${hint}`;
    const raw = (signal ? await rl.question(prompt, { signal }) : await rl.question(prompt)).trim();
    if (opts.length) {
      const n = Number.parseInt(raw, 10);
      if (Number.isInteger(n) && n >= 1 && n <= opts.length) return opts[n - 1];
    }
    return raw;
  };
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

  // First-run AGENTS.md offer — classic REPL only. In TUI mode we must NOT call rl.question before ink
  // mounts: a readline question puts stdin in a state ink can't read from, leaving the input box dead
  // (the TUI shows a `/init` tip instead, below). See the `tip` in the runTui header.
  if (!homeWorkspace && !hasAgentsMd(cwd) && !useTui) {
    const ans = (await rl.question(`${c.dim("No AGENTS.md here — analyze this project and create one?")} ${c.dim("[Y/n]")} `)).trim().toLowerCase();
    if (ans === "" || ans.startsWith("y")) {
      out(c.dim("Analyzing project…\n"));
      try {
        await runInit(provider, cwd, sandbox, cfg);
      } catch (e: any) {
        out(c.red(`[init error] ${e.message}\n`));
      }
    }
  }
  let projectContext = loadAgentContext(cwd) || undefined;
  const spawn = (t: string, role?: string, signal?: AbortSignal) => runSubagent(cfg, provider, cwd, sandbox, projectContext, stats, t, role, signal);

  // session: --resume <id> / --continue (latest in this cwd) / new
  let resumeId: string | null = null;
  if (opts.resume) {
    const rid = resolveSessionId(opts.resume); // accept a full UUID or a unique prefix (short id)
    resumeId = rid;
    if (!resumeId) out(c.yellow(`(no session '${opts.resume}'; starting fresh)\n`));
  } else if (opts.continue) {
    resumeId = latestForCwd(cwd)?.meta.id ?? null;
    if (!resumeId) out(c.dim("(no prior session in this directory; starting fresh)\n"));
  }
  // Single-writer guard: two hara processes on the SAME session race writes to its append-only history and
  // corrupt it. Acquire BEFORE reading the history, then re-read under the lock so no stale snapshot can
  // overwrite a turn appended between load and lock.
  const sessionId = resumeId ?? newSessionId();
  const lock = acquireSessionLock(sessionId);
  if (!lock.ok) {
    out(
      c.red(`Session ${shortId(sessionId)} is already open in another hara process (pid ${lock.pid}).`) +
        c.dim(` Resuming the same session twice races writes and can corrupt its history. Close that one, or run \`hara\` for a new session. (Override: rm ~/.hara/sessions/${sessionId}.lock)\n`),
    );
    process.exit(1);
  }
  process.on("exit", () => releaseSessionLock(sessionId));
  const resumed: SessionData | null = resumeId ? loadSession(resumeId) : null;
  if (resumeId && sessionFileExists(resumeId) && !resumed) {
    releaseSessionLock(sessionId);
    out(c.red(`Session ${shortId(resumeId)} exists but is unreadable or corrupt; refusing to overwrite it. Inspect ~/.hara/sessions/${resumeId}.json.\n`));
    process.exit(2);
  }
  if (resumed && canonicalProjectPath(resumed.meta.cwd) !== canonicalProjectPath(cwd)) {
    releaseSessionLock(sessionId);
    out(
      c.red(`Session ${shortId(resumed.meta.id)} belongs to ${resumed.meta.cwd}, but this run is rooted at ${cwd}; refusing to resume across project homes.\n`) +
        c.dim(`Run hara from the session's project directory instead.\n`),
    );
    process.exit(2);
  }
  const meta: SessionMeta = resumed?.meta ?? {
    id: sessionId,
    cwd,
    provider: cfg.provider,
    model: cfg.model,
    title: "",
    createdAt: new Date().toISOString(),
    updatedAt: "",
    source: "interactive",
  };
  // Conversation transcript and task execution are restored independently. A process that disappeared
  // mid-run leaves `running`; recovery turns it into an explicit paused/interrupted task.
  let task: TaskExecution | undefined = recoverTaskExecution(resumed?.task);
  let resumeTaskPending = Boolean(resumeId && task && task.status !== "completed");
  // Task-state continuity (interactive twin of the -p path): restore the checklist, mirror changes onto meta.
  restoreTodos(meta.todos);
  onTodosChange((list) => {
    meta.todos = [...list];
  });
  // Per-session model precedence on resume:
  //   1. --model flag (already applied to cfg.model up-top) → wins and is written back to meta.model.
  //   2. resumed meta.model → restored into cfg.model (the user's last /model choice).
  //   3. otherwise leave cfg.model as the profile-resolved default.
  // Safety: if we're on a gateway profile with a finite availableModels list and the resumed
  // meta.model isn't in it (e.g. user switched profiles between sessions), warn and degrade to
  // profile.defaultModel — a stale pinned model shouldn't brick the resume.
  if (resumed) {
    if (opts.model) {
      // explicit --model on the command line wins; persist it onto the session.
      meta.model = cfg.model;
    } else if (meta.model && meta.model !== cfg.model) {
      const __ap = __activeP;
      const __allowed = __ap.kind === "gateway" && __ap.availableModels && __ap.availableModels.length > 0;
      if (__allowed && !__ap.availableModels!.includes(meta.model)) {
        const __fallback = __ap.defaultModel || cfg.model;
        out(c.yellow(`⚠ resumed session was pinned to '${meta.model}', which isn't in this profile's availableModels (${__ap.availableModels!.join(", ")}). Falling back to '${__fallback}'.\n`));
        cfg.model = __fallback;
        meta.model = __fallback;
        const __rebuilt = await buildProvider(cfg);
        if (__rebuilt) provider = __rebuilt;
      } else {
        cfg.model = meta.model;
        const __rebuilt = await buildProvider(cfg);
        if (__rebuilt) provider = __rebuilt;
      }
    }
  }
  const history: NeutralMsg[] = resumed?.history ? [...resumed.history] : [];
  const persistSession = (): void => saveSession(meta, history, task);
  let requestedWorkspaceSwitch: string | null = null;
  const relaunchRequestedWorkspace = async (): Promise<void> => {
    if (!requestedWorkspaceSwitch) return;
    const target = requestedWorkspaceSwitch;
    requestedWorkspaceSwitch = null;
    // The foreground child starts a new session. Do not keep the old session artificially locked for the
    // entire lifetime of the new workspace merely because this small parent process is waiting on it.
    releaseSessionLock(sessionId);
    const args: string[] = [];
    if (opts.profile) args.push("--profile", String(opts.profile));
    if (opts.overlay) args.push("--overlay", String(opts.overlay));
    if (opts.model) args.push("--model", String(opts.model));
    if (opts.yes) args.push("--yes");
    else if (opts.approval) args.push("--approval", String(opts.approval));
    if (opts.sandbox) args.push("--sandbox", String(opts.sandbox));
    out(c.dim(`Switching workspace → ${target}\n`));
    try {
      const result = await runSelfAttached(args, target);
      if (result.signal) {
        out(c.yellow(`Hara in ${target} stopped by ${result.signal}.\n`));
        process.exitCode = 1;
      } else if (result.code) {
        process.exitCode = result.code;
      }
    } catch (error) {
      out(c.red(`Could not start Hara in ${target}: ${error instanceof Error ? error.message : String(error)}\n`));
      process.exitCode = 1;
    }
  };
  const keepUnfinishedTaskActive = (): void => {
    resumeTaskPending = Boolean(task && task.status !== "completed");
  };
  let continuationSession = Boolean(resumed?.history.length);
  const memorySnap = memoryDigest(cwd); // durable memory, read once (frozen snapshot)
  const buildMemory = (): string =>
    (meta.workingSet?.length ? `## Working memory (this task)\n${meta.workingSet.map((w) => `- ${w}`).join("\n")}\n\n` : "") + memorySnap;
  if (resumed) out(c.dim(`(resumed ${shortId(meta.id)} · ${history.length} msgs · model = ${cfg.model})\n`));

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
      name: "cd",
      desc: "switch to a project workspace: /cd <directory>",
      run: (a) => {
        const result = resolveWorkspaceSwitch(a, cwd);
        if (!result.ok) return void out(c.red(`(${result.error})\n`));
        if (result.cwd === realpathSync.native(cwd)) return void out(c.dim(`(already in ${result.cwd})\n`));
        requestedWorkspaceSwitch = result.cwd;
        return "exit";
      },
    },
    {
      name: "continue",
      aliases: ["resume"],
      desc: "resume the unfinished task: /continue [instruction]",
      // Interactive loops translate this command into an ordinary model turn before slash dispatch. This
      // fallback only protects future callers that invoke the command table directly.
      run: () => void out(c.dim("(type /continue [instruction] in an interactive session)\n")),
    },
    {
      name: "init",
      desc: "analyze project & regenerate AGENTS.md",
      run: async () => {
        out(c.dim("Analyzing project…\n"));
        try {
          await runInit(provider, cwd, sandbox, cfg);
          projectContext = loadAgentContext(cwd) || undefined;
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
      desc: "show or switch model: /model [id [--force|all]]",
      run: async (a) => {
        const parts = (a || "").trim().split(/\s+/).filter(Boolean);
        const force = parts.some((p) => p === "--force" || p === "all" || p === "-f");
        const id = parts.find((p) => p !== "--force" && p !== "all" && p !== "-f");
        if (!id) {
          // Bare /model: pinned model + per-role overrides table, so the user sees what's pinned now
          // and which roles deviate from it.
          const __force = isSessionForceModel();
          const __lines = [`${cfg.provider}:${cfg.model}`];
          if (meta.model && meta.model !== cfg.model) {
            __lines.push(c.dim(`session pinned: ${meta.model} (cfg drift — /model ${meta.model} to re-pin)`));
          } else {
            __lines.push(c.dim(`session pinned: ${meta.model || "(none)"}${__force ? c.yellow(" · forced (all roles use session model)") : ""}`));
          }
          const __roles = loadRoles(cwd);
          if (__roles.length) {
            __lines.push(c.dim("roles:"));
            for (const r of __roles) {
              const eff = __force ? cfg.model : (r.model || cfg.model);
              const tag = __force && r.model && r.model !== cfg.model ? c.yellow(" (overridden by --force)") : r.model ? c.dim(" (role pin)") : c.dim(" (session)");
              __lines.push(`  ${r.id}: ${eff}${tag}`);
            }
          }
          return void out(__lines.join("\n") + "\n");
        }
        cfg.model = id;
        meta.model = id;
        setSessionForceModel(force);
        visionProvider = undefined;
        remindedVision = false;
        const p = await buildProvider(cfg);
        if (p) {
          provider = p;
          if (bar.isActive()) bar.update({ model: id });
          persistSession(); // persist the session-pinned model so resume restores it
          out(c.dim(`(model → ${cfg.provider}:${id}${force ? " · forced (all roles)" : ""})\n`));
        } else out(c.red("(could not rebuild provider)\n"));
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
    { name: "jobs", desc: "list/tail/kill background shell jobs (dev servers, watchers)", run: (a) => {
      const [sub, jid] = (a || "").trim().split(/\s+/);
      if (sub === "kill" && jid) return void out((killJob(jid) ? `✕ killed ${jid}` : `no running job ${jid}`) + "\n");
      if (sub === "tail" && jid) return void out((tailJob(jid) ?? `no job ${jid}`) + "\n");
      out(renderBgJobs() + "\n");
    } },
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
      name: "context",
      desc: "show what's filling the context window (token breakdown by category)",
      run: () => void out(formatContextReport(history, cfg.model) + "\n"),
    },
    {
      name: "task",
      desc: "show separated task/run state: /task · /task clear",
      run: (a) => {
        if ((a ?? "").trim() === "clear") {
          task = undefined;
          resumeTaskPending = false;
          persistSession();
          return void out(c.dim("(task state cleared; conversation kept)\n"));
        }
        out(formatTaskExecution(task) + "\n");
      },
    },
    {
      name: "new",
      desc: "start a new task while keeping conversation context",
      run: () => {
        task = undefined;
        resumeTaskPending = false;
        clearTodos();
        meta.todos = [];
        persistSession();
        out(c.dim("(new task boundary; conversation kept — type the new objective)\n"));
      },
    },
    {
      name: "rewind",
      desc: "fork the conversation back to an earlier turn: /rewind (list) · /rewind <n> (files unchanged)",
      run: (a) => {
        const arg = (a ?? "").trim();
        if (!arg) {
          const turns = userTurnPreviews(history);
          return void out(turns.length ? "Recent turns (newest first) — `/rewind <n>` forks from before it (files unchanged):\n" + turns.map((t) => `  ${t.n}. ${t.preview}`).join("\n") + "\n" : c.dim("(nothing to rewind)\n"));
        }
        const nh = rewindTo(history, Number(arg));
        if (!nh) return void out(c.dim(`(no such turn: ${arg})\n`));
        history.length = 0;
        history.push(...nh);
        task = undefined; // the dropped transcript may have owned the current task; do not retain stale identity
        resumeTaskPending = false;
        persistSession();
        out(c.green(`(rewound — dropped the last ${arg} turn(s); ${history.length} messages kept. Files are unchanged. Type your next message.)\n`));
      },
    },
    {
      name: "checkpoint",
      desc: "file-state checkpoints: /checkpoint (list) · /checkpoint restore <n> (revert files to a checkpoint)",
      run: (a) => {
        const parts = (a ?? "").trim().split(/\s+/);
        const cps = listCheckpoints(cwd);
        if (parts[0] !== "restore") {
          return void out(cps.length ? "File checkpoints (newest first) — `/checkpoint restore <n>` reverts files to it:\n" + cps.map((cp, i) => `  ${i + 1}. ${cp.sha}  ${cp.label}`).join("\n") + "\n" : c.dim("(no checkpoints yet — taken before each turn when fileCheckpoints is on)\n"));
        }
        const cp = cps[Number(parts[1]) - 1];
        if (!cp) return void out(c.dim(`(no checkpoint ${parts[1] ?? ""})\n`));
        const k = restoreCheckpoint(cwd, cp.sha);
        out(k == null ? c.red("(restore failed)\n") : c.green(`(restored ${k} file(s) to ${cp.sha} — '${cp.label}'; prior state snapshotted too)\n`));
      },
    },
    {
      name: "evolve",
      desc: "show or run auditable self-evolution: /evolve [status|now]",
      run: async (a) => {
        const action = (a ?? "").trim() || "status";
        if (action === "status") return void out(evolutionStatus(cfg) + "\n");
        if (action !== "now") return void out(c.dim("usage: /evolve [status|now]\n"));
        if (cfg.evolve === "off") return void out(c.dim("(self-evolution is off — set `hara config set evolve light|proactive` first)\n"));
        if (history.length < 2) return void out(c.dim("(not enough session evidence to curate)\n"));
        out(c.dim("Curating evidence-backed memories and reusable skills…\n"));
        const outcome = await curateSessionLearning(provider, history, cfg, {
          cwd,
          sandbox,
          spawn,
          confirm,
          memory: buildMemory(),
          stats,
        });
        persistSession();
        out(outcome.status === "completed" ? c.green("(self-evolution curation complete)\n") : c.yellow(`(self-evolution stopped: ${outcome.error ?? outcome.status})\n`));
      },
    },
    {
      name: "compact",
      desc: "summarize the conversation so far to free up context",
      run: async () => {
        out(c.dim("Compacting…\n"));
        const compactTurn = new AbortController();
        currentTurn = compactTurn;
        let summary: string | null = null;
        try {
          if (cfg.evolve !== "off") {
            const distill = await curateSessionLearning(provider, history, cfg, {
              cwd,
              sandbox,
              spawn,
              confirm,
              memory: buildMemory(),
              stats,
              signal: compactTurn.signal,
            });
            if (distill.status !== "completed") {
              out(c.yellow(`(compact cancelled — self-evolution stopped: ${distill.error ?? distill.status})\n`));
              return;
            }
          }
          summary = await compactConversation(provider, history, meta, stats, compactTurn.signal, task);
        } finally {
          if (currentTurn === compactTurn) currentTurn = null;
        }
        out(summary ? c.green(`(compacted — ${summary.length} chars; context replaced with the summary)\n`) : c.dim("(nothing to compact / compact failed)\n"));
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
        persistSession();
        out(c.green(`(renamed → ${meta.title})\n`));
      },
    },
    {
      name: "reset",
      aliases: ["clear"],
      desc: "clear conversation context",
      run: () => {
        history.length = 0;
        task = undefined;
        resumeTaskPending = false;
        recalledContext = "";
        clearTodos();
        meta.todos = [];
        resetReachability();
        resetRepeatGuard();
        clearTouched();
        persistSession();
        out(c.dim("(context cleared)\n"));
      },
    },
    {
      name: "exit",
      aliases: ["quit"],
      desc: "leave",
      run: async () => {
        if (shouldAutoEvolve(cfg.evolve, history.length)) {
          out(c.dim("Distilling session learnings…\n"));
          try {
            await curateSessionLearning(provider, history, cfg, { cwd, sandbox, spawn, confirm, memory: buildMemory(), stats });
            persistSession();
          } catch {
            /* exiting remains available if optional curation fails */
          }
        }
        return "exit";
      },
    },
  ];
  const byName = new Map<string, Slash>();
  for (const cmd of commands) {
    byName.set(cmd.name, cmd);
    for (const a of cmd.aliases ?? []) byName.set(a, cmd);
  }

  if (useTui) {
    rl.close(); // hand stdin over to ink
    // First-run AGENTS.md offer — via a tiny ink prompt, NOT readline. A readline question before the
    // main TUI leaves stdin unreadable by ink (dead input box); ink cleans up on unmount, so the TUI
    // mounted right after gets working input. Runs before mount, like the classic path.
    if (!homeWorkspace && !hasAgentsMd(cwd)) {
      if (await askConfirm("No AGENTS.md here — analyze this project and create one?")) {
        out(c.dim("Analyzing project…\n"));
        try {
          await runInit(provider, cwd, sandbox, cfg);
        } catch (e: any) {
          out(c.red(`[init error] ${e.message}\n`));
        }
        projectContext = loadAgentContext(cwd) || undefined;
      }
    }
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
    const describeScreenshot = async (path: string, hint?: string, signal?: AbortSignal): Promise<string> => {
      const cap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
      const vp = cfg.visionModel ? await getVisionProvider() : cap === "vision" ? provider : null;
      if (!vp) return "";
      try {
        return await describeImages(vp, [{ path, mediaType: "image/png" }], { system: SCREENSHOT_SYSTEM, hint, signal });
      } catch {
        return "";
      }
    };
    // grounding for accurate RPA: ask the vision model WHERE an element is (0..1 fractions) so the computer
    // tool can click it precisely instead of guessing pixels from a text description.
    const locateScreenshot = async (path: string, target: string, signal?: AbortSignal): Promise<{ x: number; y: number } | null> => {
      const cap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
      const vp = cfg.visionModel ? await getVisionProvider() : cap === "vision" ? provider : null;
      if (!vp) return null;
      try {
        return await locateImage(vp, { path, mediaType: "image/png" }, target, { signal });
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
    // ── Header (rebuilt per 顾雅 spec, 2026-06):
    //   • Single-line logo + tagline (no ASCII banner block).
    //   • Identity line branches on profile kind: personal collapses to `personal <provider>:<model>`
    //     (route host only when baseURL is custom); org spreads to `org <label> · <id> → <host>`
    //     plus its own `model` line annotated with the source (org default / user override).
    //   • cwd line silently appends "· AGENTS.md" when loaded — we never show a negative noise line.
    //   • Vision routing is NOT in the header anymore — App emits a one-shot inline notice via
    //     `visionNotice` the first time an image lands in the session.
    const __mainCap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
    const __routeForHeader = routeHost(__activeP);
    // Model-source label (org only). `loadConfig` already merges env > project > overlay > globals,
    // so cfg.model is whatever the runtime will actually use. If it equals the profile's defaultModel
    // we treat it as "org default"; otherwise it's a user override (per-profile setModel, env, or flag).
    const __modelSource =
      __activeP.kind === "gateway"
        ? cfg.model && __activeP.defaultModel && cfg.model === __activeP.defaultModel
          ? "org default"
          : "user override"
        : undefined;
    // Lazy vision notice: only set it for the "describer in use" path (header used to always-on it).
    // Native-vision models stay silent (the routing IS direct, nothing to say). "Unknown" stays silent
    // too — the existing per-image picker (resolveImages) handles that on first paste.
    const __visionNotice =
      __mainCap === "text" && cfg.visionModel
        ? `${cfg.model} is text-only — images read by ${cfg.visionModel}`
        : undefined;
    await runTui({
      initialStatus: { sessionName: meta.title || shortId(meta.id), approval, input: stats.input, output: stats.output, ctxPct: 0, agents: 0 },
      model: cfg.model,
      cwd,
      header: {
        version: pkg.version,
        modelLabel: `${cfg.provider}:${cfg.model}`,
        cwd,
        agentsMdLoaded: hasAgentsMd(cwd),
        session: meta.id,
        kind: __activeP.kind === "gateway" ? "org" : "personal",
        profileId: __activeP.kind === "gateway" || __activeP.id === PERSONAL_ID ? undefined : __activeP.id,
        orgLabel: __activeP.kind === "gateway" ? __activeP.label : undefined,
        orgId: __activeP.kind === "gateway" ? __activeP.deviceId || __activeP.id : undefined,
        routeHost: __routeForHeader?.host,
        modelSource: __modelSource,
        visionModel: cfg.visionModel,
        // the pre-mount stdout notice (line ~2497) doesn't survive ink taking the screen — TUI users
        // never saw update notices and versions silently went stale (field report: stuck on 0.112.5)
        updateNotice: cfg.updateCheck ? (checkForUpdate(pkg.version) ?? undefined) : undefined,
        workspaceNotice: homeWorkspace
          ? "Home is not a project workspace · use /cd /path/to/project to switch"
          : undefined,
      },
      visionNotice: __visionNotice,
      cycleApproval: (m) => cycleMode(m),
      onClipboardImage: readClipboardImage,
      vim: cfg.vimMode,
      onSubmit: async (line, h, images, interaction) => {
        // `/continue` is a task interaction, not a control-only command: turn it into a model message before
        // slash dispatch, preserving the submitted turn id while explicitly targeting the unfinished task.
        const continueCommand = /^\/(?:continue|resume)(?:\s+([\s\S]+))?$/i.exec(line.trim());
        if (continueCommand) {
          if (!task || task.status === "completed") return void h.sink.notice("(there is no unfinished task to continue)");
          line = continueCommand[1]?.trim() || "continue";
          interaction = {
            kind: "steer",
            expectedTurnId: task.turnId,
            turnId: interaction?.turnId ?? newTurnInteraction().turnId,
          };
        }
        // A dropped/pasted file path (`/Users/…/doc.md`, maybe trailing text/images) starts with '/' but
        // is NOT a command — treat it as a file to read, not "Unknown command" (see isSlashCommand).
        if (isSlashCommand(line)) {
          const [nm, ...rest] = line.slice(1).split(/\s+/);
          const arg = rest.join(" ").trim();
          if (nm === "cd") {
            const result = resolveWorkspaceSwitch(arg, cwd);
            if (!result.ok) return void h.sink.notice(`(${result.error})`);
            if (result.cwd === realpathSync.native(cwd)) return void h.sink.notice(`(already in ${result.cwd})`);
            requestedWorkspaceSwitch = result.cwd;
            h.sink.notice(`(switching workspace → ${result.cwd})`);
            return void h.exit();
          }
          if (nm === "exit" || nm === "quit") {
            if (shouldAutoEvolve(cfg.evolve, history.length)) {
              h.sink.notice("✻ distilling session learnings…");
              try {
                await curateSessionLearning(provider, history, cfg, {
                  cwd,
                  sandbox,
                  spawn,
                  ui: { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice },
                  confirm: h.confirm,
                  memory: buildMemory(),
                  stats,
                  signal: h.signal,
                });
                persistSession();
              } catch {
                /* exit anyway */
              }
            }
            return void h.exit();
          }
          if (nm === "help") return void h.sink.notice(commands.map((x) => `/${x.name} — ${x.desc}`).join("\n"));
          if (nm === "tools")
            return void h.sink.notice(getTools().map((t) => `${t.name}${t.kind !== "read" ? " *" : ""} — ${t.description}`).join("\n"));
          if (nm === "evolve") {
            if (!arg || arg === "status") return void h.sink.notice(evolutionStatus(cfg));
            if (arg !== "now") return void h.sink.notice("usage: /evolve [status|now]");
            if (cfg.evolve === "off") return void h.sink.notice("(self-evolution is off — set `hara config set evolve light|proactive` first)");
            if (history.length < 2) return void h.sink.notice("(not enough session evidence to curate)");
            h.sink.notice("✻ curating evidence-backed memories and reusable skills…");
            const outcome = await curateSessionLearning(provider, history, cfg, {
              cwd,
              sandbox,
              spawn,
              ui: { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice },
              confirm: h.confirm,
              memory: buildMemory(),
              stats,
              signal: h.signal,
            });
            persistSession();
            return void h.sink.notice(outcome.status === "completed" ? "(self-evolution curation complete)" : `(self-evolution stopped: ${outcome.error ?? outcome.status})`);
          }
          if (nm === "reset" || nm === "clear") {
            history.length = 0;
            task = undefined;
            resumeTaskPending = false;
            continuationSession = false;
            recalledContext = "";
            resetReachability(); // fresh start — drop any "host unreachable" marks (network may be fixed)
            resetRepeatGuard(); // …and the repeated-failure streaks (the user may have fixed the cause)
            clearTouched();
            clearTodos();
            meta.todos = [];
            persistSession();
            return void h.sink.notice("(context cleared)");
          }
          if (nm === "undo") {
            const r = await undoLast();
            return void h.sink.notice("error" in r ? `(${r.error})` : `↩ reverted: ${r.files.join(", ")}`);
          }
          if (nm === "model") {
            const parts = (arg || "").trim().split(/\s+/).filter(Boolean);
            const force = parts.some((p) => p === "--force" || p === "all" || p === "-f");
            const id = parts.find((p) => p !== "--force" && p !== "all" && p !== "-f");
            if (!id) {
              // Bare /model → the interactive picker: the endpoint's live model list (↑↓) + its thinking
              // level (←→, per the registry's reasoning style). Falls back to typing an id if the endpoint
              // doesn't enumerate models.
              const bURL = cfg.baseURL ?? providerDefaultBaseURL(cfg.provider);
              const models = await listModels(bURL, cfg.apiKey ?? "");
              const style = resolvePlatform(cfg.provider, bURL).reasoning;
              const chosen = await h.pickModel({ models, style, current: cfg.model, effort: cfg.reasoningEffort });
              if (!chosen) return; // esc — no change
              if (chosen.model) {
                cfg.model = chosen.model;
                meta.model = chosen.model;
              }
              cfg.reasoningEffort = chosen.effort;
              visionProvider = undefined;
              remindedVision = false;
              const p2 = await buildProvider(cfg);
              if (!p2) return void h.sink.notice("(could not rebuild provider)");
              provider = p2;
              persistSession();
              return void h.sink.notice(`(model → ${cfg.provider}:${cfg.model} · thinking ${chosen.effort ?? "default"})`);
            }
            cfg.model = id;
            meta.model = id;
            setSessionForceModel(force);
            visionProvider = undefined; // new model may resolve a different describer / capability
            remindedVision = false;
            const p = await buildProvider(cfg);
            if (p) {
              provider = p;
              persistSession(); // persist the session-pinned model so resume restores it
              return void h.sink.notice(`(model → ${cfg.provider}:${id}${force ? " · forced (all roles)" : ""})`);
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
            persistSession();
            return void h.sink.notice(`(renamed → ${meta.title})`);
          }
          if (nm === "context") return void h.sink.notice(formatContextReport(history, cfg.model));
          if (nm === "task") {
            if (arg === "clear") {
              task = undefined;
              resumeTaskPending = false;
              persistSession();
              return void h.sink.notice("(task state cleared; conversation kept)");
            }
            return void h.sink.notice(formatTaskExecution(task));
          }
          if (nm === "new") {
            task = undefined;
            resumeTaskPending = false;
            clearTodos();
            meta.todos = [];
            persistSession();
            return void h.sink.notice("(new task boundary; conversation kept — type the new objective)");
          }
          if (nm === "rewind") {
            if (!arg) {
              const turns = userTurnPreviews(history);
              return void h.sink.notice(turns.length ? "Recent turns (newest first) — /rewind <n> (files unchanged):\n" + turns.map((t) => `  ${t.n}. ${t.preview}`).join("\n") : "(nothing to rewind)");
            }
            const nh = rewindTo(history, Number(arg));
            if (!nh) return void h.sink.notice(`(no such turn: ${arg})`);
            history.length = 0;
            history.push(...nh);
            task = undefined;
            resumeTaskPending = false;
            persistSession();
            return void h.sink.notice(`(rewound — kept ${history.length} messages; files unchanged. Type your next message.)`);
          }
          if (nm === "checkpoint") {
            const parts = arg.split(/\s+/);
            const cps = listCheckpoints(cwd);
            if (parts[0] !== "restore") {
              return void h.sink.notice(cps.length ? "File checkpoints (newest first) — /checkpoint restore <n>:\n" + cps.map((cp, i) => `  ${i + 1}. ${cp.sha}  ${cp.label}`).join("\n") : "(no checkpoints yet)");
            }
            const cp = cps[Number(parts[1]) - 1];
            if (!cp) return void h.sink.notice(`(no checkpoint ${parts[1] ?? ""})`);
            const k = restoreCheckpoint(cwd, cp.sha);
            return void h.sink.notice(k == null ? "(restore failed)" : `(restored ${k} file(s) to ${cp.sha} — '${cp.label}')`);
          }
          if (nm === "compact") {
            if (history.length < 2) return void h.sink.notice("(nothing to compact)");
            h.sink.notice("✻ compacting…");
            const cui = { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice };
            let distillOutcome: RunOutcome | undefined;
            if (cfg.evolve !== "off") {
              try {
                distillOutcome = await curateSessionLearning(provider, history, cfg, {
                  cwd,
                  sandbox,
                  spawn,
                  ui: cui,
                  confirm: h.confirm,
                  memory: buildMemory(),
                  stats,
                  signal: h.signal,
                });
              } catch {
                return void h.sink.notice("(compact cancelled — memory distillation did not complete)");
              }
            }
            if (h.signal.aborted || (distillOutcome && distillOutcome.status !== "completed")) {
              return void h.sink.notice("(compact cancelled — memory distillation was interrupted)");
            }
            const summary = await compactConversation(provider, history, meta, stats, h.signal, task);
            return void h.sink.notice(summary ? `(compacted — kept ${meta.workingSet?.length ?? 0} working-memory notes)` : "(nothing to compact / compact failed)");
          }
          if (nm === "sessions") {
            const ms = listSessions();
            return void h.sink.notice(
              ms.length ? ms.slice(0, 12).map((m) => `  ${shortId(m.id)}  ${m.updatedAt.slice(0, 16).replace("T", " ")}  ${m.title || "(untitled)"}`).join("\n") : "No sessions yet.",
            );
          }
          if (nm === "usage") return void h.sink.notice(`tokens — ↑${stats.input} ↓${stats.output}`);
          if (nm === "jobs") {
            const [sub, jid] = (arg || "").trim().split(/\s+/);
            if (sub === "kill" && jid) return void h.sink.notice(killJob(jid) ? `✕ killed ${jid}` : `no running job ${jid}`);
            if (sub === "tail" && jid) return void h.sink.notice(tailJob(jid) ?? `no job ${jid}`);
            return void h.sink.notice(renderBgJobs());
          }
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
          if (nm === "diff") {
            try {
              const d = (await runShell(arg === "staged" ? "git diff --staged" : "git diff HEAD", cwd, "off", { timeout: 30_000, maxBuffer: 8_000_000 })).stdout.trim();
              if (!d) return void h.sink.notice(arg === "staged" ? "(nothing staged)" : "(no changes vs HEAD — /diff staged for the index)");
              return void h.sink.diff(d.length > 12_000 ? d.slice(0, 12_000) + "\n…[truncated]" : d);
            } catch {
              return void h.sink.notice("(git diff failed — is this a git repo?)");
            }
          }
          if (nm === "commit") {
            h.sink.notice("✻ writing a commit message…");
            const r = await autoCommit(provider, cwd, h.signal); // stages all + commits with an AI message
            return void h.sink.notice(r.startsWith("error:") ? `✗ ${r}` : r === "nothing to commit" ? "(nothing to commit — make or stage changes first)" : `✓ committed · ${r.slice(0, 100)}`);
          }
          if (nm === "review") {
            const changes = captureChanges(cwd, 120_000, { includeUntracked: true });
            if (changes.error) return void h.sink.notice(`(review capture failed closed: ${changes.error})`);
            if (!changes.diff && !changes.newFiles.length && !changes.skippedFiles.length && !changes.omittedDeletions.length) {
              return void h.sink.notice("(nothing to review — no changes vs HEAD)");
            }
            if (changes.skippedFiles.length) {
              h.sink.notice(`Protected paths omitted: ${changes.skippedFiles.map((p) => JSON.stringify(p)).join(", ")}`);
            }
            const rui = { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice };
            const xin = stats.input;
            const xout = stats.output;
            await runAgent([{ role: "user", content: standaloneReviewPrompt(changes) }], {
              provider,
              ctx: { cwd, sandbox, ui: rui },
              approval: "full-auto", // read-only via the tool filter, so nothing prompts
              confirm: h.confirm,
              toolFilter: (n) => READONLY_TOOLS.has(n),
              hooks: false,
              systemOverride: REVIEW_SYSTEM,
              memory: buildMemory(),
              stats,
              signal: h.signal,
              ...agentRunLimits(cfg),
            });
            h.sink.usage(stats.input - xin, stats.output - xout);
            return;
          }
          if (byName.has(nm))
            return void h.sink.notice(`/${nm} isn't wired into the TUI yet — use \`hara ${nm} …\` as a subcommand, or HARA_TUI=0.`);
          // /<skill> — a user-invocable skill (built-in/global/plugin). ENTER it: load the skill + run a kickoff
          // turn so the agent acts at once (e.g. design mode opens its live workspace + surfaces prior progress).
          {
            const sk = loadSkillIndex(cwd).find((s) => s.id === nm && s.userInvocable);
            if (sk) {
              h.sink.notice(`↗ entering ${sk.id}…`);
              resumeTaskPending = false; // an explicit skill entry starts its own task
              clearTodos();
              meta.todos = [];
              const skillContent = `Skill \`${sk.id}\`:\n${loadSkillBody(sk)}\n\n---\nEntering ${sk.id} mode${arg ? ` — request: ${arg}` : ""}. Follow this skill now. If it has a workspace or live preview, OPEN it FIRST so any existing progress is visible, then proceed — offer to continue existing work or start fresh.`;
              const skillInteraction = interaction ?? newTurnInteraction();
              if (skillInteraction.kind === "steer") {
                const continued = continueTaskExecution(task, skillInteraction);
                if (!continued.ok) return void h.sink.notice(`(steer rejected: ${continued.reason})`);
                task = continued.task;
              } else {
                task = createTaskExecution(arg || `enter ${sk.id}`, skillInteraction.turnId);
              }
              const skillExecutionContext = taskExecutionContext(task, skillInteraction);
              history.push({ role: "user", content: skillContent });
              persistSession();
              const skin = stats.input;
              const skout = stats.output;
              // `h.approval` is the TUI-level union (includes "plan"); runAgent wants the config-level
              // ApprovalMode (no "plan"). Inside a /<skill> kickoff "plan" wouldn't make sense anyway —
              // fall back to "suggest" so we keep the user's confirm gate without crashing the type check.
              const __skApproval: ApprovalMode = h.approval === "plan" ? "suggest" : h.approval;
              let skillOutcome: RunOutcome | undefined;
              try {
                skillOutcome = await runAgent(history, { provider, ctx: { cwd, sandbox, spawn, ui: { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice }, ask: h.ask, describeImage: describeScreenshot, locate: locateScreenshot }, approval: __skApproval, confirm: h.confirm, autoApprove, projectContext, memory: buildMemory(), continuationSession, executionContext: skillExecutionContext, stats, signal: h.signal, fallback: fbOpt, guardian: guardianOpt, ...agentRunLimits(cfg) });
              } catch (e: any) {
                h.sink.notice(`[error] ${e?.message ?? e}`);
              }
              if (!meta.title && skillOutcome?.status === "completed" && !h.signal.aborted) {
                meta.title = await nameSession(provider, history, h.signal);
                h.sink.session(meta.title);
              }
              h.sink.usage(stats.input - skin, stats.output - skout);
              task = finishTaskExecution(task, skillOutcome, meta.todos ?? [], h.signal.aborted);
              keepUnfinishedTaskActive();
              persistSession();
              return;
            }
          }
          const near = nearest(nm, [...byName.keys()]);
          return void h.sink.notice(`Unknown command /${nm}.${near.length ? " Did you mean " + near.map((n) => "/" + n).join(", ") + "?" : ""}`);
        }
        // A message that begins with an absolute file path (the case skipped above) → inline it as an
        // @-mention so its content is read into the turn (drag-a-file-in → interpret it).
        line = inlineLeadingPath(line, existsSync);
        const ui = { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice };
        const appr = h.approval;
        let submittedInteraction: TaskInteraction = interaction ?? newTurnInteraction();
        if (resumeTaskPending && task && submittedInteraction.kind === "turn" &&
          (hasPendingTaskSteering(task) || requestsTaskContinuation(line))) {
          submittedInteraction = { kind: "steer", expectedTurnId: task.turnId, turnId: submittedInteraction.turnId };
        }
        const beginExecution = (objective: string): string | null => {
          if (submittedInteraction.kind === "steer") {
            const continued = continueTaskExecution(task, submittedInteraction);
            if (!continued.ok) {
              h.sink.notice(`(steer rejected: ${continued.reason})`);
              return null;
            }
            task = continued.task;
          } else {
            task = createTaskExecution(objective, submittedInteraction.turnId);
            clearTodos();
            meta.todos = [];
          }
          resumeTaskPending = false;
          return taskExecutionContext(task, submittedInteraction, meta.todos ?? []);
        };
        // Type-ahead steering: fold messages typed mid-turn into the next model call (codex-style) so a
        // clarification/addition course-corrects the live task, rather than waiting for a fresh turn.
        // Shared by every turn below (plan investigate, plan execute, and the regular turn).
        const pendingInput = async (): Promise<NeutralMsg[]> => {
          const freshMessages = new Map<string, NeutralMsg>();
          for (const it of h.drainQueue()) {
            const r2 = await resolveImages(it.images, h);
            const body = await expandMentionsAsync(it.line, cwd, { signal: h.signal }) + (r2.skip ? "" : (r2.extraText ?? ""));
            const attach = !r2.skip && r2.attach?.length ? r2.attach : undefined;
            if (!body.trim() && !attach) continue; // image-only message whose image was skipped → nothing to add
            const recorded = recordTaskSteering(task, it.expectedTurnId, body || "(image-only steering)");
            if (!recorded.ok) {
              h.sink.notice(`(steer rejected: ${recorded.reason})`);
              continue;
            }
            task = recorded.task;
            const accepted = task.steering?.at(-1);
            if (accepted?.deliveryState === "pending") {
              freshMessages.set(accepted.id, { role: "user", content: `${INTERJECT_PREFIX}\n\n${body}`, ...(attach ? { images: attach } : {}) });
            }
          }
          const consumed = consumePendingTaskSteering(task);
          if (!consumed) return [];
          const out = consumed.entries.map((entry): NeutralMsg => freshMessages.get(entry.id) ?? ({
            role: "user",
            content: `${INTERJECT_PREFIX}\n\n${entry.content}`,
          }));
          // Persist the projected transcript and consumed inbox state first, then update the same live
          // history synchronously. Returning [] prevents runAgent from appending the messages twice;
          // loop from appending twice; cancellation/error saves can no longer overwrite the projected input.
          saveSession(meta, [...history, ...out], consumed.task);
          task = consumed.task;
          history.push(...out);
          return [];
        };
        const turnStart = Date.now(); // for the task-done notification (gated on elapsed)
        if (appr === "plan") {
          // PLAN MODE: read-only investigate; the MODEL signals plan-readiness by calling `exit_plan`
          // (Claude-Code style handshake) — only then do we pop the proceed prompt. Turns that were just
          // investigation / Q&A end back at the input, still in plan mode, with no nagging.
          const planImg = await resolveImages(images, h);
          if (planImg.skip) return;
          const planContent = (recalledContext ? `${recalledContext}\n\n---\n\n` : "") + await expandMentionsAsync(line, cwd, { signal: h.signal }) + (planImg.extraText ?? "");
          const executionContext = beginExecution(line);
          if (!executionContext) return;
          history.push({ role: "user", content: planContent, ...(planImg.attach?.length ? { images: planImg.attach } : {}) });
          persistSession();
          recalledContext = "";
          const pin = stats.input;
          const pout = stats.output;
          // Run-scoped tool (never in the registry, so no other mode can see it): captures the proposed
          // plan and renders it as a bordered block (codex's ProposedPlanCell equivalent) via the sink.
          let proposedPlan: string | null = null;
          const exitPlanTool: Tool = {
            name: "exit_plan",
            description:
              "Call when your plan is complete and ready for the user to approve. Pass the FULL plan as concise " +
              "markdown (short numbered steps). This ends the planning phase — after calling it, stop and wait.",
            input_schema: { type: "object", properties: { plan: { type: "string", description: "the complete plan (markdown, short numbered steps)" } }, required: ["plan"] },
            kind: "read", // never prompts — submitting a plan is not a mutation
            run: async (input, tctx) => {
              proposedPlan = String((input as { plan?: unknown })?.plan ?? "").trim();
              if (proposedPlan) tctx.ui?.diff(renderPlanBlock(proposedPlan));
              return "Plan submitted to the user for approval. Stop now and wait for their decision — do not keep working.";
            },
          };
          let planOutcome = await runAgent(history, {
            provider,
            ctx: { cwd, sandbox, spawn, ui, ask: h.ask, describeImage: describeScreenshot, locate: locateScreenshot },
            approval: "suggest",
            confirm: h.confirm,
            toolFilter: (n) => READONLY_TOOLS.has(n),
            hooks: false,
            extraTools: [exitPlanTool],
            systemOverride: PLAN_SYSTEM,
            memory: buildMemory(),
            projectContext,
            continuationSession,
            executionContext,
            stats,
            signal: h.signal,
            pendingInput,
            ...agentRunLimits(cfg),
          });
          if (!meta.title && planOutcome.status === "completed" && !h.signal.aborted) {
            meta.title = await nameSession(provider, history, h.signal);
            h.sink.session(meta.title);
          }
          h.sink.usage(stats.input - pin, stats.output - pout);
          persistSession();
          if (planOutcome.status !== "completed" || h.signal.aborted) {
            task = finishTaskExecution(task, planOutcome, meta.todos ?? [], h.signal.aborted);
            keepUnfinishedTaskActive();
            persistSession();
            notifyDone(cfg.notify, {
              message: planOutcome.error ?? "plan turn did not complete",
              elapsedMs: Date.now() - turnStart,
              minMs: 0,
            });
            return;
          }
          if (!proposedPlan) {
            // No exit_plan this turn — the model was investigating or answering. Stay in plan mode quietly.
            task = finishTaskExecution(task, planOutcome, meta.todos ?? [], h.signal.aborted);
            keepUnfinishedTaskActive();
            persistSession();
            notifyDone(cfg.notify, {
              message: meta.title || "plan turn complete",
              elapsedMs: Date.now() - turnStart,
            });
            return;
          }
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
            planOutcome = await runAgent(history, {
              provider,
              ctx: { cwd, sandbox, spawn, ui, ask: h.ask, describeImage: describeScreenshot, locate: locateScreenshot },
              approval: choice as ApprovalMode,
              memory: buildMemory(),
              confirm: h.confirm,
              autoApprove,
              projectContext,
              continuationSession,
              executionContext,
              stats,
              signal: h.signal,
              pendingInput,
              guardian: guardianOpt,
              ...agentRunLimits(cfg),
            });
            h.sink.usage(stats.input - xin, stats.output - xout);
          }
          task = choice === "no"
            ? finishTaskExecution(task, planOutcome, [{ text: "execute approved plan", status: "pending" }], false)
            : finishTaskExecution(task, planOutcome, meta.todos ?? [], h.signal.aborted);
          keepUnfinishedTaskActive();
          persistSession();
          notifyDone(cfg.notify, {
            message: planOutcome.status === "halted" ? (planOutcome.error ?? "agent run halted") : (meta.title || "plan turn complete"),
            elapsedMs: Date.now() - turnStart,
            minMs: planOutcome.status === "halted" ? 0 : undefined,
          });
          return;
        }
        const ri = await resolveImages(images, h);
        if (ri.skip) return;
        const userContent = (recalledContext ? `${recalledContext}\n\n---\n\n` : "") + await expandMentionsAsync(line, cwd, { signal: h.signal }) + (ri.extraText ?? "");
        recalledContext = "";
        const executionContext = beginExecution(line);
        if (!executionContext) return;
        history.push({ role: "user", content: userContent, ...(ri.attach?.length ? { images: ri.attach } : {}) });
        persistSession();
        if (cfg.fileCheckpoints) checkpoint(cwd, line.slice(0, 80)); // shadow-git snapshot before the turn mutates
        const beforeIn = stats.input;
        const beforeOut = stats.output;
        const turnOutcome = await runAgent(history, {
          provider,
          ctx: { cwd, sandbox, spawn, ui, ask: h.ask, describeImage: describeScreenshot, locate: locateScreenshot },
          approval: appr,
          memory: buildMemory(),
          confirm: h.confirm,
          autoApprove,
          projectContext,
          continuationSession,
          executionContext,
          stats,
          signal: h.signal,
          pendingInput,
          fallback: fbOpt,
          guardian: guardianOpt,
          ...agentRunLimits(cfg),
        });
        if (!meta.title && turnOutcome.status === "completed" && !h.signal.aborted) {
          meta.title = await nameSession(provider, history, h.signal);
          h.sink.session(meta.title);
        }
        h.sink.usage(stats.input - beforeIn, stats.output - beforeOut);
        notifyDone(cfg.notify, {
          message: turnOutcome.status === "halted" ? (turnOutcome.error ?? "agent run halted") : (meta.title || "turn complete"),
          elapsedMs: Date.now() - turnStart,
          minMs: turnOutcome.status === "halted" ? 0 : undefined,
        });
        task = finishTaskExecution(task, turnOutcome, meta.todos ?? [], h.signal.aborted);
        keepUnfinishedTaskActive();
        persistSession();
        if (turnOutcome.status === "completed" && !h.signal.aborted) {
          await maybeAutoCompact(provider, history, meta, stats, cfg, (m) => h.sink.notice(m), h.signal, task);
        }
      },
    });
    // Only claim "saved · resume" if a turn actually persisted the session. A zero-turn session (opened,
    // then exited without submitting anything) is never written by saveSession — so printing the resume
    // hint would mislead and `hara resume <id>` would fail with "no session matching".
    if (loadSession(meta.id))
      out("\n" + c.dim("Session ") + c.bold(shortId(meta.id)) + c.dim(" saved · resume:  ") + c.cyan(`hara resume ${shortId(meta.id)}`) + "\n");
    await closeMcp();
    await relaunchRequestedWorkspace();
    process.exit(process.exitCode ?? 0); // TUI done — exit cleanly (ink can leave stdin referenced)
  }

  out(c.dim(`Type a task. /help · @path attaches a file · shift+tab cycles mode · Esc interrupts · /exit to quit.${hasAgentsMd(cwd) ? "  (AGENTS.md loaded)" : ""}\n\n`));

  bar.install({ sessionName: meta.title || shortId(meta.id), model: cfg.model, approval, input: stats.input, output: stats.output, profileId: __activeP.id, profileKind: __activeP.kind });
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
    let forcedContinuation: Extract<TaskInteraction, { kind: "steer" }> | undefined;
    const continueCommand = /^\/(?:continue|resume)(?:\s+([\s\S]+))?$/i.exec(line);
    if (continueCommand) {
      if (!task || task.status === "completed") {
        out(c.dim("(there is no unfinished task to continue)\n"));
        continue;
      }
      line = continueCommand[1]?.trim() || "continue";
      forcedContinuation = newSteerInteraction(task.turnId);
    }
    // A dropped/pasted file path starts with '/' but isn't a command — read it, don't error (see TUI path).
    if (isSlashCommand(line)) {
      const [name, ...rest] = line.slice(1).split(/\s+/);
      const cmd = byName.get(name);
      if (!cmd) {
        const sk = loadSkillIndex(cwd).find((s) => s.id === name && s.userInvocable);
        if (sk) {
          // ENTER the mode: load the skill + run a kickoff turn now (mirrors the TUI path) so e.g. /design
          // opens its workspace + surfaces prior progress immediately, instead of just staging context.
          out(c.dim(`↗ entering ${sk.id}…\n`));
          const skillContent = `Skill \`${sk.id}\`:\n${loadSkillBody(sk)}\n\n---\nEntering ${sk.id} mode${rest.length ? ` — request: ${rest.join(" ")}` : ""}. Follow this skill now. If it has a workspace or live preview, OPEN it FIRST so any existing progress is visible, then proceed — offer to continue existing work or start fresh.`;
          const skillInteraction = newTurnInteraction();
          resumeTaskPending = false;
          clearTodos();
          meta.todos = [];
          task = createTaskExecution(rest.join(" ") || `enter ${sk.id}`, skillInteraction.turnId);
          const skillExecutionContext = taskExecutionContext(task, skillInteraction);
          history.push({ role: "user", content: skillContent });
          persistSession();
          const skillTurn = new AbortController();
          currentTurn = skillTurn;
          let skillOutcome: RunOutcome | undefined;
          try {
            skillOutcome = await runAgent(history, { provider, ctx: { cwd, sandbox, spawn, ask: askUser }, approval, confirm, autoApprove, projectContext, memory: buildMemory(), continuationSession, executionContext: skillExecutionContext, stats, signal: skillTurn.signal, fallback: fbOpt, guardian: guardianOpt, ...agentRunLimits(cfg) });
          } catch (e: any) {
            out(c.red(`\n[error] ${e.message}\n`));
          }
          try {
            if (!meta.title && skillOutcome?.status === "completed" && !skillTurn.signal.aborted) {
              meta.title = await nameSession(provider, history, skillTurn.signal);
            }
            task = finishTaskExecution(task, skillOutcome, meta.todos ?? [], skillTurn.signal.aborted);
            keepUnfinishedTaskActive();
            persistSession();
          } finally {
            if (currentTurn === skillTurn) currentTurn = null;
          }
          continue;
        }
        const near = nearest(name, [...byName.keys()]);
        const hint = near.length ? c.dim(` Did you mean ${near.map((n) => "/" + n).join(", ")}?`) : "";
        out(c.red(`Unknown command /${name}.`) + hint + c.dim(" — /help for the list.\n"));
        continue;
      }
      const res = await cmd.run(rest.join(" "));
      if (res === "exit") break;
      continue;
    }
    line = inlineLeadingPath(line, existsSync); // leading dropped file path → @-mention so it's read in
    const userContent = (recalledContext ? `${recalledContext}\n\n---\n\n` : "") + await expandMentionsAsync(line, cwd);
    recalledContext = "";
    const recoveredClassicSteering = consumePendingTaskSteering(task);
    if (recoveredClassicSteering) {
      task = recoveredClassicSteering.task;
      history.push(...recoveredClassicSteering.entries.map((entry): NeutralMsg => ({
        role: "user",
        content: `${INTERJECT_PREFIX}\n\n${entry.content}`,
      })));
    }
    let interaction: TaskInteraction = forcedContinuation ?? newTurnInteraction();
    if (resumeTaskPending && task && (recoveredClassicSteering !== null || requestsTaskContinuation(line))) {
      interaction = newSteerInteraction(task.turnId);
    }
    if (interaction.kind === "steer") {
      const continued = continueTaskExecution(task, interaction);
      if (!continued.ok) {
        out(c.red(`(steer rejected: ${continued.reason})\n`));
        continue;
      }
      task = continued.task;
    } else {
      task = createTaskExecution(line, interaction.turnId);
      clearTodos();
      meta.todos = [];
    }
    resumeTaskPending = false;
    const executionContext = taskExecutionContext(task, interaction, meta.todos ?? []);
    history.push({ role: "user", content: userContent });
    persistSession();
    if (cfg.fileCheckpoints) checkpoint(cwd, userContent.slice(0, 80)); // shadow-git snapshot before the turn mutates
    const turnController = new AbortController();
    currentTurn = turnController;
    const t0 = Date.now();
    let turnOutcome: RunOutcome | undefined;
    try {
      turnOutcome = await runAgent(history, { provider, ctx: { cwd, sandbox, spawn, ask: askUser }, approval, confirm, autoApprove, projectContext, memory: buildMemory(), continuationSession, executionContext, stats, signal: turnController.signal, fallback: fbOpt, guardian: guardianOpt, ...agentRunLimits(cfg) });
    } catch (e: any) {
      out(c.red(`\n[error] ${e.message}\n`));
    }
    notifyDone(cfg.notify, {
      message: turnOutcome?.status === "halted" ? (turnOutcome.error ?? "agent run halted") : (meta.title || "turn complete"),
      elapsedMs: Date.now() - t0,
      minMs: turnOutcome?.status === "halted" ? 0 : undefined,
    });
    try {
      if (!meta.title && turnOutcome?.status === "completed" && !turnController.signal.aborted) {
        meta.title = await nameSession(provider, history, turnController.signal);
      }
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
      task = finishTaskExecution(task, turnOutcome, meta.todos ?? [], turnController.signal.aborted);
      keepUnfinishedTaskActive();
      persistSession();
      const compacted = turnOutcome?.status === "completed" && !turnController.signal.aborted
        ? await maybeAutoCompact(provider, history, meta, stats, cfg, (m) => out(c.dim(`${m}\n`)), turnController.signal, task)
        : false;
      if (!compacted) {
        const ctxPct = bar.ctxPctFor(cfg.model, stats.lastInput ?? 0);
        if (ctxPct >= 80) out(c.yellow(`  ⚠ context ${ctxPct}% full — /compact to summarize, or /clear to reset\n`));
      }
    } finally {
      if (currentTurn === turnController) currentTurn = null;
    }
  }
  bar.uninstall();
  if (loadSession(meta.id))
    out("\n" + c.dim("Session ") + c.bold(shortId(meta.id)) + c.dim(" saved · resume:  ") + c.cyan(`hara resume ${shortId(meta.id)}`) + "\n");
  rl.close();
  await closeMcp();
  await relaunchRequestedWorkspace();
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
