// Background shell jobs — run long-lived commands (dev servers, `tsc --watch`, long builds) WITHOUT blocking
// the agent, then tail/kill them. Pipe-based (no PTY yet; a true interactive PTY can come later behind an
// optional dep). Same sandbox write-confinement as runShell (shared `shellCommand`). Jobs are the agent's
// own child processes and are terminated when hara exits.
import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { shellCommand, type SandboxMode } from "../sandbox.js";
import {
  createToolOutputLineRedactor,
  redactToolSubprocessOutput,
  terminateSubprocessTree,
  toolSubprocessEnv,
} from "../security/subprocess-env.js";

const MAX_BUF = 64 * 1024; // retain only the tail of each job's combined output
const MAX_RUNNING_JOBS = 32;
const MAX_RETAINED_JOBS = 200;

export interface JobInfo {
  id: string;
  command: string;
  status: "running" | "exited" | "killed";
  code: number | null;
  ageMs: number;
}
interface Job extends Omit<JobInfo, "ageMs"> {
  child: ChildProcess;
  startedAt: number;
  buf: string;
  processGroup: boolean;
  flushOutput: () => void;
  cancelTermination?: (cancelForce?: boolean) => void;
  terminationPending: boolean;
  closed: boolean;
}

const jobs = new Map<string, Job>();
let seq = 0;

function pruneFinishedJobs(reserve = 0): void {
  const target = Math.max(0, MAX_RETAINED_JOBS - reserve);
  if (jobs.size <= target) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= target) break;
    if (job.status !== "running" && !job.terminationPending) jobs.delete(id);
  }
}

type JobsListener = () => void;
const jobsListeners = new Set<JobsListener>();
/** Subscribe to job start/exit/kill. Lets the UI show "a background task is running" LIVE — crucially at
 *  IDLE too: a turn ending doesn't mean the background work did, and without this the user reads the idle
 *  prompt as "it stopped". Returns an unsubscribe. */
export function onJobsChange(fn: JobsListener): () => void {
  jobsListeners.add(fn);
  return () => {
    jobsListeners.delete(fn);
  };
}
function emitJobsChange(): void {
  for (const fn of jobsListeners) {
    try {
      fn();
    } catch {
      /* a listener must never break job bookkeeping */
    }
  }
}

let hooked = false;
function ensureExitCleanup(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", killAllJobs); // sync; runs on normal quit so background jobs don't orphan
}

/** Start a background shell job; returns its id immediately. Output is captured to a capped tail buffer. */
export function startJob(command: string, cwd: string, mode: SandboxMode): string {
  ensureExitCleanup();
  const running = [...jobs.values()].filter((job) => job.status === "running" || job.terminationPending).length;
  if (running >= MAX_RUNNING_JOBS) {
    throw new Error(`too many background jobs (${MAX_RUNNING_JOBS}); stop or wait for an existing job before starting another`);
  }
  pruneFinishedJobs(1);
  const { cmd, args } = shellCommand(command, cwd, mode);
  const processGroup = platform() !== "win32";
  const child = spawn(cmd, args, { cwd, env: toolSubprocessEnv(), detached: processGroup });
  const job: Job = {
    id: "j" + ++seq,
    // The raw command may contain an inline --token/KEY=value. It is used only for spawning above; every
    // stored/listed copy is redacted so /jobs, TUI state, and tool results cannot replay it.
    command: redactToolSubprocessOutput(command),
    child,
    status: "running",
    code: null,
    startedAt: Date.now(),
    buf: "",
    processGroup,
    flushOutput: () => {},
    terminationPending: false,
    closed: false,
  };
  const appendSafe = (safe: string): void => {
    job.buf = (job.buf + safe).slice(-MAX_BUF);
  };
  // Separate buffers avoid stitching an stdout token prefix to an unrelated stderr suffix. Only redacted
  // text reaches Job.buf; later callers never need access to the raw subprocess stream.
  const stdout = createToolOutputLineRedactor(appendSafe);
  const stderr = createToolOutputLineRedactor(appendSafe);
  let flushed = false;
  job.flushOutput = (): void => {
    if (flushed) return;
    flushed = true;
    stdout.flush();
    stderr.flush();
  };
  child.stdout?.on("data", (d: Buffer) => stdout.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
  child.on("close", (code) => {
    job.closed = true;
    job.cancelTermination?.();
    if (!job.terminationPending) job.cancelTermination = undefined;
    job.flushOutput();
    if (job.status === "running") {
      job.status = "exited";
      job.code = code;
      emitJobsChange(); // a job finishing ON ITS OWN (no user action) must update the UI — this is the idle case
    }
  });
  child.on("error", (e) => {
    job.cancelTermination?.();
    job.cancelTermination = undefined;
    if (job.status === "running") {
      job.status = "exited";
      job.code = -1;
      appendSafe(`\n[spawn error] ${redactToolSubprocessOutput(e.message)}`);
      job.flushOutput();
      emitJobsChange();
    }
  });
  jobs.set(job.id, job);
  emitJobsChange();
  return job.id;
}

export function listJobs(): JobInfo[] {
  const now = Date.now();
  return [...jobs.values()].map((j) => ({ id: j.id, command: j.command, status: j.status, code: j.code, ageMs: now - j.startedAt }));
}

/** Last `lines` lines of a job's output buffer, or null if there is no such job. */
export function tailJob(id: string, lines = 40): string | null {
  const j = jobs.get(id);
  if (!j) return null;
  return j.buf.split("\n").slice(-lines).join("\n");
}

/** Terminate a running job (SIGTERM). Returns true only if it was running. */
export function killJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.status !== "running") return false;
  j.status = "killed";
  j.terminationPending = true;
  j.cancelTermination = terminateSubprocessTree(j.child, {
    processGroup: j.processGroup,
    graceMs: 250,
    fallbackMs: 1_000,
    onForce: () => {
      j.terminationPending = false;
      if (j.closed) j.cancelTermination = undefined;
    },
    onFallback: () => {
      // An intentionally daemonized descendant can escape its original process group while retaining a
      // pipe. Destroy our ends so it cannot keep Hara alive; normal descendants were already group-killed.
      j.child.stdout?.destroy();
      j.child.stderr?.destroy();
      j.flushOutput();
      j.cancelTermination = undefined;
    },
  });
  emitJobsChange();
  return true;
}

/** Terminate every running job — registered on process exit so dev servers don't outlive hara. */
export function killAllJobs(): void {
  for (const j of jobs.values()) {
    if (j.status === "running" || j.terminationPending) {
      j.cancelTermination?.(true);
      j.cancelTermination = undefined;
      // `exit` handlers cannot wait for a grace timer. Force the whole owned tree synchronously so normal
      // quit does not orphan a dev server or worker; Windows taskkill /T supplies the equivalent tree kill.
      terminateSubprocessTree(j.child, { force: true, processGroup: j.processGroup });
      j.terminationPending = false;
      j.status = "killed";
    }
  }
}
