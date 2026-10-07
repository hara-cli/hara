import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { LayaRuntime, layaActionRequest, layaPlatformSupported } from "../dist/decision/laya.js";
import { LAYA_MODEL, LAYA_PACKAGE_VERSION, LAYA_REVISION, LAYA_WEIGHT_SHA256, LAYA_WORKER } from "../dist/decision/laya-worker.js";
import { evaluateActionGuard } from "../dist/security/guardian.js";

const directories = [];
const instances = [];
after(() => {
  for (const runtime of instances) runtime.stop();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
const input = { task: "Inspect a local file", tool: "computer", category: "read", classifierReason: "local inspection", detail: "Read the visible title without sending anything" };

function fakeModel(directory) {
  const model = join(directory, "model", LAYA_REVISION);
  mkdirSync(join(model, "encoder"), { recursive: true });
  mkdirSync(join(model, "tokenizer"), { recursive: true });
  for (const file of ["manifest.json", "model.safetensors", "rl_agent_config.json", "encoder/config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"]) {
    writeFileSync(join(model, file), "fake model, never loaded");
  }
}

function fixture(behavior) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-laya-")));
  directories.push(home);
  const directory = join(home, ".hara", "decision", "laya-mlx", LAYA_PACKAGE_VERSION);
  mkdirSync(join(directory, "venv", "bin"), { recursive: true });
  writeFileSync(join(directory, "venv", "bin", "python"), "fake runtime, never executed");
  fakeModel(directory);
  writeFileSync(join(directory, "ready.json"), JSON.stringify({ version: LAYA_PACKAGE_VERSION, revision: LAYA_REVISION, weightSha256: LAYA_WEIGHT_SHA256 }));
  const launches = [];
  const requests = [];
  const children = [];
  const launch = (executable, args, options) => {
    launches.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = 0;
    child.unref = () => {};
    child.kill = () => { child.kills++; setImmediate(() => child.emit("close", null)); return true; };
    child.stdin.on("data", (part) => {
      const request = JSON.parse(part.toString()); requests.push(request);
      const reply = (result) => child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
      if (behavior) behavior(request, child, reply);
      else setImmediate(() => reply({ model: LAYA_MODEL, answers: { action_guard: { choice: "allow", confidence: 0.99, probabilities: { allow: 0.99, review: 0.005, block: 0.005 } } } }));
    });
    setImmediate(() => child.stdout.write(JSON.stringify({ ready: true, model: LAYA_MODEL, revision: LAYA_REVISION }) + "\n"));
    children.push(child);
    return child;
  };
  const runtime = new LayaRuntime({ home, supported: true, spawn: launch }); instances.push(runtime);
  return { runtime, launches, requests, children, directory, home };
}

test("Laya is optional and limited to Apple Silicon macOS 14+", async () => {
  assert.equal(layaPlatformSupported("darwin", "arm64", "23.0.0"), true);
  for (const values of [["darwin", "arm64", "22.0.0"], ["darwin", "x64", "24.0.0"], ["win32", "arm64", "24.0.0"]]) assert.equal(layaPlatformSupported(...values), false);
  const { home } = fixture();
  let launches = 0;
  const runtime = new LayaRuntime({ home, supported: false, spawn: () => { launches++; throw new Error("should not run"); } });
  assert.equal(runtime.snapshot().status, "unsupported");
  assert.throws(() => runtime.prepare(false), /explicit download consent/);
  assert.throws(() => runtime.prepare(true), /Apple Silicon/);
  await assert.rejects(() => runtime.judge(input), /Prepare the local Laya/);
  assert.equal(launches, 0, "settings/inference never install or download automatically");
});

test("local action input is redacted but never silently shortened", () => {
  const marker = "尾部关键限制：不能发送";
  const request = layaActionRequest({ ...input, detail: "content ".repeat(900) + marker + " apiKey=sk-secretsecret" });
  assert.match(request.state.action.detail, /尾部关键限制：不能发送/);
  assert.doesNotMatch(JSON.stringify(request), /sk-secretsecret/);
  assert.equal(Object.keys(request.questions).length, 1);
  assert.throws(() => layaActionRequest({ ...input, detail: "x".repeat(20_000) }), /exceeds.*context/);
});

test("a second Engine observes preparation without duplicating installation, then sees readiness", async () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-laya-prepare-"))); directories.push(home);
  const directory = join(home, ".hara", "decision", "laya-mlx", LAYA_PACKAGE_VERSION);
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const uv = join(home, ".local", "bin", "uv"); writeFileSync(uv, "fake installer, never executed"); chmodSync(uv, 0o700);
  mkdirSync(join(directory, "venv", "bin"), { recursive: true }); writeFileSync(join(directory, "venv", "bin", "python"), "fake Python");
  let calls = 0;
  const launch = () => {
    calls++;
    const child = new EventEmitter(); child.kill = () => true;
    setTimeout(() => { if (calls === 3) fakeModel(directory); child.emit("close", 0); }, 5);
    return child;
  };
  const first = new LayaRuntime({ home, supported: true, spawn: launch }); instances.push(first);
  const other = new LayaRuntime({ home, supported: true, spawn: () => { throw new Error("duplicate installation"); } }); instances.push(other);
  assert.equal(first.prepare(true).status, "preparing");
  assert.equal(other.snapshot().status, "preparing");
  assert.equal(other.prepare(true).status, "preparing");
  assert.equal((await first.waitForPreparation()).status, "ready");
  assert.equal(other.snapshot().status, "ready");
  assert.equal(calls, 4, "venv, pinned wheel, pinned checkpoint, offline verification");
  first.prepare(true);
  assert.equal(calls, 4, "a ready engine is not re-downloaded");
});

