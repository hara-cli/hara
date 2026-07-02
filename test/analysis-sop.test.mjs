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
