import { randomUUID } from "node:crypto";
import { startLocalWorkspaceServe } from "../serve/local-workspace.js";
import { LocalWorkspaceHost } from "./local-host.js";
import { text } from "./local-state.js";

/** Real CLI entry for the explicitly opted-in synthetic local Workspace lane. No legacy boot/config. */
export async function mainLocalWorkspaceCli(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || ["--help", "-h", "help"].includes(command)) {
    console.log("hara workspace-dev <init|status|serve|run> --root /absolute/private/fixture-root\nSynthetic Provider only. No real model/Key calls, global profile import, deployment or existing Dev control.\nserve: --port 0; run: --workspace ws_ID --agent ag_ID --message TEXT [--resume]"); return;
  }
  if (!["init", "status", "serve", "run"].includes(command)) throw new Error("unsupported Workspace Dev command");
  const values = new Map<string, string>(); let resume = false;
  for (let index = 1; index < args.length; index++) {
    const key = args[index]!;
    if (key === "--resume" && !resume) { resume = true; continue; }
    if (!["--root", "--port", "--workspace", "--agent", "--message", "--request-id"].includes(key) || values.has(key) || index + 1 >= args.length) throw new Error("invalid Workspace Dev option");
    values.set(key, args[++index]!);
  }
  const root = values.get("--root"); if (!text(root, 4096)) throw new Error("explicit --root private fixture directory is required");
  if (command === "serve") {
    const port = Number(values.get("--port") ?? 0);
    const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port, cwd: root,
      ...(process.env.HARA_WORKSPACE_DEV_TOKEN ? { token: process.env.HARA_WORKSPACE_DEV_TOKEN } : {}) },
      { root, version: "0.187.1-local-workspace-dev", allowedOrigins: ["http://127.0.0.1:1437", "http://localhost:1437"] });
    console.log(JSON.stringify({ type: "workspace-dev-ready", protocol: 1, capability: "workspace.local-dev.v2", port: handle.port, syntheticOnly: true }));
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; void handle.close().catch(() => { process.exitCode = 1; }); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop); return;
  }
  const host = new LocalWorkspaceHost(root, { interactiveApprovals: false });
  try {
    if (command === "init" || command === "status") { console.log(JSON.stringify(host.list())); return; }
    const workspaceId = values.get("--workspace"), agentId = values.get("--agent"), message = values.get("--message");
    if (!text(workspaceId) || !text(agentId) || !text(message, 4000)) throw new Error("run requires explicit --workspace, --agent and --message");
    const started = host.start("headless-cli", workspaceId, agentId, message, values.get("--request-id") ?? randomUUID(), resume);
    await host.wait(started.runId); const snapshot = host.snapshot(workspaceId, agentId);
    console.log(JSON.stringify(snapshot)); if (snapshot.conversation.state !== "completed") process.exitCode = 2;
  } finally { await host.close(); }
}
