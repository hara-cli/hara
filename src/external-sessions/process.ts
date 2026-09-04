import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import crossSpawn from "cross-spawn";
import {
  redactToolSubprocessOutput,
  terminateSubprocessTree,
  toolSubprocessEnv,
} from "../security/subprocess-env.js";

export type ExternalSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

const defaultSpawn: ExternalSpawn = (command, args, options) => crossSpawn(command, [...args], options);

const boundedAppend = (current: string, chunk: string, limit: number): string => {
  if (current.length >= limit) return current;
  return (current + chunk).slice(0, limit);
};

export interface ExternalCommandOptions {
  command: string;
  argsPrefix?: readonly string[];
  spawnProcess?: ExternalSpawn;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ExternalCommandCaptureResult {
  ok: boolean;
  stdout: string;
  code: number | null;
  timedOut: boolean;
  /** A bounded machine-readable code only. Provider stderr is never returned. */
  errorCode?: string;
}

export interface ExternalCommandRunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
}

const safeExternalErrorCode = (stderr: string): string | undefined => {
  const line = stderr.trim().split(/\r?\n/u).at(-1);
  if (!line || line.length > 64 * 1024) return undefined;
  try {
    const parsed = JSON.parse(line) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Execute one short-lived local runtime command with bounded output. Raw stderr is deliberately discarded:
 * coding-agent errors can contain prompts, native session identifiers, paths, or account details.
 */
export async function runExternalCommandCapture(
  options: ExternalCommandOptions,
  args: readonly string[],
  run: ExternalCommandRunOptions = {},
): Promise<ExternalCommandCaptureResult> {
  const timeoutMs = Math.max(250, Math.min(run.timeoutMs ?? options.timeoutMs ?? 10_000, 10 * 60_000));
  const maxOutputBytes = Math.max(4 * 1024, Math.min(run.maxOutputBytes ?? 4 * 1024 * 1024, 16 * 1024 * 1024));
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const processGroup = platform() !== "win32";
  const launch = resolveExternalCommandLaunch(options.command, options.env ?? process.env);
  if (!launch) return { ok: false, stdout: "", code: null, timedOut: false, errorCode: "command_not_found" };
  const cwd = run.cwd && isAbsolute(run.cwd) ? run.cwd : undefined;

  return await new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(launch.command, [...(options.argsPrefix ?? []), ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: externalLaunchEnv(options.env ?? process.env, launch.runtimeBin),
        detached: processGroup,
        windowsHide: true,
        ...(cwd ? { cwd } : {}),
      });
    } catch {
      resolve({ ok: false, stdout: "", code: null, timedOut: false, errorCode: "spawn_failed" });
      return;
    }

    let done = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const finish = (result: ExternalCommandCaptureResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      terminateSubprocessTree(child, { force: true, processGroup });
      finish({ ok: false, stdout: "", code: null, timedOut: true, errorCode: "timeout" });
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (done) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminateSubprocessTree(child, { force: true, processGroup });
        finish({ ok: false, stdout: "", code: null, timedOut: false, errorCode: "output_limit" });
        return;
      }
      stdout = boundedAppend(stdout, chunk.toString(), maxOutputBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk.toString(), 64 * 1024);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        stdout: "",
        code: null,
        timedOut: false,
        errorCode: error.code === "ENOENT" ? "command_not_found" : "spawn_failed",
      });
    });
    child.once("close", (code) => {
      finish({
        ok: code === 0,
        stdout: code === 0 ? stdout : "",
        code,
        timedOut: false,
        ...(code === 0 ? {} : { errorCode: safeExternalErrorCode(stderr) ?? "command_failed" }),
      });
    });
  });
}

/** Start a persistent, non-interactive local runtime without retaining its stdio or a parent handle. */
export async function spawnExternalCommandDetached(
  options: ExternalCommandOptions,
  args: readonly string[],
  run: Pick<ExternalCommandRunOptions, "cwd"> = {},
): Promise<boolean> {
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const launch = resolveExternalCommandLaunch(options.command, options.env ?? process.env);
  if (!launch) return false;
  const cwd = run.cwd && isAbsolute(run.cwd) ? run.cwd : undefined;
  return await new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(launch.command, [...(options.argsPrefix ?? []), ...args], {
        stdio: "ignore",
        env: externalLaunchEnv(options.env ?? process.env, launch.runtimeBin),
        detached: true,
        windowsHide: true,
        ...(cwd ? { cwd } : {}),
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (started: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(started);
    };
    child.once("error", () => finish(false));
    child.once("spawn", () => {
      child.unref();
      finish(true);
    });
  });
}

