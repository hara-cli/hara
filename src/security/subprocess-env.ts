// Environment boundary for model-controlled subprocesses. Provider credentials stay in the Hara process;
// Bash/jobs/hooks/MCP/external agents receive ordinary build/runtime variables but not secret-shaped values.
// A user can explicitly pass selected names with HARA_SUBPROCESS_ENV_ALLOW=NAME,OTHER before launching Hara.
import { redactSensitiveText } from "./secrets.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { delimiter, join } from "node:path";
import { normalizePortableWindowsHome } from "../runtime.js";

const SECRET_NAME = /(?:^|_)(?:API_?KEY|KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|COOKIE|JWT|AUTH)(?:_|$)/i;
const SECRET_EXACT = new Set([
  "DATABASE_URL",
  "REDIS_URL",
  "MONGODB_URI",
  "MONGO_URL",
  "PGPASSWORD",
]);
const INJECTION_NAME = /^(?:BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|GIT_ASKPASS|SSH_ASKPASS|SUDO_ASKPASS|GIT_SSH_COMMAND|GIT_CONFIG(?:_.*)?|GIT_EXEC_PATH|GIT_EXTERNAL_DIFF|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PAGER|PAGER|MANPAGER|EDITOR|VISUAL|LESSOPEN|LESSCLOSE|NPM_CONFIG_SCRIPT_SHELL|NPM_CONFIG_NODE_GYP|NPM_CONFIG_USERCONFIG|PIP_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|AWS_CONFIG_FILE|DOCKER_CONFIG|KUBECONFIG|NETRC|AZURE_CONFIG_DIR)$/;
const SAFE_EXCEPTIONS = new Set(["SSH_AUTH_SOCK"]); // socket path, not the credential itself

export function isSecretEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase(); // Windows environment names are case-insensitive
  if (SAFE_EXCEPTIONS.has(normalized)) return false;
  return SECRET_EXACT.has(normalized) || SECRET_NAME.test(normalized) || INJECTION_NAME.test(normalized);
}

function explicitAllow(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    String(env.HARA_SUBPROCESS_ENV_ALLOW ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      .map((name) => name.toUpperCase()),
  );
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key ? env[key] : undefined;
}

/** Installed plugin commands are user-approved Hara extensions. Make them reachable by model-controlled
 * subprocesses without allowing them to shadow an existing system/project command: ~/.hara/bin is appended,
 * never prepended. The interactive shell still owns its own PATH configuration. */
function appendHaraPluginBin(env: NodeJS.ProcessEnv): void {
  const explicitHome = environmentValue(env, "HOME");
  const fallbackHome = environmentValue(env, "USERPROFILE");
  // Match Hara's portable-home contract: an explicit Git Bash/MSYS HOME wins on Windows too.
  const home = platform() === "win32" && explicitHome
    ? normalizePortableWindowsHome(explicitHome)
    : explicitHome ?? fallbackHome;
  if (!home) return;
  const pluginBin = join(home, ".hara", "bin");
  if (!existsSync(pluginBin)) return;

  const pathKey = Object.keys(env).find((candidate) => candidate.toUpperCase() === "PATH") ?? "PATH";
  const current = env[pathKey] ?? "";
  const comparable = (value: string): string => platform() === "win32" ? value.toLowerCase() : value;
  if (current.split(delimiter).some((entry) => comparable(entry) === comparable(pluginBin))) return;
  env[pathKey] = current ? `${current}${delimiter}${pluginBin}` : pluginBin;
}

/** Build an own copy so callers never mutate process.env. Explicit overrides (for example an MCP server's
 * configured env) are intentional and win after the inherited environment has been scrubbed. */
export function toolSubprocessEnv(
  source: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv | Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const allow = explicitAllow(source);
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalized = name.toUpperCase();
    if (normalized === "HARA_SUBPROCESS_ENV_ALLOW") continue;
    if (isSecretEnvironmentName(normalized) && !allow.has(normalized)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete out[name];
    else out[name] = value;
  }
  appendHaraPluginBin(out);
  return out;
}

/** Redact both recognizable credential syntax and the exact values of secret-named environment variables.
 * Exact-value matching closes the gap for opaque provider tokens that have no standard prefix. */
export function redactToolSubprocessOutput(
  text: string,
  source: NodeJS.ProcessEnv = process.env,
  explicit: NodeJS.ProcessEnv | Record<string, string | undefined> = {},
): string {
  let out = redactSensitiveText(text).text;
  const values = new Set<string>();
  for (const env of [source, explicit]) {
    for (const [name, value] of Object.entries(env)) {
      if (!value || value.length < 6 || !isSecretEnvironmentName(name)) continue;
      values.add(value);
    }
  }
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (out.includes(value)) out = out.split(value).join("***");
  }
  return out;
}

/** Line-buffered streaming redactor. Redacting each transport chunk independently is unsafe because a token
 * may be split between two chunks. Holding the partial line until the next newline/end closes that gap. */
