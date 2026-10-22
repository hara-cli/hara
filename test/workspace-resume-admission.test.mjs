import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { DEFAULT_WORKSPACE_RUN_BUDGET } from "../dist/workspace/run-binding.js";

const temporary = [];
after(() => { for (const path of temporary) fs.rmSync(path, { recursive: true, force: true }); });
function setup() {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-resume-admission-"))); temporary.push(root);
  let factories = 0, calls = 0;
  const host = new LocalWorkspaceHost(root, { providerFactory(_connection, binding) {
    factories++;
    return { id: "openai", model: binding.model, async turn() {
      calls++; return { text: "synthetic exhausted task", toolUses: [], stop: "end", usage: { input: DEFAULT_WORKSPACE_RUN_BUDGET.maxTokens, output: 1 } };
    } };
  } });
  const workspace = host.createWorkspace("Synthetic resume", host.list().revision);
  host.configureSynthetic(workspace.workspaceId, 0);
  const storage = new WorkspaceResourceStorage(host.home, host.catalog.resolve(workspace.workspaceId).scope); storage.initialize();
  const file = storage.run(() => join(workspaceStateHome(), ".hara", `conversation-${workspace.selectedAgentId.slice(3)}.json`));
  return { root, host, workspace, storage, file, counts: () => ({ factories, calls }) };
}
test("exhausted resume refuses before provider construction, history append, attempt and model accounting", async () => {
  const f = setup(), w = f.workspace;
  try {
    const first = f.host.start("ui-client", w.workspaceId, w.selectedAgentId, "hello", randomUUID()); await f.host.wait(first.runId);
    assert.equal(f.host.snapshot(w.workspaceId).conversation.state, "blocked");
    assert.equal(f.host.snapshot(w.workspaceId).conversation.blockReason?.includes("safety ceiling"), true,
      f.host.snapshot(w.workspaceId).conversation.blockReason ?? "missing synthetic exhaustion reason");
    const bytes = fs.readFileSync(f.file), inode = fs.statSync(f.file).ino, counts = f.counts();
    assert.throws(() => f.host.start("ui-client", w.workspaceId, w.selectedAgentId, "/continue", randomUUID(), true), /budget.*exhausted/i);
    assert.equal(fs.readFileSync(f.file).equals(bytes), true, "rejection must not rewrite the old conversation");
    assert.equal(fs.statSync(f.file).ino, inode); assert.deepEqual(f.counts(), counts);
  } finally { await f.host.close(); }
});
test("UI, CLI and declared automatic retries are separate refused provenance, not chat/model rounds", async () => {
  const f = setup(), w = f.workspace;
  try {
    const run = f.host.start("initial", w.workspaceId, w.selectedAgentId, "hello", randomUUID()); await f.host.wait(run.runId);
    const bytes = fs.readFileSync(f.file), counts = f.counts(), ids = [];
    for (const source of ["ui", "cli", "automatic_retry"]) {
      const id = randomUUID(); ids.push(id);
      assert.throws(() => f.host.start(`${source}-client`, w.workspaceId, w.selectedAgentId, "/continue", id, false, undefined, undefined,
        { source, channel: source === "cli" ? "cli" : "rpc", clientId: `${source}-client` }), /budget.*exhausted/i);
      const receipt = f.host.requestReceipt(w.workspaceId, w.selectedAgentId, id);
      assert.equal(receipt.state, "rejected"); assert.equal(receipt.source, source); assert.equal(receipt.reason, "run_tokens");
    }
    assert.throws(() => f.host.start("retry-client", w.workspaceId, w.selectedAgentId, "/continue", ids[0], true), /rejected.*no new model call/);
    assert.equal(fs.readFileSync(f.file).equals(bytes), true); assert.deepEqual(f.counts(), counts);
    assert.equal(f.host.snapshot(w.workspaceId).conversation.resumeAdmission.allowed, false);
  } finally { await f.host.close(); }
});
for (const scenario of ["run_rounds", "run_tools", "tree_rounds", "tree_tools", "tree_tokens"]) {
  test(`frozen ${scenario} budget refuses before continuation, even after restart`, async () => {
    const f = setup(), w = f.workspace;
    try {
      const first = f.host.start("initial", w.workspaceId, w.selectedAgentId, "hello", randomUUID()); await f.host.wait(first.runId); await f.host.close();
      const raw = JSON.parse(fs.readFileSync(f.file, "utf8")), state = join(f.file, ".."), binding = raw.task.workspaceRunBinding;
      raw.runUsage = { modelCalls: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1 };
      const treeFile = join(state, `tree-budget-${first.runId}.json`), tree = JSON.parse(fs.readFileSync(treeFile, "utf8"));
      tree.usage = { ...raw.runUsage };
      const target = scenario.startsWith("run_") ? raw.runUsage : tree.usage;
      if (scenario.endsWith("rounds")) target.modelCalls = binding.budget.maxRounds;
      if (scenario.endsWith("tools")) target.toolCalls = binding.budget.maxToolCalls;
      if (scenario.endsWith("tokens")) target.inputTokens = binding.budget.maxTokens;
      raw.usage = { ...raw.runUsage }; // seed an earlier valid fixture; never alter a live/real conversation
      fs.writeFileSync(f.file, JSON.stringify(raw) + "\n", { mode: 0o600 }); fs.writeFileSync(treeFile, JSON.stringify(tree) + "\n", { mode: 0o600 });
      const bytes = fs.readFileSync(f.file), treeBytes = fs.readFileSync(treeFile), inode = fs.statSync(f.file).ino;
      let constructed = 0;
      const restored = new LocalWorkspaceHost(f.root, { providerFactory() { constructed++; throw new Error("must not construct"); } });
      try {
        const id = randomUUID(); assert.throws(() => restored.start("cli", w.workspaceId, w.selectedAgentId, "resume task", id, true), new RegExp(scenario));
        assert.equal(constructed, 0); assert.equal(fs.readFileSync(f.file).equals(bytes), true); assert.equal(fs.statSync(f.file).ino, inode);
        assert.equal(fs.readFileSync(treeFile).equals(treeBytes), true); assert.equal(restored.requestReceipt(w.workspaceId, w.selectedAgentId, id).reason, scenario);
      } finally { await restored.close(); }
    } finally { await f.host.close(); }
  });
}
test("stale running exhausted attempts are refused without writing an interrupted replacement", async () => {
  const f = setup(), w = f.workspace;
  try {
    const run = f.host.start("initial", w.workspaceId, w.selectedAgentId, "hello", randomUUID()); await f.host.wait(run.runId); await f.host.close();
    const raw = JSON.parse(fs.readFileSync(f.file, "utf8")); raw.attempt.state = "running"; raw.attempt.endedAt = null;
    fs.writeFileSync(f.file, JSON.stringify(raw) + "\n", { mode: 0o600 }); const bytes = fs.readFileSync(f.file);
    const restored = new LocalWorkspaceHost(f.root);
    try { assert.throws(() => restored.start("ui", w.workspaceId, w.selectedAgentId, "/continue", randomUUID(), true), /run_tokens/);
      assert.equal(fs.readFileSync(f.file).equals(bytes), true); assert.equal(restored.snapshot(w.workspaceId).conversation.state, "needs_recovery");
    } finally { await restored.close(); }
  } finally { await f.host.close(); }
});
test("a persisted legacy 32k run/tree stays frozen after the ordinary default increases", async () => {
  const f=setup(),w=f.workspace;
  try {
    const run=f.host.start("initial",w.workspaceId,w.selectedAgentId,"hello",randomUUID());await f.host.wait(run.runId);await f.host.close();
    const raw=JSON.parse(fs.readFileSync(f.file,"utf8")),treeFile=join(f.file,"..",`tree-budget-${run.runId}.json`),tree=JSON.parse(fs.readFileSync(treeFile,"utf8"));
    // Seed only this synthetic old-schema fixture. Never rewrite a user's frozen budget.
    raw.task.workspaceRunBinding.budget.maxTokens=32000;tree.limits.maxTokens=32000;
    raw.runUsage={modelCalls:1,toolCalls:0,inputTokens:32000,outputTokens:1};raw.usage={...raw.runUsage};tree.usage={...raw.runUsage};
    fs.writeFileSync(f.file,JSON.stringify(raw)+"\n");fs.writeFileSync(treeFile,JSON.stringify(tree)+"\n");
    const bytes=fs.readFileSync(f.file),treeBytes=fs.readFileSync(treeFile);let constructed=0;
    const reopened=new LocalWorkspaceHost(f.root,{providerFactory(){constructed++;throw new Error("must not construct");}});
    try {
      assert.equal(reopened.snapshot(w.workspaceId).conversation.resumeAdmission.reason,"run_tokens");
      assert.throws(()=>reopened.start("client",w.workspaceId,w.selectedAgentId,"/continue",randomUUID(),true),/run_tokens/);
      assert.equal(constructed,0);assert.equal(fs.readFileSync(f.file).equals(bytes),true);assert.equal(fs.readFileSync(treeFile).equals(treeBytes),true);
    } finally {await reopened.close();}
  } finally {await f.host.close();}
});
test("receipt lookup is read-only, scope-bound, and does not invent provenance for legacy accepted requests", async () => {
  const f = setup(), w = f.workspace, id = randomUUID();
  try {
    const run = f.host.start("initial", w.workspaceId, w.selectedAgentId, "hello", id); await f.host.wait(run.runId);
    const requestFile = join(f.file, "..", `requests-${w.selectedAgentId.slice(3)}.json`);
    fs.unlinkSync(requestFile); // simulate a valid older fixture with no provenance journal
    const bytes = fs.readFileSync(f.file), counts = f.counts();
    assert.equal(f.host.requestReceipt(w.workspaceId, w.selectedAgentId, id).source, "unknown_legacy");
    assert.equal(f.host.requestReceipt(w.workspaceId, w.selectedAgentId, id).state, "accepted");
    assert.equal(f.host.requestReceipt(w.workspaceId, w.selectedAgentId, randomUUID()).state, "unknown");
    assert.equal(fs.existsSync(requestFile), false); assert.equal(fs.readFileSync(f.file).equals(bytes), true); assert.deepEqual(f.counts(), counts);
    const other = f.host.createWorkspace("Other", f.host.list().revision);
    assert.throws(() => f.host.requestReceipt(other.workspaceId, w.selectedAgentId, id), /identity/);
  } finally { await f.host.close(); }
});
test("real CLI resume denial records CLI provenance but creates no caller HOME state or model call", async () => {
  const f = setup(), w = f.workspace;
  const callerHome = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-resume-cli-home-"))); temporary.push(callerHome);
  try {
    const run = f.host.start("initial", w.workspaceId, w.selectedAgentId, "hello", randomUUID()); await f.host.wait(run.runId); await f.host.close();
    const bytes = fs.readFileSync(f.file), requestId = randomUUID();
    await assert.rejects(promisify(execFile)(process.execPath, [join(process.cwd(), "dist/cli.js"), "workspace-dev", "run", "--root", f.root,
      "--workspace", w.workspaceId, "--agent", w.selectedAgentId, "--message", "/continue", "--resume", "--request-id", requestId],
    { cwd: callerHome, env: { PATH: process.env.PATH, HOME: callerHome, USERPROFILE: callerHome } }), /budget.*exhausted/i);
    assert.equal(fs.readFileSync(f.file).equals(bytes), true); assert.deepEqual(fs.readdirSync(callerHome), []);
    const restored = new LocalWorkspaceHost(f.root);
    try { assert.equal(restored.requestReceipt(w.workspaceId, w.selectedAgentId, requestId).source, "cli"); } finally { await restored.close(); }
  } finally { await f.host.close(); }
});
