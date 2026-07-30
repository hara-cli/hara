import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeskClientError,
  deskCall,
  deskConnectionsSnapshot,
  deskOrganizationIdentityMatches,
  fetchDeskSnapshot,
  fetchDeskTask,
  loadCreds,
  loadProfileCreds,
  normalizeDeskBaseUrl,
  removeMismatchedProfileCreds,
  removeProfileCreds,
  saveCreds,
  saveProfileCreds,
} from "../dist/desk.js";
import { resetPrivateHaraStateForTests } from "../dist/security/private-state.js";

const deskHome = mkdtempSync(join(tmpdir(), "hara-desk-profile-"));
process.env.HARA_DESK_STATE_HOME = deskHome;
const haraDir = join(deskHome, ".hara");
const deskPath = join(haraDir, "desk.json");
const connectionsPath = join(haraDir, "desk-connections.json");
const identityA = {
  profileId: "org-a",
  gatewayUrl: "https://control-a.example.test",
  deviceId: "device-a",
  enrolledAt: "2026-07-30T10:00:00.000Z",
};
const identityB = {
  profileId: "org-b",
  gatewayUrl: "https://control-b.example.test",
  deviceId: "device-b",
  enrolledAt: "2026-07-30T11:00:00.000Z",
};

after(() => {
  delete process.env.HARA_DESK_STATE_HOME;
  rmSync(deskHome, { recursive: true, force: true });
});

function resetDeskFile() {
  resetPrivateHaraStateForTests();
  rmSync(deskPath, { force: true });
  rmSync(connectionsPath, { force: true });
}

test("Desk URL policy requires HTTPS except for loopback and rejects URL-carried authority", () => {
  assert.equal(normalizeDeskBaseUrl("https://desk.example.test/"), "https://desk.example.test");
  assert.equal(normalizeDeskBaseUrl("http://127.0.0.1:4200"), "http://127.0.0.1:4200");
  assert.equal(normalizeDeskBaseUrl("http://localhost:4200/"), "http://localhost:4200");
  assert.throws(() => normalizeDeskBaseUrl("http://desk.example.test"), /HTTPS/i);
  assert.throws(() => normalizeDeskBaseUrl("https://user:pass@desk.example.test"), /credentials/i);
  assert.throws(() => normalizeDeskBaseUrl("https://desk.example.test/api"), /without an API path/i);
  assert.throws(() => normalizeDeskBaseUrl("https://desk.example.test?token=secret"), /query/i);
});

test("legacy Desk credentials remain unbound while native connections use an independent store", () => {
  resetDeskFile();
  mkdirSync(haraDir, { recursive: true, mode: 0o700 });
  writeFileSync(deskPath, JSON.stringify({
    url: "https://legacy.example.test",
    agentId: "legacy-agent",
    owner: "legacy-owner",
    token: "legacy-secret",
  }), { mode: 0o600 });
  resetPrivateHaraStateForTests();

  assert.equal(loadCreds()?.agentId, "legacy-agent", "legacy CLI callers remain readable");
  assert.equal(loadProfileCreds(identityA), null, "legacy token is not silently assigned to an organization");
  assert.deepEqual(deskConnectionsSnapshot([identityA]), {
    connections: [{ profileId: "org-a", configured: false }],
    legacyUnbound: true,
  });

  saveProfileCreds({
    url: "https://desk-a.example.test",
    agentId: "agent-a",
    owner: "owner-a",
    token: "secret-a",
  }, identityA);
  saveProfileCreds({
    url: "https://desk-b.example.test",
    agentId: "agent-b",
    owner: "owner-b",
    token: "secret-b",
  }, identityB);

  const file = JSON.parse(readFileSync(connectionsPath, "utf8"));
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file.connections).sort(), ["org-a", "org-b"]);
  assert.match(file.connections["org-a"].revision, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  assert.match(file.connections["org-b"].revision, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  assert.equal(JSON.parse(readFileSync(deskPath, "utf8")).agentId, "legacy-agent");
  assert.equal(loadProfileCreds(identityA)?.token, "secret-a");
  assert.equal(loadProfileCreds(identityB)?.token, "secret-b");
  assert.deepEqual(deskConnectionsSnapshot([identityA, identityB]), {
    connections: [
      {
        profileId: "org-a",
        configured: true,
        bindingRevision: file.connections["org-a"].revision,
        host: "desk-a.example.test",
        agentId: "agent-a",
        owner: "owner-a",
      },
      {
        profileId: "org-b",
        configured: true,
        bindingRevision: file.connections["org-b"].revision,
        host: "desk-b.example.test",
        agentId: "agent-b",
        owner: "owner-b",
      },
    ],
    legacyUnbound: true,
  });
});

