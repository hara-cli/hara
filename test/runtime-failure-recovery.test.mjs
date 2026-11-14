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
    assert.equal(classifyRuntimeFailure({ stderr: message, status: 429 }), kind, "native reclassification also respects its own envelope");
    assert.equal(actual, expected, `${kind}, elapsed ${elapsed}`);
    assert.equal(errorHint(actual, message), "", "structured diagnostics have no provider hint tail");
    assert.equal(failoverAction(actual, ready), "fail", "even another authorized account cannot fix local Runtime failure");
    assert.equal(workspaceProviderFailure(message, { status: 404, code: "MODEL_NOT_FOUND" }), null);
    assert.equal(legacyWorkspaceProviderFailure(`[openai error] ${message}`), null);
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
    assert.equal(failoverAction(expected, ready), "fallback");
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
  let fallbackCalls = 0;
  const outcome = await runAgent([{ role: "user", content: "hello" }], {
    provider: { id: "openai", model: "primary-fixture", async turn() { return { text: "", toolUses: [], stop: "error", errorMsg: "503" }; } },
    fallback: { provider: { id: "backup", model: "backup-fixture", async turn() { fallbackCalls++; return { text: "hello", toolUses: [], stop: "end" }; } } },
    approval: "full-auto", confirm: async () => true, quiet: true,
    ctx: { cwd: root, ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice() {} } },
  });
  assert.equal(outcome.status, "completed"); assert.equal(fallbackCalls, 1);
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
