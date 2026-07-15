import test from "node:test";
import assert from "node:assert/strict";
import { allowsEvolutionTool, EVOLUTION_SYSTEM, evolutionStatus, shouldAutoEvolve } from "../dist/agent/evolution.js";
import { getTool } from "../dist/tools/registry.js";
import { MAX_MEMORY_ENTRY_CHARS, MAX_SKILL_BODY_CHARS } from "../dist/tools/memory.js";
import "../dist/tools/all.js";

test("self-evolution policy is evidence-gated and excludes autonomous code/prompt mutation", () => {
  assert.match(EVOLUTION_SYSTEM, /evidence-backed/);
  assert.match(EVOLUTION_SYSTEM, /target=log/);
  assert.match(EVOLUTION_SYSTEM, /Never edit product code/);
  assert.equal(shouldAutoEvolve("proactive", 4), true);
  assert.equal(shouldAutoEvolve("light", 20), false);
  assert.equal(shouldAutoEvolve("proactive", 3), false);
});

test("self-evolution status explains mode, approval, and safety boundary", () => {
  const status = evolutionStatus({ evolve: "proactive", assetCapture: "ask" });
  assert.match(status, /proactive/);
  assert.match(status, /require confirmation/);
  assert.match(status, /never autonomous code/);
});

test("self-evolution cannot persist an unbounded transcript as one memory entry", async () => {
  const result = await getTool("memory_write").run({ content: "x".repeat(MAX_MEMORY_ENTRY_CHARS + 1) }, { cwd: process.cwd() });
  assert.match(result, /too large/);
});

test("self-evolution runtime tools cannot mutate task state or browse the network", () => {
  assert.equal(allowsEvolutionTool("memory_write", "off"), true);
  assert.equal(allowsEvolutionTool("skill_create", "off"), false);
  assert.equal(allowsEvolutionTool("skill_create", "ask"), true);
  assert.equal(allowsEvolutionTool("todo_write", "auto"), false);
  assert.equal(allowsEvolutionTool("web_fetch", "auto"), false);
  assert.equal(allowsEvolutionTool("write_file", "auto"), false);
});

test("self-evolution cannot persist a transcript-sized skill body", async () => {
  const result = await getTool("skill_create").run({
    name: "too-large",
    description: "test boundary",
    body: "x".repeat(MAX_SKILL_BODY_CHARS + 1),
  }, { cwd: process.cwd() });
  assert.match(result, /too large/);
});
