// Project-analysis SOP (Task: "analyzing a git repo is much slower than codex").
// The execution layer always could parallelize reads and fan out read-only sub-agents — what was
// missing was TEACHING the model. These pin the three teaching surfaces:
//   1. the system prompt's batch/explore playbook (codex: "parallelize tool calls whenever possible",
//      manifest-first sweep; CC: ">~3 searches → dedicated Explore agent"),
//   2. the agent tool's when-to-use / when-NOT guidance (CC's AgentTool prompt pattern),
//   3. the built-in "explore" persona (CC's Explore agent: parallel, excerpts, conclusions-not-dumps).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../dist/agent/loop.js";
import { getTool } from "../dist/tools/registry.js";
import { EXPLORE_SYSTEM } from "../dist/tools/agent.js";

const TEST_HOME = mkdtempSync(join(tmpdir(), "hara-analysis-sop-home-"));
process.env.HOME = TEST_HOME;
after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

test("system prompt teaches the analysis SOP: batch reads, manifest-first, fan out past ~3 searches", async () => {
  let system = "";
  const provider = {
    id: "f",
    model: "f",
    async turn(args) {
      system = args.system;
      return { text: "ok", toolUses: [], stop: "end" };
    },
  };
  await runAgent([{ role: "user", content: "hi" }], { provider, ctx: { cwd: process.cwd() }, approval: "full-auto", confirm: async () => true, quiet: true });
  assert.ok(/Batch INDEPENDENT tool calls/.test(system), "parallel-batching rule present");
  assert.ok(/run in PARALLEL when requested together/.test(system), "tells the model reads execute concurrently");
  assert.ok(/package\.json \/ Cargo\.toml \/\s+pyproject\.toml \/ go\.mod/.test(system), "manifest-first sweep for project analysis");
  assert.ok(/more than ~3 searches/.test(system), "CC's fan-out heuristic present");
  assert.ok(/role "explore"/.test(system), "points at the built-in explore persona");
  assert.match(system, /tools\/, scripts\/, bin\/, and lib\/[\s\S]*existing SDK\/client\/helper/);
  assert.match(system, /Bash or[\s\S]*PowerShell with non-ASCII[\s\S]*ASCII-named \.ps1 with -File/);
});

test("system prompt edits existing documents in place without durable helper scripts", async () => {
  let system = "";
  const provider = {
    id: "f",
    model: "f",
    async turn(args) {
      system = args.system;
      return { text: "ok", toolUses: [], stop: "end" };
    },
  };
  await runAgent([{ role: "user", content: "修改这个 docx" }], {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
  });
  assert.match(system, /keep its original path as the canonical output/);
  assert.match(system, /Do not invent suffix copies/);
  assert.match(system, /call the python tool with source directly/);
  assert.match(system, /never write a durable helper \.py file/);
  assert.match(system, /later\s+syntax\/validation\/execution failure[\s\S]*read the exact current file/);
  assert.match(system, /straight ASCII quote characters as language delimiters/);
  assert.match(system, /syntax-only validation before the first[\s\S]*execution/);
  assert.match(system, /remove it in finally\/on failure/);
  assert.match(system, /visually inspect representative pages/);
  assert.match(system, /clipped\/overlapping[\s\S]*cramped tables[\s\S]*stray template language/);
  assert.match(system, /successful file write alone is\s+not visual acceptance/);
});

test("system prompt keeps internal orchestration out of user-visible progress", async () => {
  let system = "";
  const provider = {
    id: "f",
    model: "f",
    async turn(args) {
      system = args.system;
      return { text: "ok", toolUses: [], stop: "end" };
    },
  };
  await runAgent([{ role: "user", content: "run a long task" }], {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
  });
  assert.match(system, /Never narrate private chain-of-thought/);
  assert.match(system, /task_intake, todo_write,[\s\S]*tool_search, and system-reminder/);
  assert.match(system, /major stage starts or[\s\S]*finishes/);
  assert.match(system, /Ordinary tool calls,[\s\S]*belong in the execution log, not in chat/);
  assert.match(system, /verified results, remaining blockers/);
});

