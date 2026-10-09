import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENVIRONMENT_NAMES = ["HOME", "USERPROFILE", "HARA_CODING_EXECUTOR", "HARA_TRUST_PROJECT_CONFIG"];
const ORIGINAL_ENVIRONMENT = Object.fromEntries(ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]));
const TEST_HOME = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-coding-settings-")));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.HARA_TRUST_PROJECT_CONFIG = "1";
delete process.env.HARA_CODING_EXECUTOR;

const CONFIG_DIRECTORY = join(TEST_HOME, ".hara");
const CONFIG_FILE = join(CONFIG_DIRECTORY, "config.json");
const MODULE_URL = new URL("../dist/coding-settings.js", import.meta.url).href;
const {
  CODING_EXECUTOR_PREFERENCES,
  codingSettingsSnapshot,
  normalizeCodingExecutorPreference,
  resolveCodingExecutorPreference,
  saveCodingSettings,
} = await import(MODULE_URL);

beforeEach(() => {
  delete process.env.HARA_CODING_EXECUTOR;
  rmSync(CONFIG_DIRECTORY, { recursive: true, force: true });
  mkdirSync(CONFIG_DIRECTORY, { mode: 0o700 });
});

after(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENVIRONMENT)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function writeRaw(value) {
  writeFileSync(CONFIG_FILE, JSON.stringify(value) + "\n", { mode: 0o600 });
}

