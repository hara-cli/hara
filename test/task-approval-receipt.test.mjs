import "./setup-isolated-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSession, newSessionId, saveSession } from "../dist/session/store.js";

test("task-grant revocation receipt survives restore without persisting an active grant", () => {
  const project = join(homedir(), "project");
  mkdirSync(project, { mode: 0o700 });
  const id = newSessionId();
  const at = "2026-10-08T00:00:00.000Z";
  const receipt = {
    v: 1,
    commandId: "11111111-1111-4111-8111-111111111111",
    method: "session.task-approval.revoke",
    requestHash: "a".repeat(64),
    startedAt: at,
    completedAt: at,
    outcome: { kind: "result", json: JSON.stringify({
      taskApprovalState: { active: false, toolFamilies: [], canRevoke: false },
    }) },
  };
  saveSession({ id, cwd: project, provider: "fixture", model: "fixture", title: "",
    createdAt: at, updatedAt: at, commandReceipts: [receipt] }, []);
  assert.deepEqual(loadSession(id)?.meta.commandReceipts, [receipt]);
  const sidecar = readFileSync(join(homedir(), ".hara", "sessions", `${id}.metadata`), "utf8");
  assert.doesNotMatch(sidecar, /commandReceipts|taskApprovalState|grantFromHuman/);
});