test("system prompt prefers a matching configured MCP service over inspecting its implementation", async () => {
  let system = "";
  const provider = {
    id: "f",
    model: "f",
    async turn(args) {
      system = args.system;
      return { text: "ok", toolUses: [], stop: "end" };
    },
  };
  await runAgent([{ role: "user", content: "update the customer record in the configured service" }], {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
  });
  assert.match(system, /server's name or description matches that service/);
  assert.match(system, /prefer `mcp_connect` and its exposed tool/);
  assert.match(system, /Finding an MCP repository path does not connect or use the server/);
});

test("a resumed session treats persisted history as context instead of rediscovering the workspace", async () => {
  const systems = [];
  const provider = {
    id: "f",
    model: "f",
    async turn(args) {
      systems.push(args.system);
      return { text: "ok", toolUses: [], stop: "end" };
    },
  };
  const history = [
    { role: "user", content: "implement the agreed change" },
    { role: "assistant", text: "I completed the first step", toolUses: [] },
    { role: "user", content: "continue" },
  ];

  await runAgent(history, {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    continuationSession: true,
    executionContext: [
      "# Task execution (authoritative; separate from conversation history)",
      "Task ID: task-1",
      "Turn ID: turn-2",
      "Objective: implement the agreed change",
      "Interaction: steer",
    ].join("\n"),
  });

  assert.match(systems[0], /Existing-session continuity/);
  assert.match(systems[0], /history is already the authoritative context/);
  assert.match(systems[0], /do not restart the task, re-inventory the workspace/);
  assert.match(systems[0], /Follow the latest user request/);
  assert.match(systems[0], /Task execution \(authoritative; separate from conversation history\)/);
  assert.match(systems[0], /Objective: implement the agreed change/);
  assert.match(systems[0], /Interaction: steer/);
});

test("agent tool: when-to-use / when-NOT guidance (direct tools for narrow lookups)", async () => {
  await import("../dist/tools/agent.js");
  const t = getTool("agent");
  assert.ok(t, "agent tool registered");
  assert.ok(/WHEN TO USE/.test(t.description) && /WHEN NOT TO USE/.test(t.description), "both halves of the heuristic");
  assert.ok(/more than ~3 searches/.test(t.description), "the 3-query threshold");
  assert.ok(/read_file/.test(t.description) && /grep/.test(t.description), "redirects narrow cases to direct tools");
  assert.ok(/SEVERAL agents in ONE response/.test(t.description), "parallel fan-out instruction");
  assert.ok(/# Specialist roles/.test(t.description), "points the model at the role metadata catalog");
  assert.ok(/minimal self-contained brief/.test(t.description), "prevents whole-conversation context dumping");
});

test("built-in explore persona: read-only, parallel, excerpts, conclusions — never dumps", () => {
  assert.ok(/READ-ONLY/.test(EXPLORE_SYSTEM), "read-only contract");
  assert.ok(/PARALLEL tool calls/.test(EXPLORE_SYSTEM), "parallel instruction");
  assert.ok(/excerpts, not whole files/.test(EXPLORE_SYSTEM), "excerpt discipline");
  assert.ok(/CONCLUSIONS/.test(EXPLORE_SYSTEM) && /never dump/.test(EXPLORE_SYSTEM), "returns conclusions, not dumps");
});

test("interjection triage: mid-task messages carry the fold-in / queue / urgent-switch contract", async () => {
  const { INTERJECT_PREFIX } = await import("../dist/agent/reminders.js");
  assert.ok(/TRIAGE/.test(INTERJECT_PREFIX), "triage instruction present");
  assert.ok(/fold it in now/.test(INTERJECT_PREFIX), "refinement path");
  assert.ok(/todo_write it onto the queue/.test(INTERJECT_PREFIX), "new-task path uses the todo queue");
  assert.ok(/URGENT/.test(INTERJECT_PREFIX) && /switch to it immediately/.test(INTERJECT_PREFIX), "urgent preemption path");
  assert.ok(/finish the current step safely/.test(INTERJECT_PREFIX), "no half-done edits before switching");
  // The standing policy also rides the system prompt (not only the per-message marker):
  let system = "";
  const provider = { id: "f", model: "f", async turn(a) { system = a.system; return { text: "ok", toolUses: [], stop: "end" }; } };
  await runAgent([{ role: "user", content: "hi" }], { provider, ctx: { cwd: process.cwd() }, approval: "full-auto", confirm: async () => true, quiet: true });
  assert.ok(/triage them/.test(system) && /todo list is your task queue/.test(system), "system prompt carries the scheduling policy");
});
