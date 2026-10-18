import { createHash } from "node:crypto";
import { constants, accessSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import type { OptionalRuntimeId } from "./runtime-install.js";

export interface DetectedRuntime { runtimeId: OptionalRuntimeId; path: string; realPath: string; version: string; fingerprint: string; source: string }
export interface DetectionOptions { home: string; shell?: string; path?: string; timeoutMs?: number;
  run?: (command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number) => Promise<string | null>;
  systemBins?: string[] }
const ids: OptionalRuntimeId[] = ["opencode", "codex", "claude"];
const fingerprints = new Map<string, { identity: string; value: { realPath: string; fingerprint: string } }>();
const safePath = (value: string) => isAbsolute(value) && value.length < 4096 && !/[\u0000-\u001f\u007f]/.test(value);
export function boundedRuntimeCommand(command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string | null> {
  return new Promise(resolve => {
    let output = "", stopped = false;
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true });
    const kill = () => { try { if (process.platform === "win32") child.kill(); else if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { stopped = true; kill(); }, timeout);
    child.stdout.on("data", chunk => { if (output.length + chunk.length > 16_384) { stopped = true; kill(); } else output += chunk.toString(); });
    child.once("error", () => { clearTimeout(timer); resolve(null); });
    child.once("close", code => { clearTimeout(timer); resolve(code === 0 && !stopped ? output : null); });
  });
}
export function nvmVersionOrder(a: string, b: string): number {
  const x = a.replace(/^v/, "").split(".").map(Number), y = b.replace(/^v/, "").split(".").map(Number);
  return (y[0]! - x[0]!) || (y[1]! - x[1]!) || (y[2]! - x[2]!);
}
export function inspectLocalRuntime(path: string, force = false): { realPath: string; fingerprint: string } | null {
  try {
    if (!safePath(path)) return null;
    accessSync(path, constants.X_OK);
    const realPath = realpathSync(path), before = lstatSync(realPath);
    if (!before.isFile() || before.size > 512 * 1024 * 1024 || before.size === 0 || process.platform !== "win32" && (before.mode & 0o022) !== 0) return null;
    const identity = `${realPath}:${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}:${before.mode}`;
    const known = fingerprints.get(path); if (!force && known?.identity === identity) return known.value;
    const bytes = readFileSync(realPath), after = statSync(realPath);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || realpathSync(path) !== realPath) return null;
    const value = { realPath, fingerprint: createHash("sha256").update(bytes).digest("hex") };
    if (fingerprints.size > 128) fingerprints.clear(); fingerprints.set(path, { identity, value }); return value;
  } catch { return null; }
}
/** Explicit local metadata check only. Never invokes npx, install, update, fetch or an installer. */
export async function detectInstalledRuntimes(options: DetectionOptions): Promise<DetectedRuntime[]> {
  if (!safePath(options.home)) throw new Error("Invalid explicit runtime discovery Home");
  const run = options.run ?? boundedRuntimeCommand, timeout = Math.min(3000, Math.max(25, options.timeoutMs ?? 1200));
  const deadline = Date.now() + 10000;
  const path = options.path ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const env: NodeJS.ProcessEnv = { HOME: options.home, USERPROFILE: options.home, PATH: path,
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", HARA_UPDATE_CHECK: "0", NO_COLOR: "1" };
  const candidates = new Map<OptionalRuntimeId, { path: string; source: string }[]>(ids.map(id => [id, []]));
  const add = (id: OptionalRuntimeId, p: string, source: string) => {
    if (safePath(p) && !candidates.get(id)!.some(row => row.path === p)) candidates.get(id)!.push({ path: p, source });
  };
  const shell = options.shell && ["zsh", "bash", "sh", "fish"].includes(options.shell.split("/").at(-1)!) && safePath(options.shell) ? options.shell : "/bin/zsh";
  await Promise.all(ids.map(async id => {
    const found = await run(shell, ["-lc", `command -v ${id}`], env, timeout);
    if (found) for (const line of found.trim().split("\n").reverse()) if (safePath(line.trim())) { add(id, line.trim(), "login-shell"); break; }
  }));
  let versions: string[] = [];
  try { versions = readdirSync(join(options.home, ".nvm/versions/node")).filter(v => /^v\d+\.\d+\.\d+$/.test(v)).sort(nvmVersionOrder).slice(0, 24); } catch { /* no nvm */ }
  const bins = [...versions.map(v => ({ path: join(options.home, ".nvm/versions/node", v, "bin"), source: "nvm" })),
    ...(options.systemBins ?? ["/opt/homebrew/bin", "/usr/local/bin"]).map(path => ({ path, source: "system-package-manager" })),
    { path: join(options.home, ".local/bin"), source: "local" }];
  for (const bin of bins) for (const id of ids) add(id, join(bin.path, id), bin.source);
  const npmPath = [...versions.map(v => join(options.home, ".nvm/versions/node", v, "bin/npm")), ...path.split(":").filter(safePath).map(p => join(p, "npm"))].find(p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } });
  const prefix = npmPath ? await run(npmPath, ["config", "get", "prefix"], { ...env, PATH: `${dirname(npmPath)}:${path}`,
    npm_config_update_notifier: "false", NO_UPDATE_NOTIFIER: "1", npm_config_offline: "true" }, timeout) : null;
  const extras = [prefix && safePath(prefix.trim()) ? join(prefix.trim(), "bin") : "", join(options.home, ".npm-global/bin"), join(options.home, ".volta/bin"), join(options.home, ".bun/bin")];
  for (const bin of extras.filter(Boolean)) for (const id of ids) add(id, join(bin, id), "npm-or-user-toolchain");
  // Inherited PATH is still useful on CLI/Windows hosts, but never outranks explicit login/nvm sources.
  for (const bin of path.split(":").filter(safePath)) for (const id of ids) add(id, join(bin, id), "inherited-path");
  return (await Promise.all(ids.map(async runtimeId => {
    for (const candidate of candidates.get(runtimeId)!) {
      if (Date.now() >= deadline) throw new Error("Local runtime discovery deadline reached; absence is not confirmed");
      const inspected = inspectLocalRuntime(candidate.path); if (!inspected) continue;
      const output = await run(candidate.path, ["--version"], { ...env, PATH: `${dirname(candidate.path)}:${bins.map(b => b.path).join(":")}:${path}` }, Math.min(timeout, Math.max(25, deadline - Date.now())));
      const version = output?.match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/)?.[0];
      const after = inspectLocalRuntime(candidate.path);
      if (version && after && after.fingerprint === inspected.fingerprint && after.realPath === inspected.realPath)
        return { runtimeId, ...candidate, ...inspected, version };
    }
    return null;
  }))).filter((row): row is DetectedRuntime => row !== null);
}
