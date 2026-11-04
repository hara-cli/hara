import { runtimeErrorFirstLine } from "../security/runtime-error.js";
import { RuntimeLaunchCooldown, runtimeFailureMessage, type RuntimeFailureContext, type RuntimeFailureKind } from "./failure-diagnostics.js";
import type { WorkspaceRuntimeInstaller, RuntimeLoginSource } from "../workspace/runtime-install.js";

// Registry instances are per turn. Retain only per-installer, per-colleague state, never global user state.
const trackers = new WeakMap<object, Map<string, { route: string; cooldown: RuntimeLaunchCooldown; errorFirstLine?: string }>>();
export function runtimeFailureTracker(installer: WorkspaceRuntimeInstaller, runtime: RuntimeFailureContext["runtime"],
  agentId: string, route: string, launched: { env: NodeJS.ProcessEnv; loginSource: RuntimeLoginSource }) {
  let rows = trackers.get(installer);
  if (!rows) { rows = new Map(); trackers.set(installer, rows); }
  const key = runtime + ":" + agentId;
  let row = rows.get(key);
  if (!row || row.route !== route) {
    // Bound memory even when a workspace creates/removes many colleagues.
    if (rows.size >= 2048) rows.delete(rows.keys().next().value!);
    row = { route, cooldown: new RuntimeLaunchCooldown() }; rows.set(key, row);
  }
  const cooldown = row.cooldown;
  const message = (kind: RuntimeFailureKind, elapsedMs: number) => {
    const blocked = cooldown.blocked();
    return runtimeFailureMessage({ ...(runtime === "pi" ? { runtime: "pi" as const, version: "1.5.0", loginSource: "isolated" as const, homeMatchesAccount: false } : installer.failureContext(runtime, launched)), kind, elapsedMs, errorFirstLine: row?.errorFirstLine,
      retryAtMs: blocked?.retryAtMs ?? 0, consecutiveFailures: blocked?.consecutiveFailures ?? 0 });
  };
  return {
    blocked(): string | null { const held = cooldown.blocked(); return held ? message(held.kind, 0) : null; },
    failed(kind: RuntimeFailureKind, elapsedMs: number, firstLine?: string): string { row.errorFirstLine = runtimeErrorFirstLine(firstLine, launched.env); cooldown.failed(kind, elapsedMs); return message(kind, elapsedMs); },
    succeeded(): void { row.errorFirstLine = undefined; cooldown.succeeded(); },
  };
}
