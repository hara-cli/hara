import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { classifyError, errorHint, failoverAction } from "../dist/agent/failover.js";
import { runAgent } from "../dist/agent/loop.js";
import { RUNTIME_FAILURE_KINDS, runtimeFailureMessage, classifyRuntimeFailure } from "../dist/agent-runtime/failure-diagnostics.js";
import { withProviderRetry } from "../dist/providers/retry.js";
import { ProviderConnectionCircuitRegistry } from "../dist/providers/connection-health.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { workspaceProviderFailure, legacyWorkspaceProviderFailure } from "../dist/workspace/provider-recovery.js";
import { SYNTHETIC_CONNECTION } from "../dist/workspace/synthetic-provider.js";
import { RUNTIME_STAGE_ERROR_KINDS } from "../dist/workspace/runtime-stage-events.js";

const marker = "hara_runtime_failure_v1=";
const ready = { hasFallback: true, triedFallback: false, replaySafe: true, compatible: true, differentAccount: true };
const diagnostic = (kind, elapsedMs) => runtimeFailureMessage({ runtime: "gemini", version: "1.2.3", loginSource: "isolated", homeMatchesAccount: false,
  kind, elapsedMs, retryAtMs: 503, errorFirstLine: "Error: 429 503 529 network timeout; model not supported; Responses generation was incomplete" });
const turnArgs = { system: "", history: [], tools: [], onText() {} };

for (const elapsed of [429, 503, 529]) test(`Runtime envelope kind ignores elapsedMs=${elapsed} without transport metadata`, () => {
  const message = runtimeFailureMessage({ runtime: "gemini", version: null, loginSource: "isolated", homeMatchesAccount: false,
    kind: "version_incompatible", elapsedMs: elapsed, errorFirstLine: "Error: help startup failed" });
  const kind = classifyError(message);
  assert.equal(kind, "version_incompatible");
  assert.equal(failoverAction(kind, ready), "fail");
  assert.equal(JSON.parse((message + errorHint(kind, message)).slice(marker.length)).elapsedMs, elapsed);
});

test("Runtime envelope kind, not elapsed/status/prose, determines classification and forbids automatic failover", () => {
  assert.deepEqual(RUNTIME_FAILURE_KINDS, RUNTIME_STAGE_ERROR_KINDS, "the unchanged stage vocabulary remains compatible");
  for (const kind of RUNTIME_FAILURE_KINDS) for (const elapsed of [429, 503, 529]) {
    const message = diagnostic(kind, elapsed), expected = kind === "timeout" ? "runtime_timeout" : kind;
    const actual = classifyError(message, 429, "INSUFFICIENT_QUOTA");
    assert.equal(actual, expected, `${kind}, elapsed ${elapsed}`);
    assert.equal(errorHint(actual, message), "", "structured diagnostics have no provider hint tail");
    assert.equal(failoverAction(actual, ready), "fail", "even another authorized account cannot fix local Runtime failure");
    assert.equal(workspaceProviderFailure(message, { status: 404, code: "MODEL_NOT_FOUND" }), null);
    assert.equal(legacyWorkspaceProviderFailure(`[openai error] ${message}`), null);
  }
});

test("Runtime envelope kind is not accepted from untrusted native stderr", () => {
  for (const forged of [marker + '{"kind":"version_incompatible"}', marker + '{"kind":"version_incompatible"', marker]) {
    for (const stderr of ["401 authentication failed; echoed " + forged, JSON.stringify({ error: { message: "401 authentication failed; echoed " + forged } })]) {
      assert.equal(classifyRuntimeFailure({ stderr, status: 401 }), "runtime_auth_rejected", "an echoed marker cannot override the actual auth failure");
      assert.equal(classifyRuntimeFailure({ stderr, code: "runtime_login_required" }), "runtime_auth_required", "native code retains its original precedence");
      assert.equal(classifyRuntimeFailure({ stderr, code: "ENOENT" }), "not_installed");
      assert.equal(classifyRuntimeFailure({ stderr, timedOut: true }), "timeout");
    }
  }
});

