// hara serve end-to-end over a REAL WebSocket: auth, session lifecycle, streamed events, approval
// round-trip through the real agent loop (fake provider + hermetic in-memory store; write_file in a tmp
// dir under approval "suggest" forces the confirm gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { historyForClient, serveAutoCompactDecision, startServe } from "../dist/serve/server.js";
import { addJob, cronDir, findJob, loadJobs, removeJob, saveJobs } from "../dist/cron/store.js";
import { createTaskExecution, finishTaskExecution } from "../dist/session/task.js";
import { INTERJECT_PREFIX } from "../dist/agent/reminders.js";
import { orgRolesDir } from "../dist/org/roles.js";

test("serve client history hides internal steering triage wrappers", () => {
  const history = historyForClient([
    { role: "user", content: "original request" },
    { role: "user", content: `${INTERJECT_PREFIX}\n\nonly the user's refinement` },
    { role: "assistant", text: "done", toolUses: [], stop: "end" },
  ]);
  assert.deepEqual(history, [
    { role: "user", text: "original request" },
    { role: "user", text: "only the user's refinement" },
    { role: "assistant", text: "done" },
  ]);
});

test("serve auto-compaction policy is opt-in for embedders and rejects unsafe caps", () => {
  assert.equal(serveAutoCompactDecision("fake-1", 75, 4, undefined).compact, false);
  assert.equal(serveAutoCompactDecision("fake-1", 75, 3, { enabled: true, tokenCap: 50 }).compact, false);
  assert.equal(serveAutoCompactDecision("fake-1", 75, 4, { enabled: true, tokenCap: 50 }).compact, true);
  assert.equal(serveAutoCompactDecision("fake-1", 75, 4, { enabled: false, tokenCap: 50 }).compact, false);
  assert.equal(
    serveAutoCompactDecision("fake-1", 75, 4, { enabled: true, tokenCap: Number.NaN }).compact,
    false,
    "a corrupt cap falls back to the production default instead of compacting every turn",
  );
});

/** Tiny JSON-RPC-over-ws test client: request/response correlation + notification capture. */
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map();
    const events = [];
    const waiters = [];
    let nextId = 1;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.id !== undefined && m.id !== null && pending.has(m.id)) {
        const { res } = pending.get(m.id);
        pending.delete(m.id);
        res(m);
      } else if (m.method) {
        events.push(m);
        for (const w of waiters.splice(0)) w();
      }
    });
    ws.on("open", () =>
      resolve({
        ws,
        events,
        call: (method, params) =>
          new Promise((res) => {
            const id = nextId++;
            pending.set(id, { res });
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          }),
        waitEvent: (method, timeoutMs = 5000) =>
          new Promise((res, rej) => {
            const scan = () => events.find((e) => e.method === method);
            const hit = scan();
            if (hit) return res(hit);
            const t = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), timeoutMs);
            const tick = () => {
              const h = scan();
              if (h) {
                clearTimeout(t);
                res(h);
              } else waiters.push(tick);
            };
            waiters.push(tick);
          }),
        close: () => ws.close(),
      }),
    );
    ws.on("error", reject);
  });
}

const memStore = () => {
  const files = new Map();
  return {
    saved: files,
    load: (id) => files.get(id) ?? null,
    save: (meta, history, task) => files.set(meta.id, {
      meta: { ...meta },
      history: structuredClone(history),
      ...(task ? { task: structuredClone(task) } : {}),
    }),
    list: () => [...files.values()].map((d) => d.meta),
    acquire: () => ({ ok: true }),
    release: () => {},
    delete: (id) => files.delete(id),
  };
};

/** Fake provider: emits private reasoning, streams "hel"+"lo", and ends. */
const textProvider = {
  id: "fake",
  model: "fake-1",
  async turn({ onText, onReasoning }) {
    onReasoning?.("private chain of thought must not cross Serve");
    onText("hel");
    onText("lo");
    return { text: "hello", toolUses: [], stop: "end", usage: { input: 3, output: 2 } };
  },
};

/** Fake provider: first records its task understanding, then asks to write a file (forcing the approval
 * gate under "suggest"), then ends. This exercises the real understanding → execution boundary instead of
 * relying on the runtime to let a raw request jump directly into a side effect. */
