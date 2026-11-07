import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandedCliArgs, grokPermissionResult, grokUpdate, isForbiddenNativeTool, parseExpandedRun } from "../dist/agent-runtime/expanded-protocol.js";
import { copilotHelpEfforts, parseCursorModels } from "../dist/agent-runtime/expanded-models.js";
import { writeCopilotMcpConfig, overlayCursorMcpConfig } from "../dist/agent-runtime/expanded-mcp-config.js";
import { unavailableExpandedProtection } from "../dist/agent-runtime/expanded-protection.js";
import { AGENT_RUNTIME_IDS } from "../dist/agent-runtime/bindings.js";
import { detectInstalledRuntimes } from "../dist/workspace/runtime-detect.js";
import { runtimeFailureMessage } from "../dist/agent-runtime/failure-diagnostics.js";
import { createRuntimeStageProcessObserver } from "../dist/agent-runtime/stage-observer.js";
import { SEATBELT } from "./helpers/platform-tier.mjs";

const ids = ["copilot", "cursor", "grok"], endpoint = { url: "http://127.0.0.1:1/mcp", env: { HARA_WORKSPACE_MCP_TOKEN: "a".repeat(64) } };
const result = frames => ({ ok: true, stdout: frames.map(value => JSON.stringify(value)).join("\n"), code: 0, timedOut: false });
function root(t) { const dir = mkdtempSync(join(tmpdir(), "hara-runtime-b-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
for (const id of ids) test(id + " has an explicit ID and full parameters require a protected launch", async () => {
  assert.ok(AGENT_RUNTIME_IDS.includes(id));
  const controlled = expandedCliArgs({ id, prompt: "fixture", model: null, effort: null, fullProtected: false });
  for (const flag of ["--allow-all-tools", "--allow-all-paths", "--force", "--always-approve"]) assert.equal(controlled.includes(flag), false);
  await assert.rejects(unavailableExpandedProtection(), /permission/);
  const args = expandedCliArgs({ id, prompt: "fixture", model: null, effort: null, fullProtected: true, mcpConfigPath: "/fixture/mcp.json" });
  for (const forbidden of ["login", "--reauth", "--resume", "--continue"]) assert.equal(args.includes(forbidden), false);
  if (id === "copilot") { assert.ok(args.includes("--allow-all-tools")); assert.ok(args.includes("--allow-all-paths")); assert.ok(args.includes("--additional-mcp-config=@/fixture/mcp.json")); }
  if (id === "cursor") { assert.ok(args.includes("--force")); assert.ok(args.includes("--approve-mcps")); for (const launch of [args, controlled]) {
    // Decision B: Cursor's own sandbox is disabled only inside Seatbelt; without it the flag is omitted (Cursor default).
    if (SEATBELT) assert.equal(launch[launch.indexOf("--sandbox") + 1], "disabled"); else assert.equal(launch.includes("--sandbox"), false);
  }
  for (const fullProtected of [true, false]) {
    const inside = expandedCliArgs({ id, prompt: "fixture", model: null, effort: null, fullProtected, osWriteSandbox: true });
    const outside = expandedCliArgs({ id, prompt: "fixture", model: null, effort: null, fullProtected, osWriteSandbox: false });
    assert.equal(inside[inside.indexOf("--sandbox") + 1], "disabled"); assert.equal(outside.includes("--sandbox"), false); assert.equal(outside.includes("disabled"), false);
  } }
  if (id === "grok") { assert.deepEqual(args, ["agent", "--no-leader", "--always-approve", "stdio"]); }
});
test("Copilot normalizes text and tool effects without retaining tool inputs", () => {
  const parsed = parseExpandedRun("copilot", result([
    { type: "assistant.turn_start" }, { type: "assistant.message_delta", data: { deltaContent: "hello" } },
    { type: "tool.execution_start", data: { toolName: "write_file", arguments: { secret: "PRIVATE_TOOL_ARGUMENT" } } },
    { type: "tool.execution_complete", data: { toolName: "write_file", success: true } },
    { type: "assistant.message", data: { content: "hello world" } }, { type: "session.idle" },
  ]));
  assert.equal(parsed.text, "hello world"); assert.equal(parsed.completed, true);
  assert.equal(parsed.tools[0].effect, "write"); assert.equal(JSON.stringify(parsed).includes("PRIVATE_TOOL_ARGUMENT"), false);
});
test("Cursor final result is canonical; duplicate assistant messages are not double-counted", () => {
  const parsed = parseExpandedRun("cursor", result([
    { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } },
    { type: "tool_call", subtype: "completed", tool_call: { writeToolCall: { args: { fileText: "PRIVATE" } } } },
    { type: "result", subtype: "success", is_error: false, result: "final" },
  ]));
  assert.equal(parsed.text, "final"); assert.equal(parsed.tools[0].effect, "write");
  assert.equal(JSON.stringify(parsed).includes("PRIVATE"), false);
});
test("exit zero, malformed JSON, missing terminal frames and typed provider errors cannot pass", () => {
  for (const id of ["copilot", "cursor"]) {
    for (const candidate of [
      { ok: true, stdout: "not json", code: 0, timedOut: false },
      result([{ type: "assistant.message", data: { content: "unverified" } }]),
      result([{ type: "assistant.turn_end" }]),
      result([{ type: "session.error", data: { message: "401 PRIVATE_ACCOUNT" } }, { type: "session.idle" }]),
    ]) { const parsed = parseExpandedRun(id, candidate); assert.equal(parsed.completed, false); assert.equal(parsed.text, ""); }
  }
});
test("model inventory rejects duplicate IDs and malformed entries, and effort comes from exact help", () => {
  assert.deepEqual(parseCursorModels("Available models:\nfixture-model - Fixture Model\nauto - Auto\n").map(row => row.id), ["fixture-model", "auto"]);
  assert.throws(() => parseCursorModels("fixture - First\nfixture - Duplicate"), /duplicate/);
  assert.throws(() => parseCursorModels("../invalid - unsafe"), /invalid/);
  assert.deepEqual(copilotHelpEfforts("--effort <level> (low, medium, high, xhigh, max)"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(copilotHelpEfforts("No effort flag. high performance"), []);
  for (const id of ["cursor", "grok"]) assert.throws(() => expandedCliArgs({ id, prompt: "fixture", model: null, effort: "high", fullProtected: true }), /invalid_model/);
});
test("Grok ACP accepts only the current session and strips native tool arguments", () => {
  assert.deepEqual(grokUpdate({ sessionId: "one", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply" } } }, "one"), { text: "reply" });
  assert.throws(() => grokUpdate({ sessionId: "other", update: { sessionUpdate: "agent_message_chunk" } }, "one"));
  const observed = grokUpdate({ sessionId: "one", update: { sessionUpdate: "tool_call", title: "write_file", kind: "edit", status: "completed", rawInput: { secret: "PRIVATE" } } }, "one");
  assert.deepEqual(observed.tool, { name: "write_file", state: "completed", effect: "write" });
});
test("Grok approval is allow-once only, bound to an active protected turn; all other contexts cancel", () => {
  const params = { sessionId: "one", toolCall: { title: "read_file" }, options: [{ kind: "allow_always", optionId: "forever" }, { kind: "allow_once", optionId: "once" }] };
  const input = { sessionId: "one", active: true, fullProtected: true, aborted: false };
  assert.deepEqual(grokPermissionResult(params, input), { outcome: { outcome: "selected", optionId: "once" } });
  for (const patch of [{ sessionId: "other" }, { active: false }, { fullProtected: false }, { aborted: true }, { sessionId: null }])
    assert.deepEqual(grokPermissionResult(params, { ...input, ...patch }), { outcome: { outcome: "cancelled" } });
  assert.deepEqual(grokPermissionResult({ ...params, options: [{ kind: "allow_always", optionId: "forever" }] }, input), { outcome: { outcome: "cancelled" } });
});
test("Copilot uses a private, task-owned config file and removes it on close", t => {
  const dir = root(t), config = writeCopilotMcpConfig(dir, endpoint);
  const value = JSON.parse(readFileSync(config.path, "utf8"));
  assert.equal(value.mcpServers.hara.url, endpoint.url); assert.deepEqual(value.mcpServers.hara.tools, ["*"]);
  assert.equal(statSync(config.path).mode & 0o777, 0o600);
  config.close(); assert.equal(existsSync(config.path), false); config.close();
});
test("Cursor project overlay restores original bytes and mode, preserving personal MCPs during the attempt", t => {
  const dir = root(t); mkdirSync(join(dir, ".cursor"), { mode: 0o700 });
  const file = join(dir, ".cursor/mcp.json"), original = '{ "mcpServers": { "kept": { "url": "http://127.0.0.1:2/mcp" } }, "other": true }\n';
  writeFileSync(file, original); chmodSync(file, 0o640);
  const config = overlayCursorMcpConfig(dir, endpoint), value = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(value.other, true); assert.deepEqual(Object.keys(value.mcpServers).sort(), ["hara", "kept"]); assert.equal(value.mcpServers.kept.url, "http://127.0.0.1:2/mcp");
  assert.equal(value.mcpServers.hara.url, endpoint.url);
  assert.throws(() => overlayCursorMcpConfig(dir, endpoint), /EEXIST/);
  config.close(); config.close(); assert.equal(readFileSync(file, "utf8"), original); assert.equal(statSync(file).mode & 0o777, 0o640);
});
test("Cursor new overlay cleans up, but symlinks and concurrent edits are never overwritten", t => {
  const dir = root(t), first = overlayCursorMcpConfig(dir, endpoint); first.close(); assert.equal(existsSync(join(dir, ".cursor")), false);
  mkdirSync(join(dir, ".cursor"), { mode: 0o700 }); const outside = join(dir, "keep.json"); writeFileSync(outside, "{}");
  symlinkSync(outside, join(dir, ".cursor/mcp.json")); assert.throws(() => overlayCursorMcpConfig(dir, endpoint), /permission/);
  rmSync(join(dir, ".cursor/mcp.json")); const next = overlayCursorMcpConfig(dir, endpoint); writeFileSync(next.path, '{"changed":true}');
  assert.throws(() => next.close(), /permission/); assert.equal(readFileSync(next.path, "utf8"), '{"changed":true}');
});
test("discovery never runs a missing CLI, and the generic agent alias must identify Cursor", async t => {
  const dir = root(t), calls = [], run = async (command, args) => { calls.push([command, args]); return args[0] === "-lic" ? null : "Unrelated Agent 1.2.3"; };
  const options = { home: dir, probeHome: dir, path: "/usr/bin:/bin", systemBins: [], run };
  assert.deepEqual(await detectInstalledRuntimes(options), []);
  assert.equal(calls.some(([, args]) => args[0] === "--version"), false);
  mkdirSync(join(dir, ".local/bin"), { recursive: true }); writeFileSync(join(dir, ".local/bin/agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal((await detectInstalledRuntimes(options)).some(row => row.runtimeId === "cursor"), false);
});
for (const id of ids) test(id + " diagnostic and first-output stage use closed metadata", () => {
  const diagnostic = runtimeFailureMessage({ runtime: id, version: "1.2.3", loginSource: "host", homeMatchesAccount: true, kind: "runtime_network", elapsedMs: 4 });
  assert.equal(JSON.parse(diagnostic.split("=")[1]).runtime, id);
  assert.equal(JSON.parse(diagnostic.split("=")[1]).extensionsIsolation, "inherited");
  const marks = [], recorder = { beginEvent() { return () => {}; }, mark(kind, source) { marks.push([kind, source]); } };
  const observer = createRuntimeStageProcessObserver(recorder, id, new AbortController().signal); observer.onSpawn();
  const frame = id === "copilot" ? { type: "assistant.message", data: { content: "fixture" } } : id === "cursor"
    ? { type: "assistant", message: { content: [{ type: "text", text: "fixture" }] } } : { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture" } } } };
  observer.onStdout(JSON.stringify(frame) + "\n"); observer.finish(true); assert.ok(marks.some(([kind]) => kind === "first_output"));
});

test("native scheduling/wakeup/background tools are refused, while Hara Scheduler stays governed", () => {
  for (const name of ["CronCreate", "cron_list", "ScheduleWakeup", "schedule_job", "background_task", "spawn_agent", "task"]) {
    assert.equal(isForbiddenNativeTool(name), true);
    assert.throws(() => grokUpdate({ sessionId: "one", update: { sessionUpdate: "tool_call", title: name, status: "pending" } }, "one"), /permission/);
    assert.deepEqual(grokPermissionResult({ sessionId: "one", toolCall: { title: name }, options: [{ kind: "allow_once", optionId: "once" }] },
      { sessionId: "one", active: true, fullProtected: true, aborted: false }), { outcome: { outcome: "cancelled" } });
  }
  for (const name of ["read_file", "todo_write", "hara__schedule_create", "mcp__hara__schedule_create"]) assert.equal(isForbiddenNativeTool(name), false);
});
test("Jeff A admits personal extensions only for the three expanded runtimes", async () => {
  const { assertExpandedRuntimeIsolation, expandedRuntimeIsolationReady, expandedExtensionsIsolation } = await import("../dist/agent-runtime/expanded-isolation.js");
  const { sharedExpandedRuntimeProtection } = await import("../dist/agent-runtime/expanded-policy-adapter.js");
  for (const id of ids) {
    assert.equal(expandedRuntimeIsolationReady(id), true);
    assert.equal(expandedExtensionsIsolation(id), "inherited");
    assert.doesNotThrow(() => assertExpandedRuntimeIsolation(id));
    assert.doesNotThrow(() => sharedExpandedRuntimeProtection.assertLaunchSupported(id));
  }
  for (const id of ["claude", "codex", "opencode", "gemini", "pi"]) assert.equal(expandedExtensionsIsolation(id), undefined);
  assert.throws(() => assertExpandedRuntimeIsolation("unregistered"), /permission/);
});
test("normal runtime stage metadata records inherited without changing isolated runtime records", async () => {
  const { projectRuntimeStageRuntime } = await import("../dist/workspace/runtime-stage-events.js");
  const base = { version: "1.2.3", loginSource: "host", model: "fixture", effort: null };
  for (const id of ids) assert.equal(projectRuntimeStageRuntime({ ...base, id }).extensionsIsolation, "inherited");
  for (const id of ["claude", "codex", "opencode", "pi"]) assert.equal(Object.hasOwn(projectRuntimeStageRuntime({ ...base, id }), "extensionsIsolation"), false);
});
test("metadata accepts inherited fixture configuration while retaining real outer Seatbelt", { skip: process.platform !== "darwin" }, async t => {
  const { captureExpandedMetadata } = await import("../dist/agent-runtime/expanded-metadata.js");
  for (const id of ["copilot", "cursor"]) {
    const dir = root(t), home = join(dir, "account"), protectedRoot = join(dir, "hara-state"), command = join(dir, "fake-cli");
    for (const path of [join(home, "." + id), join(home, ".hara"), join(home, ".codex"), protectedRoot]) mkdirSync(path, { recursive: true });
    const config = id === "cursor" ? ".cursor/mcp.json" : ".copilot/mcp-config.json";
    writeFileSync(join(home, config), "SYNTHETIC_PERSONAL_EXTENSION");
    writeFileSync(join(home, ".codex/auth.json"), "SYNTHETIC_OTHER_LOGIN");
    writeFileSync(join(protectedRoot, "state.json"), "SYNTHETIC_HARA");
    const code = `const fs=require('fs'),home=process.env.HOME;let haraDenied=false,foreignDenied=false;try{fs.writeFileSync(${JSON.stringify(join(protectedRoot, "state.json"))},'x')}catch{haraDenied=true}try{fs.readFileSync(home+'/.codex/auth.json')}catch{foreignDenied=true}console.log(JSON.stringify({marker:fs.readFileSync(home+'/'+${JSON.stringify(config)},'utf8'),home,haraDenied,foreignDenied,args:process.argv.slice(2)}));`;
    writeFileSync(command, "#!" + process.execPath + "\n" + code, { mode: 0o755 });
    const result = await captureExpandedMetadata({ runtimeId: id, command, env: { ...process.env, HOME: home }, accountHome: home, runtimeHome: join(home, "." + id), protectedStateRoots: [protectedRoot] });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.stdout), { marker: "SYNTHETIC_PERSONAL_EXTENSION", home, haraDenied: true, foreignDenied: true, args: id === "cursor" ? ["models"] : ["--help"] });
  }
});

test("typed native errors expose only a redacted message first line and never the error object", () => {
  const env = { FIXTURE_API_KEY: "fixture-secret-value" };
  for (const id of ["copilot", "cursor"]) {
    const result = parseExpandedRun(id, { ok: true, code: 0, timedOut: false, stdout: JSON.stringify({ type: "error",
      error: { message: "Error: startup /Users/private/settings.json key=fixture-secret-value account=owner@example.invalid\nPRIVATE_SECOND_LINE", data: { secret: "PRIVATE_ERROR_DATA" } } }) }, env);
    assert.equal(result.completed, false); assert.match(result.errorFirstLine, /Error: startup \[path\]/);
    assert.doesNotMatch(result.errorFirstLine, /fixture-secret-value|owner@|Users\/private|PRIVATE_SECOND_LINE|PRIVATE_ERROR_DATA/);
    const noMessage = parseExpandedRun(id, { ok: true, code: 0, timedOut: false, stdout: JSON.stringify({ type: "error", error: { data: { secret: "PRIVATE_ERROR_DATA" } } }) }, env);
    assert.equal(noMessage.errorFirstLine, undefined);
  }
});
