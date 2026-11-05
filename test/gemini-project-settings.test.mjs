import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { overlayGeminiProjectSettings, assertGeminiProjectSettingsSupported } from "../dist/agent-runtime/gemini-project-settings.js";
function root(t) { const value = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "gemini-overlay-"))); t.after(() => fs.rmSync(value, { recursive: true, force: true })); return value; }
const macTest = (name, body) => test(name, { skip: process.platform !== "darwin" }, body);
const contents = JSON.stringify({ hooksConfig: { enabled: false }, skills: { enabled: false }, mcpServers: { hara: { httpUrl: "http://127.0.0.1:12345/mcp" } } });
macTest("Gemini project override is private, exclusive and removed after use", () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "gemini-overlay-")));
  try { const overlay = overlayGeminiProjectSettings(cwd, contents); assert.equal(fs.readFileSync(overlay.path, "utf8"), contents); assert.equal(fs.statSync(overlay.path).mode & 0o077, 0);
    assert.throws(() => overlayGeminiProjectSettings(cwd, contents), /already exist/); overlay.close(); overlay.close(); assert.equal(fs.existsSync(join(cwd, ".gemini")), false); }
  finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
macTest("Gemini existing settings are preserved byte-for-byte and no lock is installed", t => {
  const cwd = root(t); fs.mkdirSync(join(cwd, ".gemini")); const path = join(cwd, ".gemini/settings.json"); fs.writeFileSync(path, "FAKE_EXISTING_PROJECT_CONFIG", { mode: 0o640 });
  assert.throws(() => overlayGeminiProjectSettings(cwd, contents), /already exist/); assert.equal(fs.readFileSync(path, "utf8"), "FAKE_EXISTING_PROJECT_CONFIG"); assert.equal(fs.statSync(path).mode & 0o777, 0o640); assert.equal(fs.existsSync(join(cwd, ".gemini/.hara-settings.lock")), false);
});
macTest("Gemini overlay rejects linked directories and files without changing their targets", t => {
  const cwd = root(t), outside = join(cwd, "outside"); fs.mkdirSync(outside); fs.symlinkSync(outside, join(cwd, ".gemini"));
  assert.throws(() => overlayGeminiProjectSettings(cwd, contents), /unsafe/); assert.deepEqual(fs.readdirSync(outside), []); fs.unlinkSync(join(cwd, ".gemini")); fs.mkdirSync(join(cwd, ".gemini"));
  const target = join(outside, "settings"); fs.writeFileSync(target, "FAKE_LINK_TARGET"); fs.symlinkSync(target, join(cwd, ".gemini/settings.json"));
  assert.throws(() => overlayGeminiProjectSettings(cwd, contents), /already exist/); assert.equal(fs.readFileSync(target, "utf8"), "FAKE_LINK_TARGET");
});
macTest("Gemini overlay never discards an observed writer change", t => {
  const cwd = root(t), overlay = overlayGeminiProjectSettings(cwd, contents); fs.writeFileSync(overlay.path, "FAKE_USER_CHANGE");
  assert.throws(() => overlay.close(), /cleanup held/); assert.throws(() => overlay.close(), /cleanup held/); assert.equal(fs.readFileSync(overlay.path, "utf8"), "FAKE_USER_CHANGE"); assert.equal(fs.existsSync(join(cwd, ".gemini/.hara-settings.lock")), true);
});
macTest("Gemini directory replacement holds cleanup and leaves both directories intact", t => {
  const cwd = root(t), overlay = overlayGeminiProjectSettings(cwd, contents); fs.renameSync(join(cwd, ".gemini"), join(cwd, "moved")); fs.mkdirSync(join(cwd, ".gemini")); fs.writeFileSync(join(cwd, ".gemini/settings.json"), "FAKE_NEW_OWNER");
  assert.throws(() => overlay.close(), /cleanup held/); assert.equal(fs.readFileSync(join(cwd, ".gemini/settings.json"), "utf8"), "FAKE_NEW_OWNER"); assert.equal(fs.readFileSync(join(cwd, "moved/settings.json"), "utf8"), contents);
});
macTest("Gemini cleanup retains unrelated files and rejects higher-priority admin settings", t => {
  const cwd = root(t), overlay = overlayGeminiProjectSettings(cwd, contents); fs.writeFileSync(join(cwd, ".gemini/unrelated.txt"), "KEEP"); overlay.close(); assert.equal(fs.readFileSync(join(cwd, ".gemini/unrelated.txt"), "utf8"), "KEEP");
  const admin = join(cwd, "fake-admin.json"); assertGeminiProjectSettingsSupported(admin); fs.writeFileSync(admin, "FAKE_NOT_PARSED"); assert.throws(() => assertGeminiProjectSettingsSupported(admin), /admin settings prevent/);
});
