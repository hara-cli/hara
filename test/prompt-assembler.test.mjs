import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptAssembler } from "../dist/agent/prompt.js";
import { composeSystem } from "../dist/agent/loop.js";

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
    const before = composeSystem(...common, { enabled: true });
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
    });

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
    assert.match(after.text, /# Project context \(AGENTS\.md\)/);
    assert.match(after.text, /The task brief below is the accepted interpretation/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});
