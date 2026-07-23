import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enrollDevice,
  loadEnrollment,
  clearEnrollment,
  heartbeat,
  gatewayBaseURL,
  parseEnrollResponse,
  syncOrgRoles,
  syncOrgRolesForProfile,
  deviceTokenExpired,
  deviceTokenExpiryWarning,
  normalizeGatewayUrl,
  enrollGatewayProfile,
} from "../dist/org-fleet/enroll.js";
import { orgRolesDir, loadRoles } from "../dist/org/roles.js";
import { addProfile, listProfiles, loadActiveProfile, upsertProfile } from "../dist/profile/profile.js";

test("parseEnrollResponse: snake_case + camelCase, trims slash, validates expiry, requires a token", () => {
  const e = parseEnrollResponse(
    "https://gw/",
    {
      device_token: "t1",
      device_id: "d1",
      model: "deepseek-v4-pro",
      available_models: ["deepseek-v4-pro"],
      thinking_efforts: ["off", "high", "max"],
      expires_at: "2026-01-08T00:00:00Z",
    },
    "2026-01-01",
  );
  assert.equal(e.gatewayUrl, "https://gw");
  assert.equal(e.deviceToken, "t1");
  assert.equal(e.deviceId, "d1");
  assert.deepEqual(e.availableModels, ["deepseek-v4-pro"]);
  assert.deepEqual(e.thinkingEfforts, ["off", "high", "max"]);
  assert.equal(e.expiresAt, "2026-01-08T00:00:00.000Z");
  assert.equal(gatewayBaseURL(e), "https://gw/v1");
  assert.equal(gatewayBaseURL({ ...e, baseURL: "https://gw/openai" }), "https://gw/openai");
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
      thinking_efforts: ["xhigh"],
    }, "t"),
    /invalid thinking_efforts/,
  );
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
  process.env.HOME = home;
  let heartbeatSeen = false;
  const server = createServer((req, res) => {
    if (req.url === "/v1/enroll") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        device_token: "scoped-device-token",
        device_id: "device-one",
        model: "deepseek-v4-pro",
        available_models: ["deepseek-v4-pro"],
        thinking_efforts: ["off", "high", "max"],
        expires_at: "2099-01-01T00:00:00Z",
      }));
    } else if (req.url === "/v1/heartbeat") {
      heartbeatSeen = req.headers.authorization === "Bearer scoped-device-token";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model: "deepseek-v4-pro",
        available_models: ["deepseek-v4-flash", "deepseek-v4-pro"],
        thinking_efforts: ["off", "high", "max"],
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
    assert.deepEqual(storedProfile?.thinkingEfforts, ["off", "high", "max"]);
    const profilesPath = join(home, ".hara", "profiles.json");
    assert.equal(statSync(profilesPath).mode & 0o777, 0o600);
    const stored = readFileSync(profilesPath, "utf8");
    assert.equal(stored.includes("one-time-code"), false, "the registration code is never persisted");
    assert.equal(existsSync(join(home, ".hara", "org.json")), false, "Desktop/profile enrollment does not create legacy state");
    await assert.rejects(
      () => enrollGatewayProfile({ id: "personal", gatewayUrl: url, code: "another-code" }),
      /reserved/,
    );
  } finally {
    server.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncOrgRoles: pulls /v1/roles → ~/.hara/org-roles/*.md, maps snake→camel, authoritative replace, loadRoles sees it", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-roles-"));
  const cwd = mkdtempSync(join(tmpdir(), "hara-cwd-")); // empty → no project/global/plugin roles compete
  const prev = process.env.HOME;
  process.env.HOME = home;
  let rolesAuth = null;
  let bundle = { version: 7, org_policy: { requireApprovalForWrites: true }, roles: [{ name: "auditor", description: "reviews PRs", owns: ["review", "audit"], rejects: ["implement"], model: "glm-5", allow_tools: ["read_file", "bash"], system: "You are the auditor." }] };
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

test("syncOrgRoles rejects traversal and Windows-special role names without writing outside org-roles", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-roles-traversal-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const bundle = {
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
    assert.equal(await syncOrgRoles(), 1);
    assert.ok(existsSync(join(orgRolesDir(), "safe-auditor.md")));
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
    res.end(JSON.stringify({ roles: [role] }));
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
