import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolatedHome = mkdtempSync(join(tmpdir(), "hara-external-agent-home-"));
process.env.HOME = isolatedHome; // before config/private-state modules are evaluated
const { appendBoundedExternalOutput, buildExternalArgv } = await import("../dist/tools/external_agent.js");
const { runAgent } = await import("../dist/agent/loop.js");
const { getTool } = await import("../dist/tools/registry.js");
after(() => rmSync(isolatedHome, { recursive: true, force: true }));

function providerWithToolUses(toolUses) {
  let calls = 0;
  return {
    id: "fake",
    model: "fake-model",
    async turn() {
      if (calls++ === 0) return { text: "", toolUses, stop: "tool_use" };
      return { text: "done", toolUses: [], stop: "end" };
    },
  };
}

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

test("external-agent capture preserves head/tail while remaining strictly bounded", () => {
  let captured = "";
  for (let i = 0; i < 100; i++) captured = appendBoundedExternalOutput(captured, `${i}:` + "x".repeat(200), 1024);
  assert.ok(captured.length <= 1024);
  assert.match(captured, /^0:/, "diagnostic head is retained");
  assert.match(captured, /99:/, "latest output tail is retained");
  assert.match(captured, /external output truncated/);
});

test("external_agent output stop still force-kills a quiet SIGTERM-resistant grandchild", async () => {
  if (process.platform === "win32") return; // taskkill /T has separate platform coverage
  const bin = mkdtempSync(join(tmpdir(), "hara-external-agent-bin-"));
  const pidFile = join(bin, "grandchild.pid");
  const fake = join(bin, "claude");
  const previousPath = process.env.PATH;
  const previousPidFile = process.env.HARA_EXTERNAL_TEST_PID_FILE;
  const previousTrust = process.env.HARA_EXTERNAL_AGENT_TRUST;
  let grandchildPid;
  try {
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
if (process.argv[2] === "--version") { console.log("fake-claude 1"); process.exit(0); }
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.HARA_EXTERNAL_TEST_PID_FILE, String(child.pid));
process.stdout.write("x".repeat(4 * 1024 * 1024 + 1024));
setInterval(() => {}, 1000);
`);
    chmodSync(fake, 0o755);
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.HARA_EXTERNAL_TEST_PID_FILE = pidFile;
    process.env.HARA_EXTERNAL_AGENT_TRUST = "gated";
    const result = await getTool("external_agent").run(
      { task: "exercise output cap", backend: "claude" },
      { cwd: bin, sandbox: "off", ask: async () => true },
    );
    assert.match(result, /exceeding .*output bytes/i);
    grandchildPid = Number(readFileSync(pidFile, "utf8"));
    const deadline = Date.now() + 2_000;
    for (;;) {
      try {
        process.kill(grandchildPid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") break;
        throw error;
      }
      if (Date.now() >= deadline) assert.fail(`grandchild ${grandchildPid} survived forced process-group kill`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    if (grandchildPid) try { process.kill(grandchildPid, "SIGKILL"); } catch {}
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPidFile === undefined) delete process.env.HARA_EXTERNAL_TEST_PID_FILE;
    else process.env.HARA_EXTERNAL_TEST_PID_FILE = previousPidFile;
    if (previousTrust === undefined) delete process.env.HARA_EXTERNAL_AGENT_TRUST;
    else process.env.HARA_EXTERNAL_AGENT_TRUST = previousTrust;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("external_agent is marked outside the file boundary and defaults closed without an interactive channel", async () => {
  const tool = getTool("external_agent");
  assert.ok(tool);
  assert.equal(tool.trustBoundary, "external");
  const previousAllow = process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
  delete process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
  try {
    const result = await tool.run({ task: "do not start a backend" }, { cwd: process.cwd() });
    assert.match(result, /Blocked: external_agent.*outside Hara's protected-file boundary/i);
  } finally {
    if (previousAllow === undefined) delete process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
    else process.env.HARA_ALLOW_TRUSTED_EXTENSIONS = previousAllow;
  }
});

test("external trust boundary still confirms every action in full-auto and ignores session auto-approval", async () => {
  let runs = 0;
  let confirms = 0;
  const external = {
    name: "fake_external",
    description: "opaque host extension",
    input_schema: { type: "object", properties: {} },
    kind: "exec",
    trustBoundary: "external",
    async run() {
      runs++;
      return `ran-${runs}`;
    },
  };
  const history = [{ role: "user", content: "run reviewed extension twice" }];
  await runAgent(history, {
    provider: providerWithToolUses([
      { id: "e1", name: "fake_external", input: {} },
      { id: "e2", name: "fake_external", input: {} },
    ]),
    ctx: { cwd: process.cwd(), ask: async () => "yes" },
    approval: "full-auto",
    confirm: async () => {
      confirms++;
      return "always";
    },
    autoApprove: new Set(["fake_external"]),
    extraTools: [external],
    quiet: true,
    hooks: false,
  });
  assert.equal(confirms, 2, "each opaque call needs fresh human confirmation even in full-auto");
  assert.equal(runs, 2);
});

test("agent loop blocks an external tool headlessly before confirmation or execution", async () => {
  const previousAllow = process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
  delete process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
  let ran = false;
  let confirms = 0;
  const external = {
    name: "headless_external",
    description: "opaque host extension",
    input_schema: { type: "object", properties: {} },
    kind: "exec",
    trustBoundary: "external",
    async run() {
      ran = true;
      return "should not run";
    },
  };
  const history = [{ role: "user", content: "headless" }];
  try {
    await runAgent(history, {
      provider: providerWithToolUses([{ id: "e1", name: "headless_external", input: {} }]),
      ctx: { cwd: process.cwd() },
      approval: "full-auto",
      confirm: async () => {
        confirms++;
        return true;
      },
      extraTools: [external],
      quiet: true,
      hooks: false,
    });
    assert.equal(ran, false);
    assert.equal(confirms, 0);
    assert.match(JSON.stringify(history), /Trusted extension blocked in this non-interactive run/);
  } finally {
    if (previousAllow === undefined) delete process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
    else process.env.HARA_ALLOW_TRUSTED_EXTENSIONS = previousAllow;
  }
});

test("agent tool previews redact command credentials before reaching confirmation or UI sinks", async () => {
  const token = "sk-hara-preview-12345678901234567890";
  const seen = [];
  const prompts = [];
  const fake = {
    name: "preview_probe",
    description: "capture preview",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    kind: "exec",
    async run() { return "ok"; },
  };
  const history = [{ role: "user", content: "run it" }];
  await runAgent(history, {
    provider: providerWithToolUses([{ id: "p1", name: "preview_probe", input: { command: `deploy --token ${token}` } }]),
    ctx: {
      cwd: process.cwd(),
      ui: {
        text() {}, reasoning() {}, diff() {}, notice() {},
        tool(name, preview) { seen.push(`${name} ${preview}`); },
      },
    },
    approval: "suggest",
    confirm: async (prompt) => { prompts.push(prompt); return true; },
    extraTools: [fake],
    hooks: false,
  });
  assert.equal(seen.length, 1);
  assert.equal(prompts.length, 1);
  assert.ok(!seen[0].includes(token));
  assert.ok(!prompts[0].includes(token));
  assert.match(seen[0], /--token \*\*\*/);
  assert.match(prompts[0], /--token \*\*\*/);
});

test("guardian prompt and block notices redact high-risk command credentials", async () => {
  const token = "sk-hara-guardian-12345678901234567890";
  let guardianInput = "";
  const notices = [];
  const fake = {
    name: "guardian_probe",
    description: "high-risk preview probe",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    kind: "exec",
    async run() { return "must not run"; },
  };
  const guardian = {
    id: "guardian",
    model: "guardian",
    async turn(args) {
      guardianInput = JSON.stringify(args.history);
      return { text: '{"decision":"block","reason":""}', toolUses: [], stop: "end" };
    },
  };
  await runAgent([{ role: "user", content: "probe" }], {
    provider: providerWithToolUses([{ id: "g1", name: "guardian_probe", input: { command: `sudo deploy --token ${token}` } }]),
    ctx: {
      cwd: process.cwd(),
      ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice(line) { notices.push(line); } },
    },
    approval: "full-auto",
    confirm: async () => true,
    extraTools: [fake],
    guardian: { provider: guardian },
    hooks: false,
  });
  assert.ok(!guardianInput.includes(token));
  assert.ok(!notices.join("\n").includes(token));
  assert.match(guardianInput, /\*\*\*/);
  assert.match(notices.join("\n"), /\*\*\*/);
});
