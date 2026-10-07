import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Test-only isolated compiler output. No provider, daemon, network or user project is started.
const buildRoot = process.env.HARA_LOOP_TASK_APPROVAL_TEST_BUILD_ROOT;
const moduleUrl = (path) => buildRoot ? pathToFileURL(join(resolve(buildRoot), path)).href : new URL(`../dist/${path}`, import.meta.url).href;
// Only this isolated test process trusts its synthetic per-project hook fixture.
process.env.HARA_TRUST_PROJECT_CONFIG = "1";
// A nested macOS read-mask sandbox can reject the synthetic hook before it starts. These fixtures
// exercise approval ordering, not that independently tested subprocess mask, in an isolated HOME.
process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
const { runAgent } = await import(moduleUrl("agent/loop.js"));
const { createTaskApprovalStoreForTests, DEFAULT_TASK_APPROVAL_TTL_MS, taskApprovalScope } = await import(moduleUrl("security/task-approvals.js"));
const { applyTaskBrief, createTaskExecution, newTurnInteraction } = await import(moduleUrl("session/task.js"));
const { getTool, registerTool } = await import(moduleUrl("tools/registry.js"));
const { orgRolesDir } = await import(moduleUrl("org/roles.js"));

const root = mkdtempSync(join(tmpdir(), "hara-loop-task-approval-fixtures-"));
after(() => rmSync(root, { recursive: true, force: true }));
const BRIEF = { intent: "change", goal: "write only the synthetic fixture files", constraints: ["no network or user files"],
  acceptance: ["the synthetic operation returns"], steps: ["write fixture", "inspect fixture"] };
const call = (id, name = "write_file", input = { path: `${id}.txt`, content: id }) => ({ id, name, input });
const toolRound = (...toolUses) => ({ text: "", stop: "tool_use", toolUses });
const completion = () => toolRound(call("receipt", "task_checkpoint", { completion: {
  state: "verified", evidence: ["the synthetic fixture assertions ran"], final_answer: "Fixture complete.",
} }));
const results = (history) => history.flatMap((message) => message.role === "tool" ? message.results : []);

function fixture(rounds, overrides = {}) {
  const cwd = mkdtempSync(join(root, "project-"));
  writeFileSync(join(cwd, "package.json"), "{}\n");
  let task = applyTaskBrief(createTaskExecution("write synthetic fixture files", newTurnInteraction().turnId), BRIEF).task;
  let now = 0;
  const store = createTaskApprovalStoreForTests(() => now);
  const agentId = randomUUID();
  const sessionId = randomUUID();
  let current = true;
  let round = 0;
  const offers = [];
  const confirmations = [];
  const history = [{ role: "user", content: "Write only these synthetic fixtures." }];
  const provider = {
    id: "task-approval-fixture", model: "task-approval-fixture",
    async turn(args) {
      assert.equal(JSON.stringify(args.history).includes("grantFromHuman"), false, "host callbacks never reach the model");
      return rounds[round++] ?? completion();
    },
  };
  const opts = {
    provider, ctx: { cwd, sessionId, ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice() {} } }, hooks: false, quiet: true,
    approval: "suggest", approvalChannel: true, guardian: { enabled: false }, maxRounds: 8, timeoutMs: 5_000,
    taskApprovals: { agentId, store, isCurrent: () => current },
    taskIntake: { task, current: () => task, onUpdate: (next) => { task = next; }, onCheckpoint: (next) => { task = next; } },
    confirm: async (_question, _signal, options) => {
      confirmations.push(options);
      if (options.taskApproval) {
        offers.push(options.taskApproval);
        assert.equal(options.taskApproval.isActive(), false, "reading a pending offer never approves or invalidates it");
        assert.equal(options.taskApproval.grantFromHuman(), true);
      }
      return true;
    },
    ...overrides,
  };
  return {
    cwd, history, opts, store, offers, confirmations, binding: { taskId: task.id, sessionId, agentId },
    run: () => runAgent(history, opts), advance: (ms) => { now += ms; }, revoke: () => store.revokeTask({ taskId: task.id, sessionId, agentId }),
    setCurrent: (value) => { current = value; }, task: () => task, setTask: (next) => { task = next; },
  };
}

