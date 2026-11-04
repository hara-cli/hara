import { withWorkspaceModelProxy } from "../network/model-fetch.js";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runGovernedAgent, type RunOpts, type RunOutcome } from "../agent/loop.js";
import { CompletionEvidenceLedger } from "../agent/completion-evidence.js";
import type { NeutralMsg, TurnArgs, ToolUse } from "../providers/types.js";
import { createCodingContinuationStore } from "../coding/continuations.js";
import { workspaceStateHome } from "../workspace/resource-context.js";
import { redactToolSubprocessOutput } from "../security/subprocess-env.js";
import { createCodingHostBridge } from "../coding/host.js";
import { assertWorkspaceRunAdmission, workspaceRuntimeStorage, workspaceRunRuntimeStages, recordWorkspacePiNativeCalls, publishWorkspaceNativeRisks, workspaceRunHasLegacyToolPolicy } from "../workspace/execution.js";
import { canonical } from "../workspace/local-state.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import { createRegisteredCliMcpTurn, WORKSPACE_MCP_TOKEN_ENV } from "./registered-cli-mcp.js";
import { piNativeModelTools, PI_NATIVE_TOOL_NAMES } from "./pi-native-tools.js";
import { PiRpcProcess, type PiProtectedProcessBoundary } from "./pi-rpc-process.js";
import { PiNativeSessionStore } from "./pi-native-session.js";
import { beginWorkspaceNativePolicy, endWorkspaceNativePolicy } from "./workspace-native-policy.js";
import { createRuntimeExecutionPolicy, workspaceRunPermissionTier, type RuntimeExecutionPolicy } from "./execution-policy.js";
import { classifyRuntimeFailure, type RuntimeFailureKind } from "./failure-diagnostics.js";
import { runtimeFailureTracker } from "./failure-tracker.js";
import { runtimeProxyFailure } from "../security/runtime-proxy.js";
import type { PiNativeChildConfig } from "./pi-rpc-entry.js";

