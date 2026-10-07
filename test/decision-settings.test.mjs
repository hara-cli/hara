import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const names = [
  "HOME",
  "USERPROFILE",
  "HARA_DECISION_ENGINE",
  "HARA_DECISION_MODE",
  "HARA_DECISION_MODEL",
  "HARA_DECISION_BASE_URL",
  "HARA_DECISION_API_KEY",
  "TYPESAFE_API_KEY",
];
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const home = mkdtempSync(join(tmpdir(), "hara-decision-settings-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const name of names.slice(2)) delete process.env[name];
mkdirSync(join(home, ".hara"), { recursive: true });

const {
  decisionSettingsSnapshot,
  saveDecisionSettings,
} = await import("../dist/decision-settings.js");

after(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

test("Action Guard settings persist a write-only TypeSafe credential", () => {
  const saved = saveDecisionSettings({
    engine: "typesafe",
    mode: "advisory",
    model: "jev-latest",
    baseURL: "https://api.typesafe.ai/",
    apiKey: "typesafe-fixture-key",
  }, home);
  const { laya, ...cloud } = saved;
  assert.equal(laya.contextTokens, 1024);
  assert.equal(laya.experimental, true);
  assert.deepEqual(cloud, {
    engine: "typesafe",
    mode: "advisory",
    model: "jev-latest",
    baseURL: "https://api.typesafe.ai",
    credential: "stored",
    engineEditable: true,
    modeEditable: true,
    modelEditable: true,
    baseURLEditable: true,
    credentialEditable: true,
  });
  assert.equal("apiKey" in saved, false);
  const raw = JSON.parse(readFileSync(join(home, ".hara", "config.json"), "utf8"));
  assert.equal(raw.decisionApiKey, "typesafe-fixture-key");

  const cleared = saveDecisionSettings({
    engine: "off",
    mode: "shadow",
    model: "jev-latest",
    baseURL: "https://api.typesafe.ai",
    clearApiKey: true,
  }, home);
  assert.equal(cleared.credential, "missing");
  assert.equal("decisionApiKey" in JSON.parse(readFileSync(join(home, ".hara", "config.json"), "utf8")), false);
});

test("local engine selection preserves Jev settings and is shadow-only", () => {
  const previous = Object.fromEntries(names.slice(2).map((name) => [name, process.env[name]]));
  try {
    for (const name of names.slice(2)) delete process.env[name];
    saveDecisionSettings({ engine: "typesafe", mode: "shadow", model: "jev-pinned", baseURL: "https://api.typesafe.ai", apiKey: "preserved-cloud-key" }, home);
    const saved = saveDecisionSettings({ engine: "laya-mlx", mode: "shadow", model: "jev-pinned", baseURL: "https://api.typesafe.ai" }, home);
    assert.equal(saved.engine, "laya-mlx");
    const raw = JSON.parse(readFileSync(join(home, ".hara", "config.json"), "utf8"));
    assert.equal(raw.decisionApiKey, "preserved-cloud-key");
    assert.equal(raw.decisionModel, "jev-pinned");
    assert.throws(() => saveDecisionSettings({ engine: "laya-mlx", mode: "enforce", model: saved.model, baseURL: saved.baseURL }, home), /shadow mode only/);
    assert.equal(JSON.stringify(saved).includes("preserved-cloud-key"), false);
  } finally {
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
});

test("Action Guard settings reject insecure endpoints and respect environment ownership", () => {
  assert.throws(() => saveDecisionSettings({
    engine: "typesafe",
    mode: "shadow",
    model: "jev-latest",
    baseURL: "http://decision.example",
  }, home), /HTTPS/);

  process.env.HARA_DECISION_ENGINE = "off";
  process.env.TYPESAFE_API_KEY = "environment-key";
  const snapshot = decisionSettingsSnapshot(home);
  assert.equal(snapshot.engineEditable, false);
  assert.equal(snapshot.credential, "environment");
  assert.equal(snapshot.credentialEditable, false);
  assert.throws(() => saveDecisionSettings({
    engine: "typesafe",
    mode: snapshot.mode,
    model: snapshot.model,
    baseURL: snapshot.baseURL,
  }, home), /HARA_DECISION_ENGINE/);
  assert.throws(() => saveDecisionSettings({
    engine: "off",
    mode: snapshot.mode,
    model: snapshot.model,
    baseURL: snapshot.baseURL,
    apiKey: "replacement",
  }, home), /launch environment/);
});
