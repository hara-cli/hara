import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollDevice, loadEnrollment, clearEnrollment, heartbeat, gatewayBaseURL, parseEnrollResponse } from "../dist/org-fleet/enroll.js";

test("parseEnrollResponse: snake_case + camelCase, trims slash, requires a token", () => {
  const e = parseEnrollResponse("http://gw/", { device_token: "t1", device_id: "d1", model: "m1" }, "2026-01-01");
  assert.equal(e.gatewayUrl, "http://gw");
  assert.equal(e.deviceToken, "t1");
  assert.equal(e.deviceId, "d1");
  assert.equal(gatewayBaseURL(e), "http://gw/v1");
  assert.equal(gatewayBaseURL({ ...e, baseURL: "http://gw/openai" }), "http://gw/openai");
  assert.throws(() => parseEnrollResponse("http://gw", {}, "t"), /device_token/);
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
        res.writeHead(204);
        res.end();
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
    assert.equal(clearEnrollment(), true);
    assert.equal(loadEnrollment(), null);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("enrollDevice: a non-2xx (bad code) throws with a clear message", async () => {
  const server = createServer((req, res) => {
    res.writeHead(403);
    res.end("nope");
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(() => enrollDevice(url, "BAD"), /bad or expired code|403/);
  } finally {
    server.close();
  }
});
