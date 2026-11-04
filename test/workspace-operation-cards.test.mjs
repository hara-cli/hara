import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { WORKSPACE_OPERATION_CARDS, WORKSPACE_OPERATION_SKILL_ID, workspaceOperationSkill, withWorkspaceOperationSkill } from "../dist/workspace/operation-cards.js";
import { workspaceSkillTool, validateWorkspaceSkill } from "../dist/workspace/skills.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceContextReceipts } from "../dist/workspace/context-receipts.js";
import { localWorkspaceFileTools } from "../dist/workspace/local-tools.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { SYNTHETIC_CONNECTION } from "../dist/workspace/synthetic-provider.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { channelMentions } from "../dist/workspace/local-channels.js";
import { WorkspaceRequestJournal } from "../dist/workspace/request-journal.js";
import { canonical } from "../dist/workspace/local-state.js";
import { scriptedWorkspaceProvider } from "./fixtures/scripted-workspace-provider.mjs";

const roots = [];
function dir() {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-op-cards-")));
  roots.push(root); return root;
}
const card = id => {
  const found = WORKSPACE_OPERATION_CARDS.find(row => row.id === id);
  assert.ok(found, `missing operation card ${id}`); return found;
};
function checkTools(documented, actual) {
  for (const expected of documented) {
    const tool = actual.find(row => row.name === expected.name);
    assert.ok(tool, `documented tool missing: ${expected.name}`);
    assert.deepEqual(Object.keys(tool.input_schema.properties).sort(), [...expected.fields].sort(), `${expected.name} fields`);
    assert.deepEqual([...(tool.input_schema.required ?? [])].sort(), [...expected.required].sort(), `${expected.name} required`);
  }
}
async function clientFor(handle) {
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`), pending = new Map(); let sequence = 0;
  socket.on("message", data => {
    const message = JSON.parse(data.toString()), entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  });
  await once(socket, "open");
  return {
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`bounded operation-card RPC timeout: ${method}`)); }, 5000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    async close() { const closed = once(socket, "close"); socket.close(); await closed; },
  };
}
let host, handle, client, initialized, scope, sample, mainTools, channelTools, colleagueTools, mainPrompt, mainToolImplementations;
before(async () => {
  const root = dir(), home = dir(), captures = [];
  host = new LocalWorkspaceHost(root, { mode: "workspace", hostHome: home, discoveryHome: home, credentialVault: new MemoryCredentialVault(),
    providerFactory: (_connection, binding) => scriptedWorkspaceProvider({ id: "openai", model: binding.model, async turn(args) {
      captures.push(args);
      return { text: "已查看。", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    } }),
  });
  // Observe real Host implementations: model-facing ToolSpec intentionally omits authority kinds.
  const jobTools = host.jobTools.bind(host);
  host.jobTools = (...args) => { const tools = jobTools(...args); if (args[1].kind === "main") mainToolImplementations = tools; return tools; };
  const workspace = host.createWorkspace("Operations", host.list().revision), id = workspace.workspaceId;
  host.configureConnection(id, { ...SYNTHETIC_CONNECTION }, 0); host.select("cards-client", id, host.list().revision);
  const resources = new WorkspaceResources(host.home, host.catalog.resolve(id).scope); resources.initialize();
  const colleague = resources.agents.create({ username: "reviewer", profile: { displayName: "Reviewer" } }, resources.agents.list().revision);
  const mainRun = host.start("cards-client", id, workspace.selectedAgentId, "你好", randomUUID()); await host.wait(mainRun.runId);
  assert.equal(captures.length, 1); mainTools = captures[0].tools; mainPrompt = captures[0].system;
  const dmRun = host.start("cards-client", id, colleague.agentId, "你好", randomUUID()); await host.wait(dmRun.runId);
  assert.equal(captures.length, 2); colleagueTools = captures[1].tools;
  const channelId = randomUUID(); host.createChannel("cards-client", id, channelId, "Review", [colleague.agentId], 0); host.selectChannel("cards-client", id, channelId);
  host.sendChannel("cards-client", id, channelId, "@Reviewer 你好", randomUUID(), [colleague.agentId]); await host.waitChannel(id, channelId);
  assert.equal(captures.length, 3); channelTools = captures[2].tools;

  const rpcRoot = dir(), rpcHome = dir();
  handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: rpcRoot }, {
    root: rpcRoot, version: "operation-card-contract", mode: "workspace", hostHome: rpcHome, discoveryHome: rpcHome, credentialVault: new MemoryCredentialVault(),
  });
  client = await clientFor(handle);
  initialized = await client.request("initialize", { token: handle.token });
  const created = await client.request("workspace.create", { label: "RPC operations", expectedRevision: initialized.workspace.revision });
  scope = { workspaceId: created.workspaceId, expectedGeneration: created.resourceGeneration };
  const snapshot = await client.request("workspace.snapshot", { workspaceId: created.workspaceId, agentId: null });
  sample = { ...scope, runtimeId: "codex", fingerprint: "a".repeat(64), approved: false, loginSource: "host",
    agentId: created.selectedAgentId, configRevision: snapshot.agents[0].configRevision, agentEpoch: snapshot.agents[0].agentEpoch,
    modelId: "fixture", expectedRevision: 0, effort: null, approvalId: randomUUID(), channelId: randomUUID(),
    permissionTier: "controlled", proxyUrl: null, expectedNativeRevision: 0, message: "你好", requestId: randomUUID(), recipientIds: [], source: "ui" };
});
after(async () => {
  if (client) await client.close();
  if (handle) await handle.close();
  if (host) await host.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

async function checkRpcFacts(definition) {
  for (const rpc of definition.rpcs) {
    const params = Object.fromEntries([...rpc.fields, ...(rpc.optional ?? [])].map(field => [field, sample[field]]));
    await assert.rejects(client.request(rpc.method, { ...params, undocumentedAuthority: true }), /unsupported Workspace RPC fields/, `${rpc.method} must exist and reject extra fields`);
    for (const field of rpc.fields.filter(field => !["workspaceId", "expectedGeneration"].includes(field))) {
      const missing = { ...params }; delete missing[field];
      await assert.rejects(client.request(rpc.method, missing), /unsupported Workspace RPC fields/, `${rpc.method} requires ${field}`);
    }
    // The exact documented shape must pass the field boundary. An unbound runtime/no task/no card
    // may refuse later; those business denials are not evidence that a missing RPC exists.
    try { await client.request(rpc.method, params); }
    catch (error) { assert.doesNotMatch(error.message, /unsupported Workspace (RPC fields|method)/, rpc.method); }
    await assert.rejects(client.request(rpc.method, { ...params, expectedGeneration: randomUUID() }), /generation/, `${rpc.method} retains the resource fence`);
  }
}

test("built-in cards use the existing bounded skill container with one compact prompt index", async () => {
  const bundle = validateWorkspaceSkill(workspaceOperationSkill());
  assert.equal(WORKSPACE_OPERATION_CARDS.length, 9);
  assert.equal(Object.keys(bundle.files).length, 10, "index plus nine cards");
  assert.match(mainPrompt, /"id":"hara-operations"/);
  assert.equal(mainTools.find(row => row.name === "workspace_skill").input_schema.properties.file.type, "string");
  for (const definition of WORKSPACE_OPERATION_CARDS) assert.ok(!mainPrompt.includes(definition.steps[0]), "card bodies are not in the system prompt");
  const checked = [], tool = workspaceSkillTool([], (id, version) => checked.push([id, version]));
  const index = JSON.parse(await tool.run({ id: bundle.id }, { cwd: "/unused" }));
  assert.equal(index.file, "SKILL.md"); assert.equal(index.nextOffset, null);
  for (const definition of WORKSPACE_OPERATION_CARDS) {
    assert.match(index.content, new RegExp(`cards/${definition.id}\\.md`));
    const result = await tool.run({ id: bundle.id, file: `cards/${definition.id}.md` }, { cwd: "/unused" });
    assert.ok(result.length <= 7800);
    const value = JSON.parse(result); assert.equal(value.nextOffset, null); assert.match(value.content, /权限与边界/);
    assert.deepEqual(JSON.parse(value.content.trim().split("\n").at(-1)), { rpcs: definition.rpcs, tools: definition.tools });
  }
  assert.equal(checked.length, 10, "index and all nine card reads still assert the current permit");
});

test("runtime/login card binds registration approval, login-source validation and current agent revision", async () => {
  await checkRpcFacts(card("runtime-login"));
  const method = card("runtime-login").rpcs[0].method;
  const params = { ...scope, runtimeId: "codex", fingerprint: sample.fingerprint, approved: false, loginSource: "host" };
  await assert.rejects(client.request(method, params), /Explicit local runtime approval required/);
  await assert.rejects(client.request(method, { ...params, approved: true, loginSource: "invented" }), /Invalid runtime login source/);
});

test("model/effort card binds the actual scoped inventory and revisioned selection RPCs", async () => {
  await checkRpcFacts(card("model-effort"));
  assert.ok(initialized.capabilities.includes("workspace.runtime-login-effort.v1"));
  assert.ok(!mainTools.some(row => row.name === "workspace.runtime.selectModel"), "human RPC is not a model tool");
});

test("creation card binds main-only tool schemas and a fresh, view-bound, single-use human card", async () => {
  const definition = card("create-colleague"); checkTools(definition.tools, mainTools); await checkRpcFacts(definition);
  for (const tool of definition.tools) assert.ok(!colleagueTools.some(row => row.name === tool.name), `${tool.name} is main-only`);
  const root = dir(), home = dir(), synthetic = new LocalWorkspaceHost(root, { hostHome: home, discoveryHome: home });
  try {
    const workspace = synthetic.createWorkspace("Confirmation", synthetic.list().revision), id = workspace.workspaceId;
    synthetic.configureSynthetic(id, 0); synthetic.select("owner", id, synthetic.list().revision);
    const receipt = synthetic.start("owner", id, workspace.selectedAgentId, "建立 Pi 同事 Coder", randomUUID());
    let approval;
    for (let count = 0; count < 250 && !approval; count++) {
      approval = synthetic.snapshot(id, workspace.selectedAgentId, "owner").approvals[0];
      if (!approval) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(approval, "a real human confirmation card must be pending");
    assert.equal(synthetic.snapshot(id).agents.length, 1, "pending is not created");
    assert.throws(() => synthetic.answerApproval("other", id, approval.id, true), /approval/);
    synthetic.answerApproval("owner", id, approval.id, true); await synthetic.wait(receipt.runId);
    assert.equal(synthetic.snapshot(id).agents.length, 2);
    assert.throws(() => synthetic.answerApproval("owner", id, approval.id, true), /approval/);
    const result = synthetic.snapshot(id).conversation.history.flatMap(row => row.role === "tool" ? row.results : []).find(row => row.name === "agent_create");
    assert.ok(result); const created = JSON.parse(result.content);
    assert.equal(created.created, true); assert.equal(created.humanConfirmed, true); assert.equal(created.approvalState, "consumed");
  } finally { await synthetic.close(); }
});

test("channel card binds member mentions and tools supplied only inside the local channel", async () => {
  for(const capability of ["workspace.channel-pass.v1","workspace.channel-queue.v1","workspace.channel-autonomy.v1"]) assert.ok(initialized.capabilities.includes(capability));
  const definition = card("channel-mentions"); checkTools(definition.tools, channelTools); await checkRpcFacts(definition);
  for (const tool of definition.tools) {
    assert.ok(!mainTools.some(row => row.name === tool.name)); assert.ok(!colleagueTools.some(row => row.name === tool.name));
  }
  const members = [{ agentId: "bob", displayName: "Bob" }, { agentId: "bobby", displayName: "Bobby" }];
  assert.deepEqual(channelMentions("x@Bob.test @Bobby @bob", members), ["bobby", "bob"]);
});

test("recovery card binds read-only receipts and the no-task resume refusal without a model call", async () => {
  const definition = card("failure-recovery"); await checkRpcFacts(definition);
  await assert.rejects(client.request(definition.rpcs[1].method, { ...scope, agentId: sample.agentId, message: "继续", requestId: randomUUID(), source: "ui" }), /resume|connection|interrupted|连接|provider/i);
});

test("proxy card binds the admitted getter/setter and rejects stale revision and extra authority", async () => {
  const definition=card("proxy-boundary");assert.equal(definition.tools.length,0);
  assert.ok(initialized.capabilities.includes("workspace.runtime-proxy.v1"));await checkRpcFacts(definition);
  const before=await client.request("workspace.runtime.proxy.get",scope);
  const saved=await client.request("workspace.runtime.proxy.set",{...scope,proxyUrl:null,expectedRevision:before.revision});
  assert.equal(saved.proxyUrl,null);assert.equal(saved.revision,before.revision+1);
  await assert.rejects(client.request("workspace.runtime.proxy.set",{...scope,proxyUrl:null,expectedRevision:before.revision}),/revision|changed/i);
});

test("permission card binds real file schemas, tool kinds and path/permit rejection", async () => {
  const definition = card("scope-permissions"); await checkRpcFacts(definition); checkTools(definition.tools, mainTools);
  let current = true; const tools = localWorkspaceFileTools(dir(), () => { if (!current) throw new Error("revoked permit"); });
  assert.deepEqual(tools.map(tool => [tool.name, tool.kind]), [["workspace_read", "read"], ["workspace_write", "edit"], ["workspace_verify", "read"]]);
  const read = tools.find(tool => tool.name === definition.tools[0].name);
  for (const path of ["/outside.txt", "../outside.txt", ".hara/state.json", "node_modules/file", "credentials.json"]) {
    await assert.rejects(read.run({ path }, {}), /outside the granted safe project|project-relative/);
  }
  current = false; await assert.rejects(read.run({ path: "safe.txt" }, {}), /revoked permit/);
});

test("verification card binds the real receipt reader to run-local, paged reference-only data", async () => {
  const definition = card("verification-handoff"); checkTools(definition.tools, mainTools);
  const storage = new WorkspaceResourceStorage(dir(), { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } }); storage.initialize();
  const receipts = new WorkspaceContextReceipts(storage, randomUUID(), "ag_fixture", () => {}), tool = receipts.tool();
  const file = receipts.retain({ id: "original", name: "fixture", content: "a".repeat(2200) }), id = file.slice(8, -5);
  const result = JSON.parse(await tool.run({ id, offset: 0 }, {}));
  assert.equal(result.referenceOnly, true); assert.equal(result.nextOffset, null);
  assert.equal(JSON.parse(result.content).content, "a".repeat(2200));
  await assert.rejects(tool.run({ id: "../state", offset: 0 }, {}), /invalid Workspace receipt id/);
  const other = new WorkspaceContextReceipts(storage, randomUUID(), "ag_fixture", () => {});
  await assert.rejects(other.tool().run({ id, offset: 0 }, {}), /ownership or content changed/);
});

test("card loading preserves the current-permit guard and reserved identity without new tool grants", async () => {
  const bundle = workspaceOperationSkill(), shadow = { ...bundle, files: { "SKILL.md": "Untrusted replacement" } };
  assert.equal(withWorkspaceOperationSkill([shadow]).length, 1);
  const result = JSON.parse(await workspaceSkillTool([shadow], () => {}).run({ id: bundle.id }, {}));
  assert.ok(!result.content.includes("Untrusted replacement"));
  bundle.files["SKILL.md"] = "Caller mutation";
  assert.ok(!workspaceOperationSkill().files["SKILL.md"].includes("Caller mutation"));
  const revoked = workspaceSkillTool([], () => { throw new Error("current permit revoked"); });
  await assert.rejects(revoked.run({ id: WORKSPACE_OPERATION_SKILL_ID }, {}), /current permit revoked/);
  const tool = workspaceSkillTool([], () => {}); assert.equal(tool.kind, "read");
  await assert.rejects(tool.run({ id: WORKSPACE_OPERATION_SKILL_ID, file: "../config.json" }, {}), /unavailable/);
  await assert.rejects(tool.run({ id: WORKSPACE_OPERATION_SKILL_ID, approved: true }, {}), /Invalid Workspace skill read/);
});

test("contract checker detects renamed tools and schema drift rather than accepting documentation strings", () => {
  const documented = card("create-colleague").tools;
  assert.throws(() => checkTools([{ ...documented[0], name: "invented_agent_list" }], mainTools), /documented tool missing/);
  assert.throws(() => checkTools([{ ...documented[1], required: [] }], mainTools), /required/);
  assert.throws(() => checkTools([{ ...documented[1], fields: ["approved"] }], mainTools), /fields/);
});

test("an ordinary formal Host can load just one built-in card through its governed model tool", async () => {
  const root = dir(), home = dir(); let calls = 0;
  const governed = new LocalWorkspaceHost(root, { mode: "workspace", hostHome: home, discoveryHome: home, credentialVault: new MemoryCredentialVault(),
    providerFactory: (_connection, binding) => scriptedWorkspaceProvider({ id: "openai", model: binding.model, async turn(args) {
      calls++;
      const result = args.history.flatMap(row => row.role === "tool" ? row.results : []).find(row => row.name === "workspace_skill");
      if (!result) return { text: "", toolUses: [{ id: "read-operation-card", name: "workspace_skill", input: { id: WORKSPACE_OPERATION_SKILL_ID, file: "cards/model-effort.md" } }], stop: "tool_use", usage: { input: 1, output: 1 } };
      assert.equal(result.isError ?? false, false, result.content);
      const value = JSON.parse(result.content); assert.equal(value.file, "cards/model-effort.md"); assert.equal(value.nextOffset, null);
      assert.ok(value.content.includes(card("model-effort").steps[0])); assert.ok(!value.content.includes(card("proxy-boundary").steps[0]));
      return { text: "说明已读取。", toolUses: [{id:"verify-help",name:"task_checkpoint",input:{completion:{state:"verified",evidence:["Requested help card read"],checks:[{acceptance_index:0,evidence:"The exact requested model/effort instructions were read",tool_call_ids:[result.id]}],final_answer:"说明已读取。"}}}], stop: "tool_use", usage: { input: 1, output: 1 } };
    } }),
  });
  try {
    const workspace = governed.createWorkspace("Read instructions", governed.list().revision), id = workspace.workspaceId;
    governed.configureConnection(id, { ...SYNTHETIC_CONNECTION }, 0);
    // The help-card proof tests the governed tool ledger, including its two-round explicit completion.
    const agent = governed.context(id).resources.agents.get(workspace.selectedAgentId);
    governed.context(id).resources.agents.setPermissionTier(agent.agentId,"controlled",agent.configRevision,agent.agentEpoch);
    const requestId = randomUUID(), message = "如何选择运行时模型？";
    const run = governed.start("reader", id, workspace.selectedAgentId, message, requestId); await governed.wait(run.runId);
    assert.equal(calls, 2, "one fake tool-use turn and one fake answer; zero external model calls");
    assert.equal(governed.snapshot(id).conversation.state, "completed");
    assert.equal(governed.workspaceFeatures(id).skills.length, 0, "built-in help neither imports nor enables user skill files");
    const duplicate = governed.start("reader", id, workspace.selectedAgentId, message, requestId);
    assert.equal(duplicate.runId, run.runId); assert.equal(duplicate.duplicate, true); assert.equal(calls, 2);
    assert.throws(() => governed.start("reader", id, workspace.selectedAgentId, "different message", requestId), /already belongs to another request/);
    const storage = new WorkspaceResourceStorage(governed.home, governed.catalog.resolve(id).scope), unknownId = randomUUID();
    storage.initialize();
    new WorkspaceRequestJournal(storage, workspace.selectedAgentId).receive({ requestId: unknownId, digest: createHash("sha256").update(canonical([message, false])).digest("hex"), operation: "send" }, { source: "host", channel: "internal", clientId: "reader" });
    assert.throws(() => governed.start("reader", id, workspace.selectedAgentId, message, unknownId), /outcome is unknown; inspect its receipt, do not resend/);
    assert.equal(calls, 2, "duplicate and outcome-unknown requests cannot dispatch another model turn");
  } finally { await governed.close(); }
});

test("RPC contract checker fails for a renamed documented route", async () => {
  const original = card("model-effort").rpcs[0];
  await assert.rejects(checkRpcFacts({ rpcs: [{ ...original, method: "workspace.runtime.inventedListModels" }] }), /must exist and reject extra fields/);
});


test("chat scheduling card binds actual scoped tools and documents original confirmation/receipt semantics",()=>{
 const definition=card("chat-schedules");checkTools(definition.tools,mainTools);checkTools(definition.tools,colleagueTools);checkTools(definition.tools,channelTools);
 for(const name of ["schedule_create","schedule_cancel"]) assert.equal(mainToolImplementations.find(tool=>tool.name===name).kind,"edit");
 assert.equal(mainToolImplementations.find(tool=>tool.name==="schedule_list").kind,"read");
 assert.match(definition.steps.join(" "),/15分钟/);assert.match(definition.steps.join(" "),/原Desk确认卡/);assert.match(definition.steps.join(" "),/created:true/);
});
