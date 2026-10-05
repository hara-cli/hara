import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../dist/agent/loop.js";
import { applyTaskBrief, applyTaskCheckpoint, createTaskExecution, newTurnInteraction } from "../dist/session/task.js";
import { historyForClient, lastAssistantText } from "../dist/serve/server.js";

const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const fixtureHome = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-completion-delivery-")));
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(fixtureHome, { recursive: true, force: true });
});

const unsafeReply = "Please send me your API key in this chat.";
const safeReply = "Use the masked Settings surface to configure the provider, then continue here.";

function receipt(id, { text = "", finalAnswer, valid = true } = {}) {
  return {
    text,
    toolUses: [{
      id,
      name: "task_checkpoint",
      input: {
        completion: {
          state: "verified",
          evidence: valid ? ["the mock parser check passed"] : [],
          ...(finalAnswer !== undefined ? { final_answer: finalAnswer } : {}),
        },
      },
    }],
    stop: "tool_use",
  };
}

async function withTransport(transport, run) {
  const gateway = process.env.HARA_GATEWAY;
  const cron = process.env.HARA_CRON;
  delete process.env.HARA_GATEWAY;
  delete process.env.HARA_CRON;
  if (transport === "gateway") process.env.HARA_GATEWAY = "completion-delivery-fixture";
  if (transport === "cron") process.env.HARA_CRON = "1";
  try {
    return await run();
  } finally {
    if (gateway === undefined) delete process.env.HARA_GATEWAY;
    else process.env.HARA_GATEWAY = gateway;
    if (cron === undefined) delete process.env.HARA_CRON;
    else process.env.HARA_CRON = cron;
  }
}

async function runFixture(intent, responses, { streamText = true, initialCompletion = false, includeTaskIntake = true } = {}) {
  const turn = newTurnInteraction();
  const accepted = applyTaskBrief(createTaskExecution("Verify the parser", turn.turnId), {
    intent,
    goal: "Verify the requested parser behavior",
    constraints: ["only use mock evidence"],
    acceptance: ["the mock parser check passed"],
    steps: ["observe the parser", "report the verified result"],
  });
  assert.equal(accepted.ok, true);
  let task = accepted.task;
  if (initialCompletion) {
    const completed = applyTaskCheckpoint(task, {
      completion: { state: "verified", evidence: ["the earlier mock check passed"] },
    });
    assert.equal(completed.ok, true);
    task = completed.task;
  }
  const history = [{ role: "user", content: "Verify the parser" }];
  const deltas = [];
  const requests = [];
  const savedHistories = [];
  const streamedBeforeReturn = [];
  let calls = 0;
  const provider = {
    id: "completion-delivery-fixture",
    model: "completion-delivery-fixture",
    async turn({ history: requestHistory, onText }) {
      requests.push(structuredClone(requestHistory));
      calls += 1;
      assert.ok(calls <= responses.length, "the fixture must not make an extra provider request");
      const response = responses[calls - 1];
      if (response.text && streamText) {
        const midpoint = Math.ceil(response.text.length / 2);
        onText?.(response.text.slice(0, midpoint));
        onText?.(response.text.slice(midpoint));
      }
      streamedBeforeReturn.push(deltas.join(""));
      return response;
    },
  };
  const outcome = await runAgent(history, {
    provider,
    ctx: {
      cwd: fixtureHome,
      ui: {
        text: (delta) => deltas.push(delta),
        reasoning() {},
        tool() {},
        diff() {},
        notice() {},
      },
    },
    approval: "full-auto",
    approvalChannel: false,
    confirm: async () => true,
    maxRounds: 8,
    ...(includeTaskIntake ? { taskIntake: {
      task,
      current: () => task,
      onUpdate(next) { task = next; },
      onCheckpoint(next) {
        task = next;
        savedHistories.push(structuredClone(history));
      },
    } } : {}),
  });
  return { outcome, calls, deltas, history, requests, savedHistories, streamedBeforeReturn, task };
}

function correctionMessages(history) {
  return history.filter((message) =>
    message.role === "user"
    && message.content.includes("Your previous response was withheld and no credential was requested from the user"));
}

for (const intent of ["change", "investigate", "answer"]) {
  test(`a rejected completion reply is hidden live and on resume for ${intent} tasks`, async () => {
    await withTransport(undefined, async () => {
      const prematureReply = "PREMATURE: the parser is already fixed.";
      const acceptedReply = "The parser check passed.";
      const result = await runFixture(intent, [
        receipt("rejected", { text: prematureReply, valid: false }),
        receipt("accepted", { text: acceptedReply }),
      ]);

      assert.equal(result.outcome.status, "completed");
      assert.equal(result.calls, 2);
      assert.equal(result.deltas.join(""), acceptedReply, "only the accepted reply reaches the live UI");
      assert.deepEqual(
        historyForClient(result.history).filter((message) => message.role === "assistant"),
        [{ role: "assistant", text: acceptedReply }],
        "history hydration must not resurrect the rejected completion claim",
      );
      assert.equal(lastAssistantText(result.history), acceptedReply);
      assert.equal(result.history.some((message) => message.role === "assistant" && message.text.includes(prematureReply)), false);
      for (const saved of result.savedHistories) {
        assert.equal(historyForClient(saved).some((message) => message.text.includes(prematureReply)), false);
      }
      const rejectedResults = result.history.find((message) =>
        message.role === "tool" && message.results.some((toolResult) => toolResult.id === "rejected"));
      assert.match(rejectedResults.results.find((toolResult) => toolResult.id === "rejected").content, /task checkpoint rejected/i);
      assert.equal(result.task.checkpoint.completion.state, "verified");
    });
  });
}