test("runtime verification failure is observable and allows preparation to be retried", async () => {
  const { runtime } = fixture((request, child) => setImmediate(() => child.stdout.write('{"error":"runtime_verification_failed"}\n')));
  await assert.rejects(() => runtime.judge(input), /verification failed/);
  assert.equal(runtime.snapshot().status, "error");
});

test("a receipt does not claim readiness after a required model file was removed", async () => {
  const { runtime, directory, launches } = fixture();
  rmSync(join(directory, "model", LAYA_REVISION, "model.safetensors"));
  assert.equal(runtime.snapshot().status, "missing");
  await assert.rejects(() => runtime.judge(input), /Prepare the local Laya/);
  assert.equal(launches.length, 0);
});

test("Agents share one local worker, queue independent IDs, and never pass cloud credentials or endpoints", async () => {
  const { runtime, launches, requests } = fixture();
  const [first, second] = await Promise.all([runtime.judge(input), runtime.judge({ ...input, task: "Other Agent's task" })]);
  assert.equal(launches.length, 1);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].id, requests[1].id);
  assert.equal(requests[0].state.task, input.task);
  assert.equal(requests[1].state.task, "Other Agent's task");
  assert.equal(first.choice, "allow");
  assert.equal(first.decision, "review", "even high confidence cannot confer authority");
  assert.equal(second.decision, "review");
  assert.equal(launches[0].options.shell, false);
  assert.equal(launches[0].options.env.HF_HUB_OFFLINE, "1");
  for (const name of ["TYPESAFE_API_KEY", "HARA_DECISION_API_KEY", "ANTHROPIC_API_KEY", "HF_TOKEN", "PYTHONPATH", "HTTPS_PROXY"]) assert.equal(name in launches[0].options.env, false);
  assert.ok(launches[0].args.includes("-I"));
});

test("overflow and malformed worker responses fail explicitly, not as a successful allow", async () => {
  const overflow = fixture((request, child) => setImmediate(() => child.stdout.write(JSON.stringify({ id: request.id, error: "context_budget_exceeded" }) + "\n")));
  await assert.rejects(() => overflow.runtime.judge(input), /no truncated judgment/);
  const invalid = fixture((request, child) => setImmediate(() => child.stdout.write("not JSON\n")));
  await assert.rejects(() => invalid.runtime.judge(input), /invalid response/);
  assert.equal(invalid.children[0].kills, 1);
});

test("a cancelled active judgment terminates only its worker and can be restarted", async () => {
  let sequence = 0;
  let firstDispatched;
  const firstStarted = new Promise((resolve) => { firstDispatched = resolve; });
  const { runtime, launches, requests, children } = fixture((request, child, reply) => {
    sequence++;
    if (sequence === 1) firstDispatched();
    else setImmediate(() => reply({ answers: { action_guard: { choice: "review", confidence: 0.8 } } }));
  });
  const controller = new AbortController();
  const pending = runtime.judge(input, { signal: controller.signal });
  // Cancel an actually dispatched request, not startup: a busy runner may take longer than 15 ms to
  // reach stdin. Aborting earlier leaves sequence at zero and makes the replacement ignore its request.
  await Promise.race([firstStarted, pending]);
  assert.equal(requests.length, 1);
  controller.abort();
  await assert.rejects(() => pending, /cancelled|timed out/);
  const result = await runtime.judge(input);
  assert.equal(result.choice, "review");
  assert.equal(launches.length, 2);
  assert.equal(requests.length, 2);
  assert.equal(children[0].kills, 1);
  assert.equal(children[1].kills, 0, "cancellation must not terminate the replacement worker");
});

test("late stdout from a cancelled worker cannot stop its replacement", async () => {
  let oldReply;
  let firstDispatched;
  const firstStarted = new Promise((resolve) => { firstDispatched = resolve; });
  const { runtime, children, requests } = fixture((request, child, reply) => {
    if (!oldReply) {
      oldReply = reply;
      firstDispatched();
      return;
    }
    setImmediate(() => oldReply({ answers: { action_guard: { choice: "allow", confidence: 1 } } }));
    setImmediate(() => reply({ answers: { action_guard: { choice: "review", confidence: 0.8 } } }));
  });
  const controller = new AbortController();
  const pending = runtime.judge(input, { signal: controller.signal, timeoutMs: 200 });
  await firstStarted;
  controller.abort();
  await assert.rejects(() => pending, /cancelled|timed out/);
  const result = await runtime.judge(input);
  assert.equal(result.choice, "review");
  assert.equal(requests.length, 2);
  assert.equal(children[0].kills, 1);
  assert.equal(children[1].kills, 0, "old stdout must not affect the active replacement worker");
});

