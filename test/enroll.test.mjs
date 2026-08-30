import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  enrollDevice,
  loadEnrollment,
  clearEnrollment,
  heartbeat,
  gatewayBaseURL,
  parseEnrollResponse,
  syncOrgRoles,
  syncOrgRolesForProfile,
  submitOrganizationLearning,
  syncOrganizationLearnings,
  deviceTokenExpired,
  deviceTokenExpiryWarning,
  normalizeGatewayUrl,
  enrollGatewayProfile,
  upsertGatewayProfileFromEnrollment,
  gatewayProfileFromEnrollment,
} from "../dist/org-fleet/enroll.js";
import {
  captureLearning,
  listLearnings,
  learningDigest,
} from "../dist/learning/store.js";
import {
  deskConnectionsSnapshot,
  loadProfileCreds,
  saveProfileCreds,
} from "../dist/desk.js";
import { orgRolesDir, loadRoles, parseOrganizationRoleBundleEnvelope } from "../dist/org/roles.js";
import { addProfile, getProfile, listProfiles, loadActiveProfile, spaceIdForProfile, upsertProfile } from "../dist/profile/profile.js";
import { resetPrivateHaraStateForTests } from "../dist/security/private-state.js";

test("parseEnrollResponse: snake_case + camelCase, trims slash, validates expiry, requires a token", () => {
  const e = parseEnrollResponse(
    "https://gw/",
    {
      device_token: "t1",
      device_id: "d1",
      model: "deepseek-v4-pro",
      available_models: ["deepseek-v4-pro"],
      thinking_efforts: ["off", "low", "high", "max"],
      model_capabilities: [{
        model: "deepseek-v4-pro",
        thinking_efforts: ["off", "low", "high", "max"],
      }],
      default_reasoning_effort: "high",
      expires_at: "2026-01-08T00:00:00Z",
      service_bindings: [{
        tenant_id: "tenant-1",
        service: "COLLAB",
        mode: "HARA_HOSTED",
        account_region: "GLOBAL",
        api_origin: "https://collab.example.test",
        issuer: "https://account.example.test",
        jwks_uri: "https://account.example.test/.well-known/jwks.json",
        audience: "hara-collab",
        status: "ACTIVE",
        capabilities_version: 1,
        config_version: 3,
      }],
    },
    "2026-01-01",
  );
  assert.equal(e.gatewayUrl, "https://gw");
  assert.equal(e.deviceToken, "t1");
  assert.equal(e.deviceId, "d1");
  assert.deepEqual(e.availableModels, ["deepseek-v4-pro"]);
  assert.deepEqual(e.thinkingEfforts, ["off", "low", "high", "max"]);
  assert.deepEqual(e.modelCapabilities, [{
    model: "deepseek-v4-pro",
    thinkingEfforts: ["off", "low", "high", "max"],
  }]);
  assert.equal(e.defaultReasoningEffort, "high");
  assert.equal(e.expiresAt, "2026-01-08T00:00:00.000Z");
  assert.equal(e.tokenNeverExpires, false);
  assert.deepEqual(e.serviceBindings, [{
    tenantId: "tenant-1",
    service: "COLLAB",
    mode: "HARA_HOSTED",
    accountRegion: "GLOBAL",
    apiOrigin: "https://collab.example.test",
    issuer: "https://account.example.test",
    jwksUri: "https://account.example.test/.well-known/jwks.json",
    audience: "hara-collab",
    status: "ACTIVE",
    capabilitiesVersion: 1,
    configVersion: 3,
  }]);
  assert.equal(gatewayBaseURL(e), "https://gw/v1");
  assert.equal(gatewayBaseURL({ ...e, baseURL: "https://gw/openai" }), "https://gw/openai");
  assert.deepEqual(
    parseEnrollResponse("https://gw", {
      device_token: "vision-token",
      model: "deepseek-v4-flash-vision-exp",
      available_models: ["deepseek-v4-flash-vision-exp"],
    }, "2026-01-01").thinkingEfforts,
    ["off", "low", "high", "max"],
    "older gateways that omit thinking_efforts still expose the complete Vision-Exp dial",
  );
  assert.throws(() => parseEnrollResponse("https://gw", {}, "t"), /device_token/);
  assert.throws(
    () => parseEnrollResponse("https://gw", { device_token: "t1", expires_at: "not-a-date" }, "t"),
    /invalid expires_at/,
  );
  assert.throws(
    () => parseEnrollResponse("https://gw", {
      device_token: "t1",
      model: "deepseek-v4-pro",
      available_models: ["deepseek-v4-flash"],
    }, "t"),
    /not present/,
  );
  assert.throws(
    () => parseEnrollResponse("https://gw", {
      device_token: "t1",
      model: "deepseek-v4-pro",
      thinking_efforts: ["ultra"],
    }, "t"),
    /invalid thinking_efforts/,
  );
  assert.throws(
    () => parseEnrollResponse("https://gw", {
      device_token: "t1",
      model: "deepseek-v4-pro",
      available_models: ["deepseek-v4-pro"],
      model_capabilities: [{ model: "other", thinking_efforts: ["high"] }],
    }, "t"),
    /invalid model_capabilities/,
  );
  assert.throws(
    () => parseEnrollResponse("https://gw", {
      device_token: "t1",
      model: "deepseek-v4-pro",
      thinking_efforts: ["off", "low", "high", "max"],
      default_reasoning_effort: "medium",
    }, "t"),
    /not supported/,
  );
  assert.throws(
    () => parseEnrollResponse("https://gw", {
      device_token: "t1",
      desk: {
        url: "https://desk.example.test",
        agent_id: "agent",
        token: "",
      },
    }, "t"),
    /invalid desk binding/,
  );
  assert.throws(
    () => parseEnrollResponse("https://gw", {
      device_token: "t1",
      service_bindings: [{
        tenant_id: "tenant-1",
        service: "DESK_TASKS",
        mode: "HARA_HOSTED",
        account_region: "GLOBAL",
        api_origin: "https://desk.example.test",
        status: "ACTIVE",
        capabilities_version: 1,
        config_version: 1,
        credential: "must-never-cross-the-wire",
      }],
    }, "t"),
    /must not contain credentials/,
  );
  const permanent = parseEnrollResponse(
    "https://gw",
    { device_token: "t2", device_id: "d2", model: "deepseek-v4-flash", expires_at: null },
    "2026-01-01",
  );
  assert.equal(permanent.expiresAt, undefined);
  assert.equal(permanent.tokenNeverExpires, true, "an explicit null expiry is distinct from a legacy omission");
  const legacy = parseEnrollResponse(
    "https://gw",
    { device_token: "t3", device_id: "d3", model: "deepseek-v4-flash" },
    "2026-01-01",
  );
  assert.equal(legacy.tokenNeverExpires, undefined, "legacy servers that omit expiry remain distinguishable");
});