test("an explicit human task choice skips only the next eligible action and is revoked on completion", async () => {
  const f = fixture([toolRound(call("first")), toolRound(call("second")), completion()]);
  const outcome = await f.run();
  assert.equal(outcome.status, "completed", outcome.error);
  assert.equal(f.confirmations.length, 1);
  assert.equal(readFileSync(join(f.cwd, "first.txt"), "utf8"), "first");
  assert.equal(readFileSync(join(f.cwd, "second.txt"), "utf8"), "second");
  assert.equal(f.offers[0].durationMs, DEFAULT_TASK_APPROVAL_TTL_MS);
  assert.equal(f.offers[0].toolFamily, "file-change");
  assert.equal(f.offers[0].isActive(), false, "completion revokes rather than releasing any ComputerUse lease");
  assert.equal(f.offers[0].grantFromHuman(), false, "the writer is one-use");
});

test("the file-change family covers actual edit_file and non-delete apply_patch in the same project", async () => {
  const f = fixture([
    toolRound(call("write", "write_file", { path: "shared.txt", content: "one" })),
    toolRound(call("edit", "edit_file", { path: "shared.txt", old_string: "one", new_string: "two" })),
    toolRound(call("patch", "apply_patch", { changes: [{ path: "shared.txt", type: "update", content: "three" }] })), completion(),
  ]);
  assert.equal((await f.run()).status, "completed");
  assert.equal(f.confirmations.length, 1);
  assert.equal(readFileSync(join(f.cwd, "shared.txt"), "utf8"), "three");
});

for (const decision of [true, "always"]) {
  test(`ordinary ${String(decision)} does not create a task grant`, async () => {
    const f = fixture([toolRound(call("one")), toolRound(call("two")), completion()]);
    f.opts.confirm = async (_q, _signal, options) => { f.confirmations.push(options); return decision; };
    // Existing durable/session 'always' semantics remain separate; omit those stores in this fixture.
    await f.run();
    assert.equal(f.confirmations.length, 2);
    for (const options of f.confirmations) {
      assert.equal(options.taskApproval.isActive(), false);
      assert.equal(options.taskApproval.grantFromHuman(), false, "unused callbacks cannot grant after the run ends");
    }
  });
}

for (const mutation of ["expiry", "revoke", "host-stale", "brief", "turn", "task", "project"]) {
  test(`${mutation} after planning but immediately before dispatch prevents the planned skip`, async () => {
    const f = fixture([toolRound(call("first")), toolRound(call("second")), completion()]);
    let started = 0;
    f.opts.onRuntimeItem = (event) => {
      if (event.kind !== "tool" || event.state !== "started" || event.name !== "write_file" || ++started !== 2) return;
      if (mutation === "expiry") f.advance(DEFAULT_TASK_APPROVAL_TTL_MS);
      if (mutation === "revoke") f.revoke();
      if (mutation === "host-stale") f.setCurrent(false);
      if (mutation === "brief") f.setTask({ ...f.task(), brief: { ...f.task().brief, goal: "a changed request" } });
      if (mutation === "turn") f.setTask({ ...f.task(), turnId: randomUUID() });
      if (mutation === "task") f.setTask({ ...f.task(), id: randomUUID() });
      if (mutation === "project") f.opts.ctx.cwd = join(f.cwd, "different");
    };
    await f.run();
    assert.equal(existsSync(join(f.cwd, "first.txt")), true);
    assert.equal(existsSync(join(f.cwd, "second.txt")), false);
    assert.match(results(f.history).find((result) => result.id === "second").content, /Task approval expired, was revoked, or its scope\/policy changed/);
    assert.equal(f.offers[0].isActive(), false);
  });
}

test("a failed explicit task callback cannot be downgraded to ordinary allow by a broken host", async () => {
  const f = fixture([toolRound(call("stale")), completion()]);
  f.opts.confirm = async (_q, _signal, options) => {
    f.setCurrent(false);
    assert.equal(options.taskApproval.grantFromHuman(), false);
    return true;
  };
  await f.run();
  assert.equal(existsSync(join(f.cwd, "stale.txt")), false);
  assert.match(results(f.history)[0].content, /no longer valid when the human replied/);
});

