import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptAssembler } from "../dist/agent/prompt.js";
import { composeSystem, replyLanguageInstruction } from "../dist/agent/loop.js";
import { runtimeTimePrompt } from "../dist/runtime-time.js";

test("PromptAssembler renders deterministic text and refuses a stable suffix after turn context", () => {
  const prompt = new PromptAssembler()
    .add("core", "static", "core", "core rules")
    .add("project", "session", "project", "project rules")
    .add("task", "turn", "task", "task state")
    .build();
  assert.equal(prompt.text, "core rules\n\nproject rules\n\ntask state");
  assert.deepEqual(prompt.parts.map((part) => [part.id, part.stability]), [
    ["core", "static"],
    ["project", "session"],
    ["task", "turn"],
  ]);
  assert.throws(
    () => new PromptAssembler()
      .add("task", "turn", "task", "dynamic")
      .add("late-core", "static", "core", "should fail"),
    /cannot follow turn context/,
  );
});

test("Hara prompt keeps core/session identities stable when the accepted task brief changes", () => {
  const originalHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-prompt-home-"));
  process.env.HOME = home;
  try {
    const common = [
      "/workspace/project",
      "Preserve the public API.",
      undefined,
      "Use pnpm in this repository.",
      true,
      "# Task execution\nTask ID: t1\nObjective: repair the parser",
    ];
    const runtimeTime = {
      now: new Date("2026-08-31T03:04:05.000Z"),
      timeZone: "Asia/Shanghai",
    };
    const before = composeSystem(...common, { enabled: true }, undefined, runtimeTime);
    const after = composeSystem(...common, {
      enabled: true,
      brief: {
        intent: "change",
        goal: "repair the parser",
        constraints: ["preserve the public API"],
        acceptance: ["targeted tests pass"],
        steps: ["inspect", "edit", "test"],
        createdAt: "2026-07-19T00:00:00.000Z",
      },
    }, undefined, runtimeTime);

    const reusable = (prompt) => prompt.parts
      .filter((part) => part.stability !== "turn")
      .map(({ id, stability, source, digest }) => ({ id, stability, source, digest }));
    assert.deepEqual(reusable(after), reusable(before), "task progress does not invalidate the reusable prefix");
    assert.notEqual(
      after.parts.find((part) => part.id === "task-intake").digest,
      before.parts.find((part) => part.id === "task-intake").digest,
      "only the turn-level task boundary changes",
    );
    assert.match(after.text, /Working directory: \/workspace\/project/);
    assert.match(after.text, /Reply in the same language as the user's latest message/);
    assert.match(after.text, /Keep that language consistent in every user-visible/);
    assert.match(after.text, /never give a long-lived server or tunnel a short/);
    assert.match(after.text, /verify the failing function's actual inputs and observable state/);
    assert.match(after.text, /Trace a missing or unexpected value upstream through its callers/);
    assert.match(after.text, /After one ineffective edit to the same function, stop editing it/);
    assert.match(after.text, /# Project context \(AGENTS\.md\)/);
    assert.match(after.text, /The task brief below is the accepted interpretation/);
    const clock = after.parts.find((part) => part.id === "runtime-clock");
    assert.deepEqual(
      { stability: clock?.stability, source: clock?.source },
      { stability: "turn", source: "runtime" },
    );
    assert.equal(after.parts.at(-1)?.id, "runtime-clock", "the changing clock stays after cacheable context");
    assert.match(clock?.content ?? "", /Current date and time: 2026-08-31 11:04:05 \(Monday\)/);
    assert.match(clock?.content ?? "", /Time zone: Asia\/Shanghai \(UTC\+08:00\)/);

    const nextDay = composeSystem(...common, { enabled: true }, undefined, {
      now: new Date("2026-09-01T03:04:05.000Z"),
      timeZone: "Asia/Shanghai",
    });
    assert.notEqual(
      nextDay.parts.find((part) => part.id === "runtime-clock")?.digest,
      clock?.digest,
      "a later provider request receives a refreshed clock",
    );
    assert.deepEqual(
      nextDay.parts.filter((part) => part.id !== "runtime-clock"),
      before.parts.filter((part) => part.id !== "runtime-clock"),
      "refreshing the clock does not invalidate any other prompt part",
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime clock uses the requested zone across a UTC date boundary", () => {
  const prompt = runtimeTimePrompt({
    now: new Date("2026-09-01T01:02:03.000Z"),
    timeZone: "America/Los_Angeles",
  });
  assert.match(prompt, /Current date and time: 2026-08-31 18:02:03 \(Monday\)/);
  assert.match(prompt, /Time zone: America\/Los_Angeles \(UTC-07:00\)/);
  assert.match(prompt, /refreshed before every model request/);
  assert.match(prompt, /knowledge cutoff/);
});

test("reply language follows the latest message by default and accepts an explicit language tag", () => {
  assert.match(replyLanguageInstruction({}), /same language as the user's latest message/);
  assert.match(replyLanguageInstruction({ HARA_REPLY_LANGUAGE: "zh-CN" }), /Reply in zh-CN/);
  assert.match(
    replyLanguageInstruction({ HARA_REPLY_LANGUAGE: "not_a_language" }),
    /same language as the user's latest message/,
    "invalid environment values fail back to automatic language matching",
  );
});

test("gateway prompt identifies the actual execution host and treats location corrections as evidence requests", () => {
  const originalGateway = process.env.HARA_GATEWAY;
  process.env.HARA_GATEWAY = "feishu";
  try {
    const prompt = composeSystem("/workspace/project").text;
    assert.match(prompt, /file and shell tools execute directly on host/);
    assert.match(prompt, /physical location and SSH client do not change that host/);
    assert.match(prompt, /verify it with one bounded read-only host check/);
    assert.match(prompt, /latest direct user correction outranks your earlier assumption/);
    assert.match(prompt, /limits edits to named files is a hard scope boundary/);
  } finally {
    if (originalGateway === undefined) delete process.env.HARA_GATEWAY;
    else process.env.HARA_GATEWAY = originalGateway;
  }
});
