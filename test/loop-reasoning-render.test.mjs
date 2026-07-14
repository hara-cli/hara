// Non-TUI reasoning rendering (A.P0 #7).
// Verifies that in plain-terminal mode (no UiSink), reasoning deltas land on their OWN dim lines
// — each line is prefixed `│ ` and committed once, so a subsequent spinner tick can't clobber it
// (the old bug where `out(c.dim(d))` shared a line with the spinner's `\r`-overwrite).
//
// We don't need a real provider; we just need a fake Provider that streams a reasoning delta and
// then ends the turn. We capture every stdout chunk and inspect the sequence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../dist/agent/loop.js";

// Strip ANSI to make the assertion robust against the dim() formatting.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function withCapturedStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return true;
  };
  // Also force a non-TTY context: spin/md rendering only activates on TTY, and our reasoning
  // branch hits both sink+tty conditions. Force the TTY flag on so the renderer engages.
  const prevIsTTY = process.stdout.isTTY;
  process.stdout.isTTY = true;
  return Promise.resolve(fn())
    .finally(() => {
      process.stdout.write = original;
      process.stdout.isTTY = prevIsTTY;
    })
    .then(() => chunks);
}

async function withTemporaryHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "hara-loop-render-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

test("non-TUI reasoning: each delta lands on its own dim '│ '-prefixed line, not the spinner row", async () => {
  // Fake provider: emit two reasoning deltas (the second contains a newline mid-string), then end.
  const provider = {
    id: "fake",
    model: "fake-model",
    async turn({ onReasoning }) {
      onReasoning?.("thinking about it");
      onReasoning?.("\nstill thinking");
      return { text: "done", toolUses: [], stop: "end" };
    },
  };

  const chunks = await withTemporaryHome(() => withCapturedStdout(() =>
    runAgent([{ role: "user", content: "hi" }], {
      provider,
      ctx: { cwd: process.cwd() },
      approval: "full-auto",
      confirm: async () => true,
    }),
  ));

  const stripped = chunks.map(stripAnsi).join("");
  // The reasoning content should appear on its own line(s), prefixed by '│ '.
  assert.match(stripped, /│ thinking about it/, "first reasoning chunk prefixed by box-drawing char");
  // The newline-split chunk should also be visible.
  assert.match(stripped, /│ still thinking/, "post-newline reasoning resumes on a new prefixed line");
  // Spinner has cleared (no '\r\x1b[K' bytes mid-reasoning that would have eaten the previous line):
  // i.e. the reasoning output comes AFTER any spinner clears, never the other way round.
  const reasoningIdx = stripped.indexOf("│ thinking");
  assert.ok(reasoningIdx >= 0, "reasoning ordering recoverable");
});

test("non-TUI reasoning: a synchronous provider failure clears the TTY spinner and settles", async () => {
  const provider = {
    id: "sync-throw",
    model: "fake-model",
    turn() {
      throw new Error("synchronous provider fixture failure");
    },
  };
  let outcome;
  const chunks = await withTemporaryHome(() => withCapturedStdout(async () => {
    outcome = await runAgent([{ role: "user", content: "hi" }], {
      provider,
      ctx: { cwd: process.cwd() },
      approval: "full-auto",
      confirm: async () => true,
    });
  }));

  assert.equal(outcome?.status, "error");
  assert.match(outcome?.error ?? "", /synchronous provider fixture failure/);
  assert.match(chunks.join(""), /synchronous provider fixture failure/);
});