test("a human denial withdraws an existing grant instead of preserving later skips", async () => {
  const explicit = { name: "fixture_explicit", description: "synthetic fresh approval", kind: "edit",
    input_schema: { type: "object", properties: {} }, classify: () => ({ effect: "edit", concurrencySafe: false, requiresExplicitApproval: true }),
    async run() { throw new Error("denied fixture must never run"); } };
  const f = fixture([toolRound(call("first")), toolRound(call("no", explicit.name, {})), toolRound(call("third")), completion()], { extraTools: [explicit] });
  let prompt = 0;
  f.opts.confirm = async (_q, _signal, options) => {
    f.confirmations.push(options);
    if (++prompt === 2) { assert.equal(options.taskApproval, undefined); return false; }
    assert.equal(options.taskApproval.grantFromHuman(), true);
    f.offers.push(options.taskApproval);
    return true;
  };
  await f.run();
  assert.equal(f.confirmations.length, 3, "denial requires a new explicit task choice for the later action");
  assert.equal(existsSync(join(f.cwd, "third.txt")), true);
});

test("fresh permission deny beats a previously planned Bash task grant", async () => {
  const f = fixture([toolRound(call("first", "bash", { command: "printf first" })), toolRound(call("second", "bash", { command: "printf second" })), completion()]);
  let started = 0;
  f.opts.onRuntimeItem = (event) => {
    if (event.kind === "tool" && event.state === "started" && event.name === "bash" && ++started === 2) {
      mkdirSync(join(f.cwd, ".hara"));
      writeFileSync(join(f.cwd, ".hara", "permissions.json"), JSON.stringify({ deny: ["printf second"] }));
    }
  };
  await f.run();
  assert.equal(f.confirmations.length, 1);
  assert.match(results(f.history).find((result) => result.id === "second").content, /Denied by a permission rule immediately before execution/);
});

test("an expired planned skip never launches its configured PreToolUse hook", async () => {
  const f = fixture([toolRound(call("first")), toolRound(call("second")), completion()], { hooks: true });
  mkdirSync(join(f.cwd, ".hara"));
  writeFileSync(join(f.cwd, ".hara", "config.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "^write_file$", command: "printf x >> fixture-hook.txt" }],
  } }));
  let plans = 0;
  f.opts.onRuntimeItem = (event) => {
    if (event.kind === "diff" && event.state === "queued" && ++plans === 2) f.advance(DEFAULT_TASK_APPROVAL_TTL_MS);
  };
  await f.run();
  assert.notEqual(results(f.history).find((result) => result.id === "first").isError, true,
    results(f.history).find((result) => result.id === "first").content);
  assert.equal(readFileSync(join(f.cwd, "fixture-hook.txt"), "utf8"), "x", "only the first authorized hook started");
  assert.equal(existsSync(join(f.cwd, "second.txt")), false);
});

test("an unverified required capability appearing before dispatch invalidates the task skip", async () => {
  const f = fixture([toolRound(call("first")), toolRound(call("second")), completion()]);
  f.setTask({ ...f.task(), brief: { ...f.task().brief, requiredCapabilities: ["synthetic"] }, checkpoint: {
    ...f.task().checkpoint, capabilities: { synthetic: { state: "available", detail: "offline fixture", checkedAt: new Date().toISOString() } },
  } });
  f.opts.taskIntake.task = f.task();
  let starts = 0;
  f.opts.onRuntimeItem = (event) => {
    if (event.kind === "tool" && event.state === "started" && event.name === "write_file" && ++starts === 2) {
      f.setTask({ ...f.task(), checkpoint: { ...f.task().checkpoint, capabilities: { synthetic: { state: "unknown" } } } });
    }
  };
  await f.run();
  assert.equal(existsSync(join(f.cwd, "first.txt")), true);
  assert.equal(existsSync(join(f.cwd, "second.txt")), false);
});

test("a skill restriction imposed by an earlier tool wins over an already planned task skip", async () => {
  const restrict = { name: "fixture_restrict", description: "synthetic tool-policy change", kind: "read",
    input_schema: { type: "object", properties: {} }, async run(_input, ctx) {
      assert.equal(ctx.restrictToolsForSkill("synthetic", ["read_file", "task_checkpoint"]).ok, true);
      return "synthetic restriction applied";
    } };
  const f = fixture([toolRound(call("first")), toolRound(call("restrict", restrict.name, {}), call("second")), completion()], { extraTools: [restrict] });
  await f.run();
  assert.equal(existsSync(join(f.cwd, "first.txt")), true);
  assert.equal(existsSync(join(f.cwd, "second.txt")), false);
  assert.match(results(f.history).find((result) => result.id === "second").content, /scope\/policy changed/);
});

