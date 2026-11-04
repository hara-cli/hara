import { createHash } from "node:crypto";
import { constants, accessSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import type { OptionalRuntimeId } from "./runtime-install.js";

export interface DetectedRuntime { runtimeId: OptionalRuntimeId; path: string; realPath: string; version: string; fingerprint: string; source: string }
export interface RuntimeCommandControl { signal?: AbortSignal; onTimeout?: () => void }
export interface CopilotVersionProbe extends Omit<DetectedRuntime, "runtimeId" | "version"> {
  /** Host-owned, single-use metadata retry; never grants registration or execution authority. */
  retry(signal: AbortSignal): Promise<DetectedRuntime | null>;
}
export interface DetectionOptions { home: string; probeHome?: string; shell?: string; path?: string; timeoutMs?: number;
  run?: (command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number, control?: RuntimeCommandControl) => Promise<string | null>;
  signal?: AbortSignal;
  /** The owning installer already has a retry; rescan every other runtime normally. */
  copilotProbeInProgress?: boolean;
  onCopilotProbeTimeout?: (probe: CopilotVersionProbe) => void;
  systemBins?: string[] }
const ids: OptionalRuntimeId[] = ["opencode", "codex", "claude", "agy", "gemini", "kimi", "copilot", "cursor", "grok"];
const commands = (id: OptionalRuntimeId): string[] => id === "cursor" ? ["cursor-agent", "agent"] : [id];
export const LOGIN_RUNTIME_PATH_COMMAND = 'printf "__HARA_RUNTIME_PATH__%s\\n" "$PATH"';
const fingerprints = new Map<string, { identity: string; value: { realPath: string; fingerprint: string } }>();
const safePath = (value: string) => isAbsolute(value) && value.length < 4096 && !/[\u0000-\u001f\u007f]/.test(value);
export function boundedRuntimeCommand(command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number, control: RuntimeCommandControl = {}): Promise<string | null> {
  return new Promise(resolve => {
    if (control.signal?.aborted) { resolve(null); return; }
    let output = "", stopped = false, timedOut = false, finished = false;
    const child = spawn(command, args, { env, cwd: env.HOME, stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true });
    const kill = () => { try { if (process.platform === "win32") child.kill(); else if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {} };
    const abort = () => { stopped = true; kill(); };
    const timer = setTimeout(() => { if (!stopped) { stopped = true; timedOut = true; kill(); } }, timeout);
    const finish = (code: number | null) => {
      if (finished) return; finished = true;
      clearTimeout(timer); control.signal?.removeEventListener("abort", abort);
      if (timedOut) try { control.onTimeout?.(); } catch { /* An observer cannot retain a stopped child. */ }
      resolve(code === 0 && !stopped ? output : null);
    };
    child.stdout.on("data", chunk => { if (output.length + chunk.length > 16_384) { stopped = true; kill(); } else output += chunk.toString(); });
    child.once("error", () => finish(null));
    child.once("close", finish);
    control.signal?.addEventListener("abort", abort, { once: true });
    if (control.signal?.aborted) abort();
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
  const probeHome = options.probeHome ?? options.home;
  if (!safePath(probeHome)) throw new Error("Invalid isolated runtime version-probe Home");
  const run = options.run ?? boundedRuntimeCommand, timeout = Math.min(3000, Math.max(25, options.timeoutMs ?? 1200));
  const deadline = Date.now() + 10000;
  const path = options.path ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const env: NodeJS.ProcessEnv = { HOME: options.home, USERPROFILE: options.home, PATH: path,
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", HARA_UPDATE_CHECK: "0", NO_COLOR: "1" };
  const candidates = new Map<OptionalRuntimeId, { path: string; source: string }[]>(ids.map(id => [id, []]));
  const add = (id: OptionalRuntimeId, p: string, source: string) => {
    if (safePath(p) && !candidates.get(id)!.some(row => row.path === p)) candidates.get(id)!.push({ path: p, source });
  };
  const shell = options.shell && ["zsh", "bash", "sh", "fish"].includes(options.shell.split("/").at(-1)!) && safePath(options.shell) ? options.shell : "/bin/zsh";
  // Finder has no interactive shell PATH. Read only PATH (never `env`/`export` output), with a
  // literal command and a fixed deadline. A noisy/failed rc does not hide deterministic fallbacks.
  const shellOutput = await run(shell, ["-lic", LOGIN_RUNTIME_PATH_COMMAND], env, timeout, { signal: options.signal });
  const loginPath = shellOutput?.split("\n").reverse().find(line => line.startsWith("__HARA_RUNTIME_PATH__"))?.slice("__HARA_RUNTIME_PATH__".length) ?? "";
  for (const bin of loginPath.split(":").filter(safePath)) for (const id of ids) for (const command of commands(id)) add(id, join(bin, command), "login-shell");
  let versions: string[] = [];
  try { versions = readdirSync(join(options.home, ".nvm/versions/node")).filter(v => /^v\d+\.\d+\.\d+$/.test(v)).sort(nvmVersionOrder); } catch { /* no nvm */ }
  const bins = [{ path: join(options.home, ".local/bin"), source: "local" },
    ...versions.map(v => ({ path: join(options.home, ".nvm/versions/node", v, "bin"), source: "nvm" })),
    ...(options.systemBins ?? ["/opt/homebrew/bin", "/usr/local/bin"]).map(path => ({ path, source: "system-package-manager" })),
    { path: join(options.home, ".volta/bin"), source: "volta" }, { path: join(options.home, ".bun/bin"), source: "bun" }];
  for (const bin of bins) for (const id of ids) for (const command of commands(id)) add(id, join(bin.path, command), bin.source);
  const npmPath = [...versions.map(v => join(options.home, ".nvm/versions/node", v, "bin/npm")), ...path.split(":").filter(safePath).map(p => join(p, "npm"))].find(p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } });
  const prefix = npmPath ? await run(npmPath, ["config", "get", "prefix"], { ...env, PATH: `${dirname(npmPath)}:${path}`,
    npm_config_update_notifier: "false", NO_UPDATE_NOTIFIER: "1", npm_config_offline: "true", npm_config_logs_max: "0" }, timeout, { signal: options.signal }) : null;
  const extras = [prefix && safePath(prefix.trim()) ? join(prefix.trim(), "bin") : "", join(options.home, ".npm-global/bin"), join(options.home, ".volta/bin"), join(options.home, ".bun/bin")];
  for (const bin of extras.filter(Boolean)) for (const id of ids) for (const command of commands(id)) add(id, join(bin, command), "npm-or-user-toolchain");
  // Inherited PATH is still useful on CLI/Windows hosts, but never outranks explicit login/nvm sources.
  for (const bin of path.split(":").filter(safePath)) for (const id of ids) for (const command of commands(id)) add(id, join(bin, command), "inherited-path");
  return (await Promise.all(ids.map(async runtimeId => {
    if (runtimeId === "copilot" && options.copilotProbeInProgress) return null;
    for (const candidate of candidates.get(runtimeId)!) {
      if (Date.now() >= deadline) throw new Error("Local runtime discovery deadline reached; absence is not confirmed");
      const inspected = inspectLocalRuntime(candidate.path); if (!inspected) continue;
      const versionEnv = { ...env, HOME: probeHome, USERPROFILE: probeHome,
        GEMINI_CLI_HOME: probeHome, KIMI_SHARE_DIR: join(probeHome, ".kimi"), KIMI_CODE_HOME: join(probeHome, ".kimi-code"),
        XDG_CONFIG_HOME: join(probeHome,".config"), XDG_CACHE_HOME: join(probeHome,".cache"), XDG_DATA_HOME: join(probeHome,".local/share"),
        PATH: `${dirname(candidate.path)}:${bins.map(b => b.path).join(":")}:${path}` };
      const verified = (output: string | null): DetectedRuntime | null => {
        if (runtimeId === "cursor" && candidate.path.split(/[\\/]/).at(-1) === "agent" && !/cursor/i.test(output ?? "")) return null;
        const version = output?.match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/)?.[0];
        const after = inspectLocalRuntime(candidate.path);
        return version && after && after.fingerprint === inspected.fingerprint && after.realPath === inspected.realPath
          ? { runtimeId, ...candidate, ...inspected, version } : null;
      };
      let timedOut = false;
      const output = await run(candidate.path, ["--version"], versionEnv, Math.min(timeout, Math.max(25, deadline - Date.now())),
        { signal: options.signal, onTimeout: () => { timedOut = true; } });
      if (runtimeId === "copilot" && timedOut && !options.signal?.aborted) {
        // Copilot extracts embedded assets on its first metadata call. Keep the initial scan bounded;
        // only its owner may schedule one longer retry, with the same path/Home and fresh integrity checks.
        if (!options.onCopilotProbeTimeout) throw new Error("Copilot version probe timed out; installation absence is not confirmed");
        let retried = false;
        options.onCopilotProbeTimeout(Object.freeze({ ...candidate, ...inspected, retry: async (signal: AbortSignal) => {
          if (retried || signal.aborted) return null; retried = true;
          const before = inspectLocalRuntime(candidate.path, true);
          if (!before || before.realPath !== inspected.realPath || before.fingerprint !== inspected.fingerprint) return null;
          const result = await run(candidate.path, ["--version"], versionEnv, 5000, { signal });
          return signal.aborted ? null : verified(result);
        } }));
        return null;
      }
      if (options.signal?.aborted) return null;
      const result = verified(output); if (result) return result;
    }
    return null;
  }))).filter((row): row is DetectedRuntime => row !== null);
}