export function piNativeLauncher(): { command: string; args: string[] } {
  const command = realpathSync.native(process.execPath), cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const embedded = Boolean(process.versions.bun) && (!existsSync(cli) || cli.includes("/$bunfs/"));
  if (!embedded && !existsSync(cli)) throw new Error("Pi native RPC requires the built Hara distribution");
  return { command, args: [...(embedded ? [] : [cli]), "--internal-pi-rpc", "--mode", "rpc", "--config-fd", "3"] };
}
function processBoundary(policy: RuntimeExecutionPolicy, input: ReturnType<typeof piNativeLauncher>, env: NodeJS.ProcessEnv, cwd: string): PiProtectedProcessBoundary {
  const wrapped = policy.wrap({ ...input, env }) as ReturnType<RuntimeExecutionPolicy["wrap"]> & {
    onProcess?: (child: ChildProcess, processGroup: boolean) => Promise<void>; drainProcess?: () => Promise<void> };
  if (typeof wrapped.onProcess !== "function" || typeof wrapped.drainProcess !== "function") throw new Error("Pi requires the shared protected process-tree drain");
  const register = wrapped.onProcess, drain = wrapped.drainProcess;
  return { spawn() {
    const child = spawn(wrapped.command, wrapped.args, { env: wrapped.env, cwd, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    return { child: child as ChildProcessWithoutNullStreams, ready: register(child, true) };
  }, drain };
}
function writeConfig(root: string, name: string, value: unknown): void {
  const file = join(root, "agent", name), temporary = file + ".host-next";
  writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}

function newPiWorkspaceNativePolicy(permit: NonNullable<RunOpts["workspaceRun"]>, accountHome: string, runtimeHome: string): RuntimeExecutionPolicy {
  const policy = createRuntimeExecutionPolicy({ runtimeId: "pi", managedProjectPermit: permit, tier: workspaceRunPermissionTier(permit),
    accountHome, runtimeHome, workRoot: permit.binding.project.root,
    protectedStateRoots: [workspaceRuntimeStorage(permit).run(() => workspaceStateHome())], lifetime: "attempt", loginSource: "isolated" });
  try { beginWorkspaceNativePolicy(permit, policy); return policy; } catch (error) { void policy.close(); throw error; }
}

/** Native tools remain in Pi. The only governor yields are real Hara MCP calls. */
export async function runFullProtectedPi(history: NeutralMsg[], options: RunOpts, installer: WorkspaceRuntimeInstaller): Promise<RunOutcome> {
  const permit = options.workspaceRun;
  if (!permit) return { status: "error", error: "Pi protected mode requires a trusted Workspace permit" };
  const assertCurrent = () => assertWorkspaceRunAdmission(permit, options, "pi");
  assertCurrent();
  // Do not launch native writes against a branch which has not yet received the common C-lite N1 contract.
  if (typeof (CompletionEvidenceLedger.prototype as unknown as { observeNative?: unknown }).observeNative !== "function") {
    return { status: "error", error: "Pi full-protected requires the shared native evidence/C-lite integration; no fallback was started" };
  }
  const tracker = runtimeFailureTracker(installer, "pi", permit.binding.agent.agentId,
    canonical([permit.binding.connection, permit.binding.agent.configRevision, installer.proxy.read().revision]), { env: {}, loginSource: "isolated" });
  const held = tracker.blocked(); if (held) return { status: "error", error: held };
  const began = Date.now();
  let modelFailure: RuntimeFailureKind | undefined, activeArgs: TurnArgs | undefined, policy: RuntimeExecutionPolicy | undefined;
  let sessionStore: PiNativeSessionStore | undefined, finalSession: string | undefined, drained = false, sawOutput = false;
  let gateway: Awaited<ReturnType<typeof createCodingHostBridge>> | undefined, rpc: PiRpcProcess | undefined;
  const tools = new Map<string, (failed: boolean) => void>();
  const stages = workspaceRunRuntimeStages(permit);
  const nativeTools = workspaceRunHasLegacyToolPolicy(permit) ? [] : [...PI_NATIVE_TOOL_NAMES];
  const issuedIds = new Set<string>();
  const noteIssued = (calls: readonly ToolUse[]) => {
    assertCurrent();
    if (calls.some(call => issuedIds.has(call.id))) throw new Error("Pi native tool id repeated");
    for (const call of calls) issuedIds.add(call.id);
    recordWorkspacePiNativeCalls(permit, calls.filter(call => (PI_NATIVE_TOOL_NAMES as readonly string[]).includes(call.name)).map(call => call.name));
  };
  const native = createRegisteredCliMcpTurn({ signal: options.signal!, assertCurrent, jsonEvents: false, deferNativeCompletion: true,
    prompt(args) {
      activeArgs = args;
      const records = sessionStore?.resumed ? history.slice(sessionStore.promptHistoryStart) : args.history;
      return records.length ? "Hara authoritative conversation:\n" + JSON.stringify(records) : "Continue this same frozen Hara task without repeating completed or outcome-unknown actions.";
    },
    async launch(endpoint, prompt, activity) {
      let endSpawn: ((...args: any[]) => void) | undefined, endCold: ((...args: any[]) => void) | undefined;
      const safe = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };
      try {
        assertCurrent();
        const context = await installer.prepareBuiltinPi(native.signal); assertCurrent();
        sessionStore = new PiNativeSessionStore(workspaceRuntimeStorage(permit), permit.binding, history);
        const root = sessionStore.root, agentDir = join(root, "agent");
        for (const name of ["auth.json", "models.json", "models-store.json"]) writeConfig(root, name, {});
        policy = newPiWorkspaceNativePolicy(permit, context.accountHome, agentDir);
        const audience = createHash("sha256").update(canonical(permit.binding) + "\0" + policy.key + "\0" + Date.now()).digest("hex");
        const storage = workspaceRuntimeStorage(permit);
        const continuationStore = storage.run(() => createCodingContinuationStore(workspaceStateHome(), {
          workerId: "pi-native-" + permit.binding.agent.agentId, providerSessionId: "ext_pi_" + createHash("sha256").update(permit.binding.runId).digest("hex").slice(0, 24),
          cwd: options.ctx.cwd, providerId: options.provider.id, model: permit.binding.connection.model,
          connectionRuntimeKey: createHash("sha256").update(canonical(permit.binding.connection)).digest("hex"),
        }));
        gateway = await createCodingHostBridge({ continuationStore: { load: key => storage.run(() => continuationStore.load(key)),
          save: (key, value) => storage.run(() => continuationStore.save(key, value)) }, provider: { id: options.provider.id, model: options.provider.model,
          prepareTurn: async (messages, signal) => withWorkspaceModelProxy(context.proxyUrl, async () => options.provider.prepareTurn?.(messages, signal)), async turn(args) {
            assertCurrent(); sessionStore!.accepted();
            const current = activeArgs!;
            const result = await withWorkspaceModelProxy(context.proxyUrl, () => options.provider.turn({ ...args, system: current.system + "\n\n" + args.system,
              onActivity: () => { activity(); }, onText: () => {}, onReasoning: () => {} }));
            if (result.stop === "error") modelFailure = classifyRuntimeFailure({ stderr: result.errorMsg, status: result.errorMetadata?.status });
            return result;
          } }, tools: piNativeModelTools(options.ctx.cwd, activeArgs!.tools, nativeTools),
          nativeModel: { audience, onNativeTools: noteIssued }, budget: { ...(permit.binding.budget.mode === "interactive" ? { mode: "interactive" as const } : {}), maxProviderRounds: permit.binding.budget.maxRounds,
            maxToolCalls: permit.binding.budget.maxToolCalls, maxTokens: permit.binding.budget.maxTokens, timeoutMs: permit.binding.budget.timeoutMs },
          assertCurrent, signal: native.signal, executeTool: async () => { throw new Error("The model capability cannot execute Hara tools"); } });
        const modelOptions = gateway.provider.hara!.options as { baseURL: string; apiKey: string };
        const config: PiNativeChildConfig = { schemaVersion: 1, sdkVersion: "1.5.0", root, cwd: options.ctx.cwd,
          system: "Execute this Hara task using only the selected native tools and supplied Hara MCP. Hara owns all persistent scheduling and confirmation. Do not create an independent scheduler or background daemon that outlives this task.",
          model: { baseURL: modelOptions.baseURL, token: modelOptions.apiKey },
          mcp: { url: endpoint.url, token: endpoint.env[WORKSPACE_MCP_TOKEN_ENV]!, tools: activeArgs!.tools }, nativeTools, sessionFile: sessionStore.sessionFile };
        const launch = piNativeLauncher();
        const env: NodeJS.ProcessEnv = { HOME: join(root, "home"), USERPROFILE: join(root, "home"), PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", HARA_UPDATE_CHECK: "0", NO_COLOR: "1", NODE_DISABLE_COMPILE_CACHE: "1",
          PATH: dirname(launch.command) + ":/usr/bin:/bin:/usr/sbin:/sbin", XDG_CONFIG_HOME: join(root, "home/.config"), XDG_CACHE_HOME: join(root, "home/.cache"),
          XDG_DATA_HOME: join(root, "home/.local/share") };
        safe(() => stages?.setRuntime({ id: "pi", version: "1.5.0", loginSource: "isolated", model: permit.binding.connection.model, effort: null }));
        endSpawn = safe(() => stages?.beginEvent("spawn")); endCold = safe(() => stages?.beginEvent("cold_start", { source: "native_event" }));
        rpc = new PiRpcProcess({ ...launch, env, configuration: config, cwd: options.ctx.cwd, boundary: processBoundary(policy, launch, env, options.ctx.cwd),
          timeoutMs: permit.binding.budget.timeoutMs, governedPrompt: permit.binding.budget.mode === "interactive", signal: native.signal, onAccepted: () => sessionStore!.accepted(),
          onFrame(frame) {
            assertCurrent(); activity();
            if (frame.type === "message_update" && frame.assistantMessageEvent?.type === "text_delta" && typeof frame.assistantMessageEvent.delta === "string") {
              if (!sawOutput) { sawOutput = true; safe(() => stages?.mark("first_output", "native_event")); }
            }
            if (frame.type === "tool_execution_start" && typeof frame.toolCallId === "string" && typeof frame.toolName === "string") {
              if (tools.size >= 256) throw new Error("Pi native event limit exceeded");
              const stop = safe(() => stages?.beginEvent("tool_call", { toolName: frame.toolName, source: "native_event" }));
              tools.set(frame.toolCallId, failed => { stop?.(failed ? "error" : "completed", failed ? "runtime_failed" : undefined); });
              policy!.observeNativeEvent({ type: frame.toolName === "bash" ? "command" : (PI_NATIVE_TOOL_NAMES as readonly string[]).includes(frame.toolName) ? "file" : "tool", status: "started", id: frame.toolCallId,
                path: typeof frame.args?.path === "string" ? frame.args.path : undefined, operation: frame.toolName,
                command: frame.toolName === "bash" && typeof frame.args?.command === "string" ? frame.args.command : undefined });
            }
            publishWorkspaceNativeRisks(permit);
            if (frame.type === "tool_execution_end" && typeof frame.toolCallId === "string") {
              tools.get(frame.toolCallId)?.(frame.isError === true); tools.delete(frame.toolCallId);
              policy!.observeNativeEvent({ type: "tool", id: frame.toolCallId, status: frame.isError === true ? "failed" : "completed" });
              publishWorkspaceNativeRisks(permit);
            }
          } });
        endSpawn?.("completed"); endSpawn = undefined;
        await rpc.state(); endCold?.("completed"); endCold = undefined;
        const continuation = history.slice(sessionStore.promptHistoryStart);
        const actualPrompt = sessionStore.resumed ? "Continue the same frozen Hara task without replaying completed actions.\n" +
          (continuation.length ? JSON.stringify(continuation) : "No new human message; continue only unfinished work.") : prompt;
        const result = await rpc.prompt(actualPrompt);
        if (typeof result.state.sessionFile !== "string") throw new Error("Pi native session receipt missing");
        finalSession = result.state.sessionFile;
        return { ok: true, stdout: redactToolSubprocessOutput(result.text, {
          HARA_PI_MODEL_TOKEN: modelOptions.apiKey, HARA_WORKSPACE_MCP_TOKEN: endpoint.env[WORKSPACE_MCP_TOKEN_ENV],
          HARA_PI_SESSION_SECRET: typeof result.state.sessionId === "string" ? result.state.sessionId : undefined,
        }), code: 0, timedOut: false };
      } catch (error) {
        const kind = native.signal.aborted ? "runtime_failed" : modelFailure ?? (runtimeProxyFailure(error) ? "runtime_proxy" : rpc?.classify(stderr => classifyRuntimeFailure({ stderr, timedOut: error instanceof Error && /^Pi RPC (?:turn )?timeout$/.test(error.message) })) ?? "spawn_failed");
        safe(() => endSpawn?.(native.signal.aborted ? "cancelled" : "error", kind)); safe(() => endCold?.(native.signal.aborted ? "cancelled" : "error", kind));
        return { ok: false, stdout: "", code: null, timedOut: kind === "timeout", ...(native.signal.aborted ? { errorCode: "interrupted" } : { runtimeFailure: tracker.failed(kind, Date.now() - began) }) };
      } finally {
        const closing = await Promise.allSettled([rpc?.close(), gateway?.close()]);
        drained = closing.every(result => result.status === "fulfilled");
        if (drained && policy) await endWorkspaceNativePolicy(permit, policy);
        if (drained && finalSession) tracker.succeeded();
        if (!drained) throw new Error("Pi native physical drain is incomplete");
      }
    } });
  try {
    return await runGovernedAgent(history, options, "pi", (provider, args) => { activeArgs = args; return native.turn(args); });
  } finally {
    await native.close(history);
    if (drained && finalSession && sessionStore) sessionStore.finished(finalSession, history);
    if (policy) await policy.close();
  }
}