for (const command of [
  "rm -rf fixture", "rm fixture", "git reset --hard", "python3 -c 'print(1)'", "node -e 'void 0'", "bash fixture.sh", "./fixture.sh",
  "env python3 -c 'print(1)'", "command node -e 'void 0'", "xargs sh", "timeout 2 bash fixture.sh", "nice python3 fixture.py", "nohup ruby fixture.rb",
  "sudo printf fixture", "/usr/bin/env python3 fixture.py", "printf fixture > output.txt", "printf $(date)", "for x in a; do printf x; done",
  "'python3' fixture.py", '"node" fixture.js', "$PYTHON fixture.py", "PATH=/fixture printf fixture", "sh -c 'printf fixture'", "bash -lc 'printf fixture'",
  'osascript -e \'tell application "System Events" to keystroke "x"\'', "automator fixture.workflow", "shortcuts run fixture", "screencapture fixture.png",
  "cliclick c:1,1", "xdotool key x", "ydotool key 45:1", "cscript fixture.vbs", "wscript fixture.vbs",
  "/usr/bin/osascript -e 'return 1'", "printf fixture && osascript -e 'return 1'", "cscript.exe fixture.vbs", "wscript.exe fixture.vbs",
  "open fixture.txt", "mshta fixture.hta", "rundll32 fixture.dll,Entry", "open.exe fixture.txt", "mshta.exe fixture.hta", "rundll32.exe fixture.dll,Entry",
]) {
  test(`destructive/opaque shell stays one-action approved: ${command}`, async () => {
    const f = fixture([toolRound(call("opaque", "bash", { command })), completion()]);
    f.opts.confirm = async (_q, _signal, options) => { f.confirmations.push(options); assert.equal(options.taskApproval, undefined); return false; };
    await f.run();
    assert.equal(f.confirmations.length, 1);
    assert.equal(results(f.history)[0].isError, true, "the negative fixture command is never executed");
  });
}

for (const scenario of ["python", "delete", "outside", "symlink", "wider-boundary"]) {
  test(`${scenario} never offers a task grant`, async () => {
    const f = fixture([]);
    const outside = mkdtempSync(join(root, "outside-"));
    symlinkSync(outside, join(f.cwd, "linked"));
    if (scenario === "wider-boundary") f.opts.ctx.writeBoundary = root;
    const request = scenario === "python" ? call("unsafe", "python", { code: "print('fixture')" })
      : scenario === "delete" ? call("unsafe", "apply_patch", { changes: [{ type: "delete", path: "fixture.txt" }] })
      : call("unsafe", "write_file", { path: ["symlink", "wider-boundary"].includes(scenario) ? "linked/out.txt" : join(outside, "out.txt"), content: "fixture" });
    f.opts.provider.turn = async () => f.confirmations.length === 0 ? toolRound(request) : completion();
    f.opts.confirm = async (_q, _signal, options) => { f.confirmations.push(options); assert.equal(options.taskApproval, undefined); return false; };
    await f.run();
    assert.equal(f.confirmations.length, 1);
    assert.equal(existsSync(join(outside, "out.txt")), false);
  });
}

for (const traits of [
  { effect: "computer", concurrencySafe: false },
  { effect: "read", approvalKind: "computer", concurrencySafe: true },
  { effect: "edit", requiresExplicitApproval: true, concurrencySafe: false },
  { effect: "edit", destructive: true, concurrencySafe: false },
]) {
  test(`ComputerUse/explicit/destructive/plugin floor cannot consume a file grant: ${JSON.stringify(traits)}`, async () => {
    let ran = 0;
    const extra = { name: "fixture_floor", description: "never controls an actual application", kind: "edit",
      input_schema: { type: "object", properties: {} }, classify: () => traits, async run(_input, ctx) {
        assert.equal(Object.keys(ctx).some((key) => /taskApprovals|grantFromHuman|isActive|store/.test(key)), false);
        ran += 1; return "synthetic action";
      } };
    const f = fixture([toolRound(call("first")), toolRound(call("floor", extra.name, {})), completion()], { extraTools: [extra] });
    const normal = f.opts.confirm;
    f.opts.confirm = async (q, signal, options) => {
      if (!options.taskApproval) { f.confirmations.push(options); return false; }
      return normal(q, signal, options);
    };
    await f.run();
    assert.equal(f.confirmations.length, 2);
    assert.equal(ran, 0);
  });
}