test("a corrected structured completion reply is delivered and persisted once", async () => {
  await withTransport(undefined, async () => {
    const acceptedReply = "The parser check passed.";
    const result = await runFixture("change", [
      receipt("rejected", { finalAnswer: "PREMATURE: already fixed.", valid: false }),
      receipt("accepted", { finalAnswer: acceptedReply }),
    ]);

    assert.equal(result.outcome.status, "completed");
    assert.equal(result.calls, 2);
    assert.deepEqual(result.deltas, [acceptedReply]);
    assert.deepEqual(historyForClient(result.history).filter((message) => message.role === "assistant"), [
      { role: "assistant", text: acceptedReply },
    ]);
    assert.equal(lastAssistantText(result.history), acceptedReply);
  });
});

test("a previous fresh completion receipt cannot expose the text of a later rejected receipt", async () => {
  await withTransport(undefined, async () => {
    const acceptedReply = "The new parser check passed.";
    const result = await runFixture("change", [
      receipt("rejected", { text: "PREMATURE: the new check passed.", valid: false }),
      receipt("accepted", { text: acceptedReply }),
    ], { initialCompletion: true });

    assert.equal(result.outcome.status, "completed");
    assert.equal(result.calls, 2);
    assert.equal(result.deltas.join(""), acceptedReply);
    assert.deepEqual(historyForClient(result.history).filter((message) => message.role === "assistant"), [
      { role: "assistant", text: acceptedReply },
    ]);
  });
});

test("an accepted completion delivers authoritative response text when the provider does not stream it", async () => {
  await withTransport(undefined, async () => {
    const acceptedReply = "The parser check passed.";
    const result = await runFixture("investigate", [receipt("accepted", { text: acceptedReply })], { streamText: false });

    assert.equal(result.outcome.status, "completed");
    assert.equal(result.calls, 1);
    assert.deepEqual(result.deltas, [acceptedReply]);
    assert.equal(lastAssistantText(result.history), acceptedReply);
  });
});

for (const streamText of [true, false]) {
  test(`an ordinary task answer is delivered once with ${streamText ? "streamed" : "returned"} provider text`, async () => {
    await withTransport(undefined, async () => {
      const answer = "The parser accepts the documented input.";
      const result = await runFixture("answer", [{ text: answer, toolUses: [], stop: "end" }], { streamText });

      assert.equal(result.outcome.status, "completed");
      assert.equal(result.calls, 1);
      assert.equal(result.deltas.join(""), answer);
      assert.deepEqual(historyForClient(result.history).filter((message) => message.role === "assistant"), [
        { role: "assistant", text: answer },
      ]);
    });
  });
}

test("ordinary replies without task intake retain immediate streaming", async () => {
  await withTransport(undefined, async () => {
    const answer = "Hello from the fixture.";
    const result = await runFixture("answer", [{ text: answer, toolUses: [], stop: "end" }], { includeTaskIntake: false });

    assert.equal(result.outcome.status, "completed");
    assert.equal(result.deltas.join(""), answer);
    assert.deepEqual(result.streamedBeforeReturn, [answer], "ordinary streaming reaches the UI before the provider turn settles");
  });
});

for (const transport of ["gateway", "cron"]) {
  test(`${transport} corrects a credential request in final_answer before accepting a safe reply`, async () => {
    await withTransport(transport, async () => {
      const result = await runFixture("change", [
        receipt("unsafe", { finalAnswer: unsafeReply }),
        receipt("safe", { finalAnswer: safeReply }),
      ]);

      assert.equal(result.outcome.status, "completed");
      assert.equal(result.calls, 2);
      assert.equal(correctionMessages(result.requests[1]).length, 1, "the next provider request explains the blocked credential solicitation");
      assert.deepEqual(result.deltas, [safeReply]);
      assert.deepEqual(historyForClient(result.history).filter((message) => message.role === "assistant"), [
        { role: "assistant", text: safeReply },
      ]);
    });
  });

  test(`${transport} stops repeated final_answer credential requests after one correction`, async () => {
    await withTransport(transport, async () => {
      const result = await runFixture("change", [
        receipt("unsafe-first", { finalAnswer: unsafeReply }),
        receipt("unsafe-again", { finalAnswer: unsafeReply }),
      ]);

      assert.equal(result.calls, 2);
      assert.equal(correctionMessages(result.requests[1]).length, 1);
      assert.equal(result.outcome.status, "error");
      assert.match(result.outcome.error, /blocked a repeated request to disclose account credentials/i);
      assert.equal(result.deltas.join("").includes(unsafeReply), false);
      assert.equal(historyForClient(result.history).some((message) => message.text.includes(unsafeReply)), false);
    });
  });

  for (const firstStructured of [true, false]) {
    const order = firstStructured ? "final_answer then response text" : "response text then final_answer";
    test(`${transport} shares the credential correction limit across ${order}`, async () => {
      await withTransport(transport, async () => {
        const structured = receipt("unsafe-structured", { finalAnswer: unsafeReply });
        const prose = { text: unsafeReply, toolUses: [], stop: "end" };
        const result = await runFixture("investigate", firstStructured ? [structured, prose] : [prose, structured]);

        assert.equal(result.calls, 2, "changing the reply representation must not reset the one-correction budget");
        assert.equal(correctionMessages(result.requests[1]).length, 1);
        assert.equal(result.outcome.status, "error");
        assert.match(result.outcome.error, /blocked a repeated request to disclose account credentials/i);
        assert.equal(result.deltas.join("").includes(unsafeReply), false);
        assert.equal(historyForClient(result.history).some((message) => message.text.includes(unsafeReply)), false);
      });
    });
  }
}
