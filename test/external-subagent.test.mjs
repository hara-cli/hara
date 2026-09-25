import test from "node:test";
import assert from "node:assert/strict";
import { executeExternalCodingAgent } from "../dist/subagent/external.js";
import { ExternalRuntimeSessionGoneError } from "../dist/external-sessions/types.js";

const runtimeId = `ext_runtime_${"b".repeat(24)}`;
const providerSessionId = `ext_codex_${"c".repeat(24)}`;

const request = (overrides = {}) => ({
  id: "15ee97af-e175-4ac8-9cdb-801fe9d36d6f",
  path: "/root/coder",
  parentPath: "/root",
  generation: 1,
  runtime: "codex",
  task: "Implement the bounded change.",
  signal: new AbortController().signal,
  controller: {},
  pendingInput: async () => [],
  budget: { maxProviderRounds: 2, maxToolCalls: 10, maxTokens: 10_000, timeoutMs: 10_000 },
  reportProgress: () => true,
  workspace: {
    mode: "isolated-write",
    cwd: "/tmp/hara-agent-worktree",
    sourceCwd: "/tmp/source",
    writeBoundary: "/tmp/hara-agent-worktree",
  },
  ...overrides,
});

test("external coding Agents create one Hara Live runtime and relay in-flight mailbox input", async () => {
  const calls = [];
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  let pending = [{ id: "mail-1", sourcePath: "/root", content: "Use the smaller API.", kind: "message" }];
  const service = {
    async createSession(input) {
      calls.push(["create", input]);
      return { session: { id: runtimeId, providerSessionId }, messages: [], readOnly: false, controlMode: "live" };
    },
    async readSession(id) {
      calls.push(["read", id]);
      return { session: { id, providerSessionId }, messages: [], readOnly: false, controlMode: "live" };
    },
    async submit(id, text) {
      calls.push(["submit", id, text]);
      return completed;
    },
    async terminalInput(id, text) {
      calls.push(["terminal-input", id, text]);
      finish({ sessionId: id, turnId: "turn-1", status: "completed", reply: "done" });
    },
    async interrupt(id) { calls.push(["interrupt", id]); },
  };
  const result = await executeExternalCodingAgent(request({
    pendingInput: async () => {
      const delivered = pending;
      pending = [];
      return delivered;
    },
  }), service);
  assert.equal(result.status, "completed");
  assert.equal(result.runtimeSessionId, runtimeId);
  assert.equal(result.providerSessionId, providerSessionId);
  assert.deepEqual(calls[0][0], "create");
  assert.equal(calls[0][1].cwd, "/tmp/hara-agent-worktree");
  assert.equal(calls[0][1].launch.sandboxMode, "workspace-write");
  assert.match(calls.find((entry) => entry[0] === "terminal-input")[2], /Use the smaller API/u);
});

test("external coding Agent follow-ups rehydrate the same opaque runtime instead of creating another", async () => {
  const calls = [];
  const service = {
    async createSession() { throw new Error("must not create"); },
    async readSession(id) {
      calls.push(["read", id]);
      return { session: { id, providerSessionId }, messages: [], readOnly: false, controlMode: "live" };
    },
    async submit(id, text) {
      calls.push(["submit", id, text]);
      return { sessionId: id, turnId: "turn-2", status: "completed", reply: "continued" };
    },
    async terminalInput() {},
    async interrupt() {},
  };
  const result = await executeExternalCodingAgent(request({
    generation: 2,
    runtimeSessionId: runtimeId,
    providerSessionId,
  }), service);
  assert.equal(result.status, "completed");
  assert.equal(result.providerSessionId, providerSessionId);
  assert.deepEqual(calls, [
    ["read", runtimeId],
    ["submit", runtimeId, "Implement the bounded change."],
  ]);
});

test("external coding Agent replaces only a confirmed-gone runtime and resumes the same provider session", async () => {
  const recoveredRuntimeId = `ext_runtime_${"d".repeat(24)}`;
  const calls = [];
  const notices = [];
  const service = {
    async createSession() { throw new Error("must not create a new provider session"); },
    async readSession(id) {
      calls.push(["read", id]);
      throw new ExternalRuntimeSessionGoneError("gone");
    },
    async recoverRuntimeSession(input) {
      calls.push(["recover", input]);
      return {
        session: { id: recoveredRuntimeId, providerSessionId },
        messages: [],
        readOnly: false,
        controlMode: "live",
      };
    },
    async submit(id, text) {
      calls.push(["submit", id, text]);
      return { sessionId: id, turnId: "turn-3", status: "completed", reply: "recovered" };
    },
    async terminalInput() {},
    async interrupt() {},
  };
  const result = await executeExternalCodingAgent(request({
    generation: 2,
    runtimeSessionId: runtimeId,
    providerSessionId,
  }), service, { notice: (message) => notices.push(message) });
  assert.equal(result.status, "completed");
  assert.equal(result.runtimeSessionId, recoveredRuntimeId);
  assert.equal(result.providerSessionId, providerSessionId);
  assert.deepEqual(calls.map((entry) => entry[0]), ["read", "recover", "submit"]);
  assert.equal(calls[1][1].providerSessionId, providerSessionId);
  assert.equal(calls[1][1].cwd, "/tmp/hara-agent-worktree");
  assert.deepEqual(notices, ["Hara restored the same Codex conversation in a new local terminal."]);
});

test("external coding Agent never duplicates a terminal after a transient read failure", async () => {
  let recovered = false;
  const service = {
    async createSession() { throw new Error("must not create"); },
    async readSession() { throw new Error("temporary transport failure"); },
    async recoverRuntimeSession() { recovered = true; throw new Error("must not recover"); },
    async submit() { throw new Error("must not submit"); },
    async terminalInput() {},
    async interrupt() {},
  };
  await assert.rejects(
    executeExternalCodingAgent(request({
      generation: 2,
      runtimeSessionId: runtimeId,
      providerSessionId,
    }), service),
    /temporary transport failure/,
  );
  assert.equal(recovered, false);
});
