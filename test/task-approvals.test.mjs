import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Optional isolated compiler output for this offline test only; production has no such input.
const buildRoot = process.env.HARA_TASK_APPROVAL_TEST_BUILD_ROOT;
const moduleUrl = buildRoot
  ? pathToFileURL(join(resolve(buildRoot), "security", "task-approvals.js"))
  : new URL("../dist/security/task-approvals.js", import.meta.url);
const {
  DEFAULT_TASK_APPROVAL_TTL_MS, MAX_TASK_APPROVAL_TTL_MS,
  createTaskApprovalStore, createTaskApprovalStoreForTests, taskApprovalEligible, taskApprovalScope,
} = await import(moduleUrl.href);

const root = mkdtempSync(join(tmpdir(), "hara-task-approval-test-"));
const project = join(root, "project");
const nested = join(project, "packages", "app");
mkdirSync(nested, { recursive: true });
writeFileSync(join(project, "package.json"), "{}\n");
const otherProject = join(root, "other-project");
mkdirSync(otherProject);
writeFileSync(join(otherProject, "package.json"), "{}\n");
after(() => rmSync(root, { recursive: true, force: true }));

const binding = { taskId: "task-1", sessionId: "session-1", agentId: "agent-1" };
const guards = {
  builtin: true, denied: false, commandDecision: null,
  organizationApprovalRequired: false, guardianReviewRequired: false, guardianBlocked: false,
};
const operation = { effect: "exec", concurrencySafe: false };
const scope = (tool = "bash", identity = binding, cwd = project, overrides = {}) => taskApprovalScope(
  identity, tool, tool === "bash" || tool === "python" ? operation : { effect: "edit" }, cwd, { ...guards, ...overrides },
);
const gate = (overrides = {}) => ({ approvalChannel: true, signal: new AbortController().signal, isCurrent: () => true, ...overrides });
const grant = (store, selected = scope(), overrides = {}) => store.prepareHumanGrant(selected, gate(overrides))();

test("the core is inert until a host invokes the explicit human callback", () => {
  const selected = scope();
  const store = createTaskApprovalStore();
  assert.equal(store.reader.has(selected), false);
  const callback = store.prepareHumanGrant(selected, gate());
  assert.equal(store.reader.has(selected), false, "creating a prompt does not grant authority");
  assert.equal(callback(), true);
  assert.equal(store.reader.has(selected), true);
  assert.equal(callback(), false, "a human callback is single-use");
  assert.equal(createTaskApprovalStore().reader.has(selected), false, "no cross-process/session recovery");
  assert.deepEqual(Object.keys(store.reader), ["has"], "the loop reader has no grant method");
});