/**
 * Run one bounded provider-management command without retaining or returning its output. This is used for
 * lifecycle operations such as starting Codex's official local App Server daemon. Provider stderr can
 * contain paths or account details, so callers receive only the exit status.
 */
export async function runExternalCommandStatus(
  options: ExternalCommandOptions,
  args: readonly string[],
): Promise<boolean> {
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? 10_000, 30_000));
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const processGroup = platform() !== "win32";
  const launch = resolveExternalCommandLaunch(options.command, options.env ?? process.env);
  if (!launch) return false;
  return await new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(launch.command, [...(options.argsPrefix ?? []), ...args], {
        stdio: ["ignore", "ignore", "ignore"],
        env: externalLaunchEnv(options.env ?? process.env, launch.runtimeBin),
        detached: processGroup,
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (result: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      terminateSubprocessTree(child, { force: true, processGroup });
      finish(false);
    }, timeoutMs);
    timer.unref();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

const existingExecutable = (candidate: string): string | null => {
  if (!isAbsolute(candidate) || !existsSync(candidate)) return null;
  try {
    const resolved = realpathSync(candidate);
    const metadata = statSync(resolved);
    if (!metadata.isFile()) return null;
    if (platform() !== "win32" && (metadata.mode & 0o111) === 0) return null;
    // Execute the checked target, not a mutable symlink path that could be swapped after validation.
    return resolved;
  } catch {
    return null;
  }
};

const versionedCandidates = (root: string, suffix: string): string[] => {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(root, entry.name, suffix))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }))
      .slice(0, 128);
  } catch {
    return [];
  }
};

export interface ExternalCommandLaunch {
  command: string;
  runtimeBin: string;
}

