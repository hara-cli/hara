// Project-analysis SOP (Task: "analyzing a git repo is much slower than codex").
// The execution layer always could parallelize reads and fan out read-only sub-agents — what was
// missing was TEACHING the model. These pin the three teaching surfaces:
//   1. the system prompt's batch/explore playbook (codex: "parallelize tool calls whenever possible",
//      manifest-first sweep; CC: ">~3 searches → dedicated Explore agent"),
//   2. the agent tool's when-to-use / when-NOT guidance (CC's AgentTool prompt pattern),
//   3. the built-in "explore" persona (CC's Explore agent: parallel, excerpts, conclusions-not-dumps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../dist/agent/loop.js";
import { getTool } from "../dist/tools/registry.js";
import { EXPLORE_SYSTEM } from "../dist/tools/agent.js";

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