test("organization role bundles require one complete strict policy/persona snapshot", () => {
  for (const malformed of [
    {},
    { version: 1, roles: [] },
    { version: 1, org_policy: {} },
    { version: -1, org_policy: {}, roles: [] },
    { version: 1, org_policy: {}, roles: [{ name: "../escape", system: "bad" }] },
    { version: 1, org_policy: {}, roles: [{ name: "duplicate", system: "one" }, { name: "duplicate", system: "two" }] },
  ]) assert.throws(() => parseOrganizationRoleBundleEnvelope(malformed));
  const snapshot = parseOrganizationRoleBundleEnvelope({
    version: 7,
    org_policy: { toolDeny: ["bash"] },
    roles: [{ name: "auditor", system: "Review safely." }],
  });
  assert.equal(snapshot.version, 7);
  assert.deepEqual(snapshot.policy.toolDeny, ["bash"]);
  assert.equal(snapshot.roles[0].organizationPolicyVersion, 7);
});

test("legacy Control enrollments receive a non-reusable Space generation while tenant Spaces stay stable", () => {
  const legacyEnrollment = {
    gatewayUrl: "https://control.example.test",
    deviceToken: "legacy-token-a",
    deviceId: "device-a",
    model: "managed-model",
    enrolledAt: "2026-08-23T00:00:00.000Z",
  };
  const first = gatewayProfileFromEnrollment("same-local-name", "Company A", legacyEnrollment);
  const second = gatewayProfileFromEnrollment("same-local-name", "Company B", {
    ...legacyEnrollment,
    deviceToken: "legacy-token-b",
    deviceId: "device-b",
  });
  assert.match(spaceIdForProfile(first), /^org-enrollment:[a-f0-9]{32}$/);
  assert.match(spaceIdForProfile(second), /^org-enrollment:[a-f0-9]{32}$/);
  assert.notEqual(spaceIdForProfile(first), spaceIdForProfile(second));

  const tenantA = gatewayProfileFromEnrollment("alias-a", "Acme", { ...legacyEnrollment, tenantId: "tenant-acme" });
  const tenantB = gatewayProfileFromEnrollment("alias-b", "Acme renamed", {
    ...legacyEnrollment,
    tenantId: "tenant-acme",
    deviceToken: "rotated-token",
  });
  assert.equal(spaceIdForProfile(tenantA), "org:tenant-acme");
  assert.equal(spaceIdForProfile(tenantB), "org:tenant-acme");
});

