import { governedToolResult, compactRosterIds } from "./helpers/governed-tool-result.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { claudeCliMcpFixture as cliMcpFixture, until } from "./helpers/claude-cli-mcp.mjs";
import { DEFAULT_TIER, FULL_TIER_SKIP, SEATBELT } from "./helpers/platform-tier.mjs";

const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
async function closed(url) { await until(async () => { try { await fetch(url); return false; } catch { return true; } }, Boolean); }

test("main Hara Claude uses host home, alias, effort and scoped MCP through session.send", async t => {
  const f = await cliMcpFixture(t, "list", "claude");
  await f.send("List the colleagues in this Workspace.");
  const view = await until(f.read, done), meta = f.meta();
  assert.equal(view.conversation.state, "completed");
  assert.equal(meta.home, join(f.root, "account")); assert.equal(meta.userProfile, meta.home);
  assert.equal(meta.privateClaudeConfig, null);
  assert.equal(meta.model, "sonnet"); assert.equal(meta.effort, "high");
  assert((SEATBELT ? meta.full && !meta.plan : meta.plan && !meta.full) && meta.strict && meta.haraOnly);
  assert.equal(meta.tokenInArgv, false); assert.equal(meta.tokenPresent, true);
  assert(meta.tools.includes("agent_create") && meta.tools.includes("agent_list"));
  assert.equal(meta.tools.includes("bash"), false);
  const listed = governedToolResult(meta.listed.text);
  assert.deepEqual(compactRosterIds(listed), [f.main.agentId]);
  const calls = view.conversation.history.flatMap(row => row.role === "tool" ? row.results : []);
  assert(calls.some(row => row.name === "agent_list" && row.id === listed.receipt.toolCallId && !row.isError));
  assert(view.conversation.usage.modelCalls > 0 && view.conversation.usage.toolCalls > 0);
  await closed(meta.url);
});
test("Claude one-shot attempts receive the current Hara system context anew on every turn", async t => {
  const f = await cliMcpFixture(t, "list", "claude");
  await f.send("List the colleagues in this Workspace."); await until(f.read, done);
  const first = f.meta(); assert.equal(first.freshSystemPrompt, true);
  await f.send("List the colleagues in this Workspace again."); await until(f.read, done);
  const second = f.meta(); assert.equal(second.freshSystemPrompt, true); assert.notEqual(second.pid, first.pid);
});

test("Claude final output cannot leak the per-attempt bearer", async t => {
  const f = await cliMcpFixture(t, "leak", "claude");
  await f.send("Hello.");
  const view = await until(f.read, done);
  assert.equal(view.conversation.state, "blocked");
  assert.equal(view.conversation.taskState, "paused");
  assert(view.conversation.history.filter(row => row.role === "assistant").at(-1).text === "***", "Per-attempt bearer must be redacted");
  assert.equal(f.meta().tokenInArgv, false);
  await closed(f.meta().url);
});

test("Claude failure closes its endpoint without inventing a successful reply", async t => {
  const f = await cliMcpFixture(t, "crash", "claude");
  await f.send("Hello.");
  const view = await until(f.read, done);
  assert.equal(view.conversation.state, "blocked");
  assert.equal(view.agents.length, 1);
  assert(!view.conversation.history.some(row => row.role === "assistant" && row.text === "Scoped CLI reply"));
  await closed(f.meta().url);
});