test("an extra same-name builtin shadow cannot acquire task authority", async () => {
  let ran = 0;
  const shadow = { ...getTool("write_file"), run: async () => { ran++; return "shadow result"; } };
  const f = fixture([toolRound(call("shadow")), completion()], { extraTools: [shadow] });
  f.opts.confirm = async (_q, _signal, options) => { f.confirmations.push(options); assert.equal(options.taskApproval, undefined); return true; };
  await f.run();
  assert.equal(ran, 1, "ordinary one-action human approval still applies to the plugin");
  assert.equal(f.confirmations.length, 1);
});

test("opaque external extensions always need their own fresh human decision", async () => {
  let ran = 0;
  const external = { name: "fixture_external", description: "synthetic opaque extension", kind: "edit", trustBoundary: "external",
    input_schema: { type: "object", properties: {} }, async run() { ran++; return "synthetic external action"; } };
  const f = fixture([toolRound(call("first")), toolRound(call("external", external.name, {})), completion()], { extraTools: [external] });
  f.opts.ctx.ask = async () => "synthetic human channel";
  const normal = f.opts.confirm;
  f.opts.confirm = async (q, signal, options) => {
    if (!options.taskApproval) { f.confirmations.push(options); return false; }
    return normal(q, signal, options);
  };
  await f.run();
  assert.equal(ran, 0);
  assert.equal(f.confirmations.length, 2);
  assert.equal(f.confirmations[1].allowAlways, false);
});

for (const verdict of ["allow", "block"]) {
  test(`Guardian ${verdict} never makes a high-risk action task eligible`, async () => {
    let guardCalls = 0;
    const guardian = { enabled: true, provider: { id: "synthetic-guardian", model: "synthetic-guardian", async turn() {
      guardCalls++; return { text: JSON.stringify({ decision: verdict, reason: "synthetic verdict" }), stop: "end", toolUses: [] };
    } } };
    const f = fixture([toolRound(call("risk", "bash", { command: "rm -rf fixture" })), completion()], { guardian });
    f.opts.confirm = async (_q, _signal, options) => { f.confirmations.push(options); assert.equal(options.taskApproval, undefined); return false; };
    await f.run();
    assert.equal(guardCalls, 1);
    assert.equal(f.confirmations.length, verdict === "block" ? 0 : 1);
    assert.equal(results(f.history)[0].isError, true);
  });
}

test("organization human-approval floor overrides a grant already prepared for the run", async () => {
  const policy = { version: 1, requireApprovalForWrites: false };
  const f = fixture([toolRound(call("first")), toolRound(call("second")), completion()]);
  f.opts.ctx.spaceId = "org:loop-task-approval-fixture";
  const directory = orgRolesDir(f.opts.ctx.spaceId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "_bundle.json"), JSON.stringify({ version: 1, org_policy: {}, roles: [] }), { mode: 0o600 });
  f.opts.provider.prepareTurn = async () => ({ organizationPolicy: policy, organizationPolicyVersion: 1 });
  let starts = 0;
  f.opts.onRuntimeItem = (event) => {
    if (event.kind === "tool" && event.state === "started" && event.name === "write_file" && ++starts === 2) policy.requireApprovalForWrites = true;
  };
  const outcome = await f.run();
  assert.equal(outcome.status, "completed", outcome.error);
  assert.equal(existsSync(join(f.cwd, "first.txt")), true);
  assert.equal(existsSync(join(f.cwd, "second.txt")), false);
  assert.match(results(f.history).find((result) => result.id === "second").content, /scope\/policy changed/);
});