test("organization URL validation requires HTTPS outside loopback and rejects embedded credentials or paths", () => {
  assert.equal(normalizeGatewayUrl("https://control.example.com/"), "https://control.example.com");
  assert.equal(normalizeGatewayUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(() => normalizeGatewayUrl("http://control.example.com"), /HTTPS/);
  assert.throws(() => normalizeGatewayUrl("https://user:secret@control.example.com"), /credentials/);
  assert.throws(() => normalizeGatewayUrl("https://control.example.com/tenant?a=1"), /only scheme/);
});

test("profile ids use one persistence-safe validator across BYOK and gateway entry points", () => {
  const byok = (id) => ({ id, kind: "byok", provider: "openai" });
  assert.equal(addProfile(byok("team\\escape")).ok, false, "BYOK add rejects a Windows path separator");
  assert.equal(addProfile(byok("x".repeat(65))).ok, false, "BYOK add rejects ids that session loading cannot resume");
  assert.throws(() => upsertProfile(byok("team\\escape")), /profile id/);
});

test("device token expiry: legacy is compatible; expiring and expired tokens are actionable", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  assert.equal(deviceTokenExpired(undefined, now), false, "legacy control planes remain compatible");
  assert.equal(deviceTokenExpired("2025-12-31T23:59:59Z", now), true);
  assert.equal(deviceTokenExpired("not-a-date", now), true, "corrupt lifecycle data fails closed");
  assert.match(deviceTokenExpiryWarning("2025-12-31T23:59:59Z", now), /expired.*re-enroll/);
  assert.match(deviceTokenExpiryWarning("2026-01-01T02:00:00Z", now), /expires in 2h/);
  assert.equal(deviceTokenExpiryWarning("2026-01-03T00:00:00Z", now), null, "healthy tokens stay quiet");
});

