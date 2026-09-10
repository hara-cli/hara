import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_MODE = process.env.HARA_COMPUTER_USE;
const ORIGINAL_APPS = process.env.HARA_COMPUTER_APPS;
const TEST_HOME = mkdtempSync(join(tmpdir(), "hara-computer-settings-"));
process.env.HOME = TEST_HOME;
delete process.env.HARA_COMPUTER_USE;
delete process.env.HARA_COMPUTER_APPS;
mkdirSync(join(TEST_HOME, ".hara"), { recursive: true });

const {
  computerSettingsSnapshot,
  normalizeComputerApps,
  saveComputerSettings,
} = await import("../dist/computer-settings.js");

after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_MODE === undefined) delete process.env.HARA_COMPUTER_USE;
  else process.env.HARA_COMPUTER_USE = ORIGINAL_MODE;
  if (ORIGINAL_APPS === undefined) delete process.env.HARA_COMPUTER_APPS;
  else process.env.HARA_COMPUTER_APPS = ORIGINAL_APPS;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test("Computer Use settings normalize a bounded, case-insensitive app allowlist", () => {
  assert.deepEqual(normalizeComputerApps([" Chrome ", "chrome", "WeChat", ""]), ["Chrome", "WeChat"]);
  assert.throws(() => normalizeComputerApps(["bad\nname"]), /printable characters/);
  assert.throws(() => normalizeComputerApps(Array.from({ length: 33 }, (_, index) => `App ${index}`)), /at most 32/);
});

test("Computer Use settings persist global policy and expose only redacted capability state", () => {
  saveComputerSettings({ mode: "full", apps: ["Chrome", "WeChat"] }, TEST_HOME);
  const raw = JSON.parse(readFileSync(join(TEST_HOME, ".hara", "config.json"), "utf8"));
  assert.equal(raw.computerUse, "full");
  assert.deepEqual(raw.computerApps, ["Chrome", "WeChat"]);
  assert.deepEqual(
    computerSettingsSnapshot(TEST_HOME, "fixture backend", { installed: true, enabled: true, version: "0.2.0" }),
    {
      mode: "full",
      apps: ["Chrome", "WeChat"],
      modeEditable: true,
      appsEditable: true,
      platform: process.platform,
      backend: "fixture backend",
      browser: { installed: true, enabled: true, version: "0.2.0" },
    },
  );
});

test("environment-owned Computer Use fields cannot be widened from Desktop", () => {
  process.env.HARA_COMPUTER_USE = "read";
  process.env.HARA_COMPUTER_APPS = "Chrome";
  const snapshot = computerSettingsSnapshot(TEST_HOME, "fixture", { installed: false, enabled: false });
  assert.equal(snapshot.mode, "read");
  assert.deepEqual(snapshot.apps, ["Chrome"]);
  assert.equal(snapshot.modeEditable, false);
  assert.equal(snapshot.appsEditable, false);
  assert.throws(
    () => saveComputerSettings({ mode: "full", apps: ["Chrome"] }, TEST_HOME),
    /HARA_COMPUTER_USE/,
  );
  assert.throws(
    () => saveComputerSettings({ mode: "read", apps: ["Chrome", "Edge"] }, TEST_HOME),
    /HARA_COMPUTER_APPS/,
  );
});
