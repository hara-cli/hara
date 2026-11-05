import { runtimeErrorFirstLine } from "../security/runtime-error.js";
import { RuntimeLaunchCooldown, runtimeFailureMessage, runtimeRpcDiagnostic, type RuntimeRpcDiagnostic, type RuntimeFailureContext, type RuntimeFailureKind } from "./failure-diagnostics.js";
import type { WorkspaceRuntimeInstaller, RuntimeLoginSource } from "../workspace/runtime-install.js";

// Registry instances are per turn. Retain only the original installer/colleague/conversation state;
// a channel failure must not block or clear another channel or its private conversation.
const trackers = new WeakMap<object, Map<string, { route: string; cooldown: RuntimeLaunchCooldown; errorFirstLine?: string; rpc?: RuntimeRpcDiagnostic }>>();
export function runtimeFailureTracker(installer: WorkspaceRuntimeInstaller, runtime: RuntimeFailureContext["runtime"],
  agentId: string, route: string, launched: { env: NodeJS.ProcessEnv; loginSource: RuntimeLoginSource }, sessionId: string = agentId) {
  let rows = trackers.get(installer);
  if (!rows) { rows = new Map(); trackers.set(installer, rows); }
  const key = JSON.stringify([runtime, agentId, sessionId]);
  let row = rows.get(key);
  if (!row || row.route !== route) {
    // Bound memory even when a workspace creates/removes many colleagues.
    if (rows.size >= 2048) rows.delete(rows.keys().next().value!);
    row = { route, cooldown: new RuntimeLaunchCooldown() }; rows.set(key, row);
  }
  const cooldown = row.cooldown;
  const message = (kind: RuntimeFailureKind, elapsedMs: number) => {
    const blocked = cooldown.blocked();
    return runtimeFailureMessage({ ...(runtime === "pi" ? { runtime: "pi" as const, version: "1.5.0", loginSource: "isolated" as const, homeMatchesAccount: false } : installer.failureContext(runtime, launched)), kind, elapsedMs, errorFirstLine: row?.errorFirstLine, rpc: row?.rpc,
      retryAtMs: blocked?.retryAtMs ?? 0, consecutiveFailures: blocked?.consecutiveFailures ?? 0 });
  };
  return {
    blocked(): string | null { const held = cooldown.blocked(); return held ? message(held.kind, 0) : null; },
    failed(kind: RuntimeFailureKind, elapsedMs: number, firstLine?: string, rpc?: RuntimeRpcDiagnostic): string { row.rpc = runtime === "codex" ? runtimeRpcDiagnostic(rpc) : undefined; row.errorFirstLine = runtimeErrorFirstLine(firstLine, launched.env); cooldown.failed(kind, elapsedMs); return message(kind, elapsedMs); },
    succeeded(): void { row.rpc = undefined; row.errorFirstLine = undefined; cooldown.succeeded(); },
  };
}
