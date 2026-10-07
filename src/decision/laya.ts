import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  bindPrivateHaraStateFile,
  ensurePrivateStateSubdirectory,
  readPrivateStateFileSnapshotSync,
  writePrivateStateFileSync,
  withPrivateStateLockSync,
} from "../security/private-state.js";
import { redactSensitiveText } from "../security/secrets.js";
import { parseTypeSafeActionJudgment, type ActionDecisionInput, type TypeSafeActionJudgment } from "./typesafe.js";
import { LAYA_MODEL, LAYA_MODEL_PREPARE, LAYA_PACKAGE_VERSION, LAYA_REVISION, LAYA_WEIGHT_SHA256, LAYA_WHEEL, LAYA_WORKER } from "./laya-worker.js";

export interface LayaRuntimeState {
  supported: boolean;
  status: "unsupported" | "missing" | "preparing" | "ready" | "error";
  model: string;
  revision: string;
  contextTokens: number;
  experimental: true;
  error?: string;
}

export const LAYA_ERRORS: Record<string, string> = {
  context_budget_exceeded: "Laya input exceeds its 1024-token context; no truncated judgment was used",
  question_budget_exceeded: "Laya question exceeds its token budget; no truncated judgment was used",
  inference_failed: "Laya inference failed; no local judgment was used",
  runtime_verification_failed: "Laya runtime/model verification failed; prepare the local engine again",
};

const REQUIRED_MODEL_FILES = ["manifest.json", "model.safetensors", "rl_agent_config.json", "encoder/config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"];

export function layaPlatformSupported(os = platform(), cpu = arch(), kernel = release()): boolean {
  return os === "darwin" && cpu === "arm64" && Number.parseInt(kernel, 10) >= 23;
}

// Short, fixed question: no user/repository text becomes instructions or an option definition.
export function layaActionRequest(input: ActionDecisionInput): { state: object; questions: object } {
  const clean = (value: string) => redactSensitiveText(value).text;
  const state = {
    task: clean(input.task),
    action: { tool: clean(input.tool), category: clean(input.category), reason: clean(input.classifierReason), detail: clean(input.detail) },
  };
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > 16_384) throw new Error(LAYA_ERRORS.context_budget_exceeded);
  return {
    state,
    questions: {
      action_guard: {
        type: "choice",
        instructions: "Is the pending action authorized by and aligned with the user's task? Judge only this action.",
        criteria: {
          allow: "Clearly requested, bounded, with an unambiguous target and effect.",
          review: "Ambiguous, broader than requested, or needs a human check.",
          block: "Unrelated, unauthorized, deceptive, exposes credentials, or destructively exceeds the request.",
        },
      },
    },
  };
}

interface RuntimeOptions {
  home?: string;
  supported?: boolean;
  /** Test seams are never read from project config, the renderer or environment. */
  spawn?: typeof spawn;
}

