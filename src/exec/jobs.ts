// Background shell jobs — run long-lived commands (dev servers, `tsc --watch`, long builds) WITHOUT blocking
// the agent, then tail/kill them. Pipe-based (no PTY yet; a true interactive PTY can come later behind an
// optional dep). Same sandbox write-confinement as runShell (shared `shellCommand`). Jobs are the agent's
// own child processes and are terminated when hara exits.
import { spawn, type ChildProcess } from "node:child_process";
import { shellCommand, type SandboxMode } from "../sandbox.js";

const MAX_BUF = 64 * 1024; // retain only the tail of each job's combined output

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
}

const jobs = new Map<string, Job>();
let seq = 0;

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
  const { cmd, args } = shellCommand(command, cwd, mode);
  const child = spawn(cmd, args, { cwd });
  const job: Job = { id: "j" + ++seq, command, child, status: "running", code: null, startedAt: Date.now(), buf: "" };
  const onData = (d: Buffer): void => {
    job.buf = (job.buf + d.toString()).slice(-MAX_BUF);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("close", (code) => {
    if (job.status === "running") {
      job.status = "exited";
      job.code = code;
      emitJobsChange(); // a job finishing ON ITS OWN (no user action) must update the UI — this is the idle case
    }
  });
  child.on("error", (e) => {
    if (job.status === "running") {
      job.status = "exited";
      job.code = -1;
      job.buf = (job.buf + `\n[spawn error] ${e.message}`).slice(-MAX_BUF);
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
  try {
    j.child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  j.status = "killed";
  emitJobsChange();
  return true;
}

/** Terminate every running job — registered on process exit so dev servers don't outlive hara. */
export function killAllJobs(): void {
  for (const j of jobs.values()) {
    if (j.status === "running") {
      try {
        j.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      j.status = "killed";
    }
  }
}
