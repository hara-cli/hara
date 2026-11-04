import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMINI_NATIVE_TOOLS, createJsonCliNativeObserver, normalizeJsonCliOutput, jsonCliArgs, jsonCliHelpCompatible, jsonCliRequiredFlags, writeJsonCliMcp } from "../dist/agent-runtime/json-cli-protocol.js";
import { WORKSPACE_MCP_TOKEN_ENV } from "../dist/agent-runtime/registered-cli-mcp.js";
const lines = (...values) => values.map(value => JSON.stringify(value)).join("\n");
test("Gemini normalizes assistant deltas, native tools and only a successful terminal result", () => {
  const parsed = normalizeJsonCliOutput("gemini", lines({ type: "init", session_id: "not-history" }, { type: "message", role: "user", content: "not answer" },
    { type: "tool_use", tool_name: "read_file", tool_id: "one", parameters: { api_key: "never retained" } }, { type: "tool_result", tool_id: "one", status: "success" }, { type: "message", role: "assistant", content: "Hello ", delta: true },
    { type: "message", role: "assistant", content: "world", delta: true }, { type: "result", status: "success", stats: { input_tokens: 100, output_tokens: 12 } }));
  assert.equal(parsed.turn.stop, "end"); assert.equal(parsed.turn.text, "Hello world"); assert.deepEqual(parsed.turn.toolUses, []);
  assert.deepEqual(parsed.turn.usage, { input: 100, output: 12 }); assert.ok(parsed.events.some(row => row.kind === "tool" && row.tool === "read_file"));
  assert.ok(!JSON.stringify(parsed).includes("never retained")); assert.ok(!JSON.stringify(parsed).includes("not-history"));
});
test("Gemini terminal errors and incomplete or malformed streams cannot manufacture success", () => {
  const error = normalizeJsonCliOutput("gemini", lines({ type: "message", role: "assistant", content: "partial private content" }, { type: "error", message: "401 authentication failed: fixture-private" }, { type: "result", status: "error" }));
  assert.equal(error.failure, "runtime_auth_rejected"); assert.equal(error.turn.text, ""); assert.ok(!JSON.stringify(error).includes("private"));
  for (const output of [lines({ type: "message", role: "assistant", content: "partial" }), "not json", lines({ type: "result", status: "success" }),
    lines({ type: "message", role: "assistant", content: "hello" }, { type: "result", status: "success" }, { type: "error", message: "network error" })]) {
    assert.equal(normalizeJsonCliOutput("gemini", output).turn.stop, "error");
  }
});
test("Kimi print messages preserve final assistant text and do not execute native tool observations", () => {
  const parsed = normalizeJsonCliOutput("kimi", lines({ role: "assistant", content: [], tool_calls: [{ id: "native-id", function: { name: "ReadFile", arguments: "private" } }] },
    { role: "tool", content: "not an answer", tool_call_id: "native-id" }, { role: "assistant", content: [{ type: "think", think: "not retained" }, { type: "text", text: "Done" }] }));
  assert.equal(parsed.turn.text, "Done"); assert.equal(parsed.turn.stop, "end"); assert.deepEqual(parsed.turn.toolUses, []); assert.equal(parsed.turn.usage, undefined);
  assert.ok(parsed.events.some(row => row.kind === "tool" && row.tool === "ReadFile")); assert.ok(!JSON.stringify(parsed).includes("not retained"));
  assert.equal(normalizeJsonCliOutput("kimi", lines({ role: "assistant", content: "working", tool_calls: [{ function: { name: "Shell" } }] })).turn.stop, "error");
  assert.equal(normalizeJsonCliOutput("kimi", lines({ role: "tool", content: "tool output" })).turn.stop, "error");
});
test("protocol bounds and incompatible CLI dialects fail closed", () => {
  for (const runtime of ["gemini", "kimi"]) {
    const help = jsonCliRequiredFlags(runtime).join(" \n"); assert.equal(jsonCliHelpCompatible(runtime, help), true);
    assert.equal(jsonCliHelpCompatible(runtime, help.replace("--yolo", "--yolo-unknown")), false);
    assert.equal(normalizeJsonCliOutput(runtime, "x".repeat(4 * 1024 * 1024 + 1)).turn.stop, "error");
  }
  assert.equal(jsonCliHelpCompatible("kimi", "--prompt --auto --model --output-format"), false, "new Kimi Code flags are not silently treated as the documented print dialect");
  const oversized = normalizeJsonCliOutput("kimi", lines({ role: "assistant", content: "x", tool_calls: Array.from({ length: 3000 }, () => ({ function: { name: "Shell" } })) }));
  assert.equal(oversized.turn.stop, "error"); assert.ok(oversized.events.length <= 2048);
});
test("process-only MCP settings and argv keep host config untouched and token out of argv", () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-json-cli-mcp-"))), token = "a".repeat(64);
  try {
    for (const runtime of ["gemini", "kimi"]) {
      const directory = join(root, runtime); fs.mkdirSync(directory, { mode: 0o700 });
      const config = writeJsonCliMcp(runtime, { url: "http://127.0.0.1:12345/mcp", env: { [WORKSPACE_MCP_TOKEN_ENV]: token } }, directory, 120000);
      const body = JSON.parse(fs.readFileSync(config.path, "utf8")); assert.deepEqual(Object.keys(body.mcpServers), ["hara"]);
      assert.equal(fs.statSync(config.path).mode & 0o077, 0);
      const args = jsonCliArgs({ runtime, prompt: "hello", cwd: root, model: "default", mcpPath: config.path });
      assert.ok(args.includes("--yolo")); assert.ok(!args.includes("--model")); assert.ok(!args.some(value => value.includes(token)));
      if (runtime === "gemini") { assert.equal(config.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, undefined); assert.equal(config.env.GEMINI_CLI_TRUST_WORKSPACE, "true"); assert.equal(body.mcpServers.hara.trust, true); assert.deepEqual(body.mcp.allowed, ["hara"]); assert.equal(body.mcp.serverCommand, "");
        assert.equal(body.hooksConfig.enabled, false); assert.equal(body.skills.enabled, false); assert.equal(body.tools.sandbox, false);
        assert.deepEqual(body.tools.core, [...GEMINI_NATIVE_TOOLS]); assert.equal(body.tools.discoveryCommand, ""); assert.equal(body.tools.callCommand, "");
        assert.ok(body.tools.core.includes("run_shell_command")); assert.ok(!body.tools.core.some(tool => /background|cron|schedule|agent/i.test(tool))); }
      else assert.ok(args.includes("--mcp-config-file"));
    }
    const controlled = jsonCliArgs({ runtime: "gemini", prompt: "hello", cwd: root, model: "flash", mcpPath: "unused", tier: "controlled" });
    assert.ok(!controlled.includes("--yolo")); assert.ok(controlled.includes("plan"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("native observations use the public started/completed contract without retaining raw payloads", () => {
  const events = [], observer = createJsonCliNativeObserver("gemini", event => events.push(event));
  const output = lines({ type: "tool_use", tool_name: "write_file", tool_id: "one", parameters: { file_path: "note.txt", content: "do not retain" } },
    { type: "tool_result", tool_id: "one", status: "success", output: "do not retain" });
  observer.onStdout(output.slice(0, 17)); observer.onStdout(output.slice(17)); observer.finish(); observer.onStdout(output);
  assert.deepEqual(events, [{ type: "file", status: "started", operation: "write_file", id: "one", path: "note.txt" }, { type: "tool", status: "completed", id: "one" }]);
  assert.ok(!JSON.stringify(events).includes("do not retain"));
  const kimi = [], k = createJsonCliNativeObserver("kimi", event => kimi.push(event));
  k.onStdout(lines({ role: "assistant", tool_calls: [{ id: "two", function: { name: "Shell", arguments: JSON.stringify({ command: "git push", private: "discard" }) } }] },
    { role: "tool", tool_call_id: "two", is_error: true }) + "\n"); k.finish();
  assert.deepEqual(kimi, [{ type: "command", status: "started", operation: "Shell", id: "two", command: "git push" }, { type: "tool", status: "failed", id: "two" }]);
});

test("unreturned and duplicate native calls never record terminal success", () => {
  const gemini = lines({ type: "tool_use", tool_name: "read_file", tool_id: "unfinished" }, { type: "message", role: "assistant", content: "claimed done" }, { type: "result", status: "success" });
  assert.equal(normalizeJsonCliOutput("gemini", gemini).turn.stop, "error");
  const kimi = lines({ role: "assistant", tool_calls: [{ id: "unfinished", function: { name: "ReadFile" } }] }, { role: "assistant", content: "claimed done" });
  assert.equal(normalizeJsonCliOutput("kimi", kimi).turn.stop, "error");
  const duplicate = lines({ type: "tool_use", tool_id: "one", tool_name: "read_file" }, { type: "tool_use", tool_id: "one", tool_name: "read_file" });
  assert.equal(normalizeJsonCliOutput("gemini", duplicate).failure, "version_incompatible");
});

test("JSON native error lines require Host opt-in and retain no raw data or later lines", () => {
  const env = { NATIVE_TOKEN: "opaque-fixture-credential-12345" };
  for (const runtime of ["gemini", "kimi"]) {
    const frame = { ...(runtime === "gemini" ? { type: "error" } : {}), error: { message: "Bad configuration token=" + env.NATIVE_TOKEN + " /Users/private/settings.json https://private.example/ account=private@example.com\nPRIVATE_SECOND_LINE", data: { debug: "PRIVATE_ERROR_DATA" } } };
    const output = lines(frame, ...(runtime === "gemini" ? [{ type: "result", status: "error" }] : []));
    assert.equal(normalizeJsonCliOutput(runtime, output).errorFirstLine, undefined);
    const parsed = normalizeJsonCliOutput(runtime, output, env); assert.match(parsed.errorFirstLine, /^Bad configuration/); assert.ok([...parsed.errorFirstLine].length <= 320);
    assert.doesNotMatch(JSON.stringify(parsed), /opaque-fixture|Users|private\.example|private@example|PRIVATE_SECOND_LINE|PRIVATE_ERROR_DATA/);
  }
});