const resolveExternalCommandLaunch = (
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): ExternalCommandLaunch | null => {
  if (!command || /[\u0000-\u001f\u007f]/u.test(command)) return null;
  if (isAbsolute(command)) {
    const executable = existingExecutable(command);
    return executable ? { command: executable, runtimeBin: dirname(command) } : null;
  }
  if (command.includes("/") || command.includes("\\")) return null;

  const windows = platform() === "win32";
  const names = windows && !/\.(?:exe|cmd|bat)$/iu.test(command)
    ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
    : [command];
  const candidates: string[] = [];
  for (const name of names) {
    candidates.push(
      join(userHome, ".local", "bin", name),
      join(userHome, ".volta", "bin", name),
      join(userHome, ".local", "share", "mise", "shims", name),
      join(userHome, ".asdf", "shims", name),
      join(userHome, ".bun", "bin", name),
      join(userHome, ".npm-global", "bin", name),
      join(userHome, ".local", "share", "pnpm", name),
      join(userHome, "Library", "pnpm", name),
    );
    candidates.push(...versionedCandidates(join(userHome, ".nvm", "versions", "node"), join("bin", name)));
    candidates.push(...versionedCandidates(join(userHome, ".fnm", "node-versions"), join("installation", "bin", name)));
    if (platform() === "darwin" && command === "codex") {
      // Official OpenAI desktop distributions may ship the same Codex App Server executable inside
      // an application bundle rather than installing a shell shim. Keep this list explicit and
      // resolve the checked target before execution; never scan arbitrary application resources.
      candidates.push(
        join("/Applications", "Codex.app", "Contents", "Resources", "codex"),
        join("/Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
        join(userHome, "Applications", "Codex.app", "Contents", "Resources", "codex"),
        join(userHome, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
      );
    }
    if (platform() === "darwin" && command === "wezterm") {
      // WezTerm's command shim is shipped beside wezterm-gui inside the signed app bundle. Resolve only
      // these documented application locations; never execute a project-local binary from PATH.
      candidates.push(
        join("/Applications", "WezTerm.app", "Contents", "MacOS", "wezterm"),
        join(userHome, "Applications", "WezTerm.app", "Contents", "MacOS", "wezterm"),
      );
    }
    if (windows) {
      const appData = env.APPDATA;
      const localAppData = env.LOCALAPPDATA;
      const programFiles = env.ProgramFiles;
      if (appData && isAbsolute(appData)) candidates.push(join(appData, "npm", name));
      if (localAppData && isAbsolute(localAppData)) candidates.push(join(localAppData, "pnpm", name));
      if (programFiles && isAbsolute(programFiles)) candidates.push(join(programFiles, "nodejs", name));
    } else {
      candidates.push(join("/opt/homebrew/bin", name), join("/usr/local/bin", name), join("/usr/bin", name));
    }
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const executable = existingExecutable(candidate);
    if (executable) return { command: executable, runtimeBin: dirname(candidate) };
  }
  return null;
};

const externalLaunchEnv = (source: NodeJS.ProcessEnv, runtimeBin: string): NodeJS.ProcessEnv => {
  const env = toolSubprocessEnv(source);
  const pathKey = Object.keys(env).find((candidate) => candidate.toUpperCase() === "PATH") ?? "PATH";
  const current = String(env[pathKey] ?? "");
  const comparable = (value: string): string => platform() === "win32" ? value.toLowerCase() : value;
  // A matching runtime directory later in PATH is not sufficient: an earlier legacy `node` can still
  // execute an NVM/FNM CLI's `#!/usr/bin/env node` shebang. Move the verified sibling runtime to the
  // front and de-duplicate it without mutating the parent environment.
  const runtimeKey = comparable(runtimeBin);
  const remaining = current
    .split(delimiter)
    .filter((entry) => entry && comparable(entry) !== runtimeKey);
  env[pathKey] = [runtimeBin, ...remaining].join(delimiter);
  return env;
};

/**
 * Resolve a user-installed coding-agent CLI without a login shell. Desktop launches commonly inherit a
 * minimal PATH, while NVM/FNM put tools below versioned directories. Only absolute, existing executables
 * from explicit or bounded install locations are accepted; PATH cannot select a project-local lookalike.
 */
export function resolveExternalCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string | null {
  return resolveExternalCommandLaunch(command, env, userHome)?.command ?? null;
}

export function resolveExternalCommandRuntime(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): { command: string; env: NodeJS.ProcessEnv } | null {
  const launch = resolveExternalCommandLaunch(command, env, userHome);
  return launch ? { command: launch.command, env: externalLaunchEnv(env, launch.runtimeBin) } : null;
}

export async function probeExternalCommand(options: ExternalCommandOptions): Promise<{
  installed: boolean;
  version?: string;
  failed?: boolean;
}> {
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 4_000, 15_000));
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const processGroup = platform() !== "win32";
  const launch = resolveExternalCommandLaunch(options.command, options.env ?? process.env);
  if (!launch) return { installed: false };
  return await new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(launch.command, [...(options.argsPrefix ?? []), "--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: externalLaunchEnv(options.env ?? process.env, launch.runtimeBin),
        detached: processGroup,
        windowsHide: true,
      });
    } catch {
      resolve({ installed: false });
      return;
    }
    let done = false;
    let out = "";
    let err = "";
    const finish = (value: { installed: boolean; version?: string; failed?: boolean }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      terminateSubprocessTree(child, { force: true, processGroup });
      finish({ installed: true, failed: true });
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      out = boundedAppend(out, chunk.toString(), 16 * 1024);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err = boundedAppend(err, chunk.toString(), 16 * 1024);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" ? { installed: false } : { installed: true, failed: true });
    });
    child.once("close", (code) => {
      const version = redactToolSubprocessOutput(out || err, options.env ?? process.env)
        .trim()
        .replace(/[\r\n]+/gu, " ")
        .slice(0, 120);
      finish(code === 0
        ? { installed: true, ...(version ? { version } : {}) }
        : { installed: true, failed: true, ...(version ? { version } : {}) });
    });
  });
}

export interface JsonlRpcSequenceOptions extends ExternalCommandOptions {
  requests: Array<{ id?: number; method: string; params?: Record<string, unknown> }>;
  resultId: number;
  maxOutputBytes?: number;
  /** Defaults to a private stdio App Server; Codex daemon clients use `app-server proxy`. */
  appServerArgs?: readonly string[];
}

export interface JsonlRpcRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** Sanitized provider RPC failure. The numeric code is safe for capability fallback; raw data stays local. */
export class ExternalJsonlRpcRequestError extends Error {
  constructor(readonly code: number) {
    super("external session adapter request failed");
    this.name = "ExternalJsonlRpcRequestError";
  }
}

export interface JsonlRpcClientOptions extends ExternalCommandOptions {
  maxOutputBytes?: number;
  /** Defaults to a private stdio App Server; Codex daemon clients use `app-server proxy`. */
  appServerArgs?: readonly string[];
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  onClose?: (error: Error) => void;
  onServerRequest?: (
    request: JsonlRpcRequest,
    reply: (result: unknown) => void,
    reject: (code: number, message: string) => void,
  ) => void;
}

