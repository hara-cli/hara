import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import WebSocket from "ws";
import { startServe } from "../../dist/serve/server.js";
import { RemoteCommandLedger } from "../../dist/serve/remote-command-ledger.js";
import { AgentFollowupStore } from "../../dist/gateway/agent-followup.js";
import { colleagueEvents } from "./colleague-events.mjs";

export const features = ["agent.delegated-interaction.v1", "external.delegated-interaction.v1", "external.questions.v1", "task.approvals.v1"];
export const nativeId = `ext_codex_${"c".repeat(24)}`;
const question = { questions: [{ id: "scope", question: "Which fixture implementation?", options: [{ label: "A" }, { label: "B" }] }] };
export const cardEvents = ["agent.approval.request", "agent.approval.resolved", "agent.question.request", "agent.question.resolved"];
export const projection = ({ deliveryCursor: _cursor, ...value }) => value;

function connect(port, signal) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`), inbox = colleagueEvents(signal), events = inbox.events, requests = new Map(); let next = 0;
    ws.on("message", (raw) => {
      const value = JSON.parse(String(raw)), request = requests.get(value.id);
      if (request) { requests.delete(value.id); clearTimeout(request.timer); request.resolve(value); }
      else if (value.method) inbox.push(value);
    });
    ws.on("close", () => {
      for (const request of requests.values()) { clearTimeout(request.timer); request.resolve({ error: { code: -1, message: "fixture disconnected" } }); }
      requests.clear();
      inbox.close();
    });
    ws.once("error", reject);
    ws.once("open", () => resolve({ ws, events,
      call(method, params = {}) {
        return new Promise((done, fail) => {
          // session.send waits for the entire two-colleague run, including several real human-card
          // decisions and isolated worktree setup. A transport-only deadline is not its task budget.
          const id = ++next, timer = setTimeout(() => { requests.delete(id); fail(Error(`fixture RPC timeout: ${method}`)); }, method === "session.send" ? 30_000 : 12_000);
          requests.set(id, { resolve: done, timer }); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      },
      event: inbox.wait,
    }));
  });
}

// Non-expiry cases have up to a 40 s test deadline and make multiple real WebSocket decisions. Keep their
// question alive for that whole test; explicit expiry cases still supply their own short deadline.
export async function fixture(t, { mode = "choice", clientFeatures = features, timeout = 40_000, holdCoder = false, approvalMode = "suggest" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hara-colleague-input-")), home = join(root, "home"), repo = join(root, "repo");
  const previousHome = process.env.HOME; process.env.HOME = home;
  mkdirSync(join(home, ".hara", "roles"), { recursive: true }); mkdirSync(repo);
  writeFileSync(join(repo, "source.txt"), "original\n");
  if (mode === "coding") for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.test"], ["add", "source.txt"], ["commit", "-qm", "fixture"]]) {
    const git = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(git.status, 0, git.stderr);
  }
  for (const name of ["architect", "manager", "coder"]) writeFileSync(join(home, ".hara", "roles", `${name}.md`),
    `---\nname: ${name}\ndisplay-name: ${name === "coder" ? "Cora" : name}\ndescription: Fixture ${name}\n---\nPERSONA_${name.toUpperCase()}\n`);
  const records = new Map(), observations = [], clients = [];
  const followups = new AgentFollowupStore(home), sourceTime = Date.now();
  if (mode === "followup") followups.observe("feishu-fixture", {
    chatId: "oc_fixture", userId: "ou_fixture", userName: "Fixture owner", text: "Observe this thread only",
    messageId: "om_fixture_root", createdAtMs: sourceTime, senderType: "user", chatType: "group", mentions: [{ isSelf: true }],
  }, true);
  const store = { load: (id) => records.get(id) ?? null, save: (meta, history, task) => records.set(meta.id, structuredClone({ meta, history, task })),
    list: () => [...records.values()].map(({ meta }) => meta), acquire: () => ({ ok: true }), release() {}, delete: (id) => records.delete(id) };
  let releaseCoder; const coderHold = new Promise((done) => { releaseCoder = done; });
  let server, submitted = 0;
  const provider = () => ({ id: "fake", model: "fixture", async turn({ system, history, onText, signal }) {
    const name = /PERSONA_(ARCHITECT|MANAGER|CODER)/.exec(system)?.[1].toLowerCase();
    const lastUser = history.findLastIndex((message) => message.role === "user");
    const followupTurn = mode === "followup" && String(history[lastUser]?.content).startsWith("A human explicitly authorized");
    const results = (mode === "followup" ? history.slice(lastUser + 1) : history).filter((message) => message.role === "tool").flatMap((message) => message.results);
    const has = (tool) => results.some((result) => result.name === tool); let tool;
    if (!has("task_intake")) {
      if (name === "coder" && holdCoder) await Promise.race([coderHold, new Promise((done) => signal.addEventListener("abort", done, { once: true }))]);
      tool = { name: "task_intake", input: { intent: "change", goal: "One bounded colleague interaction", constraints: ["private fixture only"],
        acceptance: ["explicit human decision or cancellation"], steps: ["delegate", "decide", "verify"] } };
    } else if (name !== "coder" && !has("agent_contact")) tool = { name: "agent_contact", input: {
      action: "message", recipient: `global:${name === "architect" ? "manager" : "coder"}`, message: `Handle fixture ${mode}` } };
    else if (name === "coder" && mode === "write" && !has("write_file")) tool = { name: "write_file", input: { path: "approved.txt", content: "only after approval\n" } };
    else if (name === "coder" && mode === "followup" && !followupTurn && !has("agent_followup")) tool = { name: "agent_followup", input: {
      action: "grant", candidateId: followups.candidates()[0].id, minutes: 10, maxMessages: 2 } };
    else if (name === "coder" && followupTurn && !has("write_file")) tool = { name: "write_file", input: { path: "followup.txt", content: "explicit follow-up approval\n" } };
    else if (name === "coder" && mode === "coding" && !has("spawn_agent")) tool = { name: "spawn_agent", input: {
      task_name: "implementation", message: "Bounded fixture", runtime: "codex", workspace: "isolated-write" } };
    else if (name === "coder" && mode === "coding" && !has("wait_agent")) tool = { name: "wait_agent", input: { target: "/root/implementation", timeout_ms: 20_000 } };
    else if (name === "coder" && mode !== "coding" && (mode !== "followup" || followupTurn) && !has("ask_user")) tool = { name: "ask_user", input: {
      question: "Which fixture implementation?", options: ["A", "B"], default: "A" } };
    else if (!has("task_checkpoint")) {
      observations.push({ name, results: structuredClone(results) });
      tool = { name: "task_checkpoint", input: { completion: { state: "verified", evidence: ["fixture decision returned without changing its scope"] } } };
    }
    const text = tool ? "" : "Fixture handled."; if (text) onText?.(text);
    return { text, toolUses: tool ? [{ id: `${name}-${tool.name}`, ...tool }] : [], stop: tool ? "tool_use" : "end", usage: { input: 1, output: 1 } };
  } });
  const externalSessions = {
    async createCodingSession() { return { session: { id: nativeId, sourceId: "codex", state: "idle" }, messages: [], readOnly: false, controlMode: "managed" }; },
    async submit(sessionId, _text, sink) {
      submitted++; observations.push({ nativeApproval: await sink.confirm({ question: "Run this native fixture?", allowAlways: true }, sink.signal) });
      observations.push({ nativeAnswers: await sink.askUser(question, sink.signal) });
      return { sessionId, turnId: "private-native-turn", status: sink.signal.aborted ? "interrupted" : "completed", reply: "Native fixture finished." };
    }, async interrupt() {}, async close() {},
  };
  t.after(async () => { releaseCoder(); for (const client of clients) client.ws.close(); await server?.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true }); });
  server = await startServe({ host: "127.0.0.1", port: 0, token: "fixture-token", cwd: repo }, {
    version: "test", providerId: "fake", model: "fixture", buildSessionProvider: async () => provider(), spawnSubagent: async () => "unused",
    sandbox: "off", approval: approvalMode, guardian: { enabled: false }, quietDiscovery: true, store, discoveryHome: home, agentTeamHome: home,
    externalSessions, remoteCommandLedger: new RemoteCommandLedger({ home }), externalUserQuestionTimeoutMs: timeout, pendingInputReconnectGraceMs: 800,
    computerSettings: () => ({ mode: "off", apps: [] }), saveComputerSettings: (input) => input,
    runtimeInfo: () => ({ providerId: "fake", model: "fixture", profileId: "personal", spaceId: "personal" }),
  });
  const attach = async (declared = clientFeatures) => {
    const client = await connect(server.port, t.signal); clients.push(client);
    await client.call("initialize", { token: "fixture-token", capabilities: { features: declared } }); return client;
  };
  const client = await attach(), created = await client.call("session.create", { cwd: repo, agentRef: "global:architect" });
  assert.ok(created.result, JSON.stringify(created)); const parent = created.result.sessionId;
  const sending = client.call("session.send", { sessionId: parent, text: `Handle fixture ${mode} through Manager and Cora.` });
  return { client, parent, sending, attach, repo, records, observations, releaseCoder, submitted: () => submitted, followups };
}
