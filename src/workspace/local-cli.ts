import { randomUUID } from "node:crypto";
import { startLocalWorkspaceServe } from "../serve/local-workspace.js";
import { LocalWorkspaceHost } from "./local-host.js";
import { messageBody, text } from "./local-state.js";
import { ARK_CONTEXT_TRIM_SLICE } from "./real-key-provider.js";
import { WorkspaceBudgetAdmissionError } from "./tree-budget.js";
import { homedir, userInfo } from "node:os";

/** Operator-only paths, never accepted from model/RPC. Writes stay under hostHome; discovery and
 * legacy reads use the OS account Home, not the Workspace/SDK/isolated process HOME. */
export function workspaceHostSources(env: NodeJS.ProcessEnv = process.env, osHome: string = userInfo().homedir) {
  return { hostHome: env.HARA_WORKSPACE_HOST_HOME ?? homedir(), discoveryHome: env.HARA_WORKSPACE_DISCOVERY_HOME ?? osHome,
    legacySourceHome: env.HARA_WORKSPACE_LEGACY_SOURCE_HOME ?? osHome };
}

/** Real CLI entry for the explicitly opted-in synthetic local Workspace lane. No legacy boot/config. */
export async function mainLocalWorkspaceCli(args: string[], mode?: "workspace"): Promise<void> {
  const command = args[0];
  if (!command || ["--help", "-h", "help"].includes(command)) {
    console.log(mode ? "hara workspace <init|status|serve|run> --root /absolute/private/workspace-root\nWorkspace-scoped connections and built-in Pi; no global profile/Key import or synthetic fallback.\nserve: --port 0; run: --workspace ws_ID --agent ag_ID --message TEXT [--resume]"
      : "hara workspace-dev <init|status|serve|run> --root /absolute/private/fixture-root\nSynthetic by default. Explicit --ark-key-file ABS opts into the original bounded real-key slice (300k tokens / 24 requests). Add --ark-slice context-trim-20261017 for the separately approved 150k / 24 request slice; prior usage remains in the same ledger and the original allowance is disabled.\nNo global profile import, deployment or existing Dev control.\nserve: --port 0; run: --workspace ws_ID --agent ag_ID --message TEXT [--resume]"); return;
  }
  if (!["init", "status", "serve", "run"].includes(command)) throw new Error("unsupported Workspace Dev command");
  const values = new Map<string, string>(); let resume = false;
  for (let index = 1; index < args.length; index++) {
    const key = args[index]!;
    if (key === "--resume" && !resume) { resume = true; continue; }
    if (!["--root", "--port", "--workspace", "--agent", "--message", "--request-id", "--ark-key-file", "--ark-slice"].includes(key) || values.has(key) || index + 1 >= args.length) throw new Error("invalid Workspace Dev option");
    values.set(key, args[++index]!);
  }
  const root = values.get("--root"); if (!text(root, 4096)) throw new Error("explicit --root private fixture directory is required");
  if (mode && (values.has("--ark-key-file") || values.has("--ark-slice"))) throw new Error("Workspace mode cannot import acceptance credentials");
  const slice = values.get("--ark-slice");
  if (slice !== undefined && (slice !== ARK_CONTEXT_TRIM_SLICE || !values.has("--ark-key-file"))) throw new Error("invalid explicit real-key slice");
  if (command === "serve") {
    const port = Number(values.get("--port") ?? 0);
    const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port, cwd: root,
      ...(process.env.HARA_WORKSPACE_DEV_TOKEN ? { token: process.env.HARA_WORKSPACE_DEV_TOKEN } : {}) },
      { root, mode, ...(mode ? workspaceHostSources() : {}), realKeyFile: values.get("--ark-key-file"), realKeySlice: slice, version: "0.187.1", allowedOrigins: ["http://127.0.0.1:1437", "http://localhost:1437", "http://localhost:1420", "http://127.0.0.1:1420"] });
    console.log(JSON.stringify({ type: mode ? "workspace-ready" : "workspace-dev-ready", protocol: 1, capability: mode ? "workspace.v1" : "workspace.local-dev.v2", port: handle.port, syntheticOnly: !mode && !values.has("--ark-key-file") }));
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; void handle.close().catch(() => { process.exitCode = 1; }); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop); return;
  }
  const host = new LocalWorkspaceHost(root, { mode, ...(mode ? workspaceHostSources() : {}), interactiveApprovals: false, realKeyFile: values.get("--ark-key-file"), realKeySlice: slice });
  try {
    if (command === "init" || command === "status") { console.log(JSON.stringify(host.list())); return; }
    const workspaceId = values.get("--workspace"), agentId = values.get("--agent"), message = values.get("--message");
    if (!text(workspaceId) || !text(agentId) || !messageBody(message)) throw new Error("run requires explicit --workspace, --agent and --message");
    const started = host.start("headless-cli", workspaceId, agentId, message, values.get("--request-id") ?? randomUUID(), resume, undefined, undefined,
      { source: "cli", channel: "cli", clientId: "headless-cli" });
    await host.wait(started.runId); const snapshot = host.snapshot(workspaceId, agentId);
    console.log(JSON.stringify(snapshot)); if (snapshot.conversation.state !== "completed") process.exitCode = 2;
  } catch (error) {
    // A fixed trusted classification is safe to show; arbitrary startup/provider errors remain
    // hidden by the early CLI boundary, so paths, credentials or response bodies cannot leak.
    if (!(error instanceof WorkspaceBudgetAdmissionError)) throw error;
    console.error(`hara workspace-dev: resume budget exhausted (${error.reason}); no model call or new chat turn started.`);
    process.exitCode = 2;
  } finally { await host.close(); }
}
