import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readStandalonePiSmokeWorkerFailure,
  standalonePiSmokeDiagnostic,
} from "../scripts/standalone-pi-runtime-diagnostics.mjs";

const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "synthetic-smoke-session";
const REGISTRATION_ERROR = "managed Agent directory is not registered to the source repository";

test("Pi smoke diagnostics select only fixed worker failure fields", () => {
  const diagnostic = standalonePiSmokeDiagnostic({
    stage: "worker_assertions", rootRounds: 6, workerRounds: 0, requests: 6, error: new Error("must-not-appear"),
    worker: {
      runtime: "pi", status: "failed", generation: 2, error: REGISTRATION_ERROR,
      providerSessionId: "must-not-appear", task: "must-not-appear", messages: ["must-not-appear"],
      workspace: { state: "error", error: REGISTRATION_ERROR, path: "must-not-appear", patch: "must-not-appear" },
    },
  });
  assert.deepEqual(diagnostic, {
    stage: "worker_assertions", errorKind: "Error", rootRounds: 6, workerRounds: 0, requests: 6,
    worker: { runtime: "pi", status: "failed", generation: 2, errorCode: "registration_missing",
      workspace: { state: "error", errorCode: "registration_missing" } },
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /must-not-appear|managed Agent directory/);
});

test("Pi smoke never echoes arbitrary error text or credential-like values", () => {
  const secret = "synthetic-opaque-secret-value";
  const text = `Authorization: Bearer ${secret}; apiKey=${secret}; ${"x".repeat(10_000)}\n\u001b[31m`;
  const diagnostic = standalonePiSmokeDiagnostic({
    stage: "worker_assertions", rootRounds: 6, workerRounds: 0, requests: 6, error: { name: text, message: text },
    worker: { runtime: "pi", status: "failed", generation: 2, error: text, workspace: { state: "error", error: text } },
  });
  assert.equal(diagnostic.errorKind, "unexpected");
  assert.equal(diagnostic.worker.errorCode, "unclassified");
  assert.equal(diagnostic.worker.workspace.errorCode, "unclassified");
  const encoded = JSON.stringify(diagnostic);
  assert.equal(encoded.length < 500, true);
  assert.doesNotMatch(encoded, /synthetic-opaque|Authorization|apiKey|\\u001b|xxxxxxxx/);
});

test("Pi smoke unknown enum fields and unsafe counters are not echoed", () => {
  const diagnostic = standalonePiSmokeDiagnostic({
    stage: "must-not-appear", rootRounds: -1, workerRounds: Infinity, requests: "must-not-appear",
    worker: { runtime: "must-not-appear", status: "must-not-appear", generation: Number.MAX_SAFE_INTEGER + 1,
      error: { arbitrary: "must-not-appear" }, workspace: { state: "must-not-appear", error: ["must-not-appear"] } },
    workerFailure: { errorCode: "must-not-appear", workspaceErrorCode: "must-not-appear" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic)), {
    stage: "unexpected", errorKind: "unexpected", worker: { runtime: "unexpected", status: "unexpected", errorCode: "unexpected",
      workspace: { state: "unexpected", errorCode: "unexpected" } },
  });
});

function fixture(t) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-pi-smoke-diagnostic-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, ".hara", "agent-teams");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${SESSION_ID}.json`);
  const snapshot = { version: 1, sessionId: SESSION_ID, agents: [{ id: WORKER_ID, error: REGISTRATION_ERROR,
    workspace: { error: "managed Agent worktree was replaced or linked" }, prompt: "must-not-appear" }] };
  const write = value => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  write(snapshot);
  return { home, directory, path, snapshot, write };
}

test("Pi smoke reads only exact fixture session/worker failure codes", t => {
  const state = fixture(t);
  assert.deepEqual(readStandalonePiSmokeWorkerFailure(state.home, SESSION_ID, WORKER_ID), {
    errorCode: "registration_missing", workspaceErrorCode: "worktree_replaced",
  });
  assert.equal(readStandalonePiSmokeWorkerFailure(state.home, "../other", WORKER_ID), undefined);
  assert.equal(readStandalonePiSmokeWorkerFailure(state.home, SESSION_ID, "22222222-2222-4222-8222-222222222222"), undefined);
  state.write({ ...state.snapshot, sessionId: "another-session" });
  assert.equal(readStandalonePiSmokeWorkerFailure(state.home, SESSION_ID, WORKER_ID), undefined);
  state.write({ ...state.snapshot, agents: [...state.snapshot.agents, ...state.snapshot.agents] });
  assert.equal(readStandalonePiSmokeWorkerFailure(state.home, SESSION_ID, WORKER_ID), undefined);
});

test("Pi smoke diagnostic state reads are bounded and reject malformed input", t => {
  const state = fixture(t);
  writeFileSync(state.path, "x".repeat(2 * 1024 * 1024 + 1));
  assert.equal(readStandalonePiSmokeWorkerFailure(state.home, SESSION_ID, WORKER_ID), undefined);
  writeFileSync(state.path, "{not JSON");
  assert.equal(readStandalonePiSmokeWorkerFailure(state.home, SESSION_ID, WORKER_ID), undefined);
  state.write({ ...state.snapshot, agents: Array.from({ length: 65 }, (_, index) => ({ id: String(index) })) });
  assert.equal(readStandalonePiSmokeWorkerFailure(state.home, SESSION_ID, WORKER_ID), undefined);
});

test("Pi smoke diagnostic state does not traverse a linked fixture directory", t => {
  const state = fixture(t);
  const other = fixture(t);
  rmSync(state.directory, { recursive: true });
  symlinkSync(other.directory, state.directory, process.platform === "win32" ? "junction" : "dir");
  assert.equal(readStandalonePiSmokeWorkerFailure(state.home, SESSION_ID, WORKER_ID), undefined);
});

test("Pi native smoke and its diagnostics need only Node builtins in public asset verification", () => {
  const helper = readFileSync(new URL("../scripts/standalone-pi-runtime-diagnostics.mjs", import.meta.url), "utf8");
  for (const match of helper.matchAll(/from\s+["']([^"']+)["']/gu)) assert.ok(match[1].startsWith("node:"), match[1]);
  assert.doesNotMatch(helper, /dist\/|redactKnownSecrets/);
  const smoke = readFileSync(new URL("../scripts/standalone-pi-runtime-smoke.mjs", import.meta.url), "utf8");
  assert.match(smoke, /assert\.equal\(worker\.status, "completed"\)/);
  assert.match(smoke, /assert\.equal\(worker\.generation, 2\)/);
  assert.match(smoke, /assert\.equal\(workerRounds, 3\); assert\.equal\(rootRounds, 6\)/);
  for (const field of ["providerRounds, 3", "toolCalls, 1", "inputTokens, 21", "outputTokens, 9"]) assert.ok(smoke.includes(`budget.${field}`));
  assert.match(smoke, /readStandalonePiSmokeWorkerFailure\(home, diagnosticSessionId, diagnosticWorker\?\.id\)/);
  assert.doesNotMatch(smoke, /error\.message|JSON\.stringify\((?:worker|listed|record)\)/);
});
