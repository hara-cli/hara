import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";
import { WorkspaceRuntimeModels } from "../dist/workspace/runtime-models.js";

async function fixture(t, effort = true) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-claude-models-")));
  const home = join(root, "home"), account = join(root, "account"), command = join(account, ".local/bin/claude");
  fs.mkdirSync(home); fs.mkdirSync(dirname(command), { recursive: true });
  fs.writeFileSync(command, "#!" + process.execPath + "\n" + (effort
    ? 'console.log(process.argv.slice(2).includes("--help") ? "--effort <level> Effort level (low, medium, high, xhigh, max)" : "claude 1.2.3");\n'
    : 'console.log("claude 1.2.3");\n'), { mode: 0o755 });
  const storage = new WorkspaceResourceStorage(home, { schemaVersion: 1, workspaceId: "ws_" + randomUUID(),
    authority: { kind: "local", localAuthorityId: randomUUID() } });
  storage.initialize();
  const installer = new WorkspaceRuntimeInstaller(storage, { accountHome: () => account,
    discovery: { home: account, path: "/usr/bin:/bin", systemBins: [],
      run: async (_command, args) => args[0] === "-lic" ? null : "claude 1.2.3" } });
  t.after(async () => { await installer.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await installer.discover();
  const detected = installer.list().options.find(row => row.runtimeId === "claude");
  installer.registerLocal("claude", detected.fingerprint, "host");
  return { root, home, account, installer, storage, fingerprint: detected.fingerprint, models: new WorkspaceRuntimeModels(storage, installer) };
}

test("Claude catalog offers provider-following CLI aliases rather than obsolete concrete versions", async t => {
  const f = await fixture(t), listed = await f.models.list("claude");
  assert.deepEqual(listed.models.map(row => row.id), ["sonnet", "opus", "haiku"]);
  assert.equal(listed.models.find(row => row.recommended).id, "sonnet");
  for (const model of listed.models) {
    assert.match(model.label, /latest/);
    assert.match(model.description, /CLI.*provider/);
    assert.deepEqual(model.supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  }
});

test("Claude alias and advertised effort persist with revision guards and unsupported selections are rejected", async t => {
  const f = await fixture(t);
  await f.models.select("claude", "sonnet", 0, "high");
  assert.deepEqual(new WorkspaceRuntimeModels(f.storage, f.installer).selection("claude"), { modelId: "sonnet", effort: "high" });
  await assert.rejects(f.models.select("claude", "opus", 0, "max"), /revision changed/);
  await assert.rejects(f.models.select("claude", "claude-sonnet-4-5", 1), /Invalid runtime modelId/);
  await assert.rejects(f.models.select("claude", "sonnet", 1, "invented"), /Invalid runtime effort/);
  await f.models.select("claude", "opus", 1, "max");
  assert.deepEqual(f.models.selection("claude"), { modelId: "opus", effort: "max" });
});

test("a Claude CLI without the effort flag cannot publish or accept invented effort", async t => {
  const f = await fixture(t, false), listed = await f.models.list("claude");
  assert(listed.models.every(row => row.supportedReasoningEfforts === undefined));
  await assert.rejects(f.models.select("claude", "haiku", 0, "high"), /does not report reasoning effort/);
  await f.models.select("claude", "haiku", 0, null);
  assert.deepEqual(f.models.selection("claude"), { modelId: "haiku", effort: null });
});

test("Claude host and isolated bindings retain separate launch homes without copying login files", async t => {
  const f = await fixture(t), host = f.installer.resolveBound("claude");
  assert.equal(host.loginSource, "host");
  assert.equal(host.env.HOME, f.account); assert.equal(host.env.USERPROFILE, f.account);
  assert.equal(host.env.CLAUDE_CONFIG_DIR, undefined);
  f.installer.registerLocal("claude", f.fingerprint, "isolated");
  const isolated = f.installer.resolveBound("claude");
  assert.equal(isolated.loginSource, "isolated");
  assert.notEqual(isolated.env.HOME, f.account);
  assert(isolated.env.HOME.startsWith(f.home)); assert(isolated.env.CLAUDE_CONFIG_DIR.startsWith(f.home));
  assert.equal(fs.existsSync(join(f.account, ".claude")), false);
});
