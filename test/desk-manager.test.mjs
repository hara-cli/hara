import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ackDeskTask,
  cancelDeskTask,
  claimStandaloneDeskTask,
  claimDeskTask,
  commentDeskTask,
  createDeskTask,
  fetchDeskSnapshot,
  fetchDeskTask,
  completeStandaloneDeskTask,
  registerAgent,
  saveCreds,
  saveProfileCreds,
  transitionDeskTask,
} from "../dist/desk.js";
import { resetPrivateHaraStateForTests } from "../dist/security/private-state.js";

const deskHome = mkdtempSync(join(tmpdir(), "hara-desk-manager-"));
process.env.HARA_DESK_STATE_HOME = deskHome;
const identity = {
  profileId: "org-manager",
  gatewayUrl: "https://control.example.test",
  tenantId: "tenant-manager",
  deviceId: "device-manager",
  enrolledAt: "2026-09-11T08:00:00.000Z",
};
const now = 1_800_000_000_000;

const task = (overrides = {}) => ({
  id: "t_abcd",
  kind: "feedback",
  title: "Desktop workbench",
  body: "Expose the organization task lifecycle.",
  risk: "high",
  state: "waiting_verification",
  priority: "urgent",
  severity: "major",
  slaDueAt: now + 60_000,
  parentId: null,
  createdBy: "a_manager",
  claimedBy: "a_manager",
  ackedBy: "owner@example.test",
  reporterRef: "tester",
  occurrenceCount: 3,
  sourceCount: 2,
  releaseVersion: "0.173.0",
  verificationSteps: "Create a task, comment, and close it.",
  claimedSessionId: null,
  claimExpiresAt: null,
  claimFence: 4,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const agent = {
  id: "a_manager",
  name: "Hara Desktop",
  owner: "owner@example.test",
  client: "hara-desktop",
  role: "owner",
  createdAt: now,
  lastSeen: now,
  revoked: false,
};

function resetDesk() {
  resetPrivateHaraStateForTests();
  saveProfileCreds({
    url: "https://desk.example.test",
    agentId: agent.id,
    owner: agent.owner,
    token: "private-manager-token",
  }, identity);
}

after(() => {
  delete process.env.HARA_DESK_STATE_HOME;
  rmSync(deskHome, { recursive: true, force: true });
});

test("Desk 0.7 lifecycle states and metadata remain readable in the organization board", async () => {
  resetDesk();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const body = url.pathname === "/whoami"
      ? { agent }
      : url.pathname === "/tasks"
        ? { tasks: [task()] }
        : url.pathname === "/agents"
          ? { agents: [agent] }
          : url.pathname === "/events"
            ? { events: [] }
            : { circles: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const snapshot = await fetchDeskSnapshot(identity, "waiting_verification");
    assert.equal(snapshot.tasks[0].state, "waiting_verification");
    assert.equal(snapshot.tasks[0].priority, "urgent");
    assert.equal(snapshot.tasks[0].sourceCount, 2);
    assert.equal(snapshot.tasks[0].releaseVersion, "0.173.0");
    assert.doesNotMatch(JSON.stringify(snapshot), /private-manager-token/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("task details include comments, sources, execution evidence, and diffs without leaking credentials", async () => {
  resetDesk();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    task: task(),
    events: [{ id: 1, taskId: "t_abcd", actor: agent.id, action: "state_waiting_verification", detail: "released", at: now }],
    comments: [{ id: "cm_abcd", taskId: "t_abcd", actor: agent.id, sessionId: null, body: "Ready for verification", at: now }],
    attachments: [],
    sources: [{ id: 1, sourceKind: "feishu", sourceChatId: "chat", sourceMessageId: "message", sourceUrl: "", reporterRef: "tester", createdAt: now }],
    links: [],
    executionEvents: [{ id: 2, eventKey: "run:1", agentId: agent.id, sessionId: null, taskId: "t_abcd", kind: "message", payload: { phase: "verified", apiKey: "private-manager-token", log: "Bearer private-manager-token" }, at: now }],
    diffs: [{ id: "df_abcd", artifactKey: "diff:1", taskId: "t_abcd", agentId: agent.id, sessionId: "s_abcd", worktreeLabel: "task", baseRef: "main", headRef: "work", patchSha256: "a".repeat(64), summary: "Desk manager", state: "approved", createdAt: now, reviewedBy: agent.id, reviewedAt: now, reviewNote: "ok", mergeRef: "abc" }],
  }), { status: 200 });
  try {
    const details = await fetchDeskTask(identity, "t_abcd");
    assert.equal(details.comments[0].body, "Ready for verification");
    assert.equal(details.sources[0].sourceKind, "feishu");
    assert.deepEqual(details.executionEvents[0].payload, { phase: "verified", apiKey: "***", log: "Bearer ***" });
    assert.equal(details.diffs[0].state, "approved");
    assert.doesNotMatch(JSON.stringify(details), /private-manager-token/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("organization task mutations stay profile-pinned and use only the Engine-owned bearer", async () => {
  resetDesk();
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path: url.pathname, method: init?.method, authorization: init?.headers?.authorization, body });
    if (url.pathname.endsWith("/comments")) {
      return new Response(JSON.stringify({
        comment: { id: "cm_abcd", taskId: "t_abcd", actor: agent.id, sessionId: null, body: body.body, at: now },
      }), { status: 201 });
    }
    const state = url.pathname.endsWith("/transition") ? body.state
      : url.pathname.endsWith("/cancel") ? "cancelled"
        : url.pathname.endsWith("/claim") ? "claimed"
          : "open";
    return new Response(JSON.stringify({ task: task({ state, title: body.title ?? task().title, body: body.body ?? task().body }) }), { status: 200 });
  };
  try {
    assert.equal((await createDeskTask(identity, { kind: "dispatch", title: "  Ship release  ", body: "today", priority: "high" })).profileId, "org-manager");
    assert.equal((await transitionDeskTask(identity, "t_abcd", { state: "waiting_user", note: "Need approval" })).task.state, "waiting_user");
    assert.equal((await ackDeskTask(identity, "t_abcd")).task.id, "t_abcd");
    assert.equal((await commentDeskTask(identity, "t_abcd", "  Confirmed  ")).comment.body, "Confirmed");
    assert.equal((await cancelDeskTask(identity, "t_abcd", "No longer needed")).task.state, "cancelled");
    assert.ok(requests.every((request) => request.method === "POST"));
    assert.ok(requests.every((request) => request.authorization === "Bearer private-manager-token"));
    assert.equal(requests[0].body.title, "Ship release");
    assert.equal(requests[3].body.body, "Confirmed");
    assert.doesNotMatch(JSON.stringify(await createDeskTask(identity, { kind: "feedback", title: "No secret" })), /private-manager-token/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("executable Desk work uses a private renewable Session and never returns its bearer", async () => {
  resetDesk();
  const previousFetch = globalThis.fetch;
  const sessionToken = `hds_${"1".repeat(48)}`;
  const renewedToken = `hds_${"2".repeat(48)}`;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = init?.headers?.authorization;
    requests.push({ path: url.pathname, authorization });
    if (url.pathname === "/sessions") {
      return new Response(JSON.stringify({
        session: { id: "s_abcdef", leaseExpiresAt: now + 3_600_000 },
        token: sessionToken,
      }), { status: 201 });
    }
    if (url.pathname.endsWith("/renew")) {
      return new Response(JSON.stringify({
        session: { id: "s_abcdef", leaseExpiresAt: now + 7_200_000 },
        token: renewedToken,
      }), { status: 200 });
    }
    if (url.pathname.endsWith("/claim")) {
      return new Response(JSON.stringify({ task: task({
        state: "claimed",
        claimedSessionId: "s_abcdef",
        claimExpiresAt: now + 900_000,
        claimFence: 5,
      }) }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  };
  try {
    const claimed = await claimDeskTask(identity, "t_abcd");
    assert.equal(requests[0].path, "/sessions");
    assert.equal(requests[0].authorization, "Bearer private-manager-token");
    assert.equal(requests[1].path, "/tasks/t_abcd/claim");
    assert.equal(requests[1].authorization, `Bearer ${sessionToken}`);
    assert.equal(claimed.task.claimedSessionId, "s_abcdef");
    assert.doesNotMatch(JSON.stringify(claimed), /hds_|private-manager-token/);

    // Simulate an Engine restart finding the same private Session cache near expiry. It renews via
    // hdk and then executes via the rotated hds; neither credential crosses the public response.
    const connectionFile = JSON.parse(readFileSync(join(deskHome, ".hara", "desk-connections.json"), "utf8"));
    const binding = connectionFile.connections[identity.profileId];
    writeFileSync(join(deskHome, ".hara", "desk-workbench-sessions.json"), JSON.stringify({
      version: 1,
      sessions: {
        [identity.profileId]: {
          identityFingerprint: binding.identityFingerprint,
          bindingRevision: binding.revision,
          sessionId: "s_abcdef",
          token: sessionToken,
          expiresAt: Date.now() + 1_000,
        },
      },
    }));
    requests.length = 0;
    const reclaimed = await claimDeskTask(identity, "t_abcd");
    assert.equal(requests[0].path, "/sessions/s_abcdef/renew");
    assert.equal(requests[0].authorization, "Bearer private-manager-token");
    assert.equal(requests[1].authorization, `Bearer ${renewedToken}`);
    assert.doesNotMatch(JSON.stringify(reclaimed), /hds_|private-manager-token/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("standalone CLI task execution also uses its private persisted Session", async () => {
  resetPrivateHaraStateForTests();
  const permanentToken = `hdk_${"3".repeat(48)}`;
  const sessionToken = `hds_${"4".repeat(48)}`;
  const creds = {
    url: "https://desk.example.test",
    agentId: agent.id,
    owner: agent.owner,
    token: permanentToken,
  };
  saveCreds(creds);
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path: url.pathname, authorization: init?.headers?.authorization, body });
    if (url.pathname === "/sessions") {
      return new Response(JSON.stringify({
        session: { id: "s_123abc", leaseExpiresAt: now + 3_600_000 },
        token: sessionToken,
      }), { status: 201 });
    }
    if (url.pathname.endsWith("/claim")) {
      return new Response(JSON.stringify({ task: task({
        state: "claimed",
        claimedSessionId: "s_123abc",
        claimExpiresAt: now + 900_000,
        claimFence: 9,
      }) }), { status: 200 });
    }
    if (url.pathname.endsWith("/claim/renew")) {
      return new Response(JSON.stringify({ task: task({
        state: "claimed",
        claimedSessionId: "s_123abc",
        claimExpiresAt: now + 900_000,
        claimFence: 9,
      }) }), { status: 200 });
    }
    if (url.pathname.endsWith("/complete")) {
      return new Response(JSON.stringify({ task: task({
        state: "done",
        claimedSessionId: null,
        claimExpiresAt: null,
        claimFence: 9,
      }) }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  };
  try {
    const claimed = await claimStandaloneDeskTask(creds, "t_abcd");
    const completed = await completeStandaloneDeskTask(creds, "t_abcd", {
      detail: "verified",
      claimFence: claimed.task.claimFence,
    });
    assert.equal(requests[0].authorization, `Bearer ${permanentToken}`);
    assert.equal(requests[1].authorization, `Bearer ${sessionToken}`);
    assert.equal(requests[2].path, "/tasks/t_abcd/claim/renew");
    assert.equal(requests[2].authorization, `Bearer ${sessionToken}`);
    assert.equal(requests[3].authorization, `Bearer ${sessionToken}`);
    assert.equal(requests[3].body.claimFence, 9);
    assert.equal(completed.task.state, "done");
    assert.doesNotMatch(JSON.stringify([claimed, completed]), /hdk_|hds_/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("organization registration binds the canonical Hara client to the Control installation", async () => {
  resetPrivateHaraStateForTests();
  const previousFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname === "/health") {
      return new Response(JSON.stringify({
        ok: true,
        deployment: { realmId: identity.tenantId },
      }), { status: 200 });
    }
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      agentId: "a_registered",
      owner: "owner@example.test",
      token: `hdk_${"5".repeat(48)}`,
    }), { status: 200 });
  };
  try {
    await registerAgent(
      "https://desk.example.test",
      "server-held-enroll-key",
      "Hara CLI",
      "owner@example.test",
      undefined,
      identity,
    );
    assert.equal(requestBody.client, "nanhara.hara-cli");
    assert.equal(requestBody.realmId, identity.tenantId);
    assert.match(requestBody.provisioningId, /^hara_[a-f0-9]{64}$/);
    assert.equal(requestBody.installationId, identity.deviceId);
    assert.equal(requestBody.platform, process.platform);
    assert.match(requestBody.version, /^\d+\.\d+\.\d+/);
    assert.deepEqual(requestBody.capabilities, [
      "tasks",
      "comments",
      "organization-workbench",
      "session-lease",
    ]);
    assert.notEqual(requestBody.deviceName, "");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
