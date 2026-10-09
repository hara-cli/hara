import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../dist/agent/loop.js";
import {
  disposeReminderScope,
  drainReminders,
  isSystemReminderContent,
  pushReminder,
  wrapReminders,
} from "../dist/agent/reminders.js";
import {
  currentTodos,
  disposeTodoScope,
  restoreTodos,
} from "../dist/tools/todo.js";
import "../dist/tools/builtin.js";

const progressReminders = (history) => history.filter((message) =>
  message.role === "user"
  && typeof message.content === "string"
  && message.content.includes("No-progress checkpoint:"));

const progressNotices = (notices) => notices.filter((message) =>
  /Task progress has stalled/.test(message));

async function fixture(t, { gateway = false, pendingTodo = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "hara-progress-reminders-"));
  const todoScope = `progress-reminders:${randomUUID()}`;
  const previousGateway = process.env.HARA_GATEWAY;
  const previousCron = process.env.HARA_CRON;
  if (gateway) process.env.HARA_GATEWAY = "feishu";
  else delete process.env.HARA_GATEWAY;
  delete process.env.HARA_CRON;
  t.after(async () => {
    if (previousGateway === undefined) delete process.env.HARA_GATEWAY;
    else process.env.HARA_GATEWAY = previousGateway;
    if (previousCron === undefined) delete process.env.HARA_CRON;
    else process.env.HARA_CRON = previousCron;
    disposeReminderScope(todoScope);
    disposeTodoScope(todoScope);
    await rm(cwd, { recursive: true, force: true });
  });
  if (pendingTodo) restoreTodos([{ text: "Finish the requested work", status: "in_progress" }], todoScope);
  const history = [{ role: "user", content: "Perform the bounded fixture work." }];
  const notices = [];
  const progress = [];
  const options = {
    ctx: {
      cwd,
      stateHome: join(cwd, "private-state"),
      todoScope,
      ui: {
        text() {}, reasoning() {}, tool() {}, diff() {},
        notice: (message) => notices.push(message),
      },
    },
    hooks: false,
    approval: "full-auto",
    confirm: async () => true,
    maxRounds: 64,
    timeoutMs: "10s",
    onProgress: (event) => progress.push(event),
  };
  return { cwd, todoScope, history, notices, progress, options };
}

function scriptedProvider(history, toolRounds, toolUseForRound, usage) {
  const calls = [];
  return {
    id: "progress-reminder-fixture",
    model: "progress-reminder-fixture",
    calls,
    async turn() {
      const round = calls.length + 1;
      calls.push({ progressReminders: progressReminders(history).length });
      if (round <= toolRounds) return {
        text: "",
        toolUses: [{ id: `fixture-call-${round}`, ...toolUseForRound(round) }],
        stop: "tool_use",
        ...(usage ? { usage } : {}),
      };
      return {
        text: "The bounded fixture is finished.", toolUses: [], stop: "end",
        ...(usage ? { usage } : {}),
      };
    },
  };
}

const readProbe = {
  name: "progress_reminder_probe",
  description: "Return one new short observation without changing durable state.",
  input_schema: {
    type: "object",
    properties: { round: { type: "integer" } },
    required: ["round"],
  },
  kind: "read",
  async run(input) { return `state-${input.round}`; },
};