test("enroll → store (0600) → heartbeat → clear, against a stub control plane", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-enroll-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  let enrollBody = null;
  let hbAuth = null;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url === "/v1/enroll") {
        enrollBody = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ device_token: "dev-abc", device_id: "dev-1", model: "glm-5" }));
      } else if (req.url === "/v1/heartbeat") {
        hbAuth = req.headers.authorization;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          model: "glm-5",
          available_models: ["glm-5", "glm-6"],
          thinking_efforts: [],
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const e = await enrollDevice(url, "CODE123");
    assert.equal(e.deviceToken, "dev-abc");
    assert.equal(e.model, "glm-5");
    assert.equal(enrollBody.code, "CODE123", "the one-time code was sent");
    assert.ok(enrollBody.device?.name && enrollBody.device?.os, "device info was sent");
    assert.equal(loadEnrollment()?.deviceToken, "dev-abc", "persisted to org.json");
    assert.equal(statSync(join(home, ".hara", "org.json")).mode & 0o777, 0o600, "org.json is 0600 (holds a token)");
    assert.equal(await heartbeat(), true);
    assert.equal(hbAuth, "Bearer dev-abc", "heartbeat carried the device token");
    assert.deepEqual(
      loadEnrollment()?.availableModels,
      ["glm-5", "glm-6"],
      "the existing credential refreshes its model catalog without re-enrollment",
    );
    assert.equal(clearEnrollment(), true);
    assert.equal(loadEnrollment(), null);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile-native enrollment stores only the scoped token in private profiles and activates the user-added connection", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-profile-enroll-"));
  const previousHome = process.env.HOME;
  const previousDeskHome = process.env.HARA_DESK_STATE_HOME;
  process.env.HOME = home;
  process.env.HARA_DESK_STATE_HOME = home;
  let heartbeatSeen = false;
  const server = createServer((req, res) => {
    if (req.url === "/v1/enroll") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        device_token: "scoped-device-token",
        device_id: "device-one",
        model: "deepseek-v4-pro",
        available_models: ["deepseek-v4-pro"],
        thinking_efforts: ["off", "low", "high", "max"],
        model_capabilities: [{
          model: "deepseek-v4-pro",
          thinking_efforts: ["off", "low", "high", "max"],
        }],
        default_reasoning_effort: "high",
        expires_at: "2099-01-01T00:00:00Z",
        desk: {
          url: "https://desk.example.test",
          agent_id: "desk-team-a",
          owner: "member@example.test",
          token: "separate-desk-token",
        },
        service_bindings: [{
          tenant_id: "tenant-team-a",
          service: "DESK_TASKS",
          mode: "CUSTOMER_HOSTED",
          account_region: "CN",
          api_origin: "https://desk.example.test",
          status: "ACTIVE",
          capabilities_version: 1,
          config_version: 2,
        }],
      }));
    } else if (req.url === "/v1/heartbeat") {
      heartbeatSeen = req.headers.authorization === "Bearer scoped-device-token";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model: "deepseek-v4-pro",
        available_models: ["deepseek-v4-flash", "deepseek-v4-pro"],
        thinking_efforts: ["off", "low", "high", "max"],
        model_capabilities: [
          { model: "deepseek-v4-flash", thinking_efforts: ["off", "low", "high", "max"] },
          { model: "deepseek-v4-pro", thinking_efforts: ["off", "low", "high", "max"] },
        ],
        default_reasoning_effort: "low",
        expires_at: null,
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await enrollGatewayProfile({
      id: "team-a",
      label: "Team A",
      gatewayUrl: url,
      code: "one-time-code",
    });
    assert.equal(result.heartbeatOk, true);
    assert.equal(heartbeatSeen, true);
    assert.equal(loadActiveProfile().id, "team-a");
    const storedProfile = listProfiles().find((profile) => profile.id === "team-a");
    assert.equal(storedProfile?.deviceToken, "scoped-device-token");
    assert.deepEqual(storedProfile?.availableModels, ["deepseek-v4-flash", "deepseek-v4-pro"]);
    assert.deepEqual(storedProfile?.thinkingEfforts, ["off", "low", "high", "max"]);
    assert.deepEqual(storedProfile?.modelCapabilities, [
      { model: "deepseek-v4-flash", thinkingEfforts: ["off", "low", "high", "max"] },
      { model: "deepseek-v4-pro", thinkingEfforts: ["off", "low", "high", "max"] },
    ]);
    assert.equal(storedProfile?.defaultReasoningEffort, "low");
    assert.equal(storedProfile?.tokenExpiresAt, undefined, "a heartbeat can replace a finite expiry with explicit permanent access");
    assert.equal(storedProfile?.tokenNeverExpires, true);
    assert.deepEqual(storedProfile?.serviceBindings, [{
      tenantId: "tenant-team-a",
      service: "DESK_TASKS",
      mode: "CUSTOMER_HOSTED",
      accountRegion: "CN",
      apiOrigin: "https://desk.example.test",
      status: "ACTIVE",
      capabilitiesVersion: 1,
      configVersion: 2,
    }]);
    assert.equal(
      loadProfileCreds({
        profileId: "team-a",
        gatewayUrl: url,
        deviceId: "device-one",
        enrolledAt: storedProfile?.enrolledAt,
      })?.agentId,
      "desk-team-a",
      "one enrollment stores the separately scoped Desk binding for the same organization identity",
    );
    const profilesPath = join(home, ".hara", "profiles.json");
    assert.equal(statSync(profilesPath).mode & 0o777, 0o600);
    const stored = readFileSync(profilesPath, "utf8");
    assert.equal(stored.includes("one-time-code"), false, "the registration code is never persisted");
    assert.equal(stored.includes("separate-desk-token"), false, "the Desk bearer never enters the model profile store");
    assert.equal(stored.includes("tenant-team-a"), true, "redacted service descriptors stay pinned to the organization profile");
    assert.equal(existsSync(join(home, ".hara", "org.json")), false, "Desktop/profile enrollment does not create legacy state");
    await assert.rejects(
      () => enrollGatewayProfile({ id: "personal", gatewayUrl: url, code: "another-code" }),
      /reserved/,
    );
  } finally {
    server.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDeskHome === undefined) delete process.env.HARA_DESK_STATE_HOME;
    else process.env.HARA_DESK_STATE_HOME = previousDeskHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("every gateway profile replacement retires a Desk binding pinned to the prior enrollment", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-profile-replace-"));
  const previousHome = process.env.HOME;
  const previousDeskHome = process.env.HARA_DESK_STATE_HOME;
  process.env.HOME = home;
  process.env.HARA_DESK_STATE_HOME = home;
  resetPrivateHaraStateForTests();
  const firstEnrollment = {
    gatewayUrl: "https://control-a.example.test",
    deviceToken: "device-token-a",
    deviceId: "device-a",
    model: "glm-5",
    enrolledAt: "2026-07-30T10:00:00.000Z",
  };
  const firstIdentity = {
    profileId: "default-org",
    gatewayUrl: firstEnrollment.gatewayUrl,
    deviceId: firstEnrollment.deviceId,
    enrolledAt: firstEnrollment.enrolledAt,
  };
  try {
    upsertGatewayProfileFromEnrollment("default-org", "Default Org", firstEnrollment);
    saveProfileCreds({
      url: "https://desk-a.example.test",
      agentId: "agent-a",
      owner: "owner-a",
      token: "desk-secret-a",
    }, firstIdentity);
    assert.equal(loadProfileCreds(firstIdentity)?.agentId, "agent-a");

    const replacement = {
      ...firstEnrollment,
      gatewayUrl: "https://control-b.example.test",
      deviceToken: "device-token-b",
      deviceId: "device-b",
      enrolledAt: "2026-07-31T10:00:00.000Z",
    };
    upsertGatewayProfileFromEnrollment("default-org", "Default Org", replacement);
    assert.equal(loadProfileCreds({
      profileId: "default-org",
      gatewayUrl: replacement.gatewayUrl,
      deviceId: replacement.deviceId,
      enrolledAt: replacement.enrolledAt,
    }), null);
    assert.deepEqual(deskConnectionsSnapshot([{
      profileId: "default-org",
      gatewayUrl: replacement.gatewayUrl,
      deviceId: replacement.deviceId,
      enrolledAt: replacement.enrolledAt,
    }]), {
      connections: [{ profileId: "default-org", configured: false }],
      legacyUnbound: false,
    });
  } finally {
    resetPrivateHaraStateForTests();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDeskHome === undefined) delete process.env.HARA_DESK_STATE_HOME;
    else process.env.HARA_DESK_STATE_HOME = previousDeskHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncOrgRoles: pulls /v1/roles → ~/.hara/org-roles/*.md, maps snake→camel, authoritative replace, loadRoles sees it", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-roles-"));
  const cwd = mkdtempSync(join(tmpdir(), "hara-cwd-")); // empty → no project/global/plugin roles compete
  const prev = process.env.HOME;
  process.env.HOME = home;
  let rolesAuth = null;
  let bundle = { version: 7, org_policy: { requireApprovalForWrites: true }, roles: [{ name: "auditor", description: "reviews PRs", owns: ["review", "audit"], rejects: ["implement"], model: "glm-5", reasoning_effort: "high", allow_tools: ["read_file", "bash"], system: "You are the auditor." }] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url === "/v1/enroll") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ device_token: "dev-r", device_id: "d-r", model: "glm-5" }));
      } else if (req.url === "/v1/roles") {
        rolesAuth = req.headers.authorization;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(bundle));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await syncOrgRoles(), 0, "not enrolled → 0, never throws");
    await enrollDevice(url, "CODE");
    const n = await syncOrgRoles();
    assert.equal(n, 1, "one role written");
    assert.equal(rolesAuth, "Bearer dev-r", "carried the device token");
    const dir = orgRolesDir("default-org");
    assert.ok(existsSync(join(dir, "auditor.md")), "role file written by name");
    const md = readFileSync(join(dir, "auditor.md"), "utf8");
    assert.match(md, /allowTools: \[read_file, bash\]/, "allow_tools → allowTools");
    assert.match(md, /owns: \[review, audit\]/);
    assert.match(md, /reasoning-effort: high/);
    assert.match(md, /You are the auditor\./);
    const policy = JSON.parse(readFileSync(join(dir, "_policy.json"), "utf8"));
    assert.equal(policy.version, 7);
    assert.equal(policy.org_policy.requireApprovalForWrites, true);
    // the loader actually picks it up with the camelCase keys mapped
    const role = loadRoles(cwd, "default-org").find((r) => r.id === "auditor");
    assert.ok(role, "loadRoles resolves the org role");
    assert.deepEqual(role.allowTools, ["read_file", "bash"]);
    assert.deepEqual(role.owns, ["review", "audit"]);
    assert.equal(role.model, "glm-5");
    assert.equal(role.reasoningEffort, "high");
    // authoritative replace: server drops the role → next sync removes it locally (the _policy sidecar isn't a role)
    bundle = { version: 8, org_policy: {}, roles: [] };
    assert.equal(await syncOrgRoles(), 0, "empty bundle → 0 roles");
    assert.ok(!existsSync(join(dir, "auditor.md")), "stale role removed on resync");
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".md")).length, 0, "no role files remain");
  } finally {
    server.close();
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("syncOrgRoles rejects an entire malformed bundle without writing any role", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-roles-traversal-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const bundle = {
    version: 1,
    org_policy: {},
    roles: [
      { name: "../../escaped", system: "bad" },
      { name: "..\\escaped", system: "bad" },
      { name: "CON", system: "bad" },
      { name: "safe-auditor", system: "good" },
    ],
  };
  const server = createServer((req, res) => {
    if (req.url === "/v1/enroll") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ device_token: "dev-r", device_id: "d-r", model: "glm-5" }));
    } else if (req.url === "/v1/roles") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(bundle));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await enrollDevice(url, "CODE");
    assert.equal(await syncOrgRoles(), 0, "one unsafe role invalidates the authenticated snapshot");
    assert.equal(existsSync(join(orgRolesDir(), "safe-auditor.md")), false);
    assert.equal(existsSync(join(home, "escaped.md")), false);
    assert.equal(existsSync(join(home, ".hara", "escaped.md")), false);
    assert.equal(existsSync(join(orgRolesDir(), "CON.md")), false);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed role bundles stay isolated by the session's exact organization profile", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-role-profile-isolation-"));
  const cwd = mkdtempSync(join(tmpdir(), "hara-role-profile-cwd-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const server = createServer((req, res) => {
    if (req.url !== "/v1/roles") {
      res.writeHead(404);
      return res.end();
    }
    const token = req.headers.authorization;
    const role = token === "Bearer token-a"
      ? { name: "managed-a-only", description: "A role", system: "You belong to organization A." }
      : { name: "managed-b-only", description: "B role", system: "You belong to organization B." };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: token === "Bearer token-a" ? 1 : 2, org_policy: {}, roles: [role] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
  const profileA = {
    id: "OrgA",
    kind: "gateway",
    gatewayUrl,
    deviceToken: "token-a",
    deviceId: "device-a",
    defaultModel: "model-a",
  };
  const profileB = {
    id: "orga",
    kind: "gateway",
    gatewayUrl,
    deviceToken: "token-b",
    deviceId: "device-b",
    defaultModel: "model-b",
  };
  try {
    upsertProfile(profileA);
    upsertProfile(profileB);
    assert.equal(await syncOrgRolesForProfile(profileA), 1);
    assert.equal(await syncOrgRolesForProfile(profileB), 1);
    assert.notEqual(
      orgRolesDir("OrgA").toLowerCase(),
      orgRolesDir("orga").toLowerCase(),
      "case-sensitive profile ids cannot alias on a case-insensitive filesystem",
    );
    assert.ok(existsSync(join(orgRolesDir("OrgA"), "managed-a-only.md")));
    assert.ok(existsSync(join(orgRolesDir("orga"), "managed-b-only.md")));
    const rolesA = loadRoles(cwd, "OrgA");
    const rolesB = loadRoles(cwd, "orga");
    assert.ok(rolesA.some((role) => role.id === "managed-a-only"));
    assert.equal(rolesA.some((role) => role.id === "managed-b-only"), false);
    assert.ok(rolesB.some((role) => role.id === "managed-b-only"));
    assert.equal(rolesB.some((role) => role.id === "managed-a-only"), false);
  } finally {
    server.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("concurrent company role refreshes leave one complete atomic snapshot", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-role-concurrent-"));
  const cwd = mkdtempSync(join(tmpdir(), "hara-role-concurrent-cwd-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  let requests = 0;
  let release;
  const bothStarted = new Promise((resolve) => { release = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/roles") {
      res.writeHead(404);
      return res.end();
    }
    const ordinal = ++requests;
    if (requests === 2) release();
    await bothStarted;
    const version = ordinal;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      version,
      org_policy: { toolDeny: version === 1 ? ["bash"] : ["write_file"] },
      roles: [{ name: `agent-v${version}`, system: `Persona version ${version}.` }],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const profile = {
    id: "concurrent-org",
    kind: "gateway",
    tenantId: "tenant-concurrent",
    gatewayUrl: `http://127.0.0.1:${server.address().port}`,
    deviceToken: "concurrent-token",
    deviceId: "concurrent-device",
    defaultModel: "model",
    enrolledAt: "2026-08-23T00:00:00.000Z",
  };
  try {
    upsertProfile(profile);
    assert.deepEqual(
      await Promise.all([
        syncOrgRolesForProfile(profile, undefined, { required: true }),
        syncOrgRolesForProfile(profile, undefined, { required: true }),
      ]),
      [1, 1],
    );
    const raw = JSON.parse(readFileSync(join(orgRolesDir("concurrent-org"), "_bundle.json"), "utf8"));
    const snapshot = parseOrganizationRoleBundleEnvelope(raw);
    assert.equal(snapshot.roles.length, 1);
    assert.equal(snapshot.roles[0].organizationPolicyVersion, snapshot.version);
    assert.equal(loadRoles(cwd, "concurrent-org")[0].organizationPolicyVersion, snapshot.version);
  } finally {
    server.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an in-flight role sync cannot populate a replacement company's Space", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-role-reenroll-race-"));
  const cwd = mkdtempSync(join(tmpdir(), "hara-role-reenroll-cwd-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  let releaseFirstResponse;
  let markFirstRequest;
  const firstRequest = new Promise((resolve) => { markFirstRequest = resolve; });
  const firstResponse = new Promise((resolve) => { releaseFirstResponse = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/roles") {
      res.writeHead(404);
      return res.end();
    }
    if (req.headers.authorization === "Bearer token-a") {
      markFirstRequest();
      await firstResponse;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ version: 1, org_policy: {}, roles: [{ name: "agent-a", system: "Company A private policy." }] }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ version: 2, org_policy: {}, roles: [{ name: "agent-b", system: "Company B private policy." }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
  const profileA = {
    id: "company",
    kind: "gateway",
    gatewayUrl,
    deviceToken: "token-a",
    deviceId: "device-a",
    defaultModel: "model-a",
    enrolledAt: "2026-08-23T00:00:00.000Z",
  };
  const profileB = {
    ...profileA,
    deviceToken: "token-b",
    deviceId: "device-b",
    defaultModel: "model-b",
    enrolledAt: "2026-08-23T00:01:00.000Z",
  };
  try {
    upsertProfile(profileA);
    const spaceA = spaceIdForProfile(profileA);
    const pending = syncOrgRolesForProfile(profileA);
    await firstRequest;
    upsertProfile(profileB);
    const spaceB = spaceIdForProfile(profileB);
    assert.notEqual(spaceA, spaceB);
    releaseFirstResponse();
    assert.equal(await pending, 0, "stale response is discarded after re-enrollment");
    assert.equal(existsSync(join(orgRolesDir(spaceB), "agent-a.md")), false);

    assert.equal(await syncOrgRolesForProfile(profileB), 1);
    const roles = loadRoles(cwd, "company");
    assert.ok(roles.some((role) => role.id === "agent-b"));
    assert.equal(roles.some((role) => role.id === "agent-a"), false);
  } finally {
    releaseFirstResponse();
    server.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("managed role bundle sync is safe across real concurrent Hara processes", { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-role-bundle-process-race-"));
  const previousHome = process.env.HOME;
  let requests = 0;
  const server = createServer((req, res) => {
    if (req.url !== "/v1/roles") {
      res.writeHead(404);
      return res.end();
    }
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      version: requests,
      org_policy: { toolDeny: ["bash"] },
      roles: [{ name: "safe-agent", system: "Use the current atomic company snapshot." }],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    process.env.HOME = home;
    upsertProfile({
      id: "company",
      kind: "gateway",
      tenantId: "tenant-process-race",
      gatewayUrl,
      deviceId: "device-process-race",
      deviceToken: "token-process-race",
      defaultModel: "company-model",
      enrolledAt: "2026-08-23T00:00:00.000Z",
    });
    const runChild = (index) => new Promise((resolve, reject) => {
      const script = `import { syncOrgRolesForProfile } from "./dist/org-fleet/enroll.js";
        import { getProfile } from "./dist/profile/profile.js";
        const profile = getProfile("company");
        if (!profile) throw new Error("missing company profile");
        for (let i = 0; i < 12; i++) await syncOrgRolesForProfile(profile, undefined, { required: true });`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`bundle child ${index} failed (${code}): ${stderr}`)));
    });
    await Promise.all(Array.from({ length: 4 }, (_, index) => runChild(index)));
    const spaceId = spaceIdForProfile(getProfile("company"));
    const roles = loadRoles(process.cwd(), "company");
    assert.deepEqual(roles.map((role) => role.id), ["safe-agent"]);
    const dir = orgRolesDir(spaceId);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes(".hara-claim-") || name.endsWith(".lock") || name.endsWith(".reclaim")),
      [],
      "clean concurrent syncs leave no claim or lock debris",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});

test("required role sync obeys caller cancellation while Control is stalled", { timeout: 10_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-role-sync-cancel-"));
  const previousHome = process.env.HOME;
  const server = createServer(() => { /* deliberately never respond */ });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const profile = {
    id: "company",
    kind: "gateway",
    tenantId: "tenant-cancel",
    gatewayUrl: `http://127.0.0.1:${server.address().port}`,
    deviceId: "device-cancel",
    deviceToken: "token-cancel",
    defaultModel: "company-model",
    enrolledAt: "2026-08-23T00:00:00.000Z",
  };
  try {
    process.env.HOME = home;
    upsertProfile(profile);
    const controller = new AbortController();
    const started = Date.now();
    const pending = syncOrgRolesForProfile(profile, controller.signal, { required: true });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending);
    assert.ok(Date.now() - started < 1_000, "caller abort interrupts the Control preflight promptly");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});

