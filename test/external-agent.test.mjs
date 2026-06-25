import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExternalArgv } from "../dist/tools/external_agent.js";

test("buildExternalArgv: claude permission-mode maps from sandbox/trust", () => {
  const plan = buildExternalArgv("claude", "do x", { cwd: "/w", sandbox: "read-only", trust: "gated" });
  assert.deepEqual(plan, { cmd: "claude", args: ["-p", "do x", "--output-format", "text", "--permission-mode", "plan"] });

  const edits = buildExternalArgv("claude", "do x", { cwd: "/w", sandbox: "workspace-write", trust: "gated" });
  assert.equal(edits.args.at(-1), "acceptEdits");

  const full = buildExternalArgv("claude", "do x", { cwd: "/w", sandbox: "read-only", trust: "full" });
  assert.equal(full.args.at(-1), "bypassPermissions"); // dangerous mode only at trust=full

  const withModel = buildExternalArgv("claude", "t", { cwd: "/w", sandbox: "off", trust: "gated", model: "claude-opus-4-8" });
  assert.ok(withModel.args.includes("--model") && withModel.args.includes("claude-opus-4-8"));
});

test("buildExternalArgv: codex --sandbox maps from sandbox/trust, --cd = cwd", () => {
  const ro = buildExternalArgv("codex", "do y", { cwd: "/proj", sandbox: "off", trust: "gated" });
  assert.deepEqual(ro, { cmd: "codex", args: ["exec", "do y", "--cd", "/proj", "--sandbox", "read-only"] });

  const ws = buildExternalArgv("codex", "do y", { cwd: "/proj", sandbox: "workspace-write", trust: "gated" });
  assert.equal(ws.args.at(-1), "workspace-write");

  const danger = buildExternalArgv("codex", "do y", { cwd: "/proj", sandbox: "workspace-write", trust: "full" });
  assert.equal(danger.args.at(-1), "danger-full-access"); // only at trust=full
});

test("buildExternalArgv: unknown backend → null", () => {
  assert.equal(buildExternalArgv("gemini", "x", { cwd: "/w", sandbox: "off", trust: "gated" }), null);
});
