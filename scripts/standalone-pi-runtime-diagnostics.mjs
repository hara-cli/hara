import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const stages = new Set([
  "fixture_git", "fixture_provider", "profile", "serve_start", "discovery", "initialize",
  "settings", "session_create", "session_send", "worker_assertions", "shutdown",
]);
const runtimes = new Set(["hara", "codex", "claude", "opencode", "pi"]);
const statuses = new Set(["queued", "working", "stopping", "completed", "failed", "cancelled", "interrupted"]);
const workspaceStates = new Set(["pending", "ready", "changes", "applying", "applied", "rejected", "error"]);
const errorNames = new Set(["Error", "AssertionError", "TypeError", "SyntaxError", "RangeError"]);
const worktreeErrors = new Map([
  ["managed Agent directory is not registered to the source repository", "registration_missing"],
  ["managed Agent worktree was replaced or linked", "worktree_replaced"],
  ["managed Agent worktree identity changed", "worktree_identity_changed"],
  ["managed Agent worktree base commit changed", "base_commit_changed"],
  ["managed Agent cwd escaped its worktree", "workspace_escaped"],
  ["the source session cwd is not a tracked directory in the managed Agent worktree", "cwd_invalid"],
]);
const errorCodes = new Set([...worktreeErrors.values(), "unclassified"]);
const MAX_TEAM_BYTES = 2 * 1024 * 1024;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const fixed = (value, values) => typeof value === "string" && values.has(value) ? value : "unexpected";
const errorCode = value => typeof value === "string" ? worktreeErrors.get(value) ?? "unclassified" : undefined;

/** Read only this fixture's exact session and worker; never return arbitrary state/error text. */
export function readStandalonePiSmokeWorkerFailure(home, sessionId, workerId) {
  if (typeof home !== "string" || !isAbsolute(home)
    || typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,220}$/u.test(sessionId)
    || typeof workerId !== "string" || !/^[a-f0-9-]{36}$/u.test(workerId)) return undefined;
  let fd;
  try {
    const directory = join(home, ".hara", "agent-teams");
    for (const path of [home, join(home, ".hara"), directory]) {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== path) return undefined;
    }
    const path = join(directory, `${sessionId}.json`);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_TEAM_BYTES || realpathSync.native(path) !== path) return undefined;
    fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== before.ino || opened.size > MAX_TEAM_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_TEAM_BYTES + 1);
    let length = 0, bytes;
    while (length < buffer.length && (bytes = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += bytes;
    if (length > MAX_TEAM_BYTES) return undefined;
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || after.ino !== opened.ino || realpathSync.native(path) !== path) return undefined;
    const snapshot = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (snapshot?.version !== 1 || snapshot.sessionId !== sessionId || !Array.isArray(snapshot.agents) || snapshot.agents.length > 64) return undefined;
    const workers = snapshot.agents.filter(worker => worker?.id === workerId);
    if (workers.length !== 1) return undefined;
    return { errorCode: errorCode(workers[0].error), workspaceErrorCode: errorCode(workers[0].workspace?.error) };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Deliberately exclude prompts, messages, provider ids, filesystem paths and arbitrary record fields. */
export function standalonePiSmokeDiagnostic({ stage, rootRounds, workerRounds, requests, worker, workerFailure, error }) {
  return {
    stage: fixed(stage, stages),
    errorKind: fixed(error?.name, errorNames),
    rootRounds: count(rootRounds),
    workerRounds: count(workerRounds),
    requests: count(requests),
    ...(worker && typeof worker === "object" ? { worker: {
      runtime: fixed(worker.runtime, runtimes),
      status: fixed(worker.status, statuses),
      generation: count(worker.generation),
      errorCode: workerFailure?.errorCode === undefined ? errorCode(worker.error) : fixed(workerFailure.errorCode, errorCodes),
      ...(worker.workspace && typeof worker.workspace === "object" ? { workspace: {
        state: fixed(worker.workspace.state, workspaceStates),
        errorCode: workerFailure?.workspaceErrorCode === undefined ? errorCode(worker.workspace.error) : fixed(workerFailure.workspaceErrorCode, errorCodes),
      } } : {}),
    } } : {}),
  };
}