interface PendingJsonlRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Long-lived, bounded JSONL client for one Codex App Server process. It deliberately exposes only JSON-RPC
 * request/notification mechanics; provider payload validation and redaction remain in the adapter. Every
 * pending request is rejected and the whole process group is stopped when the transport becomes invalid.
 */
export class JsonlRpcClient {
  private readonly child: ChildProcess;
  private readonly processGroup: boolean;
  private readonly requestTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly pending = new Map<number, PendingJsonlRequest>();
  private pendingText = "";
  private outputBytes = 0;
  private nextId = 1;
  private closed = false;

  private constructor(
    child: ChildProcess,
    processGroup: boolean,
    private readonly options: JsonlRpcClientOptions,
  ) {
    this.child = child;
    this.processGroup = processGroup;
    this.requestTimeoutMs = Math.max(500, Math.min(options.timeoutMs ?? 30_000, 120_000));
    this.maxOutputBytes = Math.max(64 * 1024, Math.min(options.maxOutputBytes ?? 16 * 1024 * 1024, 64 * 1024 * 1024));
    child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
    // Provider stderr may contain paths, native IDs or configuration data. Drain it without retaining it.
    child.stderr?.on("data", () => {});
    child.once("error", () => this.fail("external session adapter process failed"));
    child.once("close", (code) => {
      if (!this.closed) this.fail(`external session adapter exited unexpectedly (code ${code ?? "unknown"})`);
    });
  }

  static start(options: JsonlRpcClientOptions): JsonlRpcClient {
    const spawnProcess = options.spawnProcess ?? defaultSpawn;
    const processGroup = platform() !== "win32";
    const launch = resolveExternalCommandLaunch(options.command, options.env ?? process.env);
    if (!launch) throw new Error("external session adapter command was not found");
    let child: ChildProcess;
    try {
      child = spawnProcess(launch.command, [
        ...(options.argsPrefix ?? []),
        ...(options.appServerArgs ?? ["app-server", "--stdio"]),
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        env: externalLaunchEnv(options.env ?? process.env, launch.runtimeBin),
        detached: processGroup,
        windowsHide: true,
      });
    } catch {
      throw new Error("external session adapter could not start");
    }
    return new JsonlRpcClient(child, processGroup, options);
  }

  private write(value: unknown): void {
    if (this.closed || !this.child.stdin?.writable) throw new Error("external session adapter is closed");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private consume(chunk: Buffer): void {
    if (this.closed) return;
    this.outputBytes += chunk.length;
    if (this.outputBytes > this.maxOutputBytes) {
      this.fail("external session adapter exceeded its output limit");
      return;
    }
    this.pendingText += chunk.toString();
    if (this.pendingText.length > this.maxOutputBytes) {
      this.fail("external session adapter returned an overlong JSONL frame");
      return;
    }
    let newline = this.pendingText.indexOf("\n");
    while (!this.closed && newline >= 0) {
      const line = this.pendingText.slice(0, newline).trim();
      this.pendingText = this.pendingText.slice(newline + 1);
      if (line) {
        try {
          this.onMessage(JSON.parse(line));
        } catch {
          this.fail("external session adapter returned invalid JSONL");
          return;
        }
      }
      newline = this.pendingText.indexOf("\n");
    }
  }

  private onMessage(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if ((typeof record.id === "number" || typeof record.id === "string") && typeof record.method === "string") {
      const request: JsonlRpcRequest = {
        id: record.id,
        method: record.method,
        ...(record.params && typeof record.params === "object" && !Array.isArray(record.params)
          ? { params: record.params as Record<string, unknown> }
          : {}),
      };
      if (!this.options.onServerRequest) {
        this.replyError(request.id, -32601, "request is not supported by this client");
        return;
      }
      let answered = false;
      const reply = (result: unknown): void => {
        if (answered || this.closed) return;
        answered = true;
        this.write({ id: request.id, result });
      };
      const reject = (code: number, message: string): void => {
        if (answered || this.closed) return;
        answered = true;
        this.replyError(request.id, code, message);
      };
      try {
        this.options.onServerRequest(request, reply, reject);
      } catch {
        reject(-32603, "request handler failed");
      }
      return;
    }
    if (typeof record.id === "number") {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
        const providerCode = (record.error as Record<string, unknown>).code;
        pending.reject(new ExternalJsonlRpcRequestError(
          typeof providerCode === "number" && Number.isSafeInteger(providerCode) ? providerCode : -32_000,
        ));
      }
      else pending.resolve(record.result);
      return;
    }
    if (typeof record.method === "string") {
      const params = record.params && typeof record.params === "object" && !Array.isArray(record.params)
        ? record.params as Record<string, unknown>
        : {};
      this.options.onNotification?.(record.method, params);
    }
  }