test("a cancelled queued request does not kill another Agent's active judgment", async () => {
  const { runtime, children, requests } = fixture((request, child, reply) => setTimeout(() => reply({ answers: { action_guard: { choice: "review", confidence: 0.7 } } }), 35));
  const controller = new AbortController();
  const first = runtime.judge(input);
  const second = runtime.judge(input, { signal: controller.signal });
  controller.abort();
  await first;
  await assert.rejects(() => second, /abort/i);
  assert.equal(children[0].kills, 0);
  assert.equal(requests.length, 1);
});

test("readiness cannot be spoofed by a redirected private runtime tree", async () => {
  const { runtime, directory, home } = fixture();
  const escape = join(home, "outside"); mkdirSync(escape);
  const venv = join(directory, "venv"); rmSync(venv, { recursive: true }); symlinkSync(escape, venv);
  // A receipt alone never authorizes launching through a redirected venv parent.
  writeFileSync(join(escape, "python"), "not executed"); mkdirSync(join(escape, "bin")); writeFileSync(join(escape, "bin", "python"), "not executed");
  await assert.rejects(() => runtime.judge(input), /real directory|symbolic/);
});

test("Laya shadow cannot change a Guardian deny, even if config requests enforce", async () => {
  let localCalls = 0, cloudCalls = 0;
  const provider = { model: "fixture", async turn() { return { text: '{"decision":"block","reason":"out of scope"}', toolUses: [], stop: "end" }; } };
  const verdict = await evaluateActionGuard(provider, { engine: "laya-mlx", config: { mode: "enforce" } }, { tool: "computer", category: "computer_action", detail: "send", classifierReason: "external" }, [{ role: "user", content: "Inspect only" }], {
    localJudge: async () => { localCalls++; return { choice: "allow", decision: "allow", confidence: 1, probabilities: { allow: 1 }, model: "local" }; },
    decisionFetch: async () => { cloudCalls++; throw new Error("must not call cloud Jev"); },
  });
  assert.equal(verdict.decision, "block");
  assert.equal(verdict.mode, "shadow");
  assert.equal(verdict.engine, "laya-mlx");
  assert.equal(verdict.observedDecision, "allow");
  assert.equal(localCalls, 1); assert.equal(cloudCalls, 0);
});

test("unavailable local inference preserves the Guardian and reports a bounded reason", async () => {
  const verdict = await evaluateActionGuard(null, { engine: "laya-mlx", config: { mode: "shadow" } }, { tool: "computer", category: "read", detail: "read", classifierReason: "read" }, [], {
    localJudge: async () => { throw new Error("context_budget_exceeded apiKey=sk-secretsecret"); },
  });
  assert.equal(verdict.unavailable, true);
  assert.equal(verdict.source, "guardian");
  assert.doesNotMatch(verdict.unavailableReason, /sk-secretsecret/);
});

test("the actual Python worker rejects overflowing state and question tokens before inference", () => {
  const python = spawnSync("python3", ["-I", "-c", String.raw`
import json, sys, types
source = sys.stdin.read()
space = {"__name__": "unit"}
exec(source, space)
common = types.ModuleType("laya_mlx.common")
common.serialize_state = lambda state: json.dumps(state)
common.render_options = lambda q: list(q["criteria"])
common.build_prefix = lambda tok, q, maximum: ([1] * 8, [1, 2, 3])
sys.modules["laya_mlx"] = types.ModuleType("laya_mlx")
sys.modules["laya_mlx.common"] = common
class Tok:
    mask_token = "[MASK]"
    def __call__(self, value, **kw): return {"input_ids": list(value)}
class Agent:
    cfg = {"max_len": 40, "head_max_len": 192}
    tok = Tok()
    def _to_internal(self, q): return {**q, "t": "choice", "ins": q["instructions"]}
agent = Agent()
questions = {"guard": {"instructions": "check", "criteria": {"a": 1, "b": 2}}}
space["check_budget"](agent, {"text": "hi"}, questions)
for state, qs, expected in [({"text": "x" * 100}, questions, "context_budget_exceeded"), ({}, {"guard": {"instructions": "x" * 300, "criteria": {"a": 1}}}, "question_budget_exceeded")]:
    try: space["check_budget"](agent, state, qs)
    except ValueError as err: assert str(err) == expected
    else: raise AssertionError("overflow must not reach inference")
print("passed")
`], { input: LAYA_WORKER, encoding: "utf8" });
  assert.equal(python.status, 0, python.stderr);
  assert.match(python.stdout, /passed/);
});