/** One process per Hara Engine/home, shared by all Agents. Serial, bounded, cancellation-safe stdio. */
export class LayaRuntime {
  private readonly home: string;
  private readonly supported: boolean;
  private readonly launch: typeof spawn;
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending?: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void };
  private rejectStart?: (error: Error) => void;
  private queue = Promise.resolve();
  private queued = 0;
  private preparing = false;
  private preparation?: Promise<void>;
  private prepareError?: string;
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(options: RuntimeOptions = {}) {
    this.home = realpathSync.native(options.home ?? homedir());
    this.supported = options.supported ?? layaPlatformSupported();
    this.launch = options.spawn ?? spawn;
  }

  private directory(): string { return join(this.home, ".hara", "decision", "laya-mlx", LAYA_PACKAGE_VERSION); }
  private receipt() { return bindPrivateHaraStateFile(this.home, ["decision", "laya-mlx", LAYA_PACKAGE_VERSION], "ready.json"); }
  private setup() { return bindPrivateHaraStateFile(this.home, ["decision", "laya-mlx", LAYA_PACKAGE_VERSION], "setup.json"); }
  private modelDirectory(): string { return join(this.directory(), "model", LAYA_REVISION); }
  private python(): string { return join(this.directory(), "venv", "bin", "python"); }

  snapshot(): LayaRuntimeState {
    let status: LayaRuntimeState["status"] = !this.supported ? "unsupported" : this.preparing ? "preparing" : this.prepareError ? "error" : "missing";
    if (status === "missing" && existsSync(this.directory())) {
      try {
        const binding = this.receipt();
        const raw = readPrivateStateFileSnapshotSync(binding.path, 4096);
        const saved = raw ? JSON.parse(raw.text) : null;
        if (saved?.version === LAYA_PACKAGE_VERSION && saved?.revision === LAYA_REVISION && saved?.weightSha256 === LAYA_WEIGHT_SHA256
          && existsSync(this.python()) && REQUIRED_MODEL_FILES.every((file) => existsSync(join(this.modelDirectory(), file)))) status = "ready";
        const setupRaw = readPrivateStateFileSnapshotSync(this.setup().path, 4096);
        const setup = setupRaw ? JSON.parse(setupRaw.text) : null;
        if (setup?.phase === "preparing") status = this.ownerAlive(setup.pid) ? "preparing" : "missing";
        if (setup?.phase === "error") status = "error";
      } catch { status = "error"; }
    }
    return { supported: this.supported, status, model: LAYA_MODEL, revision: LAYA_REVISION, contextTokens: 1024, experimental: true,
      ...(status === "error" ? { error: this.prepareError ?? "Laya preparation state could not be verified; prepare the local engine again" } : {}) };
  }

  private ownerAlive(pid: unknown): boolean {
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
    try { process.kill(Number(pid), 0); return true; } catch (error: any) { return error?.code === "EPERM"; }
  }

  private environment(offline: boolean): NodeJS.ProcessEnv {
    // No provider keys, HF tokens, PYTHONPATH, repository configuration, or proxy credentials inherited.
    return {
      HOME: this.home, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", LANG: "en_US.UTF-8",
      HF_HOME: join(this.directory(), "cache"), HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
      HF_HUB_OFFLINE: offline ? "1" : "0", PYTHONDONTWRITEBYTECODE: "1", UV_NO_CONFIG: "1",
      UV_CACHE_DIR: join(this.directory(), "uv-cache"), UV_PYTHON_INSTALL_DIR: join(this.directory(), "python"),
    };
  }

  private workerArgs(operation: "verify" | "serve"): string[] {
    return ["-I", "-u", "-c", LAYA_WORKER, this.modelDirectory(), LAYA_MODEL, LAYA_REVISION, LAYA_WEIGHT_SHA256, LAYA_PACKAGE_VERSION, operation];
  }

  /** Starts background setup and returns immediately, so RPC reconnection can observe progress. */
  prepare(confirmed: boolean): LayaRuntimeState {
    if (confirmed !== true) throw new Error("Preparing Laya requires explicit download consent");
    if (!this.supported) throw new Error("Laya-MLX requires an Apple Silicon Mac running macOS 14 or later");
    if (this.preparing) return this.snapshot();
    if (this.snapshot().status === "ready") return this.snapshot();
    const token = randomUUID();
    const claimed = withPrivateStateLockSync(this.home, ["decision", "laya-mlx", LAYA_PACKAGE_VERSION], "setup", () => {
      const binding = this.setup();
      const raw = readPrivateStateFileSnapshotSync(binding.path, 4096);
      const previous = raw ? JSON.parse(raw.text) : null;
      if (previous?.phase === "preparing" && this.ownerAlive(previous.pid)) return false;
      writePrivateStateFileSync(binding, JSON.stringify({ pid: process.pid, token, phase: "preparing" }));
      return true;
    });
    if (!claimed) return this.snapshot();
    this.preparing = true;
    this.prepareError = undefined;
    this.stop();
    this.preparation = this.install().catch(() => {
      this.prepareError = "Laya preparation failed. Check Python 3.11+/uv and network access to PyPI and Hugging Face, then retry.";
    }).finally(() => {
      this.preparing = false;
      try {
        withPrivateStateLockSync(this.home, ["decision", "laya-mlx", LAYA_PACKAGE_VERSION], "setup", () => {
          const binding = this.setup();
          const raw = readPrivateStateFileSnapshotSync(binding.path, 4096);
          if (raw && JSON.parse(raw.text)?.token === token) {
            writePrivateStateFileSync(binding, JSON.stringify({ pid: process.pid, token, phase: this.prepareError ? "error" : "complete" }));
          }
        });
      } catch { this.prepareError = "Laya preparation state could not be verified; retry preparation"; }
    });
    return this.snapshot();
  }

  async waitForPreparation(): Promise<LayaRuntimeState> {
    if (this.preparation) await this.preparation;
    // A second CLI/Engine may own setup. Observe its private receipt rather than launching a duplicate.
    const deadline = Date.now() + 20 * 60_000;
    while (this.snapshot().status === "preparing" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return this.snapshot();
  }

  private async install(): Promise<void> {
    ensurePrivateStateSubdirectory(this.home, [".hara", "decision", "laya-mlx", LAYA_PACKAGE_VERSION]);
    ensurePrivateStateSubdirectory(this.home, [".hara", "decision", "laya-mlx", LAYA_PACKAGE_VERSION, "model", LAYA_REVISION]);
    for (const directory of ["venv", "cache", "uv-cache", "python"]) {
      ensurePrivateStateSubdirectory(this.home, [".hara", "decision", "laya-mlx", LAYA_PACKAGE_VERSION, directory]);
    }
    const uv = [join(this.home, ".local", "bin", "uv"), "/opt/homebrew/bin/uv", "/usr/local/bin/uv"].find((candidate) => {
      try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
    });
    if (uv) {
      await this.run(uv, ["--no-config", "venv", "--allow-existing", "--python", "3.12", join(this.directory(), "venv")]);
      ensurePrivateStateSubdirectory(this.home, [".hara", "decision", "laya-mlx", LAYA_PACKAGE_VERSION, "venv", "bin"]);
      await this.run(uv, ["--no-config", "pip", "install", "--python", this.python(), "--index-url", "https://pypi.org/simple", LAYA_WHEEL]);
    } else {
      const python = ["/opt/homebrew/bin/python3.12", "/opt/homebrew/bin/python3.11", "/usr/local/bin/python3.12", "/usr/local/bin/python3.11"].find((candidate) => existsSync(candidate));
      if (!python) throw new Error("python_runtime_missing");
      await this.run(python, ["-I", "-m", "venv", join(this.directory(), "venv")]);
      ensurePrivateStateSubdirectory(this.home, [".hara", "decision", "laya-mlx", LAYA_PACKAGE_VERSION, "venv", "bin"]);
      await this.run(this.python(), ["-I", "-m", "pip", "--isolated", "install", "--index-url", "https://pypi.org/simple", LAYA_WHEEL]);
    }
    await this.run(this.python(), ["-I", "-u", "-c", LAYA_MODEL_PREPARE, this.modelDirectory(), LAYA_MODEL, LAYA_REVISION, LAYA_WEIGHT_SHA256]);
    await this.run(this.python(), this.workerArgs("verify"), true);
    writePrivateStateFileSync(this.receipt(), JSON.stringify({ version: LAYA_PACKAGE_VERSION, revision: LAYA_REVISION, weightSha256: LAYA_WEIGHT_SHA256 }));
  }

  private run(executable: string, args: string[], offline = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.launch(executable, args, { cwd: this.directory(), env: this.environment(offline), stdio: ["ignore", "ignore", "ignore"], shell: false });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Laya preparation timed out")); }, 10 * 60_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Laya preparation failed")); });
    });
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    if (this.snapshot().status !== "ready") throw new Error("Prepare the local Laya engine in Settings before testing or using it");
    // Refuse redirected venv parents. The Python executable itself is normally a venv-managed symlink.
    ensurePrivateStateSubdirectory(this.home, [".hara", "decision", "laya-mlx", LAYA_PACKAGE_VERSION, "venv", "bin"]);
    ensurePrivateStateSubdirectory(this.home, [".hara", "decision", "laya-mlx", LAYA_PACKAGE_VERSION, "model", LAYA_REVISION, "tokenizer"]);
    ensurePrivateStateSubdirectory(this.home, [".hara", "decision", "laya-mlx", LAYA_PACKAGE_VERSION, "model", LAYA_REVISION, "encoder"]);
    const child = this.launch(this.python(), this.workerArgs("serve"), {
      cwd: this.directory(), env: this.environment(true), stdio: ["pipe", "pipe", "pipe"], shell: false,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    const ready = new Promise<void>((resolve, reject) => {
      this.rejectStart = reject;
      child.stdout.on("data", (part: Buffer) => {
        if (this.child !== child) return;
        buffer += decoder.write(part);
        if (Buffer.byteLength(buffer, "utf8") > 65_536) return this.stop(new Error("Laya response exceeded its limit"), child);
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (value.error === "runtime_verification_failed") {
              this.prepareError = LAYA_ERRORS.runtime_verification_failed;
              this.stop(new Error(this.prepareError), child); return;
            } else if (value.ready === true && value.model === LAYA_MODEL && value.revision === LAYA_REVISION) {
              this.rejectStart = undefined; resolve();
            } else if (this.pending && value.id === this.pending.id) {
              const pending = this.pending; this.pending = undefined;
              value.error ? pending.reject(new Error(LAYA_ERRORS[value.error] ?? "Laya inference failed")) : pending.resolve(value.result);
            } else throw new Error("Unexpected Laya response");
          } catch { this.stop(new Error("Laya runtime returned an invalid response"), child); return; }
        }
      });
      // Drain stderr without retaining task data or exposing warnings/tracebacks to Desktop.
      child.stderr.on("data", () => {});
      child.once("error", () => this.stop(new Error("Could not start the local Laya runtime"), child));
      child.once("close", () => this.stop(new Error("Local Laya runtime stopped"), child));
    });
    this.ready = ready;
    return ready;
  }

  stop(error = new Error("Local Laya runtime stopped"), expected?: ChildProcessWithoutNullStreams): void {
    if (expected && this.child !== expected) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = undefined; this.ready = undefined;
    this.rejectStart?.(error); this.rejectStart = undefined;
    this.pending?.reject(error); this.pending = undefined;
    child?.kill("SIGKILL");
  }

  async judge(input: ActionDecisionInput, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<TypeSafeActionJudgment> {
    const request = layaActionRequest(input);
    if (this.queued >= 16) throw new Error("Local Laya queue is full; no judgment was used");
    this.queued++;
    const startedAt = performance.now();
    const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 10_000), ...(options.signal ? [options.signal] : [])]);
    const work = this.queue.then(async () => {
      signal.throwIfAborted();
      if (this.idleTimer) clearTimeout(this.idleTimer);
      const aborted = () => this.stop(new Error("Local Laya judgment cancelled or timed out"));
      signal.addEventListener("abort", aborted, { once: true });
      try {
        await this.start();
        signal.throwIfAborted();
        const result = await new Promise<unknown>((resolve, reject) => {
          const id = randomUUID();
          this.pending = { id, resolve, reject };
          this.child!.stdin.write(JSON.stringify({ id, ...request }) + "\n", (error) => {
            if (error) this.stop(new Error("Local Laya input failed"));
          });
        });
        const parsed = parseTypeSafeActionJudgment(result, `${LAYA_MODEL}@${LAYA_REVISION}`);
        // Uncalibrated local decisions are evidence only; never grant or deny authority from a score.
        return { ...parsed, decision: "review" as const, elapsedMs: Math.round(performance.now() - startedAt), usage: { outputTokens: 0 } };
      } finally {
        signal.removeEventListener("abort", aborted);
        this.idleTimer = setTimeout(() => this.stop(), 60_000);
        this.idleTimer.unref();
      }
    });
    this.queue = work.then(() => {}, () => {});
    // Keep an active call alive even though the persistent worker's pipes are unref'd.
    const keepAlive = setTimeout(() => {}, options.timeoutMs ?? 10_000);
    try { return await work; } finally { clearTimeout(keepAlive); this.queued--; }
  }
}

const runtimes = new Map<string, LayaRuntime>();
export function layaRuntime(): LayaRuntime {
  const home = realpathSync.native(homedir());
  let runtime = runtimes.get(home);
  if (!runtime) { runtime = new LayaRuntime({ home }); runtimes.set(home, runtime); }
  return runtime;
}
process.once("exit", () => { for (const runtime of runtimes.values()) runtime.stop(); });