test("profile identity rotation never revives a prior organization's Desk token", () => {
  resetDeskFile();
  saveProfileCreds({
    url: "https://desk-a.example.test",
    agentId: "agent-a",
    owner: "owner-a",
    token: "secret-a",
  }, identityA);
  const bindingRevision = JSON.parse(readFileSync(connectionsPath, "utf8"))
    .connections["org-a"].revision;

  const replacement = {
    ...identityA,
    gatewayUrl: "https://control-new.example.test",
    deviceId: "device-new",
    enrolledAt: "2026-07-31T12:00:00.000Z",
  };
  assert.equal(loadProfileCreds(replacement), null);
  assert.equal(deskOrganizationIdentityMatches(identityA, replacement), false);
  assert.deepEqual(deskConnectionsSnapshot([replacement]), {
    connections: [{
      profileId: "org-a",
      configured: false,
      needsRebind: true,
      bindingRevision,
    }],
    legacyUnbound: false,
  });
  assert.equal(removeMismatchedProfileCreds(replacement), true);
  assert.deepEqual(deskConnectionsSnapshot([replacement]), {
    connections: [{ profileId: "org-a", configured: false }],
    legacyUnbound: false,
  });
  assert.equal(removeProfileCreds("org-a"), false);
});

test("rotating a profile-scoped Desk bearer changes its non-secret cache revision", () => {
  resetDeskFile();
  const first = {
    url: "https://desk-a.example.test",
    agentId: "agent-a",
    owner: "owner-a",
    token: "secret-a",
  };
  saveProfileCreds(first, identityA);
  const before = deskConnectionsSnapshot([identityA]).connections[0];
  assert.equal(before.configured, true);
  assert.ok(before.bindingRevision);

  saveProfileCreds({ ...first, token: "secret-b" }, identityA);
  const after = deskConnectionsSnapshot([identityA]).connections[0];
  assert.equal(after.configured, true);
  assert.ok(after.bindingRevision);
  assert.notEqual(after.bindingRevision, before.bindingRevision);
  assert.doesNotMatch(JSON.stringify(after), /secret-a|secret-b/);
});