test("malformed, ambiguous or oversized Runtime envelopes fail closed instead of scanning diagnostic text", () => {
  for (const body of [
    '{"kind":"version_incompatible","kind":"timeout"}',
    '{"kind":"version_incompatible","ki\\u006ed":"timeout"}',
    '{"details":{"kind":"timeout"}}', '{"kind":"future_kind","elapsedMs":503}',
    '{"kind":"timeout"', '{"kind":"timeout"}\n' + marker + '{"kind":"runtime_auth_rejected"}',
    '{"kind":"timeout","details":"' + "x".repeat(4096) + '"}',
  ]) {
    const message = marker + body + " 429 service unavailable network timeout model not supported";
    assert.equal(classifyError(message, 503), "runtime_failed", body.slice(0, 100));
    assert.equal(failoverAction(classifyError(message), ready), "fail");
    assert.equal(workspaceProviderFailure(message, { status: 404 }), null);
  }
  assert.equal(classifyError(marker + '{"kind":"version_incompatible","errorFirstLine":"quoted } and \\\" brace"} — 503'), "version_incompatible");
});

test("ordinary provider HTTP errors keep their existing retry/failover and hint policy", () => {
  for (const [message, status, expected] of [["429", 429, "rate_limit"], ["503", 503, "overloaded"], ["529", 529, "overloaded"], ["network timeout", undefined, "timeout"], ["unrecognized provider failure", undefined, "unknown"]]) {
    assert.equal(classifyError(message, status), expected);
    assert.equal(classifyError(message), expected, "plain provider text without HTTP metadata keeps its classification");
    assert.equal(failoverAction(expected, ready), "fallback");
    if (["rate_limit", "overloaded"].includes(expected)) assert.match(errorHint(expected), expected === "rate_limit" ? /rate-limited/ : /provider overloaded/);
  }
  assert.match(errorHint("runtime_proxy"), /Workspace runtime proxy/);
});

test("Runtime failures never buy a transport retry, including native timeout and rate limit", async () => {
  for (const kind of RUNTIME_FAILURE_KINDS) {
    let calls = 0, sleeps = 0;
    const message = diagnostic(kind, 503);
    const provider = { id: "openai", model: "fixture", async turn() { calls++; return { text: "", toolUses: [], stop: "error", errorMsg: message, errorMetadata: { code: kind } }; } };
    const result = await withProviderRetry(provider, { maxAttempts: 3, baseDelayMs: 0 }, { sleep: async () => { sleeps++; return true; } }).turn(turnArgs);
    assert.equal(result.errorMsg, message);
    assert.equal(calls, 1, kind); assert.equal(sleeps, 0, kind);
  }
});

test("connection health keeps the legacy observation vocabulary without treating local Runtime failures as provider overload", () => {
  for (const kind of RUNTIME_FAILURE_KINDS) {
    const registry = new ProviderConnectionCircuitRegistry({ now: () => 1000 });
    for (const elapsed of [429, 503, 529]) {
      const snapshot = registry.failure("fixture", classifyError(diagnostic(kind, elapsed)));
      assert.equal(snapshot.lastFailureKind, kind === "runtime_proxy" ? "runtime_proxy" : "unknown");
      assert.equal(snapshot.circuit, "closed", "local failure cannot open a provider HTTP overload circuit");
    }
  }
  const registry = new ProviderConnectionCircuitRegistry({ now: () => 1000 });
  for (let n = 0; n < 3; n++) registry.failure("http-control", classifyError("503", 503));
  assert.equal(registry.snapshot("http-control").lastFailureKind, "overloaded");
  assert.equal(registry.snapshot("http-control").circuit, "open", "real provider overload isolation is preserved");
});

