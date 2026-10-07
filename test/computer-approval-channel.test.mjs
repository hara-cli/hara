import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hara-computer-approval-"));
const previousHome = process.env.HOME;
process.env.HOME = join(root, "home");
mkdirSync(process.env.HOME, { recursive: true });
const { runAgent } = await import("../dist/agent/loop.js");
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function fixture({ traits, approvalChannel, confirm = async () => true, signal, calls = 1 }) {
  let rounds = 0;
  let executions = 0;
  const confirmations = [];
  const history = [{ role: "user", content: "Use the test computer tool" }];
  const provider = {
    id: "computer-approval-fixture",
    model: "computer-approval-fixture",
    async turn() {
      return rounds++ === 0
        ? {
            text: "", stop: "tool_use",
            toolUses: Array.from({ length: calls }, (_, index) => ({
              id: `computer-${index}`, name: "computer_approval_probe", input: { step: index },
            })),
          }
        : { text: "done", stop: "end", toolUses: [] };
    },
  };
  const running = runAgent(history, {
    provider,
    ctx: { cwd: root },
    approval: "full-auto",
    approvalChannel,
    signal,
    quiet: true,
    hooks: false,
    confirm: async (question, confirmationSignal, options) => {
      confirmations.push({ question, signal: confirmationSignal, options });
      return confirm(question, confirmationSignal, options);
    },
    extraTools: [{
      name: "computer_approval_probe",
      description: "Synthetic tool; never accesses a real desktop",
      input_schema: { type: "object", properties: { step: { type: "number" } } },
      kind: "computer",
      ...(traits ? { classify: () => traits } : {}),
      async run() { executions++; return "probe executed"; },
    }],
  });
  return { running, history, confirmations, executions: () => executions };
}

const computerCases = [
  { label: "a legacy computer action", traits: undefined },
  { label: "a read-only screenshot with computer approval", traits: { effect: "read", concurrencySafe: true, approvalKind: "computer" } },
];

for (const { label, traits } of computerCases) {
  for (const approvalChannel of [false, undefined, "true", 1]) {
    test(`${label} fails closed without approvalChannel === true (${String(approvalChannel)})`, async () => {
      const probe = fixture({ traits, approvalChannel });
      assert.equal((await probe.running).status, "completed");
      assert.equal(probe.executions(), 0, "full-auto cannot bypass a real approval channel");
      assert.equal(probe.confirmations.length, 0, "a headless auto-yes callback must not be consulted");
      const result = probe.history.find((message) => message.role === "tool").results[0];
      assert.equal(result.isError, true);
      assert.match(result.content, /live human confirmation.*No approval channel.*nothing was executed/i);
    });
  }

  for (const decision of [false, true]) {
    test(`${label} ${decision ? "runs after live approval" : "does not run after live denial"} in full-auto`, async () => {
      const probe = fixture({ traits, approvalChannel: true, confirm: async () => decision });
      assert.equal((await probe.running).status, "completed");
      assert.equal(probe.confirmations.length, 1);
      assert.equal(probe.confirmations[0].options.allowAlways, false);
      assert.equal(probe.executions(), decision ? 1 : 0);
      const result = probe.history.find((message) => message.role === "tool").results[0];
      if (decision) assert.equal(result.content, "probe executed");
      else {
        assert.equal(result.isError, true);
        assert.match(result.content, /User denied this action/);
      }
    });
  }
}

test("live computer approval remains fresh for every action", async () => {
  const probe = fixture({ approvalChannel: true, calls: 2 });
  assert.equal((await probe.running).status, "completed");
  assert.equal(probe.executions(), 2);
  assert.equal(probe.confirmations.length, 2);
  assert.ok(probe.confirmations.every(({ options }) => options.allowAlways === false));
});

test("cancelling a live computer approval never starts the tool even if the callback later allows it", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const probe = fixture({
    approvalChannel: true,
    signal: controller.signal,
    confirm: async (_question, signal) => {
      entered.resolve(signal);
      return reply.promise;
    },
  });
  const confirmationSignal = await entered.promise;
  assert.ok(confirmationSignal instanceof AbortSignal);
  controller.abort();
  const outcome = await probe.running;
  reply.resolve(true);
  await Promise.resolve();
  assert.equal(confirmationSignal.aborted, true);
  assert.equal(probe.executions(), 0);
  assert.deepEqual(outcome, { status: "error", error: "(interrupted)" });
  const result = probe.history.find((message) => message.role === "tool").results[0];
  assert.equal(result.isError, true);
  assert.match(result.content, /interrupted before this tool call completed/);
});

for (const approvalChannel of [false, true]) {
  test(`requiresExplicitApproval keeps its live-channel boundary (${approvalChannel})`, async () => {
    const probe = fixture({
      traits: { effect: "edit", concurrencySafe: false, requiresExplicitApproval: true },
      approvalChannel,
    });
    assert.equal((await probe.running).status, "completed");
    assert.equal(probe.executions(), approvalChannel ? 1 : 0);
    assert.equal(probe.confirmations.length, approvalChannel ? 1 : 0);
    if (approvalChannel) assert.equal(probe.confirmations[0].options.allowAlways, false);
    else assert.match(probe.history.find((message) => message.role === "tool").results[0].content, /No approval channel/);
  });
}
