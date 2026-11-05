import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { storageFixture, hostFixture } from "./helpers/workspace-user-interaction.mjs";
import { prepareWorkspaceStartContext } from "../dist/workspace/start-context.js";
import { composeSystem } from "../dist/agent/loop.js";
import { codexStandingContext } from "../dist/agent-runtime/codex-session.js";

test("turn startup context sends only actual hits; greetings omit unrelated notes and roster", t => {
  const f = storageFixture(t), home = join(f.root, "personal");
  fs.mkdirSync(join(home, ".hara/memory"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(home, ".hara/memory/MEMORY.md"),
    "UnrelatedAnchor: only unrelated context.\nVideoAnchor: the reporting period is weekly.\n", { mode: 0o600 });
  const references = [{ agentId: "ag_" + randomUUID(), name: "Video helper", title: "Video editor", aliases: ["VideoAnchor"], state: "active" }];
  const common = { storage: f.storage, personalHome: home, workspaceRoots: [], references };
  const greeting = prepareWorkspaceStartContext({ ...common, objective: "你好" });
  assert.equal(greeting.turnPrompt, "");
  const relevant = prepareWorkspaceStartContext({ ...common, objective: "What is known about VideoAnchor?" });
  const packet = JSON.parse(relevant.turnPrompt);
  assert.equal(packet.untrustedContextOnly, true); assert.equal(packet.catalog_only, true);
  assert.equal(packet.colleagues[0].agentId, references[0].agentId);
  assert.equal(packet.memory.length, 1); assert.match(packet.memory[0].snippet, /weekly/);
  assert.doesNotMatch(relevant.turnPrompt, /UnrelatedAnchor/);
  assert.equal(relevant.lookup("VideoAnchor").status, "resolved", "the evidence lookup still runs independently");
  assert.equal(relevant.lookup("VideoAnchor").candidates[0].agentId, references[0].agentId);
});

test("matched multibyte context remains valid JSON below1500 bytes without cutting a catalog path", t => {
  const f = storageFixture(t), home = join(f.root, "personal");
  fs.mkdirSync(join(home, ".hara/memory"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(home, ".hara/memory/MEMORY.md"),
    Array.from({ length: 10 }, (_, i) => "VideoAnchor " + i + "有界线索".repeat(60)).join("\n"), { mode: 0o600 });
  const references = Array.from({ length: 30 }, (_, i) => ({ agentId: "ag_" + randomUUID(), name: "同事" + i, aliases: ["VideoAnchor"], state: "active" }));
  const options = ["/known/video/" + "x".repeat(180), "/known/design/" + "y".repeat(180), "Other (type an answer)"];
  const context = prepareWorkspaceStartContext({ storage: f.storage, personalHome: home, workspaceRoots: [], references,
    objective: "VideoAnchor project", includeProjectLocations: true,
    projectLocations: { historicalContextOnly: true, access: "catalog_only", options, otherOption: options.at(-1), truncated: false } });
  assert.ok(Buffer.byteLength(context.turnPrompt) <= 1500);
  const data = JSON.parse(context.turnPrompt);
  assert.equal(data.truncated, true); assert.equal(data.projectLocations.access, "catalog_only");
  assert.equal(data.projectLocations.options.at(-1), options.at(-1));
  assert.ok(data.projectLocations.options.every(value => options.includes(value)), "only complete evidenced options survive");
  assert.equal(context.lookup("VideoAnchor").status, "ambiguous", "compression cannot turn ambiguity into a grant");
});

test("structured Host boundaries preserve the stable prefix and reject a late stable part", () => {
  const render = content => composeSystem("/managed", undefined, undefined, undefined, false, undefined,
    { enabled: false }, undefined, { now: new Date("2026-11-05T01:00:00Z"), timeZone: "UTC" },
    true, "Objective: current task", [
      { id: "core", stability: "static", source: "core", content: "Frozen governance" },
      { id: "catalog", stability: "session", source: "project", content: "catalog_only metadata" },
      { id: "current", stability: "turn", source: "task", content },
    ]);
  const first = render("你好"), next = render("What is known about video?");
  const standing = value => codexStandingContext({ system: value.text, systemParts: value.parts }, "model", "low", "controlled", 1);
  assert.equal(standing(first).digest, standing(next).digest);
  assert.doesNotMatch(standing(next).standing, /What is known about video/);
  assert.match(standing(next).standing, /Keep read-only requests read-only/);
  assert.equal(standing(next).turnParts.some(row => row.content === "What is known about video?"), true);
  assert.throws(() => composeSystem("/managed", undefined, undefined, undefined, false, undefined, undefined,
    undefined, undefined, true, "", [
      { id: "current", stability: "turn", source: "task", content: "data" },
      { id: "late", stability: "static", source: "core", content: "rules" },
    ]), /cannot follow turn context/);
});

test("long instructions keep a stable governance hash while fresh receipt references stay in each turn", async t => {
  const f = hostFixture(t, () => ({ text: "你好", toolUses: [], stop: "end" }));
  const context = f.host.context(f.workspace.workspaceId), agents = context.resources.agents;
  const before = agents.get(f.workspace.selectedAgentId), persona = agents.currentPersona(before.agentId);
  agents.updatePersona(before.agentId, { ...persona, instructions: "Retain this fixed instruction. ".repeat(100) }, before.configRevision, before.agentEpoch);
  for (const message of ["你好", "谢谢"]) {
    const run = f.host.start("client", f.workspace.workspaceId, f.workspace.selectedAgentId, message, randomUUID());
    await f.host.wait(run.runId);
  }
  assert.equal(f.turns.length, 2);
  const views = f.turns.map(args => codexStandingContext(args, "model", "low", "controlled", 2));
  assert.equal(views[0].digest, views[1].digest);
  for (const value of views) {
    assert.doesNotMatch(value.standing, /receipt-[a-f0-9]{64}/);
    assert.match(value.standing, /use workspace_receipt_read before relying on omitted instructions/);
    assert.match(value.standing, /Native file evidence cannot prove Hara colleague/);
    assert.match(value.standing, /All scheduled work must use Hara WorkspaceScheduler/);
    assert.match(value.standing, /Never claim completion without observed evidence/);
    assert.match(value.turnParts.map(part => part.content).join("\n"), /Full instructions: receipt-[a-f0-9]{64}/);
  }
  assert.notEqual(views[0].turnParts.find(part => part.id === "workspace-turn").content,
    views[1].turnParts.find(part => part.id === "workspace-turn").content, "each run retains its own full instructions");
});


test("project hints require a real lexical match unless the Host needs first-response creation candidates", t => {
  const f = storageFixture(t), options = ["Project: /known/video", "Project: /known/design", "Other (type an answer)"];
  const common = { storage: f.storage, workspaceRoots: [], references: [],
    projectLocations: { historicalContextOnly: true, access: "catalog_only", options, otherOption: options.at(-1), truncated: false } };
  assert.equal(prepareWorkspaceStartContext({ ...common, objective: "What is a project?" }).turnPrompt, "");
  const hit = JSON.parse(prepareWorkspaceStartContext({ ...common, objective: "看看 video 项目" }).turnPrompt);
  assert.deepEqual(hit.projectLocations.options, [options[0], options.at(-1)]);
  assert.equal(hit.projectLocations.access, "catalog_only"); assert.equal(hit.projectLocations.truncated, true);
  const creation = JSON.parse(prepareWorkspaceStartContext({ ...common, objective: "Create a colleague",
    includeProjectLocations: true }).turnPrompt);
  assert.deepEqual(creation.projectLocations.options, options, "creation still receives evidenced editable candidates in its first response");
  assert.equal(creation.projectLocations.access, "catalog_only");
});