test("scope binds task, session, Agent, project, and exact built-in family", () => {
  const store = createTaskApprovalStore();
  const selected = scope();
  assert.match(selected.key, /^ta1:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(grant(store, selected), true);
  assert.equal(store.reader.has(scope("bash", binding, nested)), true);
  for (const field of ["taskId", "sessionId", "agentId"]) {
    assert.equal(store.reader.has(scope("bash", { ...binding, [field]: `${field}-other` })), false);
  }
  assert.equal(store.reader.has(scope("bash", binding, otherProject)), false);
  assert.equal(store.reader.has(scope("python")), false);
  assert.equal(store.reader.has(scope("write_file")), false);
  assert.doesNotMatch(JSON.stringify(selected), /session-1|task-1|agent-1|packages|project\/|PRIVATE_TOKEN_VALUE/);
  assert.equal(JSON.stringify(selected).includes(project), false);
});

test("file editors share only the file-change family", () => {
  const store = createTaskApprovalStore();
  assert.equal(grant(store, scope("write_file")), true);
  assert.equal(store.reader.has(scope("edit_file")), true);
  assert.equal(store.reader.has(scope("apply_patch")), true);
  assert.equal(store.reader.has(scope("bash")), false);
});

for (const [label, change] of [
  ["not the registered built-in", { builtin: false }],
  ["deterministic deny", { denied: true }],
  ["command deny", { commandDecision: "deny" }],
  ["organization approval", { organizationApprovalRequired: true }],
  ["guardian human review", { guardianReviewRequired: true }],
  ["guardian block", { guardianBlocked: true }],
  ["opaque/external trust boundary", { trustBoundary: "external" }],
  ["unknown trust boundary", { trustBoundary: "internal" }],
  ["unknown command result", { commandDecision: "unknown" }],
  ["truthy but not boolean builtin", { builtin: "true" }],
]) {
  test(`${label} cannot create a remembered task scope`, () => {
    assert.equal(taskApprovalEligible("bash", operation, { ...guards, ...change }), false);
    assert.equal(scope("bash", binding, project, change), undefined);
  });
}

for (const [label, traits] of [
  ["explicit approval", { effect: "exec", requiresExplicitApproval: true }],
  ["destructive operation", { effect: "exec", destructive: true }],
  ["Computer Use effect", { effect: "computer" }],
  ["read screenshot with Computer Use approval", { effect: "read", approvalKind: "computer" }],
  ["exec with Computer Use approval", { effect: "exec", approvalKind: "computer" }],
  ["unknown approval kind", { effect: "exec", approvalKind: "opaque" }],
  ["invalid explicit flag", { effect: "exec", requiresExplicitApproval: "false" }],
]) {
  test(`${label} remains outside task-grant eligibility`, () => {
    assert.equal(taskApprovalScope(binding, "bash", traits, project, guards), undefined);
  });
}

test("missing guards, identities, unknown tools, and unsafe projects fail closed", () => {
  assert.equal(taskApprovalEligible("bash", operation, { builtin: true }), false);
  for (const tool of ["computer", "mcp.call", "codex", "claude", "open_browser", "unknown", "Bash"]) {
    assert.equal(taskApprovalScope(binding, tool, operation, project, guards), undefined);
  }
  for (const field of ["taskId", "sessionId", "agentId"]) {
    for (const value of [undefined, "", " padded", "bad\nidentity", "x".repeat(257), 123]) {
      assert.equal(scope("bash", { ...binding, [field]: value }), undefined);
    }
  }
  assert.equal(scope("bash", binding, homedir()), undefined);
  assert.equal(scope("bash", binding, join(root, "missing")), undefined);
});

test("serialized/forged scopes cannot restore or receive authority", () => {
  const store = createTaskApprovalStore();
  const selected = scope();
  assert.equal(grant(store, selected), true);
  for (const counterfeit of [{ ...selected }, JSON.parse(JSON.stringify(selected)), Object.create(selected)]) {
    assert.equal(store.reader.has(counterfeit), false);
    assert.equal(grant(store, counterfeit), false);
  }
});

test("a project replacement invalidates both an existing grant and a late human callback", () => {
  const replaceable = join(root, "replaceable");
  mkdirSync(replaceable);
  writeFileSync(join(replaceable, "package.json"), "{}\n");
  const selected = scope("bash", binding, replaceable);
  const store = createTaskApprovalStore();
  assert.equal(grant(store, selected), true);
  const pending = store.prepareHumanGrant(selected, gate());
  renameSync(replaceable, `${replaceable}-old`);
  mkdirSync(replaceable);
  writeFileSync(join(replaceable, "package.json"), "{}\n");
  assert.equal(store.reader.has(selected), false, "even the old object is revalidated");
  assert.equal(pending(), false);
  assert.equal(store.reader.has(scope("bash", binding, replaceable)), false);
});

test("a canonical project alias does not grant a second project", () => {
  const alias = join(root, "project-alias");
  symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
  const store = createTaskApprovalStore();
  assert.equal(grant(store), true);
  assert.equal(store.reader.has(scope("bash", binding, alias)), true);
  assert.equal(store.reader.has(scope("bash", binding, otherProject)), false);
});

test("TTL is monotonic, expires exactly, and lookups or duplicate approvals do not refresh it", () => {
  let now = 100;
  const store = createTaskApprovalStoreForTests(() => now);
  const selected = scope();
  assert.equal(grant(store, selected, { ttlMs: 100 }), true);
  now = 150;
  assert.equal(store.reader.has(selected), true);
  assert.equal(grant(store, selected, { ttlMs: 100 }), true);
  now = 199;
  assert.equal(store.reader.has(selected), true);
  now = 200;
  assert.equal(store.reader.has(selected), false);
  assert.equal(DEFAULT_TASK_APPROVAL_TTL_MS, 15 * 60_000);
  assert.equal(MAX_TASK_APPROVAL_TTL_MS, 30 * 60_000);
});

test("default TTL and maximum TTL expire without renewal", () => {
  for (const ttlMs of [undefined, MAX_TASK_APPROVAL_TTL_MS]) {
    let now = 0;
    const store = createTaskApprovalStoreForTests(() => now);
    const selected = scope();
    assert.equal(grant(store, selected, { ttlMs }), true);
    now = (ttlMs ?? DEFAULT_TASK_APPROVAL_TTL_MS) - 1;
    assert.equal(store.reader.has(selected), true);
    now += 1;
    assert.equal(store.reader.has(selected), false);
  }
});

test("invalid TTL and stale prompt deadlines do not issue a grant", () => {
  for (const ttlMs of [null, 0, -1, 1.5, NaN, Infinity, "100", MAX_TASK_APPROVAL_TTL_MS + 1]) {
    assert.equal(grant(createTaskApprovalStore(), scope(), { ttlMs }), false);
  }
  let now = 0;
  const store = createTaskApprovalStoreForTests(() => now);
  const selected = scope();
  const pending = store.prepareHumanGrant(selected, gate({ ttlMs: 10 }));
  now = 10;
  assert.equal(pending(), false);
  assert.equal(store.reader.has(selected), false);
});

test("live channel, AbortSignal, current task/gates, and cancellation must all hold", () => {
  for (const approvalChannel of [false, undefined, "true", 1]) {
    assert.equal(grant(createTaskApprovalStore(), scope(), { approvalChannel }), false);
  }
  for (const isCurrent of [() => false, () => "true", () => { throw new Error("PRIVATE_VALUE"); }, undefined]) {
    assert.equal(grant(createTaskApprovalStore(), scope(), { isCurrent }), false);
  }
  assert.equal(grant(createTaskApprovalStore(), scope(), { signal: { aborted: false } }), false);
  const controller = new AbortController();
  const store = createTaskApprovalStore();
  const selected = scope();
  const pending = store.prepareHumanGrant(selected, gate({ signal: controller.signal }));
  controller.abort();
  assert.equal(pending(), false);
  assert.equal(store.reader.has(selected), false);
});

test("changing live context or revoking during freshness validation fails closed", () => {
  const store = createTaskApprovalStore();
  const selected = scope();
  const controller = new AbortController();
  assert.equal(grant(store, selected, { signal: controller.signal, isCurrent: () => { controller.abort(); return true; } }), false);
  assert.equal(grant(store, selected, { isCurrent: () => { store.clear(); return true; } }), false);
});

test("cancelling the bound human/run signal invalidates an existing grant", () => {
  const store = createTaskApprovalStore();
  const selected = scope();
  const controller = new AbortController();
  assert.equal(grant(store, selected, { signal: controller.signal }), true);
  assert.equal(store.reader.has(selected), true);
  controller.abort();
  assert.equal(store.reader.has(selected), false);
});

test("revoke scope/task/session and clear invalidate pending callbacks and exact grants", () => {
  for (const revoke of [
    (store, selected) => store.revokeScope(selected),
    (store) => store.revokeTask(binding),
    (store) => store.revokeSession(binding.sessionId),
    (store) => store.clear(),
  ]) {
    const store = createTaskApprovalStore();
    const selected = scope();
    const other = scope("python", { ...binding, taskId: "other-task", sessionId: "other-session" });
    assert.equal(grant(store, selected), true);
    assert.equal(grant(store, other), true);
    const pending = store.prepareHumanGrant(selected, gate());
    revoke(store, selected);
    assert.equal(store.reader.has(selected), false);
    assert.equal(pending(), false);
  }
});

test("targeted revocation does not erase another session's existing grant", () => {
  const store = createTaskApprovalStore();
  const selected = scope();
  const other = scope("bash", { ...binding, sessionId: "other-session" });
  assert.equal(grant(store, selected), true);
  assert.equal(grant(store, other), true);
  store.revokeTask(binding);
  assert.equal(store.reader.has(selected), false);
  assert.equal(store.reader.has(other), true);
});

test("a backward, invalid, or throwing clock permanently invalidates that store", () => {
  for (const next of [-1, NaN, Infinity, 99, "100", () => { throw new Error("PRIVATE_CLOCK"); }]) {
    let now = 100;
    const store = createTaskApprovalStoreForTests(() => typeof now === "function" ? now() : now);
    const selected = scope();
    assert.equal(grant(store, selected), true);
    now = next;
    assert.equal(store.reader.has(selected), false);
    now = 200;
    assert.equal(grant(store, selected), false);
    assert.equal(store.reader.has(selected), false);
  }
});

test("the bounded store refuses growth without evicting active grants", () => {
  const store = createTaskApprovalStoreForTests(() => 0);
  const first = scope();
  assert.equal(grant(store, first), true);
  for (let index = 1; index < 256; index++) {
    assert.equal(grant(store, scope("bash", { ...binding, taskId: `task-${index + 1}` })), true);
  }
  assert.equal(grant(store, scope("bash", { ...binding, taskId: "too-many" })), false);
  assert.equal(store.reader.has(first), true);
});