function inLaunchedHost(executor, body) {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    const settings = await import(${JSON.stringify(MODULE_URL)});
    ${body}
  `], {
    encoding: "utf8",
    env: {
      HOME: TEST_HOME,
      USERPROFILE: TEST_HOME,
      HARA_CODING_EXECUTOR: executor,
      HARA_TRUST_PROJECT_CONFIG: "1",
    },
  }));
}

test("coding settings default to auto with the OpenCode engineering default and no secret fields", () => {
  assert.deepEqual(codingSettingsSnapshot(TEST_HOME), {
    version: 1,
    revision: 0,
    executor: "auto",
    effectiveExecutor: "opencode",
    recommendedExecutor: "opencode",
    executorEditable: true,
    experimental: false,
  });
  assert.deepEqual([...CODING_EXECUTOR_PREFERENCES], ["auto", "opencode", "pi", "codex", "claude"]);
  assert.equal(Object.isFrozen(CODING_EXECUTOR_PREFERENCES), true);
  for (const executor of CODING_EXECUTOR_PREFERENCES) {
    assert.equal(normalizeCodingExecutorPreference(executor), executor);
    assert.equal(resolveCodingExecutorPreference(executor), executor === "auto" ? "opencode" : executor);
  }
});

test("coding settings persist only the executor and preserve other global configuration", () => {
  writeRaw({ model: "synthetic-model", apiKey: "synthetic-secret-do-not-expose", sentinel: { keep: true } });
  let revision = 0;
  for (const executor of ["pi", "codex", "claude", "opencode", "auto"]) {
    const saved = saveCodingSettings({ executor, expectedRevision: revision }, TEST_HOME);
    revision += 1;
    assert.equal(saved.revision, revision);
    assert.equal(saved.executor, executor);
    assert.equal(saved.experimental, executor === "pi");
    assert.deepEqual(saved, codingSettingsSnapshot(TEST_HOME));
    assert.equal(JSON.stringify(saved).includes("synthetic-secret"), false);
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    assert.deepEqual(raw.codingSettings, { version: 1, revision, executor });
    assert.equal(raw.apiKey, "synthetic-secret-do-not-expose");
    assert.deepEqual(raw.sentinel, { keep: true });
  }
  if (process.platform !== "win32") assert.equal(statSync(CONFIG_FILE).mode & 0o777, 0o600);
});

test("coding settings require a current revision and never overwrite a newer selection", () => {
  const initial = codingSettingsSnapshot();
  saveCodingSettings({ executor: "pi", expectedRevision: initial.revision });
  const before = readFileSync(CONFIG_FILE, "utf8");
  assert.throws(() => saveCodingSettings({ executor: "claude", expectedRevision: initial.revision }), /changed.*refresh/i);
  assert.equal(readFileSync(CONFIG_FILE, "utf8"), before);
  assert.throws(() => saveCodingSettings({ executor: "codex" }), /expectedRevision/);
  assert.equal(readFileSync(CONFIG_FILE, "utf8"), before);
});

test("coding executor input rejects unknown values, arbitrary packages, endpoints and credentials", () => {
  writeRaw({ sentinel: "unchanged" });
  const before = readFileSync(CONFIG_FILE, "utf8");
  for (const executor of ["", "PI", " pi ", "../pi.mjs", "@vendor/agent", "https://executor.invalid", "opencode\n", null, 1, {}]) {
    assert.throws(() => normalizeCodingExecutorPreference(executor), /must be one of/);
    assert.throws(() => saveCodingSettings({ executor, expectedRevision: 0 }), /must be one of/);
  }
  for (const extra of ["package", "path", "baseURL", "apiKey", "network", "version", "revision", "__proto__"]) {
    const input = JSON.parse(`{"executor":"pi","expectedRevision":0,${JSON.stringify(extra)}:"synthetic-value"}`);
    assert.throws(() => saveCodingSettings(input), /unsupported fields/);
  }
  for (const expectedRevision of [-1, 1.5, "0", null, Infinity, 9007199254740992]) {
    assert.throws(() => saveCodingSettings({ executor: "pi", expectedRevision }), /expectedRevision/);
  }
  for (const input of [null, [], "pi", new Date()]) assert.throws(() => saveCodingSettings(input), /object/);
  assert.equal(readFileSync(CONFIG_FILE, "utf8"), before);
});

test("unknown persisted schemas and executors fail closed without a reset to auto", () => {
  for (const codingSettings of [
    null,
    [],
    "pi",
    { version: 2, revision: 1, executor: "pi" },
    { version: 1, revision: 1, executor: "unknown" },
    { version: 1, executor: "pi" },
    { version: 1, revision: -1, executor: "pi" },
    { version: 1, revision: 0, executor: "pi", package: "external-agent" },
  ]) {
    writeRaw({ codingSettings, sentinel: "unchanged" });
    const before = readFileSync(CONFIG_FILE, "utf8");
    assert.throws(() => codingSettingsSnapshot(), /coding (?:settings|executor)/);
    assert.throws(() => saveCodingSettings({ executor: "auto", expectedRevision: 0 }), /coding (?:settings|executor)/);
    assert.equal(readFileSync(CONFIG_FILE, "utf8"), before);
  }
  writeRaw({ codingSettings: { version: 1, revision: Number.MAX_SAFE_INTEGER, executor: "pi" } });
  const before = readFileSync(CONFIG_FILE, "utf8");
  assert.throws(() => saveCodingSettings({ executor: "auto", expectedRevision: Number.MAX_SAFE_INTEGER }), /exhausted/);
  assert.equal(readFileSync(CONFIG_FILE, "utf8"), before);
});

test("even trusted repository settings cannot choose a coding executor", () => {
  const workspace = join(TEST_HOME, "workspace");
  mkdirSync(join(workspace, ".hara"), { recursive: true });
  const projectFile = join(workspace, ".hara", "config.json");
  const repositoryConfig = { codingSettings: { version: 99, revision: 123, executor: "pi" }, codingExecutor: "claude" };
  writeFileSync(projectFile, JSON.stringify(repositoryConfig) + "\n");
  assert.equal(codingSettingsSnapshot(workspace).executor, "auto");
  saveCodingSettings({ executor: "codex", expectedRevision: 0 }, workspace);
  assert.equal(codingSettingsSnapshot(workspace).executor, "codex");
  assert.deepEqual(JSON.parse(readFileSync(projectFile, "utf8")), repositoryConfig);
});

test("launch-time host environment selection is visible, locked, and unaffected by later mutations", () => {
  saveCodingSettings({ executor: "codex", expectedRevision: 0 });
  const result = inLaunchedHost("pi", `
    const first = settings.codingSettingsSnapshot();
    process.env.HARA_CODING_EXECUTOR = "claude";
    const second = settings.codingSettingsSnapshot();
    let error;
    try { settings.saveCodingSettings({ executor: "pi", expectedRevision: 1 }); }
    catch (caught) { error = caught.message; }
    console.log(JSON.stringify({ first, second, error }));
  `);
  assert.equal(result.first.executor, "pi");
  assert.equal(result.first.effectiveExecutor, "pi");
  assert.equal(result.first.experimental, true);
  assert.equal(result.first.executorEditable, false);
  assert.equal(result.first.revision, 1);
  assert.deepEqual(result.second, result.first);
  assert.match(result.error, /HARA_CODING_EXECUTOR/);
  assert.equal(codingSettingsSnapshot().executor, "codex");
  process.env.HARA_CODING_EXECUTOR = "pi";
  assert.equal(codingSettingsSnapshot().executor, "codex", "late extension mutations cannot widen launch policy");
});

test("invalid launch policy and invalid persisted state cannot be hidden by overrides", () => {
  const invalid = inLaunchedHost("../agent.mjs", `
    let readError, saveError;
    try { settings.codingSettingsSnapshot(); } catch (error) { readError = error.message; }
    try { settings.saveCodingSettings({ executor: "pi", expectedRevision: 0 }); } catch (error) { saveError = error.message; }
    console.log(JSON.stringify({ readError, saveError }));
  `);
  assert.match(invalid.readError, /must be one of/);
  assert.match(invalid.saveError, /must be one of/);
  assert.equal(JSON.stringify(invalid).includes("../agent.mjs"), false);
  writeRaw({ codingSettings: { version: 2, revision: 1, executor: "pi" } });
  const invalidStored = inLaunchedHost("opencode", `
    let error;
    try { settings.codingSettingsSnapshot(); } catch (caught) { error = caught.message; }
    console.log(JSON.stringify({ error }));
  `);
  assert.match(invalidStored.error, /unsupported coding settings version/);
});

test("malformed and aliased private config are rejected without replacing their contents", { skip: process.platform === "win32" }, () => {
  writeFileSync(CONFIG_FILE, "{not-json\n", { mode: 0o600 });
  assert.throws(() => codingSettingsSnapshot(), /not valid JSON/);
  assert.throws(() => saveCodingSettings({ executor: "pi", expectedRevision: 0 }), /not valid JSON/);
  assert.equal(readFileSync(CONFIG_FILE, "utf8"), "{not-json\n");
  rmSync(CONFIG_FILE);
  const outside = join(TEST_HOME, "outside-config.json");
  const bytes = '{"sentinel":"unchanged"}\n';
  writeFileSync(outside, bytes, { mode: 0o600 });
  symlinkSync(outside, CONFIG_FILE);
  assert.throws(() => codingSettingsSnapshot(), /symlink|symbolic/i);
  assert.throws(() => saveCodingSettings({ executor: "pi", expectedRevision: 0 }), /symlink|symbolic/i);
  assert.equal(readFileSync(outside, "utf8"), bytes);
  rmSync(CONFIG_FILE);
  linkSync(outside, CONFIG_FILE);
  assert.throws(() => codingSettingsSnapshot(), /hard.link/i);
  assert.throws(() => saveCodingSettings({ executor: "pi", expectedRevision: 0 }), /hard.link/i);
  assert.equal(readFileSync(outside, "utf8"), bytes);
});