for (const missing of ["agent", "session", "task", "channel", "host-current"]) {
  test(`missing ${missing} binding fails closed while ordinary approval remains usable`, async () => {
    const f = fixture([toolRound(call("ordinary")), completion()]);
    if (missing === "agent") f.opts.taskApprovals.agentId = "";
    if (missing === "session") delete f.opts.ctx.sessionId;
    if (missing === "task") delete f.opts.taskIntake;
    if (missing === "channel") f.opts.approvalChannel = false;
    if (missing === "host-current") f.setCurrent(false);
    f.opts.confirm = async (_q, _signal, options) => { f.confirmations.push(options); assert.equal(options.taskApproval, undefined); return true; };
    await f.run();
    assert.equal(existsSync(join(f.cwd, "ordinary.txt")), true);
    assert.equal(f.confirmations.length, 1);
  });
}

test("abort and a later run cannot reuse the previous run's task grant", async () => {
  const controller = new AbortController();
  const f = fixture([toolRound(call("first")), toolRound(call("second"))], { signal: controller.signal });
  const normal = f.opts.confirm;
  f.opts.confirm = async (q, signal, options) => {
    const answer = await normal(q, signal, options);
    controller.abort();
    return answer;
  };
  assert.equal((await f.run()).status, "error");
  assert.equal(existsSync(join(f.cwd, "first.txt")), false);
  assert.equal(f.offers[0].isActive(), false);
  const scope = taskApprovalScope(f.binding, "write_file", { effect: "edit" }, f.cwd, {
    builtin: true, denied: false, commandDecision: null, organizationApprovalRequired: false, guardianReviewRequired: false, guardianBlocked: false,
  });
  assert.equal(f.store.reader.has(scope), false);
});

test("run completion revokes only its exact binding and a new run requires another human choice", async () => {
  const f = fixture([toolRound(call("first")), completion()]);
  const other = { ...f.binding, agentId: randomUUID() };
  const unrelated = taskApprovalScope(other, "write_file", { effect: "edit" }, f.cwd, {
    builtin: true, denied: false, commandDecision: null, organizationApprovalRequired: false, guardianReviewRequired: false, guardianBlocked: false,
  });
  assert.equal(f.store.prepareHumanGrant(unrelated, { approvalChannel: true, signal: new AbortController().signal, isCurrent: () => true })(), true);
  await f.run();
  assert.equal(f.store.reader.has(unrelated), true, "another Agent's grant is not cleared or inherited");
  let round = 0;
  f.opts.provider.turn = async () => round++ === 0 ? toolRound(call("new-run")) : completion();
  f.opts.taskApprovals.agentId = randomUUID();
  await f.run();
  assert.equal(f.confirmations.length, 2, "no /continue reuse of the earlier run grant");
  assert.equal(f.store.reader.has(unrelated), true);
});

test("an inactive policy-derived status actually withdraws the remembered family grant", async () => {
  const f = fixture([]);
  let round = 0;
  f.opts.provider.turn = async () => {
    if (round++ === 0) return toolRound(call("first", "bash", { command: "printf first" }));
    if (round === 2) {
      mkdirSync(join(f.cwd, ".hara"));
      writeFileSync(join(f.cwd, ".hara", "permissions.json"), JSON.stringify({ deny: ["printf first"] }));
      assert.equal(f.offers[0].isActive(), false);
      return toolRound(call("second", "bash", { command: "printf second" }));
    }
    return completion();
  };
  assert.equal((await f.run()).status, "completed");
  assert.equal(f.confirmations.length, 2, "status does not hide a still-reusable grant");
});

test("registry replacement after planning cannot execute under an original builtin's grant", async () => {
  const original = getTool("write_file");
  const f = fixture([toolRound(call("replace")), completion()]);
  let replacementRuns = 0;
  f.opts.onRuntimeItem = (event) => {
    if (event.kind === "tool" && event.state === "started" && event.name === "write_file") {
      registerTool({ ...original, run: async () => { replacementRuns++; return "replacement"; } });
    }
  };
  await f.run();
  assert.equal(replacementRuns, 0);
  assert.equal(existsSync(join(f.cwd, "replace.txt")), false);
  assert.match(results(f.history)[0].content, /scope\/policy changed/);
  // This is deliberately last: registerTool cannot restore the exact captured original object.
});