  private replyError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(message);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    terminateSubprocessTree(this.child, { force: true, processGroup: this.processGroup });
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.child.stdin?.destroy();
    this.options.onClose?.(error);
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("external session adapter is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        // A provider may have accepted a turn even when its reply was lost. Once the request deadline
        // passes, the transport is no longer safe to reuse: terminate the owned process tree and reject
        // every in-flight request rather than leaving unobserved work running behind a live adapter.
        this.fail("external session adapter request timed out");
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("external session adapter request failed"));
      }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ method, params });
  }

  close(): void {
    this.fail("external session adapter closed");
  }
}

/**
 * Run a bounded JSONL request sequence against a short-lived local app-server process.
 * Notifications are ignored and no provider payload is logged. The process tree is always terminated after
 * the requested response, timeout, parse failure, or output overflow.
 */
export async function runJsonlRpcSequence<T>(options: JsonlRpcSequenceOptions): Promise<T> {
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? 10_000, 30_000));
  const maxOutputBytes = Math.max(64 * 1024, Math.min(options.maxOutputBytes ?? 4 * 1024 * 1024, 16 * 1024 * 1024));
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const processGroup = platform() !== "win32";
  const launch = resolveExternalCommandLaunch(options.command, options.env ?? process.env);
  if (!launch) throw new Error("external session adapter command was not found");

  return await new Promise<T>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(launch.command, [
        ...(options.argsPrefix ?? []),
        ...(options.appServerArgs ?? ["app-server", "--stdio"]),
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        env: externalLaunchEnv(options.env ?? process.env, launch.runtimeBin),
        detached: processGroup,
        windowsHide: true,
      });
    } catch {
      reject(new Error("external session adapter could not start"));
      return;
    }

    let done = false;
    let pending = "";
    let outputBytes = 0;
    let stderr = "";
    let nextRequest = 0;
    const stop = (): void => {
      terminateSubprocessTree(child, { force: true, processGroup });
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    };
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      fn();
    };
    const fail = (message: string): void => finish(() => reject(new Error(message)));
    const writeNext = (): void => {
      while (!done) {
        const request = options.requests[nextRequest++];
        if (!request) return;
        try {
          child.stdin?.write(`${JSON.stringify(request)}\n`);
        } catch {
          fail("external session adapter closed before completing its request");
          return;
        }
        // Notifications have no response. Flush any immediately following notification(s) and the next
        // request in one pass; otherwise the sequence would wait forever after `initialized`.
        if (request.id !== undefined) return;
      }
    };
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const record = message as Record<string, unknown>;
      if (typeof record.id !== "number") return;
      if (record.error && typeof record.error === "object") {
        const providerCode = !Array.isArray(record.error)
          ? (record.error as Record<string, unknown>).code
          : undefined;
        finish(() => reject(new ExternalJsonlRpcRequestError(
          typeof providerCode === "number" && Number.isSafeInteger(providerCode) ? providerCode : -32_000,
        )));
        return;
      }
      if (record.id === options.resultId) {
        finish(() => resolve(record.result as T));
        return;
      }
      writeNext();
    };
    const consume = (chunk: string): void => {
      pending += chunk;
      if (pending.length > maxOutputBytes) {
        fail("external session adapter returned an overlong JSONL frame");
        return;
      }
      let newline = pending.indexOf("\n");
      while (!done && newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) {
          try {
            onMessage(JSON.parse(line));
          } catch {
            fail("external session adapter returned invalid JSONL");
            return;
          }
        }
        newline = pending.indexOf("\n");
      }
    };
    const timer = setTimeout(() => {
      fail("external session adapter timed out");
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (done) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        fail("external session adapter exceeded its output limit");
        return;
      }
      consume(chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk.toString(), 64 * 1024);
    });
    child.once("error", () => fail("external session adapter process failed"));
    child.once("close", (code) => {
      if (done) return;
      // Provider stderr can contain home paths, native session IDs, or configuration details. It is held
      // only for bounded draining and is intentionally never returned across Hara's protocol boundary.
      void stderr;
      fail(`external session adapter exited before replying (code ${code ?? "unknown"})`);
    });
    writeNext();
  });
}