test("gateway file work does not get a stall reminder merely for repeating one tool with an unfinished todo", async (t) => {
  const fx = await fixture(t, { gateway: true });
  const provider = scriptedProvider(fx.history, 6, (round) => ({
    name: "write_file",
    input: { path: "progress.txt", content: `Verified file revision ${round}\n` },
  }));
  const outcome = await runAgent(fx.history, { ...fx.options, provider });

  assert.equal(outcome.status, "completed");
  assert.equal(provider.calls.length, 7);
  assert.equal(await readFile(join(fx.cwd, "progress.txt"), "utf8"), "Verified file revision 6\n");
  assert.equal(fx.progress.length, 6);
  assert.ok(fx.progress.every((event) => event.verifiedChangeAdvanced && event.checkpointStaleRounds === 0));
  assert.ok(fx.progress.every((event) => event.state === "working"));
  assert.equal(currentTodos(fx.todoScope)[0].status, "in_progress", "the pending checklist alone does not negate changed bytes");
  assert.equal(progressReminders(fx.history).length, 0);
  assert.equal(progressNotices(fx.notices).length, 0);
  assert.doesNotMatch(JSON.stringify(fx.history), /you've repeated the same action|todo list has not been updated|Self-check:/i);
});

test("attached pending todos share one watchdog warning across eleven rounds without durable progress", async (t) => {
  const fx = await fixture(t);
  const provider = scriptedProvider(fx.history, 11, (round) => ({ name: readProbe.name, input: { round } }));
  const outcome = await runAgent(fx.history, { ...fx.options, provider, extraTools: [readProbe] });

  assert.equal(outcome.status, "completed", "the unattended eight-round limit does not stop attached work");
  assert.equal(provider.calls.length, 12);
  assert.ok(fx.progress.slice(0, 4).every((event) => event.state === "working"));
  assert.equal(fx.progress[4].state, "warning");
  assert.equal(fx.progress[4].checkpointStaleRounds, 5);
  assert.ok(fx.progress.slice(4).every((event) => event.state === "warning" && event.trigger === undefined));
  assert.equal(provider.calls[4].progressReminders, 0, "the fifth round has not closed when its provider call starts");
  assert.equal(provider.calls[5].progressReminders, 1, "the next provider call sees the fifth-round warning");
  assert.equal(progressReminders(fx.history).length, 1, "a continuous warning episode does not nag again at round ten");
  assert.equal(progressNotices(fx.notices).length, 1);
  assert.equal(isSystemReminderContent(progressReminders(fx.history)[0].content), true);
  assert.doesNotMatch(JSON.stringify(fx.history), /todo list has not been updated|you've repeated the same action/i);
});

for (const delivery of ["returned message", "shared history append"]) {
  test(`real user steering through ${delivery} refreshes the warning window without resetting usage`, async (t) => {
    const fx = await fixture(t);
    const initialUsage = { input: 10_000, output: 1_000 };
    const stats = { ...initialUsage };
    const usage = { input: 900, output: 100 };
    const provider = scriptedProvider(fx.history, 13, (round) => ({
      name: readProbe.name, input: { round },
    }), usage);
    let steered = false;
    const steeringText = "Keep checking the same bounded target with the corrected criterion.";
    const outcome = await runAgent(fx.history, {
      ...fx.options,
      provider,
      stats,
      extraTools: [readProbe],
      pendingInput: async () => {
        if (steered || provider.calls.length !== 6) return [];
        steered = true;
        const message = { role: "user", content: steeringText };
        if (delivery === "shared history append") {
          fx.history.push(message);
          return [];
        }
        return [message];
      },
    });

    assert.equal(outcome.status, "completed");
    assert.equal(steered, true);
    assert.equal(provider.calls.length, 14);
    assert.deepEqual(fx.progress.map((event) => event.state), [
      "working", "working", "working", "working", "warning", "warning",
      "working", "working", "working", "working", "working", "warning", "warning",
    ]);
    assert.equal(fx.progress[6].unattendedRounds, 0, "the actual seventh-round steer starts a fresh warning window");
    assert.equal(fx.progress[6].checkpointStaleRounds, 7, "steering does not invent durable task evidence");
    assert.deepEqual(fx.progress.map((event) => event.tokens.total),
      Array.from({ length: 13 }, (_, index) => (index + 1) * 1_000),
      "all pre-steering usage remains in the run's token ledger");
    assert.equal(stats.input, initialUsage.input + 14 * usage.input);
    assert.equal(stats.output, initialUsage.output + 14 * usage.output);
    assert.equal(progressReminders(fx.history).length, 2, "each distinct warning episode gets one reminder");
    assert.equal(progressNotices(fx.notices).length, 2);
    assert.match(progressReminders(fx.history)[0].content, /No-progress checkpoint: round 5,/);
    assert.match(progressReminders(fx.history)[1].content, /No-progress checkpoint: round 12,/);
    assert.equal(provider.calls[11].progressReminders, 1);
    assert.equal(provider.calls[12].progressReminders, 2);
    assert.equal(fx.history.filter((message) => message.role === "user" && message.content === steeringText).length, 1);
  });

  test(`internal reminders through ${delivery} do not refresh a stale warning window`, async (t) => {
    const fx = await fixture(t);
    const initialUsage = { input: 10_000, output: 1_000 };
    const stats = { ...initialUsage };
    const usage = { input: 900, output: 100 };
    const provider = scriptedProvider(fx.history, 11, (round) => ({
      name: readProbe.name, input: { round },
    }), usage);
    const injectedRounds = [];
    const outcome = await runAgent(fx.history, {
      ...fx.options,
      provider,
      stats,
      extraTools: [readProbe],
      pendingInput: async () => {
        const nextRound = provider.calls.length + 1;
        if (![5, 8].includes(nextRound)) return [];
        injectedRounds.push(nextRound);
        const message = {
          role: "user",
          content: wrapReminders([`Runtime observation for fixture round ${nextRound}.`]),
        };
        if (delivery === "shared history append") {
          fx.history.push(message);
          return [];
        }
        return [message];
      },
    });

    assert.equal(outcome.status, "completed");
    assert.deepEqual(injectedRounds, [5, 8]);
    assert.ok(fx.progress.slice(0, 4).every((event) => event.state === "working"));
    assert.ok(fx.progress.slice(4).every((event) => event.state === "warning"));
    assert.deepEqual(fx.progress.map((event) => event.unattendedRounds),
      Array.from({ length: 11 }, (_, index) => index + 1),
      "internal role:user envelopes do not count as a live user intervention");
    assert.deepEqual(fx.progress.map((event) => event.tokens.total),
      Array.from({ length: 11 }, (_, index) => (index + 1) * 1_000));
    assert.equal(stats.input, initialUsage.input + 12 * usage.input);
    assert.equal(stats.output, initialUsage.output + 12 * usage.output);
    assert.equal(progressReminders(fx.history).length, 1, "internal context does not re-arm the same warning episode");
    assert.equal(progressNotices(fx.notices).length, 1);
    assert.match(progressReminders(fx.history)[0].content, /No-progress checkpoint: round 5,/);
    assert.equal(fx.history.filter((message) =>
      message.role === "user" && !isSystemReminderContent(message.content)).length, 1,
    "the only genuine user message is the original request");
  });
}

test("unattended work warns once at five stale rounds and stops before a ninth provider call", async (t) => {
  const fx = await fixture(t, { pendingTodo: false });
  const provider = scriptedProvider(fx.history, 12, (round) => ({ name: readProbe.name, input: { round } }));
  const outcome = await runAgent(fx.history, { ...fx.options, provider, unattended: true, extraTools: [readProbe] });

  assert.equal(outcome.status, "halted");
  assert.equal(outcome.stopReason, "no_progress");
  assert.equal(provider.calls.length, 8);
  assert.deepEqual(fx.progress.map((event) => event.state), [
    "working", "working", "working", "working", "warning", "warning", "warning", "stopped",
  ]);
  assert.equal(fx.progress.at(-1).trigger, "unattended_without_checkpoint");
  assert.equal(fx.progress.at(-1).checkpointStaleRounds, 8);
  assert.equal(progressReminders(fx.history).length, 1);
  assert.equal(progressNotices(fx.notices).length, 1);
  assert.equal(provider.calls[5].progressReminders, 1);
});

test("quiet stalled work keeps the hard stop without injecting or draining scoped reminders", async (t) => {
  const fx = await fixture(t);
  const otherScope = `${fx.todoScope}:other`;
  t.after(() => disposeReminderScope(otherScope));
  pushReminder("A queued main-conversation event.", fx.todoScope);
  pushReminder("An unrelated conversation event.", otherScope);
  const provider = scriptedProvider(fx.history, 12, (round) => ({ name: readProbe.name, input: { round } }));
  const outcome = await runAgent(fx.history, {
    ...fx.options, provider, unattended: true, quiet: true, extraTools: [readProbe],
  });

  assert.equal(outcome.status, "halted");
  assert.equal(outcome.stopReason, "no_progress");
  assert.equal(provider.calls.length, 8);
  assert.equal(fx.progress[4].state, "warning", "quiet suppresses presentation, not the typed watchdog decision");
  assert.equal(fx.progress.at(-1).trigger, "unattended_without_checkpoint");
  assert.equal(fx.history.some((message) => isSystemReminderContent(message.content)), false);
  assert.deepEqual(fx.notices, []);
  assert.deepEqual(drainReminders(fx.todoScope), ["A queued main-conversation event."]);
  assert.deepEqual(drainReminders(otherScope), ["An unrelated conversation event."]);
});

test("gateway missing-image feedback produces one internal corrective reminder after two results", async (t) => {
  const fx = await fixture(t, { gateway: true, pendingTodo: false });
  const imageTools = Array.from({ length: 4 }, (_, index) => ({
    name: `progress_image_probe_${index + 1}`,
    description: "Report unavailable native image input without invoking a computer.",
    input_schema: { type: "object", properties: {} },
    kind: "read",
    async run() { return "Tool image was not read: switch to an image-capable model."; },
  }));
  const imageReminderCount = () => fx.history.filter((message) =>
    message.role === "user"
    && typeof message.content === "string"
    && message.content.includes("selected model has no native image input")).length;
  const provider = scriptedProvider(fx.history, 4, (round) => ({ name: imageTools[round - 1].name, input: {} }));
  const imageReminderCounts = [];
  const turn = provider.turn;
  provider.turn = async () => {
    imageReminderCounts.push(imageReminderCount());
    return turn();
  };
  const outcome = await runAgent(fx.history, { ...fx.options, provider, extraTools: imageTools });

  assert.equal(outcome.status, "completed");
  assert.deepEqual(imageReminderCounts, [0, 0, 1, 1, 1], "two missing-image results trigger the reminder, which stays one-shot");
  const imageReminders = fx.history.filter((message) =>
    message.role === "user"
    && typeof message.content === "string"
    && message.content.includes("selected model has no native image input"));
  assert.equal(imageReminders.length, 1);
  assert.equal(isSystemReminderContent(imageReminders[0].content), true, "capability correction is internal context, not user steering");
  assert.equal(progressReminders(fx.history).length, 0, "this fixture does not depend on a generic stall to catch missing image input");
  assert.equal(progressNotices(fx.notices).length, 0);
});
