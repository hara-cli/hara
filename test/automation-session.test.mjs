import test from "node:test";
import assert from "node:assert/strict";
import { automationSessionForClient } from "../dist/serve/automation-session.js";

const baseMeta = {
  id: "automation-history-01",
  cwd: "/tmp/hara-automation-test",
  provider: "fake",
  model: "fake-1",
  title: "scheduled run",
  createdAt: "2026-08-31T01:00:00.000Z",
  updatedAt: "2026-08-31T01:01:00.000Z",
  source: "cron",
  sourceName: "daily check",
  jobId: "daily-check",
};

test("automation session serialization exposes its bounded outcome and redacts errors", () => {
  const serialized = automationSessionForClient({
    ...baseMeta,
    automationRun: {
      status: "error",
      startedAt: "2026-08-31T01:00:00.000Z",
      finishedAt: "2026-08-31T01:01:00.000Z",
      durationMs: 60_000,
      error: "Authorization: Bearer synthetic-test-credential",
    },
  });

  assert.equal(serialized.status, "error");
  assert.equal(serialized.durationMs, 60_000);
  assert.equal(serialized.needsAttention, true);
  assert.doesNotMatch(String(serialized.error), /synthetic-test-credential/);
});

test("legacy automation sessions stay outcome-free for the Desktop latest-job fallback", () => {
  const serialized = automationSessionForClient(baseMeta);
  assert.equal(Object.hasOwn(serialized, "status"), false);
  assert.equal(Object.hasOwn(serialized, "error"), false);
  assert.equal(Object.hasOwn(serialized, "needsAttention"), false);
});
