import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { workspaceResourceScopeKey } from "../dist/workspace/resource-context.js";
import { captureWorkspaceProjectIdentity, freezeWorkspaceRunBinding, isWorkspaceRunBinding, workspaceAgentBindingHash, workspaceFileIdMatches } from "../dist/workspace/run-binding.js";

function binding(project = { root: resolve("."), dev: 1, ino: 2 }) {
  const scope = { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } };
  const agent = { schemaVersion: 1, resourceBinding: { schemaVersion: 1, scopeKey: workspaceResourceScopeKey(scope), generation: randomUUID() },
    workspaceId: scope.workspaceId, agentId: `ag_${randomUUID()}`, agentEpoch: 1, configRevision: 1, configHash: "a".repeat(64), runtimeId: "pi", taskId: randomUUID() };
  return { schemaVersion: 1, scope, agent, agentBindingHash: workspaceAgentBindingHash(agent),
    connection: { connectionId: `mc_${randomUUID()}`, credentialGeneration: `gen_${randomUUID()}`, connectionRevision: 1, model: "synthetic", reasoning: null },
    runtimeContract: "hara-governed-pi-v1", project, sessionId: randomUUID(), runId: randomUUID(), lineage: { rootRunId: null, parentRunId: null, depth: 0 },
    createdAt: new Date().toISOString(), host: { hostId: randomUUID(), hostEpoch: 1, grantId: randomUUID(), grantRevision: 1, actorId: randomUUID(), policyRevision: 1 },
    budget: { maxRounds: 12, maxToolCalls: 32, maxTokens: 128000, timeoutMs: 120000 } };
}

test("RunBinding preserves full-width native directory identities through JSON instead of lossy numbers", () => {
  const original = binding({ root: resolve("."), dev: "18446744073709551615", ino: "9007199254740993" });
  const frozen = freezeWorkspaceRunBinding(original);
  assert.equal(frozen.project.ino, "9007199254740993");
  assert.deepEqual(freezeWorkspaceRunBinding(JSON.parse(JSON.stringify(frozen))), frozen);
  assert.equal(Object.isFrozen(frozen.project), true);
});

test("RunBinding retains exact legacy safe integers but rejects rounded, malformed or oversized file ids", () => {
  assert.equal(isWorkspaceRunBinding(binding()), true);
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "", "00", "01", "+1", "-1", " 1", "1 ", "1e3", "1.0", "18446744073709551616", "9".repeat(1000), 1n]) {
    for (const field of ["dev", "ino"]) {
      const invalid = binding(); invalid.project[field] = value;
      assert.equal(isWorkspaceRunBinding(invalid), false, `invalid ${field}: ${String(value).slice(0, 30)}`);
    }
  }
});

test("directory authority distinguishes adjacent native IDs even when Number would merge them", () => {
  const first = 9007199254740992n, second = first + 1n;
  assert.equal(Number(first), Number(second), "fixture must expose the lossy-number collision");
  assert.equal(workspaceFileIdMatches(String(first), first), true);
  assert.equal(workspaceFileIdMatches(String(first), second), false);
  assert.equal(workspaceFileIdMatches(Number(first), first), false, "already rounded numbers cannot regain authority");
  assert.equal(workspaceFileIdMatches(123, 123n), true, "old exact numeric bindings remain usable");
  assert.equal(workspaceFileIdMatches(123, 124n), false);
});

test("native directory capture freezes exact IDs and still rejects replacement and aliases", t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-binding-id-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "project"), retained = join(root, "retained"); fs.mkdirSync(directory);
  const info = fs.lstatSync(directory, { bigint: true }), identity = captureWorkspaceProjectIdentity(directory);
  t.diagnostic(JSON.stringify({ platform: process.platform, arch: process.arch, nativeDev: String(info.dev), nativeIno: String(info.ino),
    numberDevSafe: Number.isSafeInteger(Number(info.dev)), numberInoSafe: Number.isSafeInteger(Number(info.ino)) }));
  assert.equal(identity.dev, String(info.dev)); assert.equal(identity.ino, String(info.ino));
  assert.equal(isWorkspaceRunBinding(binding(identity)), true);
  fs.renameSync(directory, retained); fs.mkdirSync(directory);
  assert.equal(workspaceFileIdMatches(identity.ino, fs.lstatSync(directory, { bigint: true }).ino), false,
    "the original directory remains allocated, so a fresh directory cannot reuse its file id");
  fs.rmdirSync(directory); fs.symlinkSync(retained, directory, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => captureWorkspaceProjectIdentity(directory), /project grant identity changed/);
});