test("an in-flight Desk read fails if its profile credential rotates before completion", async () => {
  resetDeskFile();
  const initial = {
    url: "https://desk-a.example.test",
    agentId: "agent-a",
    owner: "owner-a",
    token: "secret-a",
  };
  saveProfileCreds(initial, identityA);
  const previousFetch = globalThis.fetch;
  const now = 1234;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    if (calls === 5) {
      saveProfileCreds({
        ...initial,
        token: "rotated-secret",
      }, identityA);
    }
    const path = new URL(String(input)).pathname;
    const body = path === "/whoami"
      ? {
          agent: {
            id: "agent-a",
            name: "Desk A",
            owner: "owner-a",
            client: "hara-cli",
            role: "member",
            createdAt: now,
            lastSeen: now,
            revoked: false,
          },
        }
      : path === "/tasks"
        ? { tasks: [] }
        : path === "/agents"
          ? { agents: [] }
          : path === "/events"
            ? { events: [] }
            : { circles: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    await assert.rejects(
      fetchDeskSnapshot(identityA, "open"),
      (error) =>
        error instanceof DeskClientError
        && error.code === "CONFLICT",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("legacy MCP writes cannot overwrite native multi-organization bindings", () => {
  resetDeskFile();
  saveProfileCreds({
    url: "https://desk-a.example.test",
    agentId: "agent-a",
    owner: "owner-a",
    token: "secret-a",
  }, identityA);
  saveCreds({
    url: "https://legacy-new.example.test",
    agentId: "legacy-new",
    owner: "legacy-owner",
    token: "legacy-secret",
  });
  assert.equal(loadCreds()?.agentId, "legacy-new");
  assert.equal(loadProfileCreds(identityA)?.agentId, "agent-a");
  assert.equal(JSON.parse(readFileSync(connectionsPath, "utf8")).version, 1);
});

test("a malformed native connection store fails closed and is never overwritten", () => {
  resetDeskFile();
  mkdirSync(haraDir, { recursive: true, mode: 0o700 });
  writeFileSync(connectionsPath, "{\"version\":1,\"connections\":", { mode: 0o600 });
  resetPrivateHaraStateForTests();
  assert.throws(
    () => saveProfileCreds({
      url: "https://desk-a.example.test",
      agentId: "agent-a",
      owner: "owner-a",
      token: "secret-a",
    }, identityA),
    (error) =>
      error instanceof DeskClientError
      && error.code === "INVALID_CONFIGURATION",
  );
  assert.equal(readFileSync(connectionsPath, "utf8"), "{\"version\":1,\"connections\":");
});

test("prototype-shaped profile ids require real own bindings", () => {
  resetDeskFile();
  const constructorIdentity = {
    ...identityA,
    profileId: "constructor",
  };
  const toStringIdentity = {
    ...identityB,
    profileId: "toString",
  };
  assert.deepEqual(deskConnectionsSnapshot([constructorIdentity, toStringIdentity]), {
    connections: [
      { profileId: "constructor", configured: false },
      { profileId: "toString", configured: false },
    ],
    legacyUnbound: false,
  });
  saveProfileCreds({
    url: "https://desk-constructor.example.test",
    agentId: "agent-constructor",
    owner: "owner-constructor",
    token: "secret-constructor",
  }, constructorIdentity);
  assert.equal(loadProfileCreds(constructorIdentity)?.agentId, "agent-constructor");
  assert.equal(loadProfileCreds(toStringIdentity), null);
});

test("profile-scoped Desk snapshot performs only explicit bounded reads and never returns the token", async () => {
  resetDeskFile();
  saveProfileCreds({
    url: "https://desk-a.example.test",
    agentId: "agent-a",
    owner: "owner-a",
    token: "secret-a",
  }, identityA);

  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      path: `${url.pathname}${url.search}`,
      authorization: init?.headers?.authorization,
      redirect: init?.redirect,
    });
    const now = 1234;
    const bodies = {
      "/whoami": {
        agent: {
          id: "agent-a",
          name: "Desk A",
          owner: "owner-a",
          client: "hara-cli",
          role: "member",
          createdAt: now,
          lastSeen: now,
          revoked: false,
        },
      },
      "/agents": {
        agents: [{
          id: "agent-a",
          name: "Desk A",
          owner: "owner-a",
          client: "hara-cli",
          role: "member",
          createdAt: now,
          lastSeen: now,
          revoked: false,
        }],
      },
      "/circles": {
        circles: [{ id: "c_1", name: "Build", owner: "owner-a", createdAt: now }],
      },
    };
    const body = url.pathname === "/tasks"
      ? {
          tasks: [{
            id: "t_1",
            kind: "dispatch",
            title: "Ship",
            body: "Deploy",
            risk: "low",
            state: "open",
            createdBy: "agent-a",
            claimedBy: null,
            ackedBy: null,
            createdAt: now,
            updatedAt: now,
          }],
        }
      : url.pathname === "/events"
        ? {
            events: [{
              id: 1,
              taskId: "t_1",
              actor: "agent-a",
              action: "post",
              detail: "",
              at: now,
              title: "Ship",
              kind: "dispatch",
            }],
          }
        : bodies[url.pathname];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const snapshot = await fetchDeskSnapshot(identityA, "open");
    assert.equal(snapshot.profileId, "org-a");
    assert.equal(snapshot.me.id, "agent-a");
    assert.equal(snapshot.tasks[0].id, "t_1");
    assert.equal(snapshot.tasks[0].excerpt, "Deploy");
    assert.equal("body" in snapshot.tasks[0], false);
    assert.equal(snapshot.events[0].taskId, "t_1");
    assert.equal(snapshot.circles[0].id, "c_1");
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-a/);
    assert.deepEqual(
      requests.map((request) => request.path).sort(),
      [
        "/agents",
        "/circles",
        "/events?since=0&limit=100",
        "/tasks?state=open&limit=100",
        "/whoami",
      ],
    );
    assert.ok(requests.every((request) => request.authorization === "Bearer secret-a"));
    assert.ok(requests.every((request) => request.redirect === "error"));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Desk snapshot rejects unknown authorization and task-state enums instead of downgrading them", async () => {
  resetDeskFile();
  saveProfileCreds({
    url: "https://desk-a.example.test",
    agentId: "agent-a",
    owner: "owner-a",
    token: "secret-a",
  }, identityA);
  const previousFetch = globalThis.fetch;
  const now = 1234;
  const baseAgent = {
    id: "agent-a",
    name: "Desk A",
    owner: "owner-a",
    client: "hara-cli",
    role: "member",
    createdAt: now,
    lastSeen: now,
    revoked: false,
  };
  const baseTask = {
    id: "t_1",
    kind: "dispatch",
    title: "Ship",
    body: "Deploy",
    risk: "low",
    state: "open",
    createdBy: "agent-a",
    claimedBy: null,
    ackedBy: null,
    createdAt: now,
    updatedAt: now,
  };
  let scenario = "state";
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    const agent = { ...baseAgent };
    const task = { ...baseTask };
    if (scenario === "state") task.state = "blocked";
    if (scenario === "risk") task.risk = "critical";
    if (scenario === "kind") task.kind = "job";
    if (scenario === "role") agent.role = "observer";
    if (scenario === "revoked") agent.revoked = "false";
    const body = path === "/whoami"
      ? { agent }
      : path === "/agents"
        ? { agents: [agent] }
        : path === "/tasks"
          ? { tasks: [task] }
          : path === "/events"
            ? { events: [] }
            : { circles: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    for (scenario of ["state", "risk", "kind", "role", "revoked"]) {
      await assert.rejects(
        fetchDeskSnapshot(identityA, "open"),
        (error) => error instanceof DeskClientError && error.code === "PROTOCOL",
        `scenario ${scenario} must fail closed`,
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Desk transport redacts remote error bodies and task reads reject path injection", async () => {
  resetDeskFile();
  saveProfileCreds({
    url: "https://desk-a.example.test",
    agentId: "agent-a",
    owner: "owner-a",
    token: "secret-a",
  }, identityA);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: "authorization secret-a leaked by upstream" }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
  try {
    await assert.rejects(
      deskCall("https://desk-a.example.test", "GET", "/whoami", { token: "secret-a" }),
      (error) =>
        error instanceof DeskClientError
        && error.code === "UNAUTHORIZED"
        && !error.message.includes("secret-a"),
    );
    await assert.rejects(
      fetchDeskTask(identityA, "../whoami"),
      (error) => error instanceof DeskClientError && error.code === "INVALID_CONFIGURATION",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Desk transport rejects cross-origin path normalization and oversized successful responses", async () => {
  await assert.rejects(
    deskCall("https://desk-a.example.test", "GET", "/\\attacker.example.test/whoami"),
    (error) =>
      error instanceof DeskClientError
      && error.code === "INVALID_CONFIGURATION",
  );

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("x", {
    status: 200,
    headers: { "content-length": String(1024 * 1024 + 1) },
  });
  try {
    await assert.rejects(
      deskCall("https://desk-a.example.test", "GET", "/whoami"),
      (error) =>
        error instanceof DeskClientError
        && error.code === "PROTOCOL"
        && /size limit/i.test(error.message),
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("profile-pinned task details reject a mismatched task identity and omit unrelated events", async () => {
  resetDeskFile();
  saveProfileCreds({
    url: "https://desk-a.example.test",
    agentId: "agent-a",
    owner: "owner-a",
    token: "secret-a",
  }, identityA);
  const previousFetch = globalThis.fetch;
  const task = {
    id: "t_beef",
    kind: "dispatch",
    title: "Other task",
    body: "",
    risk: "low",
    state: "open",
    createdBy: "agent-a",
    claimedBy: null,
    ackedBy: null,
    createdAt: 1,
    updatedAt: 2,
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    task,
    events: [],
  }), { status: 200 });
  try {
    await assert.rejects(
      fetchDeskTask(identityA, "t_abcd"),
      (error) =>
        error instanceof DeskClientError
        && error.code === "PROTOCOL"
        && /task identity/i.test(error.message),
    );
    globalThis.fetch = async () => new Response(JSON.stringify({
      task: { ...task, id: "t_abcd", title: "Expected task" },
      events: [
        { id: 1, taskId: "t_abcd", actor: "agent-a", action: "post", detail: "", at: 1 },
        { id: 2, taskId: "t_cafe", actor: "agent-b", action: "post", detail: "", at: 2 },
      ],
    }), { status: 200 });
    const details = await fetchDeskTask(identityA, "t_abcd");
    assert.deepEqual(details.events.map((event) => event.taskId), ["t_abcd"]);
    assert.equal(details.task.body, "");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