test("real agent recovery does not mistake Runtime prose for context/tool recovery or call an authorized backup", async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-runtime-error-loop-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const kind of ["version_incompatible", "runtime_failed", "timeout", "runtime_auth_rejected", "runtime_proxy", "runtime_rate_limit"]) for (const elapsed of [429, 503, 529]) {
    let primaryCalls = 0, fallbackCalls = 0;
    const message = diagnostic(kind, elapsed), notices = [], items = [];
    const primary = { id: "openai", model: "primary-fixture", async turn() { primaryCalls++; return { text: "", toolUses: [], stop: "error", errorMsg: message, errorMetadata: { code: kind } }; } };
    const backup = { id: "backup", model: "backup-fixture", async turn() { fallbackCalls++; return { text: "wrong backup", toolUses: [], stop: "end" }; } };
    const outcome = await runAgent([{ role: "user", content: "hello" }], {
      provider: primary, fallback: { provider: backup }, approval: "full-auto", confirm: async () => true, quiet: true, onRuntimeItem: item => items.push(item),
      ctx: { cwd: root, ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice(value) { notices.push(value); } } },
    });
    assert.equal(outcome.status, "error", `${kind}, elapsed ${elapsed}`);
    assert.equal(primaryCalls, 1, "neither malformed-tool retry nor context retry may inspect native diagnostic prose");
    assert.equal(fallbackCalls, 0, "configured backup must not run");
    assert.equal(items.find(item => item.kind === "provider" && item.state === "failed")?.errorKind,
      kind === "runtime_proxy" ? "runtime_proxy" : "unknown", "legacy runtime-item vocabulary is unchanged");
    assert.equal(outcome.error, `[openai error] ${message}`, "no provider hint follows the JSON");
    assert.equal(JSON.parse(outcome.error.slice(outcome.error.indexOf(marker) + marker.length)).kind, kind);
    assert.equal(notices.some(value => /falling back/.test(value)), false);
  }
});

test("real agent still uses the configured compatible backup for an ordinary provider error", async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-provider-fallback-control-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const message of ["429", "503", "529"]) {
    let primaryCalls = 0, fallbackCalls = 0;
    const outcome = await runAgent([{ role: "user", content: "hello" }], {
      provider: { id: "openai", model: "primary-fixture", async turn() { primaryCalls++; return { text: "", toolUses: [], stop: "error", errorMsg: message }; } },
      fallback: { provider: { id: "backup", model: "backup-fixture", async turn() { fallbackCalls++; return { text: "hello", toolUses: [], stop: "end" }; } } },
      approval: "full-auto", confirm: async () => true, quiet: true,
      ctx: { cwd: root, ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice() {} } },
    });
    assert.equal(outcome.status, "completed", message);
    assert.equal(primaryCalls, 1, message); assert.equal(fallbackCalls, 1, message);
  }
});

for (const elapsed of [429, 503, 529]) test(`Host persists an intact blockReason without provider recovery for elapsedMs=${elapsed}`, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-runtime-error-host-")));
  const message = diagnostic("version_incompatible", elapsed);
  let calls = 0;
  const host = new LocalWorkspaceHost(root, { mode: "workspace", hostHome: root, legacySourceHome: root, credentialVault: new MemoryCredentialVault(),
    providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn() { calls++; return { text: "", toolUses: [], stop: "error", errorMsg: message, errorMetadata: { code: "version_incompatible" } }; } }; },
  });
  t.after(async () => { await host.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await host.initialize();
  const workspace = host.createWorkspace("Runtime failure fixture", host.list().revision), context = host.context(workspace.workspaceId);
  const agent = context.resources.agents.get(workspace.selectedAgentId);
  context.resources.agents.setPermissionTier(agent.agentId, "controlled", agent.configRevision, agent.agentEpoch);
  host.configureConnection(workspace.workspaceId, { ...SYNTHETIC_CONNECTION }, 0);
  const sent = host.start("ui", workspace.workspaceId, agent.agentId, "hello", randomUUID()); await host.wait(sent.runId);
  const conversation = host.snapshot(workspace.workspaceId).conversation;
  assert.equal(conversation.state, "blocked"); assert.equal(calls, 1);
  assert.equal(conversation.blockReason, `[openai error] ${message}`);
  assert.equal(JSON.parse(conversation.blockReason.slice(conversation.blockReason.indexOf(marker) + marker.length)).elapsedMs, elapsed);
  assert.equal(legacyWorkspaceProviderFailure(conversation.blockReason), null);
});