export function createToolOutputLineRedactor(
  emit: (safeLine: string) => void,
  source: NodeJS.ProcessEnv = process.env,
  explicit: NodeJS.ProcessEnv | Record<string, string | undefined> = {},
  maxPendingCharacters = 64 * 1024,
): { push(chunk: string): void; flush(): void } {
  if (!Number.isSafeInteger(maxPendingCharacters) || maxPendingCharacters < 1024) {
    throw new Error("streaming redactor maxPendingCharacters must be an integer >= 1024");
  }
  let pending = "";
  let droppingLongLine = false;
  const feed = (piece: string, endsLine: boolean): void => {
    if (droppingLongLine) {
      if (endsLine) droppingLongLine = false;
      return;
    }
    if (pending.length + piece.length > maxPendingCharacters) {
      // Never release a prefix of an overlong line: a credential could straddle that release boundary.
      // Drop through the newline instead, keeping memory fixed and preserving only a safe diagnostic.
      pending = "";
      droppingLongLine = !endsLine;
      emit(`[output line omitted — exceeded ${maxPendingCharacters} characters]\n`);
      return;
    }
    pending += piece;
    if (endsLine) {
      emit(redactToolSubprocessOutput(pending, source, explicit));
      pending = "";
    }
  };
  return {
    push(chunk: string): void {
      let start = 0;
      let newline: number;
      while ((newline = chunk.indexOf("\n", start)) >= 0) {
        feed(chunk.slice(start, newline + 1), true);
        start = newline + 1;
      }
      if (start < chunk.length) feed(chunk.slice(start), false);
    },
    flush(): void {
      if (pending) emit(redactToolSubprocessOutput(pending, source, explicit));
      pending = "";
      droppingLongLine = false;
    },
  };
}

/** Terminate a spawned tool and, when it owns a POSIX process group, all descendants. On Windows,
 * taskkill /T is the supported process-tree primitive. Callers should spawn with `detached: true` on POSIX
 * and pass `processGroup: true`; the explicit flag avoids ever signaling Hara's own process group. */
export function terminateSubprocessTree(
  child: ChildProcess,
  options: {
    force?: boolean;
    processGroup?: boolean;
    /** Send TERM first, then KILL after this grace period. Omit for a single immediate signal. */
    graceMs?: number;
    /** Called even if inherited pipes never close (for example a daemon escaped the process group). */
    fallbackMs?: number;
    onFallback?: () => void;
    /** Called after the forced tree-kill has been issued (used by exit cleanup bookkeeping). */
    onForce?: () => void;
  } = {},
): (cancelForce?: boolean) => void {
  const force = options.force === true;
  const pid = child.pid;
  if (!pid) return () => {};

  const signal = (hard: boolean): void => {
    const direct = (): void => {
      try { child.kill(hard ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ }
    };
    if (platform() === "win32") {
      try {
        // Asynchronous taskkill preserves the caller's wall-clock fallback; a synchronous 5s taskkill
        // timeout here could itself make a 200ms tool timeout take ten seconds across TERM + force passes.
        const killer = spawn("taskkill", ["/pid", String(pid), "/t", ...(hard ? ["/f"] : [])], {
          stdio: "ignore",
          windowsHide: true,
          env: toolSubprocessEnv(),
        });
        killer.once("error", direct);
        killer.once("close", (code) => { if (code !== 0) direct(); });
        killer.unref();
        return;
      } catch {
        // Fall back to Node's direct-child signal below.
      }
    } else if (options.processGroup) {
      try {
        process.kill(-pid, hard ? "SIGKILL" : "SIGTERM");
        return;
      } catch {
        // The group may have exited between the check and signal; direct-child kill is a safe fallback.
      }
    }
    direct();
  };

  signal(force);
  if (force) options.onForce?.();
  const graceMs = options.graceMs;
  if (force || graceMs === undefined) return () => {};
  const grace = Math.max(0, Math.min(graceMs, 30_000));
  const fallback = Math.max(0, Math.min(options.fallbackMs ?? 1_000, 30_000));
  let fallbackActive = true;
  let forceTimer: NodeJS.Timeout | undefined;
  let fallbackTimer: NodeJS.Timeout | undefined;
  const cancelFallback = (): void => {
    if (!fallbackActive) return;
    fallbackActive = false;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    child.off("close", cancelFallback);
    child.off("error", cancelFallback);
  };
  // `close` only proves the direct child's stdio is closed. A grandchild can redirect stdio, ignore TERM,
  // and remain in the owned process group, so the forced group kill MUST NOT be cancelled by child close.
  // We cancel only the API hard-settle fallback; the short force timer is intentionally kept referenced so
  // natural process exit cannot orphan a resistant descendant before escalation runs.
  child.once("close", cancelFallback);
  child.once("error", cancelFallback);
  forceTimer = setTimeout(() => {
    forceTimer = undefined;
    signal(true);
    options.onForce?.();
  }, grace);
  if (options.onFallback) {
    fallbackTimer = setTimeout(() => {
      if (!fallbackActive) return;
      const callback = options.onFallback;
      cancelFallback();
      callback?.();
    }, grace + fallback);
  }
  return (cancelForce = false): void => {
    cancelFallback();
    if (cancelForce && forceTimer) {
      clearTimeout(forceTimer);
      forceTimer = undefined;
    }
  };
}