test("organization learning is explicitly submitted, version-synced, injected only after approval, and revocable", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-learning-control-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "hara-learning-control-cwd-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  let bundleVersion = 1;
  let bundleItems = [];
  let submittedBody;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer learning-device-token") {
      res.writeHead(401);
      return res.end();
    }
    if (req.url === "/v1/learnings/candidates" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      submittedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        status: "pending",
        revision: 1,
      }));
    }
    if (req.url === "/v1/learnings" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ version: bundleVersion, learnings: bundleItems }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
  const profile = {
    id: "learning-org",
    kind: "gateway",
    label: "Learning Org",
    gatewayUrl,
    deviceToken: "learning-device-token",
    deviceId: "learning-device",
    defaultModel: "managed-model",
    enrolledAt: "2026-08-22T00:00:00.000Z",
  };
  try {
    upsertProfile(profile);
    const organizationScopeId = spaceIdForProfile(profile);
    const capture = (taskId, evidence) => captureLearning({
      patternKey: "agent.authorized_action_execution",
      kind: "action_ownership",
      scope: "organization",
      summary: "Execute authorized, tool-supported work and report verified results.",
      evidence,
      source: "runtime_guard",
    }, { cwd, stateHome: home, profileId: organizationScopeId, taskId });
    capture("task-a", "The guard rejected advice and requested an execution tool call.");
    capture("task-a", "The agent used the available edit tool after the runtime reminder.");
    const stable = capture("task-b", "A second task executed and verified instead of delegating to the user.").candidate;
    assert.equal(stable.stability, "stable");

    const submitted = await submitOrganizationLearning(profile.id, stable, {
      cwd,
      stateHome: home,
      organizationScopeId,
    });
    assert.equal(submitted.status, "pending");
    assert.equal(submitted.candidate.status, "submitted");
    assert.equal(submittedBody.pattern_key, stable.patternKey);
    assert.equal(JSON.stringify(submittedBody).includes("learning-device-token"), false);

    bundleItems = [{
      id: submitted.remoteId,
      pattern_key: stable.patternKey,
      kind: stable.kind,
      summary: stable.summary,
      occurrence_count: 3,
      distinct_task_count: 2,
      revision: 2,
      updated_at: new Date().toISOString(),
    }];
    const synced = await syncOrganizationLearnings(profile.id, { cwd, stateHome: home, organizationScopeId });
    assert.equal(synced.version, 1);
    assert.equal(synced.learnings.length, 1);
    assert.match(learningDigest(cwd, organizationScopeId, home), /authorized_action_execution/);
    assert.doesNotMatch(learningDigest(cwd, "org:another-company", home), /authorized_action_execution/);

    bundleVersion = 2;
    bundleItems = [];
    await syncOrganizationLearnings(profile.id, { cwd, stateHome: home, organizationScopeId });
    assert.equal(
      listLearnings({ cwd, profileId: organizationScopeId, stateHome: home, scope: "organization" })
        .some((item) => item.remoteId === submitted.remoteId && item.status === "approved"),
      false,
    );
    assert.doesNotMatch(learningDigest(cwd, organizationScopeId, home), /authorized_action_execution/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    resetPrivateHaraStateForTests();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("enrollDevice: a non-2xx (bad code) throws with a clear message", async () => {
  const reflectedSecret = "one-time-secret-that-must-not-leak";
  const server = createServer((req, res) => {
    res.writeHead(403);
    res.end(`invalid code ${reflectedSecret}`);
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(
      () => enrollDevice(url, "BAD"),
      (error) => {
        assert.match(error.message, /bad or expired code|403/);
        assert.equal(error.message.includes(reflectedSecret), false, "server response cannot reflect a credential into logs");
        return true;
      },
    );
  } finally {
    server.close();
  }
});