const toolProvider = () => {
  let n = 0;
  return {
    id: "fake",
    model: "fake-1",
    async turn({ onText }) {
      if (n++ === 0) {
        return {
          text: "",
          toolUses: [{
            id: "brief1",
            name: "task_intake",
            input: {
              intent: "change",
              goal: "write approved.txt with the requested content",
              constraints: ["write only inside the test workspace"],
              acceptance: ["approved.txt contains hi"],
              steps: ["record the task brief", "request approval and write the file", "report completion"],
            },
          }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      if (n === 2) {
        return { text: "", toolUses: [{ id: "t1", name: "write_file", input: { path: "approved.txt", content: "hi" } }], stop: "tool_use", usage: { input: 1, output: 1 } };
      }
      if (n === 3) {
        return {
          text: "",
          toolUses: [{
            id: "receipt1",
            name: "task_checkpoint",
            input: {
              current_step: "",
              blocked_step: "",
              block_reason: "",
              next_step: "",
              completion: {
                state: "verified",
                evidence: ["approved.txt was written and read back with the exact content hi"],
              },
            },
          }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      onText("done");
      return { text: "done", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
};

const baseDeps = (provider, store, approval = "full-auto") => ({
  version: "0.0.0-test",
  providerId: "fake",
  model: "fake-1",
  buildSessionProvider: async () => provider,
  spawnSubagent: async () => "(subagents disabled in test)",
  sandbox: "off",
  approval,
  store,
  spaces: () => ({
    activeId: "personal",
    activeProfileId: "personal",
    activeSource: "default",
    switchLocked: false,
    spaces: [{
      id: "personal",
      name: "Personal",
      kind: "personal",
      profileId: "personal",
      active: true,
      authoritative: true,
      agentProfilePermission: "edit",
    }],
    vision: {
      enabled: false,
      apiKeyConfigured: false,
      usesManagedCredential: false,
      editable: true,
      authorized: true,
    },
  }),
  useSpace: () => ({
    activeId: "personal",
    activeProfileId: "personal",
    activeSource: "default",
    switchLocked: false,
    spaces: [{
      id: "personal",
      name: "Personal",
      kind: "personal",
      profileId: "personal",
      active: true,
      authoritative: true,
      agentProfilePermission: "edit",
    }],
  }),
  quietDiscovery: true,
});

test("serve e2e: revoked organization access returns a safe re-enrollment error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-org-auth-"));
  const store = memStore();
  const deps = {
    ...baseDeps(textProvider, store),
    buildSessionProvider: async () => {
      throw new Error("organization role sync failed with HTTP 401");
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const client = await connect(srv.port);
  try {
    await client.call("initialize", { token: "tok" });
    const created = await client.call("session.create", { cwd: dir });
    assert.equal(created.error.code, -32001);
    assert.match(created.error.message, /re-enroll/i);
    assert.doesNotMatch(created.error.message, /HTTP 401|role sync/i);
  } finally {
    client.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const assertPortCanListen = (port) => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
});

test("serve exposes explicit organization learning submit/sync without exposing device credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-learning-"));
  const calls = [];
  const candidate = {
    version: 1,
    id: "local-learning",
    clientId: "local-learning",
    remoteId: "remote-learning",
    patternKey: "agent.authorized_action_execution",
    kind: "action_ownership",
    scope: "organization",
    summary: "Execute authorized work and verify it.",
    status: "submitted",
    stability: "stable",
    occurrenceCount: 3,
    distinctTaskCount: 2,
    evidence: [],
    revision: 2,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    sourceVersion: "0.150.0",
  };
  const deps = {
    ...baseDeps(textProvider, memStore()),
    runtimeInfo: () => ({ providerId: "hara-gateway", model: "managed", profileId: "acme", profileKind: "gateway", spaceId: "org:acme" }),
    organizationLearningSubmit: async (profileId, spaceId, candidateId, cwd) => {
      calls.push(["submit", profileId, spaceId, candidateId, cwd]);
      return { remoteId: "remote-learning", status: "pending", revision: 1, candidate };
    },
    organizationLearningSync: async (profileId, spaceId, cwd) => {
      calls.push(["sync", profileId, spaceId, cwd]);
      return { version: 4, learnings: [{ ...candidate, status: "approved" }] };
    },
  };
  const server = await startServe({ host: "127.0.0.1", port: 0, token: "learning-token", cwd: dir }, deps);
  const client = await connect(server.port);
  try {
    const initialized = await client.call("initialize", { token: "learning-token" });
    assert.ok(initialized.result.capabilities.methods.includes("learning.submit"));
    assert.ok(initialized.result.capabilities.methods.includes("learning.sync"));
    assert.ok(initialized.result.capabilities.features.includes("learning.organization-review.v1"));

    const submitted = await client.call("learning.submit", { id: "local-learning" });
    assert.equal(submitted.result.status, "pending");
    const synced = await client.call("learning.sync", {});
    assert.equal(synced.result.version, 4);
    assert.deepEqual(calls, [
      ["submit", "acme", "org:acme", "local-learning", dir],
      ["sync", "acme", "org:acme", dir],
    ]);
    assert.equal(JSON.stringify(submitted).includes("device-token"), false);
  } finally {
    client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const hangingCompactProvider = () => {
  let calls = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let compactSignal;
  let finishCompact;
  return {
    provider: {
      id: "fake",
      model: "fake-1",
      turn({ onText, signal }) {
        if (calls++ === 0) {
          onText("ready");
          return Promise.resolve({ text: "ready", toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
        }
        compactSignal = signal;
        markStarted();
        return new Promise((resolve) => {
          // Intentionally ignore abort: Serve must settle its logical operation while retaining the
          // session lock until this physical provider Promise is explicitly released by the test.
          finishCompact = () => resolve({ text: "late summary", toolUses: [], stop: "end" });
        });
      },
    },
    started,
    signal: () => compactSignal,
    finish: () => finishCompact?.(),
  };
};

test("serve discovery: private atomic replacement, symlink safety, and instance-owned cleanup", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-serve-home-"));
  const haraDir = join(home, ".hara");
  const discoveryPath = join(haraDir, "serve.json");
  const victimPath = join(home, "victim.txt");
  mkdirSync(haraDir, { mode: 0o777 });
  chmodSync(haraDir, 0o777);
  writeFileSync(discoveryPath, "legacy", { mode: 0o644 });
  chmodSync(discoveryPath, 0o644);
  const deps = { ...baseDeps(textProvider, memStore()), quietDiscovery: false, discoveryHome: home };
  let legacy;
  let older;
  let newer;
  try {
    legacy = await startServe({ host: "127.0.0.1", port: 0, token: "legacy-token", cwd: home }, deps);
    assert.equal(statSync(haraDir).mode & 0o777, 0o700, "legacy ~/.hara mode is tightened");
    assert.equal(statSync(discoveryPath).mode & 0o777, 0o600, "legacy 0644 discovery is replaced privately");
    assert.equal(JSON.parse(readFileSync(discoveryPath, "utf8")).token, "legacy-token");
    await legacy.close();
    legacy = undefined;

    writeFileSync(victimPath, "do not follow me", { mode: 0o644 });
    symlinkSync(victimPath, discoveryPath);
    older = await startServe({ host: "127.0.0.1", port: 0, token: "older-token", cwd: home }, deps);
    const olderRecord = JSON.parse(readFileSync(discoveryPath, "utf8"));
    assert.equal(lstatSync(discoveryPath).isSymbolicLink(), false, "serve.json symlink inode was replaced");
    assert.equal(readFileSync(victimPath, "utf8"), "do not follow me", "symlink target was untouched");
    assert.ok(olderRecord.instanceId, "discovery is stamped with an instance nonce");

    newer = await startServe({ host: "127.0.0.1", port: 0, token: "newer-token", cwd: home }, deps);
    const newerRecord = JSON.parse(readFileSync(discoveryPath, "utf8"));
    assert.notEqual(newerRecord.instanceId, olderRecord.instanceId);
    await older.close();
    older = undefined;
    assert.equal(JSON.parse(readFileSync(discoveryPath, "utf8")).instanceId, newerRecord.instanceId, "old close preserved newer discovery");
    await newer.close();
    newer = undefined;
    assert.equal(existsSync(discoveryPath), false, "owning instance removes its discovery on close");
  } finally {
    await legacy?.close();
    await older?.close();
    await newer?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("serve discovery: a write failure closes the already-listening socket", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-serve-bad-home-"));
  writeFileSync(join(home, ".hara"), "not a directory");
  const port = await reservePort();
  try {
    await assert.rejects(
      startServe(
        { host: "127.0.0.1", port, token: "tok", cwd: home },
        { ...baseDeps(textProvider, memStore()), quietDiscovery: false, discoveryHome: home },
      ),
      /EEXIST|ENOTDIR|directory/i,
    );
    await assertPortCanListen(port);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("serve Desk RPCs advertise only with complete support and pin every remote read to profileId", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-desk-"));
  const calls = [];
  const now = 1_700_000_000_000;
  const agent = {
    id: "agent-a",
    name: "Desk A",
    owner: "owner-a",
    client: "hara-cli",
    role: "member",
    createdAt: now,
    lastSeen: now,
    revoked: false,
  };
  const task = {
    id: "t_abcd",
    kind: "dispatch",
    title: "Ship",
    excerpt: "Deploy",
    risk: "low",
    state: "open",
    createdBy: "agent-a",
    claimedBy: null,
    ackedBy: null,
    createdAt: now,
    updatedAt: now,
  };
  const deps = {
    ...baseDeps(textProvider, memStore()),
    deskConnections: () => ({
      connections: [{
        profileId: "org-a",
        configured: true,
        bindingRevision: "binding-revision-a",
        host: "desk.example.test",
        agentId: "agent-a",
        owner: "owner-a",
      }],
      legacyUnbound: false,
    }),
    deskSnapshot: async (profileId, state) => {
      calls.push({ method: "snapshot", profileId, state });
      return {
        profileId,
        fetchedAt: now,
        me: agent,
        tasks: [task],
        agents: [agent],
        events: [],
        circles: [],
        truncated: false,
      };
    },
    deskTask: async (profileId, taskId) => {
      calls.push({ method: "task", profileId, taskId });
      return { profileId, task: { ...task, id: taskId, body: "Deploy" }, events: [] };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const client = await connect(srv.port);
  try {
    const init = await client.call("initialize", { token: "tok" });
    for (const method of ["desk.connections.list", "desk.snapshot", "desk.task.get"]) {
      assert.ok(init.result.capabilities.methods.includes(method), `${method} advertised`);
    }
    assert.ok(init.result.capabilities.features.includes("collaboration.remote.v1"));
    assert.equal(calls.length, 0, "initialize performs no Desk remote read");

    const connections = await client.call("desk.connections.list", {});
    assert.equal(connections.result.connections[0].profileId, "org-a");
    assert.equal(connections.result.connections[0].bindingRevision, "binding-revision-a");
    assert.equal(calls.length, 0, "connection discovery remains local");

    const snapshot = await client.call("desk.snapshot", { profileId: "org-a", state: "claimed" });
    assert.equal(snapshot.result.profileId, "org-a");
    assert.deepEqual(calls[0], { method: "snapshot", profileId: "org-a", state: "claimed" });

    const details = await client.call("desk.task.get", { profileId: "org-a", taskId: "t_abcd" });
    assert.equal(details.result.task.id, "t_abcd");
    assert.deepEqual(calls[1], { method: "task", profileId: "org-a", taskId: "t_abcd" });

    assert.equal((await client.call("desk.snapshot", { profileId: "../org-b" })).error.code, -32602);
    assert.equal((await client.call("desk.task.get", { profileId: "org-a", taskId: "../whoami" })).error.code, -32602);
    assert.doesNotMatch(JSON.stringify({ snapshot, details, connections }), /token|secret/i);
  } finally {
    client.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: auth gate → create → send streams text events and returns the reply", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-"));
  const store = memStore();
  const srv = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    { ...baseDeps(textProvider, store), artifactHome: dir },
  );
  const c = await connect(srv.port);
  let automationId;
  let timezoneAutomationId;
  let pastOneShotId;
  let legacyIntervalId;
  let unchangedCronId;
  let pendingCronId;
  try {
    // unauthenticated calls bounce; bad token bounces
    const denied = await c.call("session.list", {});
    assert.equal(denied.error.code, -32001);
    const badTok = await c.call("initialize", { token: "wrong" });
    assert.equal(badTok.error.code, -32001);
    const init = await c.call("initialize", { token: "tok" });
    assert.equal(init.result.protocol, 1);
    assert.equal(init.result.model, "fake-1");
    assert.ok(init.result.capabilities.methods.includes("automation.list"), "capabilities advertised");
    for (const method of [
      "automation.validate",
      "automation.update",
      "automation.run",
      "automation.scheduler.install",
    ]) {
      assert.ok(init.result.capabilities.methods.includes(method), `${method} advertised`);
    }
    assert.ok(init.result.capabilities.methods.includes("session.steer"), "expected-turn steering advertised");
    assert.ok(init.result.capabilities.methods.includes("session.submit"), "atomic turn-input routing advertised");
    assert.ok(init.result.capabilities.events.includes("event.task_state"), "typed task lifecycle event advertised");
    assert.ok(init.result.capabilities.events.includes("event.workforce_state"), "typed workforce snapshot event advertised");
    assert.ok(init.result.capabilities.events.includes("event.surface"), "typed visual surface event advertised");
    assert.deepEqual(
      init.result.capabilities.features,
      [
        "composer.attachments.v1",
        "models.capabilities.v1",
        "sessions.readonly-history.v1",
        "sessions.cross-profile-fork.v1",
        "sessions.space-route.v1",
        "learning.review.v1",
        "agent.action-ownership.v1",
        "agent.public-profile-edit.v1",
        "agent.blueprint-provenance.v1",
        "external.sessions.metadata.v1",
        "external.sessions.interaction.v1",
        "external.sessions.live-control.v1",
        "external.sessions.runtime.v1",
        "external.sessions.native-resume.v1",
        "external.sessions.launch-options.v1",
        "external.sessions.terminal-mirror.v1",
        "external.sessions.terminal-stream.v2",
        "external.sessions.runtime-remove.v1",
        "spaces.tenant-boundary.v1",
      ],
      "persistent clients can negotiate attachments, model descriptors, safe recovery, explicit Space routing, reviewed learning, action ownership, Agent profiles, verified blueprints, Hara Live runtime control, and tenant Spaces",
    );
    for (const method of ["spaces.list", "spaces.use", "agents.create", "agents.update-profile", "agents.archive"]) {
      assert.ok(init.result.capabilities.methods.includes(method), `${method} advertised`);
    }
    for (const method of [
      "artifact.import",
      "artifact.commit",
      "artifact.revert",
      "artifact.validate",
      "artifact.export",
      "artifact.list",
      "artifact.get",
      "artifact.revisions",
      "presentation.create",
      "presentation.import",
      "presentation.update",
      "presentation.get",
      "presentation.validate",
      "presentation.export",
      "presentation.render",
      "presentation.preview",
      "presentation.preview-file",
    ]) {
      assert.ok(init.result.capabilities.methods.includes(method), `${method} advertised`);
    }

    const artifactSource = join(dir, "brief.docx");
    writeFileSync(artifactSource, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]));
    const importedArtifact = await c.call("artifact.import", {
      sourcePath: artifactSource,
      title: "Client brief",
    });
    assert.equal(importedArtifact.result.artifact.kind, "document");
    assert.equal(importedArtifact.result.artifact.title, "Client brief");
    const artifactId = importedArtifact.result.artifact.artifactId;
    const artifactList = await c.call("artifact.list", {});
    assert.equal(artifactList.result.artifacts.some((artifact) => artifact.artifactId === artifactId), true);
    const artifactDetails = await c.call("artifact.get", { artifactId });
    assert.equal(artifactDetails.result.currentRevision.artifactId, artifactId);
    const artifactRevisions = await c.call("artifact.revisions", { artifactId });
    assert.equal(artifactRevisions.result.revisions.length, 1);
    const firstRevisionId = artifactDetails.result.currentRevision.revisionId;
    const artifactValidation = await c.call("artifact.validate", {
      artifactId,
      revisionId: firstRevisionId,
    });
    assert.equal(artifactValidation.result.report.status, "pass");
    assert.equal(artifactValidation.result.report.revisionId, firstRevisionId);
    const artifactExportPath = join(dir, "brief-export.docx");
    const artifactExport = await c.call("artifact.export", {
      artifactId,
      revisionId: firstRevisionId,
      validationReportId: artifactValidation.result.report.reportId,
      destinationPath: artifactExportPath,
    });
    assert.equal(artifactExport.result.receipt.fidelity, "roundtrip");
    assert.deepEqual(readFileSync(artifactExportPath), readFileSync(artifactSource));
    const duplicateArtifactExport = await c.call("artifact.export", {
      artifactId,
      revisionId: firstRevisionId,
      validationReportId: artifactValidation.result.report.reportId,
      destinationPath: artifactExportPath,
    });
    assert.equal(duplicateArtifactExport.error.code, -32005);
    const artifactEdit = join(dir, "brief-edited.docx");
    writeFileSync(artifactEdit, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x02]));
    const committedArtifact = await c.call("artifact.commit", {
      artifactId,
      baseRevisionId: firstRevisionId,
      sourcePath: artifactEdit,
      changedPaths: ["document/body"],
    });
    assert.equal(committedArtifact.result.currentRevision.parentRevisionId, firstRevisionId);
    assert.equal(committedArtifact.result.currentRevision.actor, "user");
    const staleArtifactCommit = await c.call("artifact.commit", {
      artifactId,
      baseRevisionId: firstRevisionId,
      sourcePath: artifactEdit,
    });
    assert.equal(staleArtifactCommit.error.code, -32005);
    const revertedArtifact = await c.call("artifact.revert", {
      artifactId,
      baseRevisionId: committedArtifact.result.currentRevision.revisionId,
      targetRevisionId: firstRevisionId,
    });
    assert.equal(
      revertedArtifact.result.currentRevision.parentRevisionId,
      committedArtifact.result.currentRevision.revisionId,
    );
    assert.equal(revertedArtifact.result.currentRevision.contentDigest, artifactDetails.result.content.sha256);
    const finalArtifactRevisions = await c.call("artifact.revisions", { artifactId });
    assert.equal(finalArtifactRevisions.result.revisions.length, 3);
    const badArtifactImport = await c.call("artifact.import", { sourcePath: "relative.docx" });
    assert.equal(badArtifactImport.error.code, -32602);

    const createdPresentation = await c.call("presentation.create", { title: "Release evidence" });
    assert.equal(createdPresentation.result.artifact.kind, "presentation");
    assert.equal(createdPresentation.result.content.extension, ".hpres");
    assert.equal(createdPresentation.result.project.slides.length, 1);
    const presentationId = createdPresentation.result.artifact.artifactId;
    const presentationRevisionId = createdPresentation.result.currentRevision.revisionId;
    const presentationDetails = await c.call("presentation.get", { artifactId: presentationId });
    assert.equal(presentationDetails.result.project.title, "Release evidence");
    const editedPresentationProject = {
      ...presentationDetails.result.project,
      title: "Release evidence — edited",
      slides: presentationDetails.result.project.slides.map((slide, index) => index === 0
        ? { ...slide, takeawayTitle: "One presenter, one saved revision" }
        : slide),
    };
    const renderedDraft = await c.call("presentation.render", { project: editedPresentationProject });
    assert.match(renderedDraft.result.html, /One presenter, one saved revision/);
    const updatedPresentation = await c.call("presentation.update", {
      artifactId: presentationId,
      baseRevisionId: presentationRevisionId,
      project: editedPresentationProject,
    });
    assert.equal(updatedPresentation.result.artifact.title, "Release evidence — edited");
    assert.equal(updatedPresentation.result.currentRevision.parentRevisionId, presentationRevisionId);
    const updatedPresentationRevisionId = updatedPresentation.result.currentRevision.revisionId;
    const stalePresentationUpdate = await c.call("presentation.update", {
      artifactId: presentationId,
      baseRevisionId: presentationRevisionId,
      project: editedPresentationProject,
    });
    assert.equal(stalePresentationUpdate.error.code, -32005);
    const presentationValidation = await c.call("presentation.validate", {
      artifactId: presentationId,
      revisionId: updatedPresentationRevisionId,
    });
    assert.equal(presentationValidation.result.report.status, "pass");
    assert.equal(presentationValidation.result.report.validatorId, "hara.office.presentation");
    const presentationPreview = await c.call("presentation.preview-file", {
      artifactId: presentationId,
      revisionId: updatedPresentationRevisionId,
    });
    const presentationPreviewText = readFileSync(presentationPreview.result.path, "utf8");
    assert.match(presentationPreviewText, /Content-Security-Policy/);
    const presentationInlinePreview = await c.call("presentation.preview", {
      artifactId: presentationId,
      revisionId: updatedPresentationRevisionId,
    });
    assert.equal(presentationInlinePreview.result.html, presentationPreviewText);
    const presentationHtmlPath = join(dir, "release-evidence.html");
    const presentationExport = await c.call("presentation.export", {
      artifactId: presentationId,
      revisionId: updatedPresentationRevisionId,
      validationReportId: presentationValidation.result.report.reportId,
      destinationPath: presentationHtmlPath,
      format: "html",
    });
    assert.equal(presentationExport.result.receipt.fidelity, "visual-fidelity");
    assert.match(readFileSync(presentationHtmlPath, "utf8"), /@media print/);

    const slidevSource = join(dir, "release-review.md");
    writeFileSync(slidevSource, "---\ntitle: Release review\n---\n\n# Evidence is complete\n\n- Tests passed\n- Rollback rehearsed\n");
    const importedPresentation = await c.call("presentation.import", { sourcePath: slidevSource });
    assert.equal(importedPresentation.result.project.title, "Release review");
    assert.equal(importedPresentation.result.artifact.origin, "slidev-import");

    const created = await c.call("session.create", {});
    const sid = created.result.sessionId;
    assert.ok(sid, "got a session id");

    const sent = await c.call("session.send", { sessionId: sid, text: "hi there" });
    assert.equal(sent.result.reply, "hello");
    assert.equal(sent.result.usage.input, 3);
    const deltas = c.events.filter((e) => e.method === "event.text").map((e) => e.params.delta).join("");
    assert.equal(deltas, "hello", "text streamed as events");
    assert.equal(c.events.some((e) => e.method === "event.reasoning"), false);
    assert.equal(JSON.stringify(c.events).includes("private chain of thought"), false);
    await c.waitEvent("event.turn_end");
    const taskStates = c.events.filter((e) => e.method === "event.task_state").map((e) => e.params);
    assert.equal(taskStates[0].state, "running");
    assert.equal(taskStates[0].phase, "starting");
    assert.equal(
      new Set(taskStates.map((state) => state.streamId)).size,
      1,
      "one server run emits one ordered task-state stream",
    );
    assert.ok(
      taskStates.every((state) => Number.isSafeInteger(state.sequence) && state.sequence > 0),
      "every task state has a valid stream sequence",
    );
    assert.ok(
      taskStates.every((state, index) => index === 0 || state.sequence > taskStates[index - 1].sequence),
      "task-state sequences strictly increase",
    );
    assert.ok(taskStates.some((state) => state.phase === "responding"), "stream phase is explicit");
    assert.ok(taskStates.some((state) => state.phase === "thinking"), "private reasoning still updates the safe typed phase");
    assert.equal(taskStates.at(-1).state, "completed");
    assert.equal(taskStates.at(-1).taskStatus, "completed");
    assert.equal(taskStates.at(-1).phase, "finished");
    const workforceStates = c.events.filter((e) => e.method === "event.workforce_state").map((e) => e.params);
    assert.ok(workforceStates.length > 0, "root execution emits workforce snapshots");
    assert.ok(workforceStates.every((state) => state.mode === "snapshot" && state.actors[0]?.kind === "root"));
    assert.ok(workforceStates.every((state, index) => index === 0 || state.sequence > workforceStates[index - 1].sequence));
    assert.doesNotMatch(JSON.stringify(workforceStates), /hi there|private chain of thought/);

    // persisted through the (injected) store + listed
    assert.ok(store.saved.get(sid), "session persisted after the turn");
    const listed = await c.call("session.list", {});
    assert.equal(listed.result.sessions.length, 1);

    // unknown session / busy / params errors
    const nosess = await c.call("session.send", { sessionId: "nope", text: "x" });
    assert.equal(nosess.error.code, -32003);
    const badParams = await c.call("session.send", { sessionId: sid });
    assert.equal(badParams.error.code, -32602);

    // plugins/skills surface (P2): shape-only — contents depend on the machine's ~/.hara
    const plugins = await c.call("plugins.list", {});
    assert.ok(Array.isArray(plugins.result.plugins), "plugins.list returns an array");
    const badSet = await c.call("plugins.set", { name: "definitely-not-installed-xyz", enabled: false });
    assert.equal(badSet.error.code, -32602, "plugins.set on unknown plugin → params error (never writes config)");
    const skills = await c.call("skills.list", {});
    assert.ok(Array.isArray(skills.result.skills), "skills.list returns an array");
    const auto = await c.call("automation.list", {});
    assert.ok(Array.isArray(auto.result.jobs) && Array.isArray(auto.result.sessions), "automation.list returns jobs + sessions");
    assert.equal(auto.result.sessionPage.hasMore, false);
    assert.equal(auto.result.sessionPage.limit, 50);
    assert.equal(typeof auto.result.scheduler?.installed, "boolean");
    assert.equal(typeof auto.result.scheduler?.supported, "boolean");
    // sessions created through serve are stamped interactive → never leak into the automation timeline
    assert.equal(auto.result.sessions.some((s) => s.id === sid), false, "serve session not in automation list");
    for (let index = 0; index < 55; index++) {
      const occurrenceAt = new Date(Date.UTC(2026, 6, 24, 0, 0, index)).toISOString();
      store.save({
        id: `automation-history-${String(index).padStart(2, "0")}`,
        cwd: dir,
        provider: "fake",
        model: "fake-1",
        title: `automation run ${index}`,
        createdAt: occurrenceAt,
        updatedAt: occurrenceAt,
        source: "cron",
        sourceName: "paged automation",
        jobId: "paged-automation",
        ...(index === 54
          ? {
              automationRun: {
                status: "error",
                startedAt: occurrenceAt,
                finishedAt: new Date(Date.UTC(2026, 6, 24, 0, 1, index)).toISOString(),
                durationMs: 60_000,
                error: "agent repeated the same failing call",
              },
            }
          : {}),
      }, []);
    }
    const firstHistoryPage = await c.call("automation.list", { sessionLimit: 20 });
    assert.equal(firstHistoryPage.result.sessions.length, 20);
    assert.equal(firstHistoryPage.result.sessionPage.hasMore, true);
    assert.ok(firstHistoryPage.result.sessionPage.nextCursor);
    const failedOccurrence = firstHistoryPage.result.sessions.find(
      (session) => session.id === "automation-history-54",
    );
    assert.equal(failedOccurrence.status, "error");
    assert.equal(failedOccurrence.error, "agent repeated the same failing call");
    assert.equal(failedOccurrence.durationMs, 60_000);
    assert.equal(failedOccurrence.needsAttention, true);
    const secondHistoryPage = await c.call("automation.list", {
      sessionLimit: 20,
      sessionCursor: firstHistoryPage.result.sessionPage.nextCursor,
    });
    assert.equal(secondHistoryPage.result.sessions.length, 20);
    assert.equal(
      firstHistoryPage.result.sessions.some((first) =>
        secondHistoryPage.result.sessions.some((second) => second.id === first.id)),
      false,
      "automation history pages do not repeat sessions",
    );
    const badHistoryCursor = await c.call("automation.list", {
      sessionCursor: "forged-cursor",
    });
    assert.equal(badHistoryCursor.error.code, -32602);

    const validSchedule = await c.call("automation.validate", {
      schedule: "0 9 * * 1-5",
      tz: "Asia/Shanghai",
    });
    assert.equal(validSchedule.result.schedule, "0 9 * * 1-5");
    assert.match(validSchedule.result.description, /cron/);
    assert.ok(
      Array.isArray(validSchedule.result.nextRuns)
        && validSchedule.result.nextRuns.length <= 3,
      "validation returns only the preview entries that fit its latency budget",
    );
    assert.equal(
      validSchedule.result.nextRuns.length < 3,
      validSchedule.result.nextRunDeferred === true,
      "a partial cron preview explicitly advertises deferred calculation",
    );
    assert.ok(validSchedule.result.nextRuns.every((value) => Number.isFinite(value)));
    const unchangedCronLastRunAt = Date.now();
    const unchangedCron = addJob({
      name: "unchanged cron validation",
      schedule: { kind: "cron", expr: "* * * * *" },
      task: "do not replay the same minute",
      mode: "command",
      cwd: dir,
      createdAt: unchangedCronLastRunAt - 60_000,
      lastRunAt: unchangedCronLastRunAt,
      lastStatus: "ok",
    });
    unchangedCronId = unchangedCron.id;
    const unchangedCronValidation = await c.call("automation.validate", {
      id: unchangedCron.id,
      schedule: "* * * * *",
    });
    assert.ok(
      Math.floor(unchangedCronValidation.result.nextRuns[0] / 60_000)
        > Math.floor(unchangedCronLastRunAt / 60_000),
      "validating an unchanged cron keeps lastRunAt and never previews the completed current minute",
    );
    const pendingAt = Date.now() - 1_000;
    const pendingCron = addJob({
      name: "pending cron validation",
      schedule: { kind: "cron", expr: "* * * * *" },
      task: "show the durable catch-up",
      mode: "command",
      cwd: dir,
      createdAt: pendingAt,
    });
    pendingCronId = pendingCron.id;
    const pendingValidationStartedAt = Date.now();
    const pendingCronValidation = await c.call("automation.validate", {
      id: pendingCron.id,
      schedule: "* * * * *",
    });
    const pendingValidationFinishedAt = Date.now();
    assert.ok(
      pendingCronValidation.result.nextRuns[0] >= pendingValidationStartedAt
        && pendingCronValidation.result.nextRuns[0] <= pendingValidationFinishedAt,
      "validating an unchanged cron preserves an already-due pending occurrence",
    );
    const validationStartedAt = Date.now();
    const boundedSchedule = await c.call("automation.validate", {
      schedule: "0 0 31 2 *",
      tz: "Asia/Shanghai",
    });
    assert.equal(boundedSchedule.result.nextRunDeferred, true);
    assert.ok(
      Date.now() - validationStartedAt < 1_000,
      "sparse zoned schedule validation cannot monopolize Serve's event loop",
    );
    const outOfRangeOneShot = await c.call("automation.add", {
      name: "must not persist",
      schedule: "in 100000000d",
      task: "never",
      mode: "command",
    });
    assert.equal(outOfRangeOneShot.error.code, -32602);
    assert.equal(
      (await c.call("automation.list", {})).result.jobs.some((job) => job.name === "must not persist"),
      false,
      "an unserializable one-shot is rejected before it can poison later list calls",
    );
    const extendedYearOneShot = await c.call("automation.validate", {
      schedule: "in 3000000d",
    });
    assert.equal(
      extendedYearOneShot.error.code,
      -32602,
      "Serve rejects one-shots that would emit a Desktop-incompatible signed six-digit ISO year",
    );
    const offsetExtendedYearOneShot = await c.call("automation.validate", {
      schedule: "9999-12-31T23:59:59-01:00",
    });
    assert.equal(
      offsetExtendedYearOneShot.error.code,
      -32602,
      "an ISO timezone offset cannot move an accepted four-digit timestamp into year 10000",
    );
    const legacyInterval = addJob({
      name: "legacy long interval",
      schedule: {
        kind: "every",
        everyMs: 3_000_000 * 86_400_000,
        display: "every 3000000d",
      },
      task: "legacy check",
      mode: "command",
      cwd: dir,
      createdAt: Date.now(),
    });
    legacyIntervalId = legacyInterval.id;
    const listedLegacyInterval = (await c.call("automation.list", {})).result.jobs.find(
      (job) => job.id === legacyIntervalId,
    );
    assert.equal(
      "nextRunAt" in listedLegacyInterval,
      false,
      "legacy intervals cannot emit timestamps outside Desktop's supported year range",
    );
    assert.equal(listedLegacyInterval.nextRunDeferred, true);
    const validatedLegacyInterval = await c.call("automation.validate", {
      id: legacyIntervalId,
      schedule: listedLegacyInterval.scheduleSpec,
    });
    assert.equal(validatedLegacyInterval.result.schedule, "every 3000000d");
    assert.deepEqual(validatedLegacyInterval.result.nextRuns, []);
    assert.equal(validatedLegacyInterval.result.nextRunDeferred, true);
    const editedLegacyInterval = await c.call("automation.update", {
      id: legacyIntervalId,
      name: "legacy long interval renamed",
      schedule: listedLegacyInterval.scheduleSpec,
      task: "legacy check",
      mode: "command",
    });
    assert.equal(
      editedLegacyInterval.result.id,
      legacyIntervalId,
      "a pre-0.134.7 oversized interval can round-trip for metadata edits",
    );
    const invalidTimezone = await c.call("automation.validate", {
      schedule: "0 9 * * *",
      tz: "Not/A_Timezone",
    });
    assert.equal(invalidTimezone.error.code, -32602);

    const privateDelivery = "webhook:https://example.invalid/hooks/SECRET_PATH?token=PRIVATE_QUERY";
    const quietAutomation = await c.call("automation.add", {
      name: `quiet monitor ${Date.now()}`,
      schedule: "every 5m",
      task: "check",
      mode: "command",
      deliver: privateDelivery,
      deliverMode: "on-output",
      alertAfter: 2,
    });
    automationId = quietAutomation.result.id;
    assert.ok(automationId, "automation.add returns the created id");
    const emptyToggle = await c.call("automation.toggle", { id: "", enabled: false });
    assert.equal(emptyToggle.error.code, -32602, "an empty prefix cannot toggle the only task");
    const emptyRun = await c.call("automation.run", { id: "" });
    assert.equal(emptyRun.error.code, -32602, "an empty prefix cannot run the only task");
    const emptyDelete = await c.call("automation.delete", { id: "" });
    assert.equal(emptyDelete.error.code, -32602, "an empty prefix cannot delete the only task");
    const autoWithQuiet = await c.call("automation.list", {});
    const quietJob = autoWithQuiet.result.jobs.find((job) => job.id === automationId);
    assert.equal("deliver" in quietJob, false, "raw delivery target never crosses into the renderer");
    assert.deepEqual(quietJob.delivery, {
      kind: "webhook",
      label: "Webhook · configured",
      mode: "on-output",
      state: "ready",
    });
    assert.equal(quietJob.deliverMode, "on-output");
    assert.equal(quietJob.alertAfter, 2);
    assert.equal(quietJob.scheduleSpec, "every 5m");
    assert.equal(quietJob.task, "check");
    assert.ok(Number.isFinite(quietJob.nextRunAt));
    assert.doesNotMatch(JSON.stringify(autoWithQuiet.result), /SECRET_PATH|PRIVATE_QUERY|example\.invalid/);

    const updatedAutomation = await c.call("automation.update", {
      id: automationId,
      name: "quiet monitor edited",
      schedule: "every 10m",
      task: "check again",
      mode: "command",
      deliverMode: "on-error",
      alertAfter: 4,
    });
    assert.equal(updatedAutomation.result.id, automationId);
    const autoWithUpdate = await c.call("automation.list", {});
    const updatedJob = autoWithUpdate.result.jobs.find((job) => job.id === automationId);
    assert.equal(updatedJob.name, "quiet monitor edited");
    assert.equal(updatedJob.scheduleSpec, "every 10m");
    assert.equal(updatedJob.task, "check again");
    assert.deepEqual(updatedJob.delivery, {
      kind: "webhook",
      label: "Webhook · configured",
      mode: "on-error",
      state: "ready",
    });
    assert.doesNotMatch(JSON.stringify(autoWithUpdate.result), /SECRET_PATH|PRIVATE_QUERY|example\.invalid/);

    const clearedAutomation = await c.call("automation.update", {
      id: automationId,
      name: "quiet monitor edited",
      schedule: "every 10m",
      task: "check again",
      mode: "command",
      clearDeliver: true,
      alertAfter: 4,
    });
    assert.equal(clearedAutomation.result.id, automationId);
    const autoAfterClear = await c.call("automation.list", {});
    const clearedJob = autoAfterClear.result.jobs.find((job) => job.id === automationId);
    assert.deepEqual(clearedJob.delivery, {
      kind: "none",
      label: "Saved only in Hara",
    });
    assert.equal("deliver" in clearedJob, false);
    assert.equal("deliverMode" in clearedJob, false);

    const missingDeliver = await c.call("automation.add", {
      name: "missing delivery",
      schedule: "every 5m",
      task: "check",
      deliverMode: "on-error",
    });
    assert.equal(missingDeliver.error.code, -32602);
    const invalidDeliverMode = await c.call("automation.add", {
      name: "bad delivery mode",
      schedule: "every 5m",
      task: "check",
      deliver: "feishu:oc_test",
      deliverMode: "sometimes",
    });
    assert.equal(invalidDeliverMode.error.code, -32602);
    const missingExistingDeliver = await c.call("automation.update", {
      id: automationId,
      name: "quiet monitor edited",
      schedule: "every 10m",
      task: "check again",
      mode: "command",
      deliverMode: "on-error",
    });
    assert.equal(missingExistingDeliver.error.code, -32602);

    const zonedAutomation = await c.call("automation.add", {
      name: "Shanghai morning",
      schedule: "0 9 * * *",
      task: "prepare brief",
      mode: "print",
      tz: "Asia/Shanghai",
    });
    timezoneAutomationId = zonedAutomation.result.id;
    const renamedZonedAutomation = await c.call("automation.update", {
      id: timezoneAutomationId,
      name: "Shanghai morning renamed",
      schedule: "0 9 * * *",
      task: "prepare brief",
      mode: "print",
    });
    assert.equal(renamedZonedAutomation.result.id, timezoneAutomationId);
    const zonedAfterRename = (await c.call("automation.list", {})).result.jobs.find(
      (job) => job.id === timezoneAutomationId,
    );
    assert.equal(zonedAfterRename.tz, "Asia/Shanghai", "omitting tz preserves the cron timezone");
    const clearedTimezone = await c.call("automation.update", {
      id: timezoneAutomationId,
      name: "Local morning",
      schedule: "0 9 * * *",
      task: "prepare brief",
      mode: "print",
      tz: "",
    });
    assert.equal(clearedTimezone.result.id, timezoneAutomationId);
    const localAfterClear = (await c.call("automation.list", {})).result.jobs.find(
      (job) => job.id === timezoneAutomationId,
    );
    assert.equal("tz" in localAfterClear, false, "an explicit empty tz clears the cron timezone");

    const pastRunAt = Date.now() - 60_000;
    const pastOneShot = addJob({
      name: "Completed one-shot",
      schedule: { kind: "once", runAt: pastRunAt, display: "once, original label" },
      task: "already done",
      mode: "print",
      cwd: dir,
      createdAt: pastRunAt - 60_000,
      enabled: false,
      lastRunAt: pastRunAt,
      lastStatus: "ok",
    });
    pastOneShotId = pastOneShot.id;
    const listedPastOneShot = (await c.call("automation.list", {})).result.jobs.find(
      (job) => job.id === pastOneShotId,
    );
    const validatedPastOneShot = await c.call("automation.validate", {
      id: pastOneShotId,
      schedule: listedPastOneShot.scheduleSpec,
    });
    assert.equal(validatedPastOneShot.result.schedule, listedPastOneShot.scheduleSpec);
    assert.deepEqual(
      validatedPastOneShot.result.nextRuns,
      [],
      "validation reflects that an unchanged completed one-shot will not run again",
    );
    const rejectedPastOneShotValidation = await c.call("automation.validate", {
      id: pastOneShotId,
      schedule: new Date(pastRunAt - 60_000).toISOString(),
    });
    assert.equal(
      rejectedPastOneShotValidation.error.code,
      -32602,
      "validation still rejects a different past one-shot",
    );
    const renamedPastOneShot = await c.call("automation.update", {
      id: pastOneShotId,
      name: "Completed one-shot renamed",
      schedule: listedPastOneShot.scheduleSpec,
      task: "already done",
      mode: "print",
    });
    assert.equal(renamedPastOneShot.result.id, pastOneShotId);
    const changedPastOneShot = await c.call("automation.update", {
      id: pastOneShotId,
      name: "Must stay unchanged",
      schedule: new Date(pastRunAt - 60_000).toISOString(),
      task: "already done",
      mode: "print",
    });
    assert.equal(
      changedPastOneShot.error.code,
      -32602,
      "a different past one-shot remains invalid",
    );

    const listed2 = await c.call("session.list", {});
    assert.equal(listed2.result.sessions[0].source, "interactive", "session.list carries source");
    assert.ok(
      listed2.result.sessions.every((session) => session.source === "interactive"),
      "ordinary session.list excludes cron/gateway history even when automation history is large",
    );
    assert.equal(typeof listed2.result.page.hasMore, "boolean");
    assert.ok(listed2.result.sessions.length <= listed2.result.page.limit);
  } finally {
    if (automationId) await c.call("automation.delete", { id: automationId });
    if (timezoneAutomationId) await c.call("automation.delete", { id: timezoneAutomationId });
    if (pastOneShotId) await c.call("automation.delete", { id: pastOneShotId });
    if (legacyIntervalId) await c.call("automation.delete", { id: legacyIntervalId });
    if (unchangedCronId) await c.call("automation.delete", { id: unchangedCronId });
    if (pendingCronId) await c.call("automation.delete", { id: pendingCronId });
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: models.list derives reasoning controls from the session-pinned model", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-model-controls-"));
  const store = memStore();
  const runtimeRequests = [];
  const deps = {
    ...baseDeps(textProvider, store),
    buildProviderFor: async (model) => ({
      ...textProvider,
      model,
    }),
    listModels: async () => ["qwen3.7-plus", "qwen3-coder-next"],
    runtimeInfo: (cwd, model) => {
      runtimeRequests.push({ cwd, model });
      const selected = model ?? "qwen3.7-plus";
      return {
        providerId: "qwen",
        model: selected,
        effortLevels: selected === "qwen3-coder-next" ? [] : ["low", "medium", "high"],
        attachmentCapabilities: {
          image: { mode: selected === "qwen3-coder-next" ? "unknown" : "native" },
          textFile: "inline-text",
          directory: "bounded-inventory-and-tools",
          binaryFile: "agent-tool",
        },
      };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const sid = (await c.call("session.create", {})).result.sessionId;
    const switched = await c.call("session.set-model", { sessionId: sid, model: "qwen3-coder-next" });
    assert.equal(switched.result.model, "qwen3-coder-next");

    const listed = await c.call("models.list", { sessionId: sid });
    assert.equal(listed.result.current, "qwen3-coder-next");
    assert.deepEqual(listed.result.effortLevels, [], "a coder model without thinking controls must not inherit the configured default model's dial");
    assert.equal(listed.result.attachmentCapabilities.image.mode, "unknown");
    assert.equal(
      listed.result.entries.find((entry) => entry.id === "qwen3.7-plus").attachmentCapabilities.image.mode,
      "native",
    );
    assert.equal(
      listed.result.entries.find((entry) => entry.id === "qwen3-coder-next").attachmentCapabilities.image.mode,
      "unknown",
    );
    assert.ok(runtimeRequests.some((request) => request.model === "qwen3-coder-next"));
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: models.list marks a removed Token Plan session model and returns only a live-authorized replacement", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-stale-token-plan-model-"));
  const store = memStore();
  const sessionId = "stale-glm-session";
  store.saved.set(sessionId, {
    meta: {
      id: sessionId,
      cwd: dir,
      profileId: "personal",
      provider: "token-plan",
      model: "glm-5",
      title: "Stale GLM session",
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      source: "interactive",
    },
    history: [],
  });
  const deps = {
    ...baseDeps(textProvider, store),
    listModels: async () => ["glm-5.2", "qwen3.8-max"],
    runtimeInfo: (_cwd, model) => ({
      providerId: "token-plan",
      model: model ?? "qwen3.8-max",
      effortLevels: [],
    }),
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const client = await connect(srv.port);
  try {
    await client.call("initialize", { token: "tok" });
    const listed = await client.call("models.list", { sessionId });
    assert.equal(listed.result.current, "glm-5");
    assert.equal(listed.result.currentAvailable, false);
    assert.equal(listed.result.recommendedModel, "glm-5.2");
    assert.equal(listed.result.entries.find((entry) => entry.id === "glm-5").available, false);
    assert.equal(listed.result.entries.find((entry) => entry.id === "glm-5.2").available, true);
  } finally {
    client.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: structured attachments support image-only turns and expose path-free history", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-attachments-"));
  const store = memStore();
  const imagePath = join(dir, "界面 截图.png");
  const filePath = join(dir, "需求 说明.txt");
  const folderPath = join(dir, "参考 目录");
  writeFileSync(
    imagePath,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  );
  writeFileSync(filePath, "attachment text");
  mkdirSync(folderPath);
  writeFileSync(join(folderPath, "notes.md"), "# Folder note");
  let providerHistory = [];
  const provider = {
    ...textProvider,
    model: "image-native",
    async turn({ history, onText }) {
      providerHistory = structuredClone(history);
      onText("inspected");
      return {
        text: "inspected",
        toolUses: [],
        stop: "end",
        usage: { input: 1, output: 1 },
      };
    },
  };
  const capabilitiesFor = (model) => ({
    image: { mode: model === "image-native" ? "native" : "unsupported" },
    textFile: "inline-text",
    directory: "bounded-inventory-and-tools",
    binaryFile: "agent-tool",
  });
  const deps = {
    ...baseDeps(provider, store),
    buildProviderFor: async (model) => ({ ...provider, model }),
    prepareImages: async (images) => ({ images }),
    runtimeInfo: (_cwd, model) => ({
      providerId: "fake",
      model: model ?? "image-native",
      effortLevels: [],
      attachmentCapabilities: capabilitiesFor(model ?? "image-native"),
    }),
  };
  const srv = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    deps,
  );
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const sid = (await c.call("session.create", {})).result.sessionId;
    const sent = await c.call("session.send", {
      sessionId: sid,
      text: "",
      attachments: [
        { kind: "image", path: imagePath, mediaType: "image/jpeg" },
        { kind: "file", path: filePath },
        { kind: "directory", path: folderPath },
      ],
    });
    assert.equal(sent.result.reply, "inspected");
    const user = providerHistory.findLast((message) => message.role === "user");
    assert.equal(user.images[0].mediaType, "image/png", "Serve trusts image bytes, not client MIME");
    assert.match(user.content, /Please inspect the attached context/);
    assert.match(user.content, /attachment text/);
    assert.match(user.content, /notes\.md/);

    const persistedUser = store.saved.get(sid).history.findLast((message) => message.role === "user");
    assert.equal(persistedUser.displayContent, "");
    assert.deepEqual(
      persistedUser.attachments.map((attachment) => attachment.kind),
      ["image", "file", "directory"],
      "display-only metadata stays in Hara history instead of leaking into provider payloads",
    );
    const clientHistory = historyForClient([persistedUser]);
    assert.deepEqual(
      clientHistory[0].attachments.map((attachment) => attachment.name),
      ["界面 截图.png", "需求 说明.txt", "参考 目录"],
    );
    assert.equal(
      JSON.stringify(clientHistory).includes(dir),
      false,
      "absolute attachment paths never cross the renderer boundary",
    );

    const incompatible = await c.call("session.set-model", {
      sessionId: sid,
      model: "text-only",
    });
    assert.equal(incompatible.error.code, -32602);
    assert.match(incompatible.error.message, /history contains native image attachments/);
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: vision-first persists description text and never sends raw images to the main model", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-sidecar-image-"));
  const store = memStore();
  mkdirSync(join(dir, ".git"));
  const skillDir = join(dir, ".hara", "skills", "inspect-image");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: inspect-image\ndescription: Inspect an attached image\n---\n\nUse all supplied visual evidence.",
  );
  const imagePath = join(dir, "diagram.png");
  writeFileSync(
    imagePath,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  );
  let providerHistory = [];
  const provider = {
    ...textProvider,
    model: "text-main",
    async turn({ history, onText }) {
      providerHistory = structuredClone(history);
      onText("understood");
      return {
        text: "understood",
        toolUses: [],
        stop: "end",
        usage: { input: 1, output: 1 },
      };
    },
  };
  const deps = {
    ...baseDeps(provider, store),
    prepareImages: async (images, opts) => {
      assert.equal(images.length, 1);
      assert.equal(opts.model, "text-main");
      return {
        description: "A sequence diagram with three participants.",
        viaModel: "vision-helper",
      };
    },
    runtimeInfo: (_cwd, model) => ({
      providerId: "fake",
      model: model ?? "text-main",
      effortLevels: [],
      attachmentCapabilities: {
        image: { mode: "vision-sidecar", viaModel: "vision-helper" },
        textFile: "inline-text",
        directory: "bounded-inventory-and-tools",
        binaryFile: "agent-tool",
      },
    }),
  };
  const srv = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    deps,
  );
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const sid = (await c.call("session.create", {})).result.sessionId;
    const sent = await c.call("session.send", {
      sessionId: sid,
      text: "/inspect-image",
      images: [{ path: imagePath, mediaType: "image/jpeg" }],
    });
    assert.equal(sent.error, undefined);
    assert.equal(sent.result.reply, "understood");
    const user = providerHistory.findLast((message) => message.role === "user");
    assert.equal(user.images, undefined, "the main model receives no image bytes");
    assert.match(user.content, /Use all supplied visual evidence/);
    assert.match(user.content, /read first by vision-helper/);
    assert.match(user.content, /three participants/);
    const persistedUser = store.saved.get(sid).history.findLast((message) => message.role === "user");
    assert.equal(persistedUser.images, undefined);
    assert.equal(persistedUser.imageDescription, "A sequence diagram with three participants.");
    assert.equal(persistedUser.attachments[0].strategy, "vision-sidecar");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: an early-failed cron occurrence resumes with current runtime defaults", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-cron-placeholder-"));
  const store = memStore();
  const sessionId = randomUUID();
  store.save({
    id: sessionId,
    cwd: dir,
    profileId: "personal",
    spaceId: "personal",
    provider: "",
    model: "",
    title: "failed scheduled run",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "cron",
    sourceName: "failed task",
    jobId: "failed-task",
  }, []);
  const requestedModels = [];
  const deps = {
    ...baseDeps(textProvider, store),
    buildProviderFor: async (model) => {
      requestedModels.push(model);
      return { ...textProvider, model };
    },
    runtimeInfo: (_cwd, model) => ({
      providerId: "fake",
      model: model || "fake-1",
      profileId: "personal",
      profileKind: "byok",
      spaceId: "personal",
      effortLevels: [],
    }),
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const client = await connect(srv.port);
  try {
    await client.call("initialize", { token: "tok" });
    const resumed = await client.call("session.resume", { sessionId });
    assert.equal(resumed.result.model, "fake-1");
    assert.ok(requestedModels.length >= 1);
    assert.ok(requestedModels.every((model) => model === "fake-1"), "the empty placeholder is never passed as a pinned model");
    assert.equal(store.saved.get(sessionId).meta.model, "fake-1", "the repaired runtime identity is persisted");
    assert.equal(store.saved.get(sessionId).meta.provider, "fake");
  } finally {
    client.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: models.list honors a persisted session profile before that session is live", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-persisted-model-profile-"));
  const store = memStore();
  const sessionId = "persisted-flash-session";
  store.saved.set(sessionId, {
    meta: {
      id: sessionId,
      cwd: dir,
      profileId: "flash-org",
      provider: "hara-gateway",
      model: "deepseek-v4-flash",
      effort: "high",
      title: "Persisted Flash session",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
      source: "interactive",
    },
    history: [],
  });
  const runtimeRequests = [];
  const deps = {
    ...baseDeps(textProvider, store),
    listModels: async (_cwd, profileId) =>
      profileId === "flash-org" ? ["deepseek-v4-flash"] : ["deepseek-v4-pro"],
    runtimeInfo: (cwd, model, profileId) => {
      runtimeRequests.push({ cwd, model, profileId });
      const selectedProfile = profileId ?? "pro-org";
      const selectedModel = model ?? (selectedProfile === "flash-org" ? "deepseek-v4-flash" : "deepseek-v4-pro");
      return {
        providerId: "hara-gateway",
        profileId: selectedProfile,
        model: selectedModel,
        availableModels: [selectedProfile === "flash-org" ? "deepseek-v4-flash" : "deepseek-v4-pro"],
        effortLevels: ["off", "low", "high", "max"],
      };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const client = await connect(srv.port);
  try {
    await client.call("initialize", { token: "tok" });
    runtimeRequests.length = 0;
    const listed = await client.call("models.list", { sessionId });
    assert.deepEqual(listed.result.models, ["deepseek-v4-flash"]);
    assert.equal(listed.result.current, "deepseek-v4-flash");
    assert.equal(listed.result.profileId, "flash-org");
    assert.equal(listed.result.effort, "high");
    assert.ok(runtimeRequests.every((request) => request.profileId === "flash-org"));

    const missing = await client.call("models.list", { sessionId: "missing-session" });
    assert.equal(missing.error.code, -32003);
  } finally {
    client.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: new sessions freeze the connection reasoning default and automatic across restarts", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-reasoning-default-freeze-"));
  const store = memStore();
  const providerBuilds = [];
  let defaultReasoningEffort = "high";
  const providerFor = (model) => ({ ...textProvider, model });
  const deps = {
    ...baseDeps(providerFor("qwen3.8-flash"), store),
    buildSessionProvider: async () => providerFor("qwen3.8-flash"),
    buildProviderFor: async (model, effort) => {
      providerBuilds.push({ model, effort });
      return providerFor(model);
    },
    listModels: async () => ["qwen3.8-flash"],
    runtimeInfo: (_cwd, model) => ({
      providerId: "token-plan",
      model: model ?? "qwen3.8-flash",
      profileId: "personal",
      profileKind: "byok",
      spaceId: "personal",
      defaultReasoningEffort,
      effortLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      availableModels: ["qwen3.8-flash"],
    }),
  };

  let firstServer;
  let firstClient;
  let secondServer;
  let secondClient;
  try {
    firstServer = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
    firstClient = await connect(firstServer.port);
    await firstClient.call("initialize", { token: "tok" });
    const explicit = await firstClient.call("session.create", {});
    await firstClient.call("session.send", { sessionId: explicit.result.sessionId, text: "freeze high" });
    const listed = await firstClient.call("models.list", { sessionId: explicit.result.sessionId });
    assert.equal(listed.result.defaultModel, "qwen3.8-flash");
    assert.equal(listed.result.defaultReasoningEffort, "high");
    assert.equal(listed.result.effort, "high");

    defaultReasoningEffort = undefined;
    const automatic = await firstClient.call("session.create", {});
    await firstClient.call("session.send", { sessionId: automatic.result.sessionId, text: "freeze automatic" });
    assert.equal(store.saved.get(automatic.result.sessionId).meta.effort, null);

    firstClient.close();
    firstClient = undefined;
    await firstServer.close();
    firstServer = undefined;
    defaultReasoningEffort = "low";

    secondServer = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
    secondClient = await connect(secondServer.port);
    await secondClient.call("initialize", { token: "tok" });
    await secondClient.call("session.resume", { sessionId: explicit.result.sessionId });
    await secondClient.call("session.resume", { sessionId: automatic.result.sessionId });
    assert.ok(
      providerBuilds.some((build) => build.model === "qwen3.8-flash" && build.effort === "high"),
      "the old explicit inherited default remains frozen",
    );
    assert.ok(
      providerBuilds.some((build) => build.model === "qwen3.8-flash" && build.effort === null),
      "provider automatic remains explicit instead of inheriting the later low default",
    );
    const forkBuildStart = providerBuilds.length;
    const forkedAutomatic = await secondClient.call("session.fork", {
      sessionId: automatic.result.sessionId,
    });
    assert.equal(forkedAutomatic.error, undefined);
    assert.equal(store.saved.get(forkedAutomatic.result.sessionId).meta.effort, null);
    const forkBuilds = providerBuilds.slice(forkBuildStart);
    assert.ok(forkBuilds.length > 0);
    assert.ok(
      forkBuilds.every((build) => build.effort === null),
      "forking a provider-automatic session must not inherit a newer connection default",
    );
  } finally {
    firstClient?.close();
    secondClient?.close();
    if (firstServer) await firstServer.close();
    if (secondServer) await secondServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: managed gateway enforces its model scope and advertised DeepSeek thinking levels", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-managed-model-scope-"));
  const store = memStore();
  const deps = {
    ...baseDeps(textProvider, store),
    buildProviderFor: async (model) => ({ ...textProvider, model }),
    listModels: async () => ["deepseek-v4-flash", "deepseek-v4-pro"],
    runtimeInfo: (_cwd, model) => ({
      providerId: "hara-gateway",
      model: model ?? "deepseek-v4-pro",
      effortLevels: ["off", "low", "high", "max"],
      availableModels: ["deepseek-v4-pro"],
    }),
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const sid = (await c.call("session.create", {})).result.sessionId;
    const switched = await c.call("session.set-model", {
      sessionId: sid,
      model: "deepseek-v4-pro",
      effort: "max",
    });
    assert.equal(switched.result.model, "deepseek-v4-pro");
    assert.equal(switched.result.effort, "max");

    const listed = await c.call("models.list", { sessionId: sid });
    assert.deepEqual(listed.result.models, ["deepseek-v4-pro"], "stored token scope wins over a broader discovery response");
    assert.deepEqual(listed.result.effortLevels, ["off", "low", "high", "max"]);

    const forbiddenModel = await c.call("session.set-model", {
      sessionId: sid,
      model: "deepseek-v4-flash",
    });
    assert.match(forbiddenModel.error.message, /not authorized/);

    const forbiddenEffort = await c.call("session.set-model", {
      sessionId: sid,
      model: "deepseek-v4-pro",
      effort: "medium",
    });
    assert.match(forbiddenEffort.error.message, /not supported/);
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: persisted sessions keep their organization profile across active-profile switches", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-profile-binding-"));
  const store = memStore();
  const availableProfiles = new Set(["flash-org", "pro-org"]);
  const models = { "flash-org": "deepseek-v4-flash", "pro-org": "deepseek-v4-pro" };
  const spaces = {
    "flash-org": `org:test-flash-${randomUUID()}`,
    "pro-org": `org:test-pro-${randomUUID()}`,
  };
  const providerRequests = [];
  const auxiliaryRequests = [];
  let auxiliaryRound = 0;
  const auxiliaryProvider = {
    ...textProvider,
    async turn({ onText }) {
      if (auxiliaryRound++ === 0) {
        return {
          text: "",
          toolUses: [{ id: "agent-1", name: "agent", input: { task: "inspect the bound route" } }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      onText("bound");
      return { text: "bound", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
  let activeProfile = "flash-org";
  const withPolicyLease = (provider, model) => ({
    ...provider,
    model,
    async prepareTurn() {
      return { organizationPolicyVersion: 1, organizationPolicy: { version: 1 } };
    },
  });
  const profileFor = (profileId) => profileId ?? activeProfile;
  const requireProfile = (profileId) => {
    const selected = profileFor(profileId);
    if (!availableProfiles.has(selected)) throw new Error(`session profile '${selected}' is no longer available; choose an existing profile before continuing`);
    return selected;
  };
  const deps = {
    ...baseDeps(auxiliaryProvider, store),
    buildSessionProvider: async (_cwd, profileId) => {
      const selected = requireProfile(profileId);
      providerRequests.push({ operation: "create", profileId: selected });
      return withPolicyLease(auxiliaryProvider, models[selected]);
    },
    buildProviderFor: async (model, _effort, _cwd, profileId) => {
      const selected = requireProfile(profileId);
      providerRequests.push({ operation: "resume", profileId: selected, model });
      return withPolicyLease(auxiliaryProvider, model);
    },
    listModels: async (_cwd, profileId) => [models[requireProfile(profileId)]],
    runtimeInfo: (_cwd, model, profileId) => {
      const selected = requireProfile(profileId);
      const selectedModel = model ?? models[selected];
      return {
        providerId: "hara-gateway",
        profileId: selected,
        profileKind: "gateway",
        spaceId: spaces[selected],
        model: selectedModel,
        effortLevels: ["off", "low", "high", "max"],
        availableModels: [models[selected]],
      };
    },
    buildGuardian: async (_cwd, profileId) => {
      auxiliaryRequests.push({ operation: "guardian", profileId });
      return undefined;
    },
    spawnSubagent: async (_provider, _cwd, _projectContext, _stats, _task, _role, _signal, _observers, profileId) => {
      auxiliaryRequests.push({ operation: "subagent", profileId });
      return "subagent stayed bound";
    },
  };

  const flashRolesDir = orgRolesDir(spaces["flash-org"]);
  mkdirSync(flashRolesDir, { recursive: true });
  writeFileSync(join(flashRolesDir, "_bundle.json"), `${JSON.stringify({
    version: 1,
    org_policy: {},
    roles: [],
  }, null, 2)}\n`);

  let sessionId;
  const first = await startServe({ host: "127.0.0.1", port: 0, token: "tok-1", cwd: dir }, deps);
  let client = await connect(first.port);
  try {
    await client.call("initialize", { token: "tok-1" });
    const created = await client.call("session.create", {});
    sessionId = created.result.sessionId;
    assert.equal(created.result.profileId, "flash-org");
    assert.equal(created.result.cwd, dir);
    assert.equal(created.result.source, "interactive");
    assert.equal(created.result.updatedAt.length > 0, true);
    assert.equal(store.saved.has(sessionId), false, "an untouched new chat remains an in-memory draft");
    const visibleDraft = await client.call("session.list", {});
    assert.ok(visibleDraft.result.sessions.some((session) => session.id === sessionId),
      "create → list exposes the live draft before the first turn is persisted");
    const firstTurn = await client.call("session.send", { sessionId, text: "pin this organization route" });
    assert.equal(firstTurn.result.reply, "bound");
    assert.equal(store.saved.get(sessionId).meta.profileId, "flash-org", "the first turn persists its identity route");
  } finally {
    client.close();
    await first.close();
  }

  activeProfile = "pro-org";
  auxiliaryRound = 0;
  auxiliaryRequests.length = 0;
  const second = await startServe({ host: "127.0.0.1", port: 0, token: "tok-2", cwd: dir }, deps);
  client = await connect(second.port);
  try {
    await client.call("initialize", { token: "tok-2" });
    const resumed = await client.call("session.resume", { sessionId });
    assert.equal(resumed.result.profileId, "flash-org", "resume ignores the newly active organization");
    assert.equal(resumed.result.model, "deepseek-v4-flash");
    assert.ok(providerRequests.some((request) => request.operation === "resume" && request.profileId === "flash-org"));
    const listed = await client.call("models.list", { sessionId });
    assert.deepEqual(listed.result.models, ["deepseek-v4-flash"], "the model picker remains scoped to the session's organization");
    const forbidden = await client.call("session.set-model", { sessionId, model: "deepseek-v4-pro" });
    assert.match(forbidden.error.message, /not authorized/);
    const sent = await client.call("session.send", { sessionId, text: "exercise auxiliary routes" });
    assert.equal(sent.result?.reply, "bound", JSON.stringify(sent));
    assert.ok(auxiliaryRequests.some((request) => request.operation === "guardian" && request.profileId === "flash-org"));
    assert.ok(auxiliaryRequests.some((request) => request.operation === "subagent" && request.profileId === "flash-org"));
    assert.equal(auxiliaryRequests.some((request) => request.profileId === "pro-org"), false);
  } finally {
    client.close();
    await second.close();
  }

  availableProfiles.delete("flash-org");
  const third = await startServe({ host: "127.0.0.1", port: 0, token: "tok-3", cwd: dir }, deps);
  client = await connect(third.port);
  try {
    await client.call("initialize", { token: "tok-3" });
    const refused = await client.call("session.resume", { sessionId });
    assert.match(refused.error.message, /profile 'flash-org' is no longer available/, "removed profile fails closed instead of using the active Pro connection");
  } finally {
    client.close();
    await third.close();
    rmSync(orgRolesDir(spaces["flash-org"]), { recursive: true, force: true });
    rmSync(orgRolesDir(spaces["pro-org"]), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: unavailable history stays readable, same-Space recovery is explicit, and company export is blocked", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-readonly-history-"));
  const store = memStore();
  const sessionId = "stale-key-session";
  const originalHistory = [
    { role: "user", content: "continue the existing task" },
    { role: "assistant", text: "the durable result", toolUses: [], stop: "end" },
  ];
  store.saved.set(sessionId, {
    meta: {
      id: sessionId,
      cwd: dir,
      profileId: "key",
      spaceId: "org:tenant-key",
      provider: "hara-gateway",
      model: "deepseek-chat",
      title: "Older task",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T01:00:00.000Z",
      source: "interactive",
    },
    history: structuredClone(originalHistory),
  });
  const personalSourceId = "stale-personal-session";
  store.saved.set(personalSourceId, {
    meta: {
      id: personalSourceId,
      cwd: dir,
      profileId: "retired-personal-route",
      spaceId: "personal",
      provider: "qwen",
      model: "qwen-old",
      title: "Older personal task",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T01:00:00.000Z",
      source: "interactive",
    },
    history: structuredClone(originalHistory),
  });
  const providerRequests = [];
  const personalProvider = { ...textProvider, model: "qwen3.7-plus" };
  const deps = {
    ...baseDeps(personalProvider, store),
    buildSessionProvider: async () => personalProvider,
    buildProviderFor: async (model, _effort, _cwd, profileId, spaceId) => {
      providerRequests.push({ model, profileId, spaceId });
      if (profileId === "key") {
        throw new Error(`model '${model}' is not authorized for organization connection 'key'`);
      }
      if (profileId !== "personal" || model !== "qwen3.7-plus") {
        throw new Error("unexpected target route");
      }
      return personalProvider;
    },
    runtimeInfo: (_cwd, model, profileId, spaceId) => {
      const selectedProfile = profileId ?? "personal";
      if (selectedProfile === "key") {
        return {
          providerId: "hara-gateway",
          profileId: "key",
          spaceId: "org:tenant-key",
          model: model ?? "deepseek-v4-pro",
          effortLevels: [],
          availableModels: ["deepseek-v4-pro"],
        };
      }
      return {
        providerId: "qwen",
        profileId: "personal",
        spaceId: spaceId ?? "personal",
        model: model ?? "qwen3.7-plus",
        effortLevels: [],
        availableModels: ["qwen3.7-plus"],
        attachmentCapabilities: { image: { mode: "native" } },
      };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const client = await connect(srv.port);
  try {
    const initialized = await client.call("initialize", { token: "tok" });
    assert.ok(initialized.result.capabilities.methods.includes("session.history"));
    assert.ok(initialized.result.capabilities.features.includes("sessions.readonly-history.v1"));
    assert.ok(initialized.result.capabilities.features.includes("sessions.cross-profile-fork.v1"));

    const refusedResume = await client.call("session.resume", { sessionId });
    assert.match(refusedResume.error.message, /not authorized for organization connection 'key'/);
    const providerCallsBeforeHistory = providerRequests.length;

    const history = await client.call("session.history", { sessionId });
    assert.equal(history.result.readOnly, true);
    assert.equal(history.result.model, "deepseek-chat");
    assert.equal(history.result.profileId, "key");
    assert.deepEqual(history.result.history.map((message) => message.text), [
      "continue the existing task",
      "the durable result",
    ]);
    assert.equal(
      providerRequests.length,
      providerCallsBeforeHistory,
      "reading local history never rebuilds or authorizes the unavailable provider",
    );

    const missingConsent = await client.call("session.fork", {
      sessionId,
      targetProfileId: "personal",
      targetModel: "qwen3.7-plus",
    });
    assert.equal(missingConsent.error.code, -32602);
    assert.match(missingConsent.error.message, /explicit history-transfer consent required/i);

    const blockedExport = await client.call("session.fork", {
      sessionId,
      targetProfileId: "personal",
      targetModel: "qwen3.7-plus",
      transferHistory: true,
    });
    assert.equal(blockedExport.error.code, -32001);
    assert.match(blockedExport.error.message, /cross-Space conversation transfer is blocked/i);
    assert.equal(store.saved.size, 2, "a denied company export creates no copied session");

    const companyContextWithPersonalFunding = await client.call("session.fork", {
      sessionId,
      targetProfileId: "personal",
      targetModel: "qwen3.7-plus",
      targetSpaceId: "org:tenant-key",
      transferHistory: true,
    });
    assert.equal(companyContextWithPersonalFunding.error, undefined);
    assert.equal(companyContextWithPersonalFunding.result.profileId, "personal");
    assert.equal(companyContextWithPersonalFunding.result.spaceId, "org:tenant-key");
    assert.equal(companyContextWithPersonalFunding.result.model, "qwen3.7-plus");
    assert.equal(store.saved.get(companyContextWithPersonalFunding.result.sessionId).meta.profileId, "personal");
    assert.equal(store.saved.get(companyContextWithPersonalFunding.result.sessionId).meta.spaceId, "org:tenant-key");
    assert.ok(
      providerRequests.some((request) => request.profileId === "personal" && request.spaceId === "org:tenant-key"),
      "the provider is built with the company Space audience even though the personal connection pays",
    );

    const forked = await client.call("session.fork", {
      sessionId: personalSourceId,
      targetProfileId: "personal",
      targetModel: "qwen3.7-plus",
      transferHistory: true,
    });
    assert.notEqual(forked.result.sessionId, sessionId);
    assert.equal(forked.result.profileId, "personal");
    assert.equal(forked.result.model, "qwen3.7-plus");
    assert.equal(forked.result.approval, "full-auto", "legacy source inherits the server policy when forked");
    assert.deepEqual(forked.result.history, history.result.history);
    assert.equal(store.saved.get(forked.result.sessionId).meta.profileId, "personal");
    assert.equal(store.saved.get(forked.result.sessionId).meta.spaceId, "personal");
    assert.equal(store.saved.get(forked.result.sessionId).meta.model, "qwen3.7-plus");
    assert.deepEqual(store.saved.get(sessionId).history, originalHistory, "the unavailable source remains unchanged");
    assert.equal(store.saved.get(sessionId).meta.profileId, "key");
    assert.equal(store.saved.get(sessionId).meta.spaceId, "org:tenant-key");

    const continued = await client.call("session.send", {
      sessionId: forked.result.sessionId,
      text: "continue now",
    });
    assert.equal(continued.result.reply, "hello", "the consented target fork is writable");
  } finally {
    client.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: resume refuses an identity changed between provider preflight and the locked reload", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-profile-race-"));
  const store = memStore();
  const sessionId = "profile-race-session";
  store.saved.set(sessionId, {
    meta: {
      id: sessionId,
      cwd: dir,
      profileId: "flash-org",
      spaceId: "org:tenant-acme",
      provider: "hara-gateway",
      model: "deepseek-v4-flash",
      title: "Profile race",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
      source: "interactive",
    },
    history: [],
  });
  let changed = false;
  const deps = {
    ...baseDeps(textProvider, store),
    buildProviderFor: async (model, _effort, _cwd, profileId) => {
      assert.equal(profileId, changed ? "pro-org" : "flash-org");
      if (!changed) {
        changed = true;
        store.saved.get(sessionId).meta.profileId = "pro-org";
        store.saved.get(sessionId).meta.model = "deepseek-v4-pro";
      }
      return { ...textProvider, model };
    },
    runtimeInfo: (_cwd, model, profileId) => ({
      providerId: "hara-gateway",
      profileId: profileId ?? "pro-org",
      profileKind: "gateway",
      spaceId: "org:tenant-acme",
      model: model ?? (profileId === "flash-org" ? "deepseek-v4-flash" : "deepseek-v4-pro"),
      availableModels: [profileId === "flash-org" ? "deepseek-v4-flash" : "deepseek-v4-pro"],
      effortLevels: ["off", "low", "high", "max"],
    }),
  };
  const server = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const client = await connect(server.port);
  try {
    await client.call("initialize", { token: "tok" });
    const raced = await client.call("session.resume", { sessionId });
    assert.equal(raced.error.code, -32002);
    assert.match(raced.error.message, /identity changed/);
    assert.equal(store.saved.get(sessionId).meta.profileId, "pro-org", "the locked identity is never overwritten by the stale preflight");

    const resumed = await client.call("session.resume", { sessionId });
    assert.equal(resumed.result.profileId, "pro-org");
    assert.equal(resumed.result.model, "deepseek-v4-pro");
  } finally {
    client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: provider settings are capability-advertised, redacted, tested, and saved without echoing credentials", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-provider-settings-"));
  const state = {
    current: {
      provider: "ollama",
      model: "qwen3",
      baseURL: "http://127.0.0.1:11434/v1",
      location: "local",
      auth: "none",
      keyConfigured: true,
      authenticated: true,
      profileId: "personal",
      profileKind: "byok",
      profileSource: "default",
      editable: true,
    },
    providers: [{
      id: "ollama",
      label: "Ollama",
      location: "local",
      auth: "none",
      defaultModel: "qwen3",
      defaultBaseURL: "http://127.0.0.1:11434/v1",
      customBaseURL: true,
    }],
    connections: [{
      id: "personal",
      label: "Personal",
      provider: "ollama",
      model: "qwen3",
      baseURL: "http://127.0.0.1:11434/v1",
      location: "local",
      auth: "none",
      keyConfigured: true,
      authenticated: true,
      active: true,
      legacyPersonal: true,
      removable: false,
    }],
    switchLocked: false,
  };
  let savedInput;
  let savedVisionInput;
  let testedVisionInput;
  let createdConnectionInput;
  let enrolledOrganizationInput;
  let unpinnedCwd;
  let closeGatewayLoginsCalled = false;
  const loginSnapshot = {
    id: "weixin-login-1",
    platform: "weixin",
    phase: "waiting",
    qrPayload: "weixin://login/local-only-qr",
    qrRevision: 1,
    startedAt: 100,
    updatedAt: 100,
    deadlineAt: 1_000,
  };
  const organizationState = {
    activeId: "personal",
    activeSource: "default",
    switchLocked: false,
    connections: [{
      id: "acme",
      label: "Acme",
      active: false,
      gatewayUrl: "https://control.example.com",
      gatewayHost: "control.example.com",
      model: "deepseek-chat",
      availableModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
      tokenNeverExpires: true,
      accessState: "permanent",
      services: [{
        service: "DESK_TASKS",
        mode: "CUSTOMER_HOSTED",
        accountRegion: "CN",
        host: "desk.example.com",
        status: "ACTIVE",
        capabilitiesVersion: 2,
        configVersion: 4,
      }],
    }],
  };
  const deps = {
    ...baseDeps(textProvider, memStore()),
    providerSettings: () => state,
    testProviderSettings: async (input) => ({
      ok: false,
      models: ["qwen3"],
      error: `upstream rejected apiKey=${input.apiKey}`,
    }),
    testVisionSettings: async (input) => {
      testedVisionInput = input;
      return {
        ok: false,
        models: [],
        error: `vision upstream rejected apiKey=${input.apiKey}`,
      };
    },
    saveProviderSettings: async (input) => {
      savedInput = input;
      return { ...state, accidentalApiKey: input.apiKey };
    },
    saveVisionSettings: async (input) => {
      savedVisionInput = input;
      return {
        ...state,
        vision: {
          ...state.vision,
          enabled: input.enabled,
          model: input.model,
          apiKeyConfigured: Boolean(input.apiKey),
        },
        accidentalApiKey: input.apiKey,
      };
    },
    createProviderConnection: async (input) => {
      createdConnectionInput = input;
      return {
        ...state,
        connections: [...state.connections, {
          ...state.connections[0],
          id: input.id,
          label: input.label,
          provider: input.provider,
          model: input.model,
          active: input.activate === true,
          legacyPersonal: false,
          removable: true,
        }],
        accidentalApiKey: input.apiKey,
      };
    },
    testProviderConnection: async (id) => ({ ok: true, models: [`${id}-model`] }),
    useProviderConnection: (id) => ({
      ...state,
      current: { ...state.current, profileId: id },
    }),
    removeProviderConnection: () => ({ ...state, connections: state.connections }),
    gatewayStatuses: async () => [{
      platform: "weixin",
      label: "WeChat",
      configuration: "ready",
      configured: true,
      running: false,
      runningInstances: 0,
      runtimeState: "stopped",
      recommendation: "start it",
      token: "gateway-secret-must-not-leak",
    }],
    startGatewayLogin: async () => ({
      ...loginSnapshot,
      bot_token: "login-token-must-not-leak",
    }),
    gatewayLoginStatus: (_platform, id) => id === loginSnapshot.id
      ? { ...loginSnapshot, phase: "scanned", updatedAt: 200 }
      : undefined,
    cancelGatewayLogin: (_platform, id) => id === loginSnapshot.id
      ? { ...loginSnapshot, phase: "cancelled", qrPayload: undefined, updatedAt: 300 }
      : undefined,
    closeGatewayLogins: async () => {
      closeGatewayLoginsCalled = true;
    },
    organizationConnections: () => ({ ...organizationState, deviceToken: "org-device-secret-must-not-leak" }),
    enrollOrganizationConnection: async (input) => {
      enrolledOrganizationInput = input;
      return { ...organizationState, accidentalCode: input.code, deviceToken: "org-device-secret-must-not-leak" };
    },
    useOrganizationConnection: () => ({ ...organizationState, activeId: "acme" }),
    removeOrganizationConnection: () => ({ ...organizationState, connections: [] }),
    checkOrganizationConnection: async (id) => ({ id, ok: true, checkedAt: 123 }),
    unpinProjectProfile: (cwd) => {
      unpinnedCwd = cwd;
      return {
        removed: true,
        providers: {
          ...state,
          current: { ...state.current, profileId: "personal", profileKind: "byok", profileSource: "default" },
          accidentalApiKey: "unpin-result-secret-must-not-leak",
        },
        organizations: { ...organizationState, activeId: "personal", activeSource: "default", switchLocked: false },
      };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  try {
    const init = await c.call("initialize", { token: "tok" });
    assert.ok(init.result.capabilities.methods.includes("settings.providers.list"));
    assert.ok(init.result.capabilities.methods.includes("settings.providers.test"));
    assert.ok(init.result.capabilities.methods.includes("settings.providers.save"));
    assert.ok(init.result.capabilities.methods.includes("settings.vision.save"));
    assert.ok(init.result.capabilities.methods.includes("settings.vision.test"));
    for (const method of [
      "settings.providers.connections.create",
      "settings.providers.connections.test",
      "settings.providers.connections.use",
      "settings.providers.connections.remove",
    ]) assert.ok(init.result.capabilities.methods.includes(method), `${method} advertised`);
    assert.ok(init.result.capabilities.methods.includes("settings.gateways.list"));
    for (const method of [
      "settings.gateways.login.start",
      "settings.gateways.login.status",
      "settings.gateways.login.cancel",
      "settings.organizations.list",
      "settings.organizations.enroll",
      "settings.organizations.use",
      "settings.organizations.remove",
      "settings.organizations.check",
      "settings.profiles.unpin",
    ]) assert.ok(init.result.capabilities.methods.includes(method), `${method} advertised`);

    const listed = await c.call("settings.providers.list", {});
    assert.equal(listed.result.current.provider, "ollama");
    assert.equal(JSON.stringify(listed.result).includes("\"apiKey\":"), false);

    const secret = "sk-testsecret-1234567890";
    const tested = await c.call("settings.providers.test", { provider: "openai", model: "gpt-test", apiKey: secret });
    assert.equal(tested.result.ok, false);
    assert.equal(JSON.stringify(tested.result).includes(secret), false, "test errors must never echo a submitted key");

    const saved = await c.call("settings.providers.save", { provider: "openai", model: "gpt-test", apiKey: secret, activatePersonal: true });
    assert.equal(savedInput.apiKey, secret, "the authenticated callback receives the ephemeral credential");
    assert.equal(JSON.stringify(saved.result).includes(secret), false, "save results must never echo a submitted key");

    const visionTested = await c.call("settings.vision.test", {
      source: "custom",
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: secret,
    });
    assert.equal(testedVisionInput.apiKey, secret, "the vision probe receives its transient credential");
    assert.equal(JSON.stringify(visionTested.result).includes(secret), false, "vision probe errors never echo a submitted key");

    const visionSaved = await c.call("settings.vision.save", {
      enabled: true,
      source: "custom",
      provider: "deepseek",
      model: "deepseek-v4-flash-vision-exp",
      apiKey: secret,
    });
    assert.equal(savedVisionInput.apiKey, secret, "the vision callback receives the transient credential");
    assert.equal(visionSaved.result.vision.model, "deepseek-v4-flash-vision-exp");
    assert.equal(JSON.stringify(visionSaved.result).includes(secret), false, "vision settings never echo a submitted key");

    const created = await c.call("settings.providers.connections.create", {
      id: "qwen-personal",
      label: "Qwen Personal",
      provider: "openai",
      model: "qwen3.7-plus",
      apiKey: secret,
      activate: false,
    });
    assert.equal(createdConnectionInput.apiKey, secret, "named connection creation receives the transient key only inside Serve");
    assert.equal(created.result.connections.at(-1).id, "qwen-personal");
    assert.equal(JSON.stringify(created.result).includes(secret), false, "named connection results never echo a submitted key");
    assert.deepEqual(
      (await c.call("settings.providers.connections.test", { id: "qwen-personal" })).result,
      { ok: true, models: ["qwen-personal-model"] },
    );
    assert.equal(
      (await c.call("settings.providers.connections.use", { id: "qwen-personal" })).result.current.profileId,
      "qwen-personal",
    );
    assert.equal(
      (await c.call("settings.providers.connections.remove", { id: "qwen-personal" })).result.connections.length,
      1,
    );

    const gateways = await c.call("settings.gateways.list", {});
    assert.equal(gateways.result.gateways[0].platform, "weixin");
    assert.equal(JSON.stringify(gateways.result).includes("gateway-secret-must-not-leak"), false);

    const startedLogin = await c.call("settings.gateways.login.start", { platform: "weixin" });
    assert.equal(startedLogin.result.login.qrPayload, loginSnapshot.qrPayload);
    assert.equal(JSON.stringify(startedLogin.result).includes("login-token-must-not-leak"), false);
    const scannedLogin = await c.call("settings.gateways.login.status", {
      platform: "weixin",
      id: loginSnapshot.id,
    });
    assert.equal(scannedLogin.result.login.phase, "scanned");
    const cancelledLogin = await c.call("settings.gateways.login.cancel", {
      platform: "weixin",
      id: loginSnapshot.id,
    });
    assert.equal(cancelledLogin.result.login.phase, "cancelled");

    const organizations = await c.call("settings.organizations.list", {});
    assert.equal(organizations.result.connections[0].gatewayHost, "control.example.com");
    assert.deepEqual(organizations.result.connections[0].availableModels, ["deepseek-v4-flash", "deepseek-v4-pro"]);
    assert.equal(organizations.result.connections[0].tokenNeverExpires, true);
    assert.equal(organizations.result.connections[0].accessState, "permanent");
    assert.deepEqual(organizations.result.connections[0].services, [{
      service: "DESK_TASKS",
      mode: "CUSTOMER_HOSTED",
      accountRegion: "CN",
      host: "desk.example.com",
      status: "ACTIVE",
      capabilitiesVersion: 2,
      configVersion: 4,
    }]);
    assert.equal(JSON.stringify(organizations.result).includes("org-device-secret-must-not-leak"), false);

    const enrollmentCode = "single-use-code-must-not-leak";
    const enrolled = await c.call("settings.organizations.enroll", {
      id: "acme",
      label: "Acme",
      gatewayUrl: "https://control.example.com",
      code: enrollmentCode,
    });
    assert.equal(enrolledOrganizationInput.code, enrollmentCode, "authenticated callback receives the transient code");
    assert.equal(JSON.stringify(enrolled.result).includes(enrollmentCode), false, "enrollment results never echo a one-time code");
    assert.equal(JSON.stringify(enrolled.result).includes("org-device-secret-must-not-leak"), false);

    const checked = await c.call("settings.organizations.check", { id: "acme" });
    assert.deepEqual(checked.result, { id: "acme", ok: true, checkedAt: 123 });
    assert.equal((await c.call("settings.organizations.use", { id: "acme" })).result.activeId, "acme");
    assert.equal((await c.call("settings.organizations.remove", { id: "acme" })).result.connections.length, 0);

    const projectCwd = join(dir, "project");
    const unpinned = await c.call("settings.profiles.unpin", { cwd: projectCwd });
    assert.equal(unpinnedCwd, projectCwd);
    assert.equal(unpinned.result.removed, true);
    assert.equal(unpinned.result.providers.current.profileId, "personal");
    assert.equal(unpinned.result.organizations.switchLocked, false);
    assert.equal(JSON.stringify(unpinned.result).includes("unpin-result-secret-must-not-leak"), false);
  } finally {
    c.close();
    await srv.close();
    assert.equal(closeGatewayLoginsCalled, true, "serve shutdown closes every owned interactive login");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: an unconfigured engine still initializes so Desktop can open System Settings", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-provider-onboarding-"));
  const state = {
    current: {
      provider: "openai",
      model: "gpt-test",
      location: "cloud",
      auth: "api-key",
      keyConfigured: false,
      authenticated: false,
      profileId: "personal",
      profileKind: "byok",
      profileSource: "default",
      editable: true,
    },
    providers: [],
  };
  const deps = { ...baseDeps(null, memStore()), providerSettings: () => state };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  try {
    const init = await c.call("initialize", { token: "tok" });
    assert.equal(init.result.setupState, "needs-credentials");
    const settings = await c.call("settings.providers.list", {});
    assert.equal(settings.result.current.authenticated, false);
    const create = await c.call("session.create", {});
    assert.equal(create.error.code, -32603, "only task creation is blocked while settings remain available");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: live metadata and resume are serialized with an active turn", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-busy-"));
  const store = memStore();
  let markStarted;
  let finishTurn;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn() {
      markStarted();
      return new Promise((resolve) => {
        finishTurn = () => resolve({ text: "finished", toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
      });
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  let sending;
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    sending = c.call("session.send", { sessionId: result.sessionId, text: "hold this turn" });
    await started;

    for (const [method, params] of [
      ["session.resume", { sessionId: result.sessionId }],
      ["session.rename", { sessionId: result.sessionId, title: "racy title" }],
      ["session.archive", { sessionId: result.sessionId, archived: true }],
    ]) {
      const response = await c.call(method, params);
      assert.equal(response.error.code, -32002, `${method} rejects while the turn is active`);
    }
    assert.equal(store.saved.get(result.sessionId).meta.title, "", "busy rename did not persist");
    assert.equal(store.saved.get(result.sessionId).meta.archived, undefined, "busy archive did not persist");

    finishTurn();
    const sent = await sending;
    assert.equal(sent.result.reply, "finished");
    assert.equal((await c.call("session.rename", { sessionId: result.sessionId, title: "settled title" })).result.title, "settled title");
    assert.equal((await c.call("session.archive", { sessionId: result.sessionId, archived: true })).result.archived, true);
  } finally {
    finishTurn?.();
    if (sending) await sending.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: an attached session reloads AGENTS.md before every idle turn", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-agents-refresh-"));
  const store = memStore();
  const systems = [];
  writeFileSync(join(dir, "AGENTS.md"), "FIRST_PROJECT_RULE");
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ system, onText }) {
      systems.push(system);
      onText("ok");
      return { text: "ok", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    await c.call("session.send", { sessionId: result.sessionId, text: "answer once" });

    writeFileSync(join(dir, "AGENTS.md"), "SECOND_PROJECT_RULE");
    await c.call("session.send", { sessionId: result.sessionId, text: "answer again" });

    assert.equal(systems.length, 2);
    assert.match(systems[0], /FIRST_PROJECT_RULE/);
    assert.doesNotMatch(systems[0], /SECOND_PROJECT_RULE/);
    assert.match(systems[1], /SECOND_PROJECT_RULE/);
    assert.doesNotMatch(systems[1], /FIRST_PROJECT_RULE/);
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: session.steer targets the live turn and stays in the same task", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-steer-"));
  const store = memStore();
  let releaseFirst;
  let calls = 0;
  const providerHistories = [];
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ history, onText }) {
      calls++;
      providerHistories.push(structuredClone(history));
      if (calls === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
        onText("first");
        return { text: "first", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
      }
      onText("steered");
      return { text: "steered", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  let sending;
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    sending = c.call("session.send", { sessionId: result.sessionId, text: "primary objective" });
    const started = await c.waitEvent("event.turn_start");

    const stale = await c.call("session.steer", { sessionId: result.sessionId, text: "wrong", expectedTurnId: "stale-turn" });
    assert.equal(stale.error.code, -32002, "stale expectedTurnId is rejected");
    const steered = await c.call("session.steer", {
      sessionId: result.sessionId,
      text: "also cover the edge case",
      expectedTurnId: started.params.turnId,
    });
    assert.equal(steered.result.accepted, true);
    assert.equal(steered.result.taskId, started.params.taskId, "steering does not replace task identity");
    const acceptedSnapshot = store.saved.get(result.sessionId);
    assert.equal(acceptedSnapshot.task.steering[0].deliveryState, "pending", "ACK happens only after executable input is durable");
    assert.ok(!acceptedSnapshot.history.some((message) => message.role === "user" && message.content.includes("also cover the edge case")), "write-ahead inbox has not pretended the model consumed it yet");

    releaseFirst();
    const sent = await sending;
    assert.equal(sent.result.reply, "steered");
    assert.equal(sent.result.taskId, started.params.taskId);
    assert.equal(calls, 2, "late steering causes another provider round in the same logical task");
    assert.ok(providerHistories[1].some((message) => message.role === "user" && message.content.includes("also cover the edge case")));
    const saved = store.saved.get(result.sessionId);
    assert.equal(saved.task.objective, "primary objective", "original objective remains authoritative");
    assert.equal(saved.task.steering.length, 1, "accepted steer has a bounded durable audit entry");
    assert.equal(saved.task.steering[0].deliveryState, "consumed", "transcript delivery commits exactly once");
  } finally {
    releaseFirst?.();
    if (sending) await sending.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: session.submit atomically starts or steers and reports non-submission", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-submit-"));
  const store = memStore();
  let releaseFirst;
  let calls = 0;
  const providerHistories = [];
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ history, onText }) {
      calls++;
      providerHistories.push(structuredClone(history));
      if (calls === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
        onText("first");
        return { text: "first", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
      }
      onText("steered");
      return { text: "steered", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  let starting;
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    starting = c.call("session.submit", {
      sessionId: result.sessionId,
      text: "primary objective",
      mode: "start_or_steer",
    });
    const started = await c.waitEvent("event.turn_start");

    const idleOnly = await c.call("session.submit", {
      sessionId: result.sessionId,
      text: "wait for the next turn",
      mode: "start_if_idle",
    });
    assert.deepEqual(idleOnly.result, {
      submission: "not_submitted",
      reason: "not_idle",
      activeTurnId: started.params.turnId,
    });

    const pendingModelRoute = await c.call("session.submit", {
      sessionId: result.sessionId,
      text: "use the newly selected model",
      mode: "start_if_idle",
      expectedModel: "fake-2",
      expectedEffort: "high",
    });
    assert.deepEqual(pendingModelRoute.result, {
      submission: "not_submitted",
      reason: "configuration_mismatch",
      activeTurnId: started.params.turnId,
    }, "a staged composer route cannot start or steer on the previous provider");

    const forcedNewTask = await c.call("session.submit", {
      sessionId: result.sessionId,
      text: "a separate objective",
      newTask: true,
    });
    assert.deepEqual(forcedNewTask.result, {
      submission: "not_submitted",
      reason: "not_idle",
      activeTurnId: started.params.turnId,
    }, "newTask never steers into the currently running task");

    const wrongTurn = await c.call("session.submit", {
      sessionId: result.sessionId,
      text: "strict stale steer",
      mode: "steer",
      expectedTurnId: "stale-turn",
    });
    assert.deepEqual(wrongTurn.result, {
      submission: "not_submitted",
      reason: "expected_turn_mismatch",
      expectedTurnId: "stale-turn",
      activeTurnId: started.params.turnId,
    });

    const attachment = await c.call("session.submit", {
      sessionId: result.sessionId,
      text: "inspect this later",
      attachments: [{ kind: "file", path: join(dir, "not-opened-during-steer.txt") }],
    });
    assert.deepEqual(attachment.result, {
      submission: "not_submitted",
      reason: "attachments_not_steerable",
      activeTurnId: started.params.turnId,
    }, "an active turn rejects attachment steering without touching the selected path");

    const steered = await c.call("session.submit", {
      sessionId: result.sessionId,
      text: "also cover the edge case",
    });
    assert.equal(steered.result.submission, "steered");
    assert.equal(steered.result.taskId, started.params.taskId);
    assert.equal(steered.result.turnId, started.params.turnId);

    releaseFirst();
    const completed = await starting;
    assert.equal(completed.result.submission, "started");
    assert.equal(completed.result.reply, "steered");
    assert.equal(completed.result.taskId, started.params.taskId);
    assert.equal(calls, 2);
    assert.ok(providerHistories[1].some((message) => message.role === "user" && message.content.includes("also cover the edge case")));

    const noActiveTurn = await c.call("session.submit", {
      sessionId: result.sessionId,
      text: "too late",
      mode: "steer",
      expectedTurnId: started.params.turnId,
    });
    assert.equal(noActiveTurn.result.submission, "not_submitted");
    assert.equal(noActiveTurn.result.reason, "no_active_turn");
    assert.equal(noActiveTurn.result.activeTurnId, undefined, "an idle session must not leak the prior turn as active");
  } finally {
    releaseFirst?.();
    if (starting) await starting.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: concurrent session.submit calls preserve wire order without waiting for turn completion", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-submit-order-"));
  const store = memStore();
  let releaseFirst;
  let calls = 0;
  const providerHistories = [];
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ history }) {
      calls++;
      providerHistories.push(structuredClone(history));
      if (calls === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
        return { text: "first", toolUses: [], stop: "end" };
      }
      return { text: "done", toolUses: [], stop: "end" };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  let first;
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    first = c.call("session.submit", { sessionId: result.sessionId, text: "primary" });
    await c.waitEvent("event.turn_start");

    const [second, third] = await Promise.all([
      c.call("session.submit", { sessionId: result.sessionId, text: "follow-up two" }),
      c.call("session.submit", { sessionId: result.sessionId, text: "follow-up three" }),
    ]);
    assert.equal(second.result.submission, "steered");
    assert.equal(third.result.submission, "steered");

    releaseFirst();
    assert.equal((await first).result.submission, "started");
    assert.equal(calls, 2, "both concurrent steering inputs are consumed by one ordered follow-up round");
    const followUps = providerHistories[1]
      .filter((message) => message.role === "user" && message.content.includes(INTERJECT_PREFIX))
      .map((message) => message.content);
    assert.match(followUps[0], /follow-up two/);
    assert.match(followUps[1], /follow-up three/);
  } finally {
    releaseFirst?.();
    if (first) await first.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: interrupt after steer cannot overwrite the write-ahead transcript", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-steer-interrupt-"));
  const store = memStore();
  let releaseFirst;
  let calls = 0;
  const providerHistories = [];
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ history, onText }) {
      calls++;
      providerHistories.push(structuredClone(history));
      if (calls === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; }); // deliberately ignores AbortSignal
        return { text: "late", toolUses: [], stop: "end" };
      }
      onText("recovered");
      return { text: "recovered", toolUses: [], stop: "end" };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  let sending;
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    sending = c.call("session.send", { sessionId: result.sessionId, text: "primary" });
    const started = await c.waitEvent("event.turn_start");
    const steer = await c.call("session.steer", { sessionId: result.sessionId, text: "must survive interrupt", expectedTurnId: started.params.turnId });
    assert.equal(steer.result.accepted, true);
    await c.call("session.interrupt", { sessionId: result.sessionId });
    const interrupted = await sending;
    assert.ok(interrupted.error, "owning send ends as interrupted");

    const afterInterrupt = store.saved.get(result.sessionId);
    assert.equal(afterInterrupt.task.steering[0].deliveryState, "consumed");
    assert.equal(afterInterrupt.history.filter((message) => message.role === "user" && message.content.includes("must survive interrupt")).length, 1);

    const overlapping = await c.call("session.send", { sessionId: result.sessionId, text: "继续" });
    assert.equal(overlapping.error.code, -32002, "the interrupted physical provider retains the session lease");
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resumed = await c.call("session.send", { sessionId: result.sessionId, text: "继续" });
    assert.equal(resumed.result.reply, "recovered");
    assert.equal(providerHistories[1].filter((message) => message.role === "user" && message.content.includes("must survive interrupt")).length, 1, "recovery sees the accepted steer exactly once");
  } finally {
    releaseFirst?.();
    if (sending) await sending.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: only an explicit continuation resumes an unfinished task", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-resume-task-"));
  const store = memStore();
  const sessionId = randomUUID();
  const created = createTaskExecution("finish the original migration", randomUUID(), "2026-07-15T00:00:00.000Z");
  const paused = finishTaskExecution(created, { status: "completed" }, [{ text: "verify migration", status: "pending" }], false, "2026-07-15T00:01:00.000Z");
  store.saved.set(sessionId, {
    meta: {
      id: sessionId,
      cwd: dir,
      profileId: "personal",
      spaceId: "personal",
      provider: "fake",
      model: "fake-1",
      title: "migration",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:01:00.000Z",
      source: "interactive",
    },
    history: [{ role: "user", content: "finish the original migration" }],
    task: paused,
  });
  const systems = [];
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ system, onText }) {
      systems.push(system);
      const text = systems.length === 1 ? "continued" : "fresh";
      onText(text);
      return { text, toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const resumed = await c.call("session.resume", { sessionId });
    assert.equal(resumed.result.task.id, paused.id);

    const continued = await c.call("session.send", { sessionId, text: "continue and verify" });
    assert.equal(continued.result.taskId, paused.id, "an explicit continuation keeps the recovered task identity");
    assert.match(systems[0], /Objective: finish the original migration/);
    assert.doesNotMatch(systems[0], /Objective: continue and verify/);

    const fresh = await c.call("session.send", { sessionId, text: "start a separate audit" });
    assert.notEqual(fresh.result.taskId, paused.id, "an ordinary idle message starts a separate task by default");
    assert.match(systems[1], /Objective: start a separate audit/);
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: structured task facts, capability preflight, and artifacts survive the durable checkpoint", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-task-state-"));
  const store = memStore();
  let call = 0;
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ onText }) {
      call++;
      if (call === 1) {
        return {
          text: "",
          toolUses: [{
            id: "brief-state",
            name: "task_intake",
            input: {
              intent: "investigate",
              goal: "verify the generated report",
              constraints: ["do not modify the report"],
              acceptance: ["verification result and artifact are persisted"],
              steps: ["inspect report", "record verification state"],
            },
          }],
          stop: "tool_use",
        };
      }
      if (call === 2) {
        return {
          text: "",
          toolUses: [{
            id: "checkpoint-state",
            name: "task_checkpoint",
            input: {
              artifacts: ["reports/verified.json"],
              facts: [{ key: "rows_verified", value: 12, evidence: "twelve rows matched" }],
              capabilities: [{ name: "report_read", state: "available", detail: "read completed" }],
            },
          }],
          stop: "tool_use",
        };
      }
      onText("verified");
      return { text: "verified", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    const sent = await c.call("session.send", { sessionId: result.sessionId, text: "verify the report" });
    assert.equal(sent.result.reply, "verified");
    const saved = store.saved.get(result.sessionId);
    assert.equal(saved.task.checkpoint.facts.rows_verified.value, 12);
    assert.equal(saved.task.checkpoint.capabilities.report_read.state, "available");
    assert.deepEqual(saved.task.checkpoint.artifacts, ["reports/verified.json"]);
    const state = c.events.filter((event) => event.method === "event.task_state").at(-1);
    assert.deepEqual(state.params.checkpoint.facts, { rows_verified: 12 });
    assert.deepEqual(state.params.checkpoint.capabilities, { report_read: { state: "available", detail: "read completed" } });
    assert.deepEqual(state.params.checkpoint.artifacts, ["reports/verified.json"]);
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: failed and empty turns never replay an earlier assistant reply", { timeout: 20000 }, async () => {
  for (const mode of ["error", "empty"]) {
    const dir = mkdtempSync(join(tmpdir(), `hara-serve-${mode}-`));
    let calls = 0;
    const provider = {
      id: "fake",
      model: "fake-1",
      async turn({ onText }) {
        calls++;
        if (calls === 1) {
          onText("previous success");
          return { text: "previous success", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
        }
        if (mode === "error") {
          return { text: "", toolUses: [], stop: "error", errorMsg: "upstream exploded", usage: { input: 1, output: 0 } };
        }
        return { text: "", toolUses: [], stop: "end", usage: { input: 1, output: 0 } };
      },
    };
    const store = memStore();
    const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
    const c = await connect(srv.port);
    try {
      await c.call("initialize", { token: "tok" });
      const { result } = await c.call("session.create", {});
      assert.equal((await c.call("session.send", { sessionId: result.sessionId, text: "first" })).result.reply, "previous success");

      const failed = await c.call("session.send", { sessionId: result.sessionId, text: "now fail" });
      assert.equal(failed.error.code, -32603, `${mode} is an explicit RPC failure`);
      assert.doesNotMatch(failed.error.message, /previous success/, `${mode} did not reuse old assistant text`);
      assert.match(failed.error.message, mode === "error" ? /upstream exploded/ : /empty response/);
      const turnEnd = c.events.filter((event) => event.method === "event.turn_end").at(-1);
      assert.equal(turnEnd.params.status, mode);
      assert.equal(turnEnd.params.reply, "", `${mode} event has no stale reply`);
      const taskState = c.events.filter((event) => event.method === "event.task_state").at(-1);
      assert.equal(taskState.params.state, "blocked", `${mode} cannot leave the task indefinitely running`);
      assert.equal(store.saved.get(result.sessionId).task.status, "blocked", `${mode} persists a resumable failure boundary`);
    } finally {
      c.close();
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("serve e2e: an active deadline returns a recoverable paused result instead of an RPC error", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-deadline-paused-"));
  const provider = {
    id: "deadline",
    model: "deadline",
    async turn() {
      const until = Date.now() + 1_100;
      while (Date.now() < until) {
        // Deliberately hold the event loop past the active budget. The agent loop must notice the elapsed
        // deadline before accepting this late response as a successful turn.
      }
      return { text: "late response", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
  const deps = {
    ...baseDeps(provider, memStore()),
    runLimits: () => ({ timeoutMs: 1_000, maxRounds: 20 }),
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    const sent = await c.call("session.send", { sessionId: result.sessionId, text: "work until the deadline" });
    assert.equal(sent.error, undefined, "a recoverable deadline is not an RPC failure");
    assert.equal(sent.result.status, "paused");
    assert.equal(sent.result.stopReason, "deadline");
    assert.match(sent.result.reply, /agent run paused.*\/continue/i);

    const turnEnd = c.events.filter((event) => event.method === "event.turn_end").at(-1);
    assert.equal(turnEnd.params.status, "paused");
    assert.equal(turnEnd.params.stopReason, "deadline");
    assert.equal(turnEnd.params.error, undefined);
    const taskState = c.events.filter((event) => event.method === "event.task_state").at(-1);
    assert.equal(taskState.params.state, "paused");
    assert.equal(taskState.params.taskStatus, "paused");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: cumulative task rounds pause at 100 and explicit continuation opens the next tranche", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-task-round-budget-"));
  const store = memStore();
  const sessionId = randomUUID();
  const created = createTaskExecution("finish the bounded long task", randomUUID(), "2026-08-10T00:00:00.000Z");
  const pausedAtNinetyNine = {
    ...created,
    status: "paused",
    endedAt: "2026-08-10T00:01:00.000Z",
    roundsUsed: 99,
    roundBudgetLimit: 100,
  };
  store.saved.set(sessionId, {
    meta: {
      id: sessionId,
      cwd: dir,
      profileId: "personal",
      spaceId: "personal",
      provider: "fake",
      model: "fake-1",
      title: "bounded task",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
      source: "interactive",
    },
    history: [{ role: "user", content: "finish the bounded long task" }],
    task: pausedAtNinetyNine,
  });

  let calls = 0;
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ onText }) {
      calls += 1;
      if (calls === 1) {
        return {
          text: "",
          toolUses: [{
            id: "round-100-checkpoint",
            name: "task_checkpoint",
            input: { current_step: "verify the next strategy" },
          }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      onText("continued in the next bounded tranche");
      return {
        text: "continued in the next bounded tranche",
        toolUses: [],
        stop: "end",
        usage: { input: 1, output: 1 },
      };
    },
  };
  const deps = {
    ...baseDeps(provider, store),
    runLimits: () => ({ timeoutMs: 10_000, maxRounds: 256 }),
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const opened = await c.call("session.resume", { sessionId });
    assert.equal(opened.error, undefined);

    const capped = await c.call("session.send", { sessionId, text: "continue to the safety checkpoint" });
    assert.equal(capped.error, undefined);
    assert.equal(capped.result.status, "paused");
    assert.equal(capped.result.stopReason, "task_round_budget");
    assert.match(capped.result.reply, /100 cumulative provider round\(s\).*\/continue/is);
    assert.equal(store.saved.get(sessionId).task.roundsUsed, 100);
    assert.equal(store.saved.get(sessionId).task.roundBudgetLimit, 100);
    assert.equal(store.saved.get(sessionId).task.status, "paused");

    const resumed = await c.call("session.send", { sessionId, text: "/continue" });
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.result.reply, "continued in the next bounded tranche");
    assert.equal(store.saved.get(sessionId).task.roundsUsed, 101);
    assert.equal(store.saved.get(sessionId).task.roundBudgetLimit, 200);
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: graceful close aborts turns, closes clients, releases settled locks, and is idempotent", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-close-"));
  const store = memStore();
  const released = [];
  store.release = (id) => released.push(id);
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let aborted = false;
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ signal }) {
      markStarted();
      return new Promise((resolve) => {
        const interrupt = () => {
          aborted = true;
          resolve({ text: "", toolUses: [], stop: "error", errorMsg: "interrupted", usage: { input: 0, output: 0 } });
        };
        if (signal?.aborted) interrupt();
        else signal?.addEventListener("abort", interrupt, { once: true });
      });
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    void c.call("session.send", { sessionId: result.sessionId, text: "keep running" });
    await started;
    const socketClosed = new Promise((resolve) => c.ws.once("close", resolve));
    const outcome = await Promise.race([
      srv.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 3_000)),
    ]);
    assert.equal(outcome, "closed", "close is bounded even with a connected WebSocket");
    await socketClosed;
    assert.equal(aborted, true, "active provider received the shutdown abort");
    assert.ok(released.includes(result.sessionId), "a settled turn's session lock was released");
    await srv.close(); // repeat callers share the completed close promise
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: graceful close aborts an automation.run child and closes its persisted running state", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-close-automation-"));
  const storeLock = join(cronDir(), ".jobs.lock");
  let unlocker;
  const job = addJob({
    name: "close-owned automation",
    schedule: { kind: "once", runAt: Date.now() + 60_000, display: "once later" },
    task: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
    mode: "command",
    cwd: dir,
    createdAt: Date.now(),
  });
  const srv = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    baseDeps(textProvider, memStore()),
  );
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    void c.call("automation.run", { id: job.id });
    const startedBy = Date.now() + 2_000;
    while (findJob(job.id)?.lastStatus !== "running" && Date.now() < startedBy) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(findJob(job.id)?.lastStatus, "running");
    writeFileSync(
      storeLock,
      JSON.stringify({ pid: process.pid, token: "shutdown-terminal-persistence-blocker" }),
      { mode: 0o600 },
    );
    const closeStartedAt = Date.now();
    unlocker = spawn(
      process.execPath,
      [
        "-e",
        "setTimeout(() => require('node:fs').rmSync(process.argv[1], { force: true }), 3500)",
        storeLock,
      ],
      { stdio: "ignore" },
    );
    await srv.close();
    assert.ok(
      Date.now() - closeStartedAt >= 3_000,
      "close waits beyond its ordinary grace period while terminal cron persistence is blocked",
    );
    const settled = findJob(job.id);
    assert.notEqual(settled?.lastStatus, "running");
    assert.match(settled?.lastError ?? "", /interrupted|shutting down|cancellation/i);
  } finally {
    unlocker?.kill();
    rmSync(storeLock, { force: true });
    c.close();
    await srv.close();
    removeJob(job.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: Desktop actions recover dead automation owners but keep live owners busy", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-recover-automation-"));
  const makeJob = (name) => addJob({
    name,
    schedule: { kind: "every", everyMs: 3_600_000, display: "every 1h" },
    task: "exit 0",
    mode: "command",
    cwd: dir,
    createdAt: Date.now(),
  });
  const runJob = makeJob("recover before run");
  const updateJob = makeJob("recover before update");
  const deleteJob = makeJob("recover before delete");
  const liveJob = makeJob("live owner");
  const ownedIds = new Set([runJob.id, updateJob.id, deleteJob.id, liveJob.id]);
  const startedAt = Date.now() - 1_000;
  saveJobs(loadJobs().map((job) => ownedIds.has(job.id)
    ? {
        ...job,
        lastStatus: "running",
        runningSince: startedAt,
        lastRunAt: startedAt,
        runningPid: job.id === liveJob.id ? process.pid : 2_147_483_647,
        runningToken: `owner-${job.id}`,
      }
    : job));

  const srv = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    baseDeps(textProvider, memStore()),
  );
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });

    const recoveredRun = await c.call("automation.run", { id: runJob.id });
    assert.equal(recoveredRun.result.ok, false);
    assert.match(recoveredRun.result.error, /previous owner exited|recovered and disabled/i);
    assert.equal(findJob(runJob.id).lastStatus, "error");
    assert.equal(findJob(runJob.id).enabled, false);

    const firstUpdate = await c.call("automation.update", {
      id: updateJob.id,
      name: "updated after recovery",
      schedule: "every 1h",
      task: "exit 0",
      mode: "command",
    });
    assert.equal(firstUpdate.error.code, -32005, "the recovery action requires one informed retry");
    assert.equal(findJob(updateJob.id).enabled, false);
    const retriedUpdate = await c.call("automation.update", {
      id: updateJob.id,
      name: "updated after recovery",
      schedule: "every 1h",
      task: "exit 0",
      mode: "command",
    });
    assert.equal(retriedUpdate.result.id, updateJob.id);

    const firstDelete = await c.call("automation.delete", { id: deleteJob.id });
    assert.equal(firstDelete.error.code, -32005, "deletion does not erase a possible orphan without warning");
    const retriedDelete = await c.call("automation.delete", { id: deleteJob.id });
    assert.equal(retriedDelete.result.deleted, true);

    const liveRun = await c.call("automation.run", { id: liveJob.id });
    assert.equal(liveRun.error.code, -32002, "a live owner remains protected by BUSY");
  } finally {
    c.close();
    await srv.close();
    saveJobs(loadJobs().map((job) => job.id === liveJob.id
      ? {
          ...job,
          enabled: false,
          lastStatus: "error",
          lastError: "test cleanup",
          runningSince: undefined,
          runningPid: undefined,
          runningToken: undefined,
        }
      : job));
    for (const id of ownedIds) removeJob(id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: authenticated server.shutdown acknowledges then runs the graceful close path", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-rpc-shutdown-"));
  const srv = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    baseDeps(textProvider, memStore()),
  );
  const c = await connect(srv.port);
  try {
    const initialized = await c.call("initialize", { token: "tok" });
    assert.ok(initialized.result.capabilities.methods.includes("server.shutdown"));
    const socketClosed = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("server.shutdown did not close the socket")),
        3_000,
      );
      c.ws.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    const stopped = await c.call("server.shutdown", {});
    assert.deepEqual(stopped.result, { accepted: true });
    await socketClosed;
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: operations settling after shutdown grace release their retained locks", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-late-close-"));
  const store = memStore();
  const released = [];
  store.release = (id) => released.push(id);
  let markTurnStarted;
  let finishTurn;
  const turnStarted = new Promise((resolve) => { markTurnStarted = resolve; });
  const slowTurnProvider = {
    id: "fake",
    model: "fake-1",
    async turn() {
      markTurnStarted();
      return new Promise((resolve) => {
        finishTurn = () => resolve({ text: "late finish", toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
      });
    },
  };
  let markFactoryStarted;
  let finishFactory;
  const factoryStarted = new Promise((resolve) => { markFactoryStarted = resolve; });
  const switchedProvider = { id: "fake", model: "fake-2", async turn() { throw new Error("unused"); } };
  const deps = {
    ...baseDeps(slowTurnProvider, store),
    buildProviderFor: async (model) => {
      if (model !== "fake-2") return slowTurnProvider;
      markFactoryStarted();
      return new Promise((resolve) => { finishFactory = () => resolve(switchedProvider); });
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const turnSession = (await c.call("session.create", {})).result.sessionId;
    const configSession = (await c.call("session.create", {})).result.sessionId;
    void c.call("session.send", { sessionId: turnSession, text: "ignore shutdown abort" });
    void c.call("session.set-model", { sessionId: configSession, model: "fake-2" });
    await Promise.all([turnStarted, factoryStarted]);

    const outcome = await Promise.race([
      srv.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 3_500)),
    ]);
    assert.equal(outcome, "closed", "shutdown returns after its bounded grace period");
    assert.equal(released.includes(turnSession), false, "busy turn lock remained held at the timeout boundary");
    assert.equal(released.includes(configSession), false, "configuring lock remained held at the timeout boundary");

    finishTurn();
    finishFactory();
    const cleanupDeadline = Date.now() + 1_000;
    while ((!released.includes(turnSession) || !released.includes(configSession)) && Date.now() < cleanupDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(released.includes(turnSession), "late turn completion released its lock");
    assert.ok(released.includes(configSession), "late provider factory completion released its lock");
  } finally {
    finishTurn?.();
    finishFactory?.();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: session.interrupt settles a compaction even when its provider ignores abort", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-compact-interrupt-"));
  const store = memStore();
  const hanging = hangingCompactProvider();
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(hanging.provider, store));
  const c = await connect(srv.port);
  let compacting;
  try {
    await c.call("initialize", { token: "tok" });
    const sid = (await c.call("session.create", {})).result.sessionId;
    await c.call("session.send", { sessionId: sid, text: "make history" });
    compacting = c.call("session.compact", { sessionId: sid });
    await hanging.started;
    assert.equal(hanging.signal()?.aborted, false);
    assert.deepEqual((await c.call("session.interrupt", { sessionId: sid })).result, {});
    const result = await Promise.race([
      compacting,
      new Promise((_, reject) => setTimeout(() => reject(new Error("interrupted compact did not settle")), 1_000)),
    ]);
    assert.equal(result.error.code, -32603);
    assert.match(result.error.message, /compaction interrupted/);
    assert.equal(hanging.signal()?.aborted, true, "compact provider receives the interrupt signal");
    assert.equal(
      (await c.call("session.rename", { sessionId: sid, title: "too early" })).error.code,
      -32002,
      "the physical compaction retains the session lease after logical interruption",
    );
    hanging.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((await c.call("session.rename", { sessionId: sid, title: "idle again" })).result.title, "idle again", "busy clears after physical settlement");
  } finally {
    hanging.finish();
    if (compacting) await compacting.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: compaction has a hard timeout and close retains its lock until physical settlement", { timeout: 15000 }, async () => {
  for (const mode of ["timeout", "close"]) {
    const dir = mkdtempSync(join(tmpdir(), `hara-serve-compact-${mode}-`));
    const store = memStore();
    const released = [];
    store.release = (id) => released.push(id);
    const hanging = hangingCompactProvider();
    const deps = { ...baseDeps(hanging.provider, store), compactTimeoutMs: mode === "timeout" ? 40 : 5_000 };
    const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
    const c = await connect(srv.port);
    let compacting;
    try {
      await c.call("initialize", { token: "tok" });
      const sid = (await c.call("session.create", {})).result.sessionId;
      await c.call("session.send", { sessionId: sid, text: "make history" });
      compacting = c.call("session.compact", { sessionId: sid });
      await hanging.started;
      if (mode === "timeout") {
        const result = await Promise.race([
          compacting,
          new Promise((_, reject) => setTimeout(() => reject(new Error("compact hard timeout did not settle")), 1_000)),
        ]);
        assert.equal(result.error.code, -32603);
        assert.match(result.error.message, /compaction timed out/);
        assert.equal(hanging.signal()?.aborted, true, "hard timeout also aborts provider work");
        assert.equal(
          (await c.call("session.rename", { sessionId: sid, title: "after timeout" })).error.code,
          -32002,
          "the physical compaction retains the session lease after logical timeout",
        );
        c.close();
        await srv.close();
      } else {
        await srv.close();
        assert.equal(hanging.signal()?.aborted, true, "shutdown interrupts compact");
      }
      assert.equal(
        released.includes(sid),
        false,
        `${mode} shutdown keeps the attached session lock while the ignored provider is physical pending`,
      );
      hanging.finish();
      const releaseDeadline = Date.now() + 1_000;
      while (!released.includes(sid) && Date.now() < releaseDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(released.includes(sid), `${mode} provider settlement released the attached session lock`);
    } finally {
      hanging.finish();
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("serve automatically compacts a completed Desktop turn without replacing its reply", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-auto-compact-"));
  const store = memStore();
  let calls = 0;
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ onText, tools }) {
      calls += 1;
      if (calls === 1 || calls === 2 || calls === 4) {
        const text = `answer-${calls}`;
        onText?.(text);
        return { text, toolUses: [], stop: "end", usage: { input: 75, output: 2 } };
      }
      assert.deepEqual(tools, [], "compaction is a no-tool provider turn");
      if (calls === 5) {
        return { text: "", toolUses: [], stop: "error", errorMsg: "summarizer unavailable", usage: { input: 10, output: 0 } };
      }
      return { text: "verified work is complete; continue with the latest request", toolUses: [], stop: "end", usage: { input: 15, output: 5 } };
    },
  };
  const deps = {
    ...baseDeps(provider, store),
    autoCompact: () => ({ enabled: true, tokenCap: 50 }),
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const sid = (await c.call("session.create", {})).result.sessionId;
    const first = await c.call("session.send", { sessionId: sid, text: "one" });
    assert.equal(first.result.reply, "answer-1");
    assert.equal(calls, 1, "a two-message history is too small to compact");

    const second = await c.call("session.send", { sessionId: sid, text: "two" });
    assert.equal(second.result.reply, "answer-2", "the user receives the completed turn, never the summary text");
    assert.equal(calls, 3, "the second completed turn triggered exactly one bounded compaction call");
    assert.equal(second.result.usage.input, 90, "internal compaction usage remains visible in turn accounting");
    assert.ok(store.saved.get(sid).history[0].content.startsWith("Execution checkpoint"));
    const notices = c.events.filter((event) => event.method === "event.notice").map((event) => event.params.text);
    assert.ok(notices.some((text) => text.includes("Auto-compacting conversation")));
    assert.ok(notices.some((text) => text.includes("auto-compacted")));
    const turnEnds = c.events.filter((event) => event.method === "event.turn_end");
    assert.equal(turnEnds.at(-1).params.reply, "answer-2");

    const third = await c.call("session.send", { sessionId: sid, text: "three" });
    assert.equal(third.result.reply, "answer-4", "a failed automatic summary never fails the completed task reply");
    assert.equal(calls, 5, "the failed summarizer is attempted once without recursively retrying");
    assert.equal(third.result.usage.input, 85, "a provider-reported failed summarizer request is still accounted");
    assert.ok(store.saved.get(sid).history.some((message) => message.content === "three"));
    assert.ok(
      c.events
        .filter((event) => event.method === "event.notice")
        .some((event) => event.params.text.includes("auto-compact failed")),
      "the original history is kept and the recovery action is visible",
    );
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve compacts oversized durable history before retrying after a failed turn", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-preflight-compact-"));
  const store = memStore();
  let summaryCalls = 0;
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ history, onText, tools }) {
      if (tools.length === 0) {
        summaryCalls += 1;
        return {
          text: "Verified checkpoint: preserve the user's current task and the latest recovery request.",
          toolUses: [],
          stop: "end",
          usage: { input: 20, output: 5 },
        };
      }
      const latest = [...history].reverse().find((message) => message.role === "user")?.content ?? "";
      if (latest.includes("FAIL_WITH_LARGE_HISTORY")) {
        return { text: "", toolUses: [], stop: "error", errorMsg: "image adapter failed", usage: { input: 1, output: 0 } };
      }
      const reply = latest.includes("retry after compaction") ? "retry completed" : "seed completed";
      onText?.(reply);
      return { text: reply, toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
  const srv = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    {
      ...baseDeps(provider, store),
      autoCompact: () => ({ enabled: true, tokenCap: 9_999_999 }),
    },
  );
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const sid = (await c.call("session.create", {})).result.sessionId;
    assert.equal((await c.call("session.send", { sessionId: sid, text: "seed one" })).result.reply, "seed completed");
    assert.equal((await c.call("session.send", { sessionId: sid, text: "seed two" })).result.reply, "seed completed");

    const failed = await c.call("session.send", {
      sessionId: sid,
      text: `FAIL_WITH_LARGE_HISTORY\n${"diagnostic ".repeat(50_000)}`,
    });
    assert.equal(failed.error.code, -32603);
    assert.equal(summaryCalls, 0, "a failed turn cannot use the success-only compactor");

    const retried = await c.call("session.send", { sessionId: sid, text: "retry after compaction" });
    assert.equal(retried.result.reply, "retry completed");
    assert.equal(summaryCalls, 1, "the next request first creates one durable checkpoint");
    assert.ok(store.saved.get(sid).history[0].content.startsWith("Execution checkpoint"));
    assert.ok(
      c.events
        .filter((event) => event.method === "event.notice")
        .some((event) => event.params.text.includes("before this request")),
      "Desktop is told that recovery compaction happened before the retry",
    );
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: files.search + session.context + compact + rewind (codex desktop parity set)", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "alpha.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "beta.ts"), "export const b = 2;\n");
  writeFileSync(join(dir, "readme.md"), "# hi\n");
  const store = memStore();
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(textProvider, store));
  const c = await connect(srv.port);
  try {
    const init = await c.call("initialize", { token: "tok" });
    for (const m of ["files.search", "session.context", "session.compact", "session.rewind"]) {
      assert.ok(init.result.capabilities.methods.includes(m), `capability ${m} advertised`);
    }

    // files.search: fuzzy match + browse-all on empty query (relative POSIX paths)
    const hit = await c.call("files.search", { cwd: dir, query: "alpha" });
    assert.ok(hit.result.files.includes("src/alpha.ts"), `fuzzy hit, got ${JSON.stringify(hit.result.files)}`);
    const all = await c.call("files.search", { cwd: dir, query: "" });
    assert.ok(all.result.files.length >= 3, "empty query lists files");

    const { result } = await c.call("session.create", {});
    const sid = result.sessionId;

    // session.context resolves the session's cwd when cwd is omitted from files.search
    const viaSession = await c.call("files.search", { sessionId: sid, query: "beta" });
    assert.ok(viaSession.result.files.includes("src/beta.ts"), "files.search resolves cwd from sessionId");

    // two turns → history u,a,u,a; turn_end carries the ctx watermark
    const sent1 = await c.call("session.send", { sessionId: sid, text: "one" });
    assert.ok(sent1.result.ctx && typeof sent1.result.ctx.pct === "number" && sent1.result.ctx.window > 0, "send returns ctx watermark");
    await c.call("session.send", { sessionId: sid, text: "two" });
    const te = c.events.find((e) => e.method === "event.turn_end");
    assert.ok(te.params.ctx && typeof te.params.ctx.pct === "number", "turn_end event carries ctx");

    // session.context: watermark + spend breakdown
    const ctx = await c.call("session.context", { sessionId: sid });
    assert.ok(ctx.result.window > 0 && Array.isArray(ctx.result.rows) && ctx.result.total > 0, "context report shape");

    // session.rewind n=1 → drops the last exchange (4 → 2 entries client-side)
    const rew = await c.call("session.rewind", { sessionId: sid, n: 1 });
    assert.equal(rew.result.history.length, 2, "rewind dropped the last exchange");
    assert.equal(rew.result.history[0].text, "one", "the first exchange survived");
    const oor = await c.call("session.rewind", { sessionId: sid, n: 99 });
    assert.equal(oor.error.code, -32602, "out-of-range n → params error");

    // session.compact: bounded checkpoint + recent turn anchor (fake provider's weak "hello" is normalized)
    const comp = await c.call("session.compact", { sessionId: sid });
    assert.ok(comp.result.history[0].text.startsWith("Execution checkpoint"), "history begins with a structured checkpoint");
    assert.ok(comp.result.history.some((message) => message.text === "one"), "recent exact turn survives compaction");
    assert.ok(comp.result.notes >= 1, "working notes distilled");
    assert.ok(comp.result.ctx && typeof comp.result.ctx.pct === "number", "compact returns fresh ctx");
    const notices = c.events.filter((e) => e.method === "event.notice").map((e) => e.params.text);
    assert.ok(notices.some((t) => t.includes("Compacting")), "compaction announced");
    assert.equal(store.saved.get(sid).history.length, comp.result.history.length, "checkpoint and recent anchor persisted together");
    // compacting an (effectively) empty session refuses politely
    const { result: fresh } = await c.call("session.create", {});
    const nothing = await c.call("session.compact", { sessionId: fresh.sessionId });
    assert.equal(nothing.error.code, -32602, "nothing to compact → params error");

    // session.fork: duplicate history into a NEW live session; original untouched
    const fk = await c.call("session.fork", { sessionId: sid });
    assert.ok(fk.result.sessionId && fk.result.sessionId !== sid, "fork got a fresh id");
    assert.equal(fk.result.approval, "full-auto", "fork reports the inherited approval mode");
    assert.equal(fk.result.history.length, comp.result.history.length, "fork copied the compacted checkpoint plus recent anchor");
    assert.ok(store.saved.has(fk.result.sessionId), "fork persisted immediately");
    const fsend = await c.call("session.send", { sessionId: fk.result.sessionId, text: "diverge" });
    assert.equal(fsend.result.reply, "hello", "fork is a working session");
    assert.equal(store.saved.get(sid).history.length, comp.result.history.length, "original unchanged by fork's turn");
    const nofork = await c.call("session.fork", { sessionId: "nope" });
    assert.equal(nofork.error.code, -32003, "fork of unknown session errors");

    // session.delete: permanent — gone from the store and from session.list
    const del = await c.call("session.delete", { sessionId: sid });
    assert.equal(del.result.deleted, true, "delete acked");
    assert.equal(store.saved.has(sid), false, "session file removed");
    const after = await c.call("session.list", {});
    assert.equal(after.result.sessions.some((s) => s.id === sid), false, "deleted session not listed");
    const again = await c.call("session.delete", { sessionId: sid });
    assert.equal(again.error.code, -32003, "double delete → no-session error");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: inspect_image gives an agent-discovered workspace image to the pinned native model", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-inspect-image-"));
  const imagePath = join(dir, "downloaded.png");
  writeFileSync(
    imagePath,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  );
  const store = memStore();
  let agentRound = 0;
  let finalHistory = [];
  const provider = {
    id: "fake",
    model: "fake-native-vision",
    async turn(args) {
      const imageTurn = args.history.findLast((message) => message.role === "user")?.images?.length;
      if (imageTurn) {
        assert.equal(args.history.findLast((message) => message.role === "user").images[0].mediaType, "image/png");
        return {
          text: "The screenshot shows account 313499857952.",
          toolUses: [],
          stop: "end",
          usage: { input: 1, output: 1 },
        };
      }
      if (agentRound++ === 0) {
        return {
          text: "",
          toolUses: [{
            id: "inspect-1",
            name: "inspect_image",
            input: { path: "downloaded.png", focus: "read the account number" },
          }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      finalHistory = structuredClone(args.history);
      args.onText("identified");
      return { text: "identified", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
  const deps = {
    ...baseDeps(provider, store),
    prepareImages: async (images, opts) => {
      assert.equal(opts.model, "fake-native-vision");
      assert.equal(opts.hint, "read the account number");
      return { images };
    },
    runtimeInfo: () => ({
      providerId: "fake",
      model: "fake-native-vision",
      effortLevels: [],
      attachmentCapabilities: {
        image: { mode: "native" },
        textFile: "inline-text",
        directory: "bounded-inventory-and-tools",
        binaryFile: "agent-tool",
      },
    }),
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const client = await connect(srv.port);
  try {
    await client.call("initialize", { token: "tok" });
    const sessionId = (await client.call("session.create", {})).result.sessionId;
    const sent = await client.call("session.send", {
      sessionId,
      text: "Inspect the image downloaded during this task.",
    });
    assert.equal(sent.result.reply, "identified");
    const result = finalHistory.findLast((message) => message.role === "tool").results[0].content;
    assert.match(result, /Image inspected with fake-native-vision/);
    assert.match(result, /313499857952/);
  } finally {
    client.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: approval round-trip — suggest mode write_file waits for approval.reply, then completes", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-"));
  const store = memStore();
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(toolProvider(), store, "suggest"));
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    // answer the approval as soon as it arrives (concurrently with the running send)
    const approver = c.waitEvent("approval.request").then((ev) => {
      assert.equal(ev.params.allowAlways, true, "ordinary project edits advertise the narrow remembered scope");
      return c.call("approval.reply", { approvalId: ev.params.approvalId, allow: true });
    });
    const sent = await c.call("session.send", { sessionId: result.sessionId, text: "write it" });
    await approver;
    assert.equal(sent.result.reply, "done");
    assert.equal(c.events.filter((e) => e.method === "approval.request").length, 1, "exactly one approval asked");
    const waiting = c.events.find((e) => e.method === "event.task_state" && e.params.state === "waiting");
    assert.equal(waiting?.params.phase, "approval", "task state explicitly enters approval wait");
    assert.ok(waiting?.params.approval?.id, "waiting state carries the approval identity");
    const toolStates = c.events.filter((e) => e.method === "event.task_state" && e.params.phase === "tool");
    assert.ok(toolStates.some((event) => event.params.detail === "write_file"), "ambient task state names the active tool");
    assert.ok(
      toolStates.every((event) => !event.params.detail.includes(dir)),
      "ambient task state cannot expose command or workspace path previews",
    );
    assert.equal(c.events.filter((e) => e.method === "event.task_state").at(-1).params.state, "completed");
    const lifecycle = c.events.filter((e) => e.method === "event.task_state").map((e) => e.params);
    const checkpointIndex = lifecycle.findIndex((event) => event.phase === "checkpoint");
    assert.ok(checkpointIndex >= 0, "task_intake closes with a durable checkpoint");
    assert.ok(
      lifecycle.slice(checkpointIndex + 1).some(
        (event) => event.phase === "thinking" && event.detail === "Waiting for model response",
      ),
      "the next provider round replaces the checkpoint phase immediately instead of looking stuck",
    );
    assert.ok(
      lifecycle.every((event, index) => index === 0 || event.sequence > lifecycle[index - 1].sequence),
      "approval transitions retain strict event ordering",
    );
    assert.equal(readFileSync(join(dir, "approved.txt"), "utf8"), "hi", "the approved tool actually ran");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: a mid-turn conversation can fork from its last protocol-complete snapshot", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-mid-turn-fork-"));
  const store = memStore();
  const srv = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    baseDeps(toolProvider(), store, "suggest"),
  );
  const c = await connect(srv.port);
  let sending;
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    sending = c.call("session.send", { sessionId: result.sessionId, text: "write it, then keep working" });
    const approval = await c.waitEvent("approval.request");

    const forked = await c.call("session.fork", { sessionId: result.sessionId });
    assert.equal(forked.error, undefined, "an approval wait cannot permanently lock conversation transfer");
    assert.notEqual(forked.result.sessionId, result.sessionId);
    const snapshot = store.saved.get(forked.result.sessionId);
    assert.ok(snapshot.history.some((message) => message.role === "user" && message.content.includes("write it")));
    assert.equal(
      snapshot.history.some((message, index) =>
        message.role === "assistant"
        && message.toolUses.length > 0
        && snapshot.history[index + 1]?.role !== "tool"),
      false,
      "the copied history never ends with an orphaned tool_use",
    );
    assert.equal(snapshot.task.status, "paused", "the copied execution is a recoverable snapshot, not running");

    await c.call("approval.reply", { approvalId: approval.params.approvalId, allow: false });
    const original = await sending;
    assert.equal(original.result.reply, "done", "copying does not interrupt or mutate the source turn");
  } finally {
    if (sending) await sending.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: a per-session full-auto choice persists across reconnects without approval prompts", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-full-auto-persist-"));
  const store = memStore();
  let sessionId = "";

  const firstServer = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    baseDeps(toolProvider(), store, "suggest"),
  );
  const firstClient = await connect(firstServer.port);
  try {
    await firstClient.call("initialize", { token: "tok" });
    const created = await firstClient.call("session.create", {});
    sessionId = created.result.sessionId;
    assert.equal(created.result.approval, "suggest");

    const changed = await firstClient.call("session.set-approval", {
      sessionId,
      approval: "full-auto",
    });
    assert.equal(changed.result.approval, "full-auto");
    assert.equal(store.saved.has(sessionId), false, "draft-only settings do not create an empty transcript");

    const sent = await firstClient.call("session.send", { sessionId, text: "write without prompting" });
    assert.equal(sent.result.reply, "done");
    assert.equal(firstClient.events.filter((event) => event.method === "approval.request").length, 0);
    assert.equal(store.saved.get(sessionId).meta.approval, "full-auto");
  } finally {
    firstClient.close();
    await firstServer.close();
  }

  const secondServer = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok-2", cwd: dir },
    baseDeps(toolProvider(), store, "suggest"),
  );
  const secondClient = await connect(secondServer.port);
  try {
    await secondClient.call("initialize", { token: "tok-2" });
    const resumed = await secondClient.call("session.resume", { sessionId });
    assert.equal(resumed.result.approval, "full-auto", "resume restores the conversation choice, not the server default");

    const sent = await secondClient.call("session.send", { sessionId, text: "write after reconnect" });
    assert.equal(sent.result.reply, "done");
    assert.equal(secondClient.events.filter((event) => event.method === "approval.request").length, 0);
  } finally {
    secondClient.close();
    await secondServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: denied approval blocks the tool", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-"));
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(toolProvider(), memStore(), "suggest"));
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    const denier = c.waitEvent("approval.request").then((ev) => c.call("approval.reply", { approvalId: ev.params.approvalId, allow: false }));
    const sent = await c.call("session.send", { sessionId: result.sessionId, text: "write it" });
    await denier;
    assert.equal(sent.result.reply, "done", "turn still completes (model told of the denial)");
    assert.equal(existsSync(join(dir, "approved.txt")), false, "denied tool did NOT run");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: interrupt settles a pending approval immediately and leaves valid history", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-interrupt-approval-"));
  const store = memStore();
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(toolProvider(), store, "suggest"));
  const c = await connect(srv.port);
  let sending;
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    sending = c.call("session.send", { sessionId: result.sessionId, text: "write it" });
    const approval = await c.waitEvent("approval.request");

    const interrupted = await c.call("session.interrupt", { sessionId: result.sessionId });
    assert.deepEqual(interrupted.result, {});
    const failed = await Promise.race([
      sending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("turn stayed blocked on approval after interrupt")), 1_000)),
    ]);
    assert.equal(failed.error.code, -32603, "interrupted send fails instead of reporting success");
    assert.match(failed.error.message, /interrupted/);
    assert.equal(existsSync(join(dir, "approved.txt")), false, "interrupted approval never runs the tool");
    const lifecycle = c.events.filter((event) => event.method === "event.task_state");
    assert.ok(lifecycle.some((event) => event.params.phase === "stopping"), "interrupt announces safe stopping");
    assert.equal(lifecycle.at(-1).params.state, "paused", "interrupted task ends paused, not completed");

    const saved = store.saved.get(result.sessionId);
    assert.deepEqual(saved.history.slice(-2).map((message) => message.role), ["assistant", "tool"]);
    assert.equal(saved.history.at(-1).results[0].id, "t1");
    assert.equal(saved.history.at(-1).results[0].isError, true);
    // A reply racing in after cancellation is idempotent and cannot revive the old call.
    assert.deepEqual((await c.call("approval.reply", { approvalId: approval.params.approvalId, allow: true })).result, {});

    // The session is no longer busy immediately after the interrupted turn settles.
    const renamed = await c.call("session.rename", { sessionId: result.sessionId, title: "interrupt settled" });
    assert.equal(renamed.result.title, "interrupt settled");
  } finally {
    if (sending) await sending.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: approval wait pauses the active deadline and remains executable", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-paused-approval-"));
  const store = memStore();
  const deps = {
    ...baseDeps(toolProvider(), store, "suggest"),
    runLimits: () => ({ timeoutMs: 1_000, maxRounds: 10 }),
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  let sending;
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    sending = c.call("session.send", { sessionId: result.sessionId, text: "wait forever for approval" });
    const approval = await c.waitEvent("approval.request");
    let settled = false;
    void sending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(settled, false, "human wait may exceed runTimeoutMs without consuming active budget");
    assert.equal(existsSync(join(dir, "approved.txt")), false, "the tool remains gated until the reply");

    assert.deepEqual((await c.call("approval.reply", { approvalId: approval.params.approvalId, allow: true })).result, {});
    const sent = await Promise.race([
      sending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("approved turn did not resume")), 2_500)),
    ]);
    assert.equal(sent.result.reply, "done");
    assert.equal(readFileSync(join(dir, "approved.txt"), "utf8"), "hi");
  } finally {
    if (sending) await sending.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
