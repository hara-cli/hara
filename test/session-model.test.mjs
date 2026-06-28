// Per-session pinned model + `--force` (override all roles) — the unit boundary.
//
// We exercise three layers:
//   1. setSessionForceModel / isSessionForceModel       — module-local force flag, off by default.
//   2. effectiveRoleModel(roleModel, sessionModel)      — the helper threaded into the 4 role-provider
//                                                          sites in index.ts. Default respects role.model;
//                                                          --force collapses every role to the session model.
//   3. SessionMeta.model round-trip via saveSession/loadSession — the on-disk artifact that resume
//                                                          restores cfg.model from.
//
// We don't spin up the REPL here (the priority chain at startup is wired in index.ts and exercised by
// the higher-level integration runs in the issue self-test). These five tests cover the load-bearing
// behaviour every other site relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import {
  setSessionForceModel,
  isSessionForceModel,
  effectiveRoleModel,
} from "../dist/session/session-model.js";
import { saveSession, loadSession, newSessionId } from "../dist/session/store.js";

test("session-model: force flag toggles, starts off", () => {
  // Sanity: every other test depends on a clean baseline. We always reset at the end.
  try {
    assert.equal(isSessionForceModel(), false, "default is off — sessions don't quietly steamroll role.model");
    setSessionForceModel(true);
    assert.equal(isSessionForceModel(), true);
    setSessionForceModel(false);
    assert.equal(isSessionForceModel(), false);
  } finally {
    setSessionForceModel(false);
  }
});

test("session-model: effectiveRoleModel default — role.model wins iff it differs from session", () => {
  try {
    // No role-pin → no override needed, the base provider is reused.
    assert.equal(effectiveRoleModel(undefined, "glm-5"), undefined);
    // Role-pin equals session → no rebuild (cheap path).
    assert.equal(effectiveRoleModel("glm-5", "glm-5"), undefined);
    // Role-pin differs → the role's model is what runs (org-policy is respected by default).
    assert.equal(effectiveRoleModel("claude-4-opus", "glm-5"), "claude-4-opus");
  } finally {
    setSessionForceModel(false);
  }
});

test("session-model: --force collapses every role to the session model", () => {
  try {
    setSessionForceModel(true);
    // Returns undefined regardless of role.model: callers interpret undefined as "use baseProvider"
    // (which is built from cfg.model = the session model).
    assert.equal(effectiveRoleModel(undefined, "glm-5"), undefined);
    assert.equal(effectiveRoleModel("glm-5", "glm-5"), undefined);
    assert.equal(effectiveRoleModel("claude-4-opus", "glm-5"), undefined, "role-pin is ignored under --force");
    assert.equal(effectiveRoleModel("qwen3-max", "glm-5"), undefined, "even very different role-pins are ignored");
  } finally {
    setSessionForceModel(false);
  }
});

test("session-model: SessionMeta.model round-trips through save/load (the resume substrate)", () => {
  const id = newSessionId();
  const cwd = "/tmp/hara-session-model-" + id;
  try {
    const meta = {
      id,
      cwd,
      provider: "qwen",
      model: "claude-4-opus", // ← the per-session pinned model
      title: "pin test",
      createdAt: new Date().toISOString(),
      updatedAt: "",
    };
    const history = [{ role: "user", content: "x" }];
    saveSession(meta, history);
    const loaded = loadSession(id);
    assert.ok(loaded);
    assert.equal(loaded.meta.model, "claude-4-opus", "resume restores the pinned model — the whole point");
  } finally {
    rmSync(join(homedir(), ".hara", "sessions", `${id}.json`), { force: true });
  }
});

test("session-model: changing meta.model + re-save re-pins (simulates `/model X`)", () => {
  const id = newSessionId();
  const cwd = "/tmp/hara-session-model-" + id;
  try {
    const meta = {
      id,
      cwd,
      provider: "qwen",
      model: "glm-5",
      title: "",
      createdAt: new Date().toISOString(),
      updatedAt: "",
    };
    const history = [];
    saveSession(meta, history);
    // user types `/model claude-4-opus` → cfg.model + meta.model both flip, session is re-saved
    meta.model = "claude-4-opus";
    saveSession(meta, history);
    const loaded = loadSession(id);
    assert.equal(loaded.meta.model, "claude-4-opus", "`/model X` persists into the session file");
    // and a subsequent resume picks the new pin up (the index.ts resume block reads meta.model)
  } finally {
    rmSync(join(homedir(), ".hara", "sessions", `${id}.json`), { force: true });
  }
});
