import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableRuntimePermissionTiers, createRuntimeExecutionPolicy, defaultRuntimePermissionTier, NATIVE_ENGINE_UNSUPPORTED,
  RUNTIME_TIER_UNAVAILABLE, runtimeWriteProtection,
} from "../dist/agent-runtime/execution-policy.js";
import { registeredCliArgs } from "../dist/agent-runtime/registered-cli.js";

// Decision B (Jeff 2026-11-08): macOS keeps Seatbelt with no unprotected fallback; other platforms keep the
// released 1.0.x behavior (controlled tier only, native read-only/plan modes, no OS write protection).
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-platform-tier-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), work = join(root, "work"); fs.mkdirSync(join(home, ".codex"), { recursive: true }); fs.mkdirSync(work);
  return { home, work, input: tier => ({ runtimeId: "codex", tier, accountHome: home, workRoot: work, loginSource: "host" }) };
}
const command = process.execPath;
// These tests inspect launch shape only and never spawn; close() then reports the unattached ownership hook.
const closeUnspawned = policy => policy.close().catch(error => { if (!/did not attach its process ownership hook/u.test(error.message)) throw error; });
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

test("tier availability and defaults follow the Host platform's OS write protection", () => {
  assert.equal(runtimeWriteProtection("darwin"), "seatbelt");
  assert.deepEqual(availableRuntimePermissionTiers("darwin"), ["full-protected", "controlled"]);
  assert.equal(defaultRuntimePermissionTier("darwin"), "full-protected");
  for (const platform of ["linux", "win32", "freebsd"]) {
    assert.equal(runtimeWriteProtection(platform), "none", platform);
    assert.deepEqual(availableRuntimePermissionTiers(platform), ["controlled"], platform);
    assert.equal(defaultRuntimePermissionTier(platform), "controlled", platform);
  }
});

test("off macOS the full tier is refused explicitly before any native process or temporary state exists", t => {
  const f = fixture(t), before = fs.readdirSync(tmpdir()).filter(name => name.startsWith("hara-native-")).length;
  for (const platform of ["linux", "win32"]) {
    assert.throws(() => createRuntimeExecutionPolicy(f.input("full-protected"), { platform }),
      error => error.code === RUNTIME_TIER_UNAVAILABLE && /controlled tier/u.test(error.message), platform);
  }
  assert.equal(fs.readdirSync(tmpdir()).filter(name => name.startsWith("hara-native-")).length, before, "no policy temporary directory was created");
});

test("Linux controlled runs through the POSIX process guard without sandbox-exec and keeps launch hygiene", async t => {
  const f = fixture(t), policy = createRuntimeExecutionPolicy(f.input("controlled"), { platform: "linux" }); t.after(() => closeUnspawned(policy));
  assert.equal(policy.writeProtection, "none");
  const launch = policy.wrap({ command, args: ["--version"], env: { PATH: "/usr/bin", NODE_OPTIONS: "--require x", DYLD_INSERT_LIBRARIES: "x", LD_PRELOAD: "x", KEEP: "1" } });
  assert.equal(launch.command, "/bin/sh");
  assert.equal(launch.args.includes(SANDBOX_EXEC), false, "no Seatbelt claim off macOS");
  assert.deepEqual(launch.args.slice(3), [command, "--version"], "guard execs the resolved command directly");
  for (const name of ["NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"]) assert.equal(launch.env[name], undefined, name);
  assert.equal(launch.env.KEEP, "1"); assert.equal(launch.env.TMPDIR, policy.tempRoot + "/");
});

test("Windows refuses native engines explicitly instead of launching them unprotected", async t => {
  const f = fixture(t), policy = createRuntimeExecutionPolicy(f.input("controlled"), { platform: "win32" }); t.after(() => policy.close());
  assert.throws(() => policy.wrap({ command, args: [], env: {} }), error => error.code === NATIVE_ENGINE_UNSUPPORTED && /Pi/u.test(error.message));
});

test("macOS never falls back: without Seatbelt the launch is refused, with it every launch is sandboxed", async t => {
  const f = fixture(t);
  for (const tier of ["full-protected", "controlled"]) {
    const policy = createRuntimeExecutionPolicy(f.input(tier), { platform: "darwin" }); t.after(() => closeUnspawned(policy));
    assert.equal(policy.writeProtection, "seatbelt");
    if (fs.existsSync(SANDBOX_EXEC)) {
      const launch = policy.wrap({ command, args: [], env: {} });
      assert.deepEqual(launch.args.slice(3, 6), [SANDBOX_EXEC, "-p", policy.profile], tier);
    } else {
      // Hosted Linux CI exercises the real "Seatbelt unavailable" case for a macOS-configured policy.
      assert.throws(() => policy.wrap({ command, args: [], env: {} }), /requires macOS Seatbelt; no unprotected fallback/, tier);
    }
  }
});

test("Codex keeps its own read-only sandbox for the controlled tier and whenever there is no OS write sandbox", () => {
  const common = { id: "codex", prompt: "fixture", cwd: "/fixture/project", model: null, effort: null, skipGitRepoCheck: false, permissionTier: "controlled" };
  const unprotected = registeredCliArgs({ ...common, osWriteSandbox: false }).join(" ");
  assert.match(unprotected, /--sandbox read-only/);
  assert.doesNotMatch(unprotected, /danger-full-access|--dangerously-bypass/);
  const seatbelt = registeredCliArgs({ ...common, osWriteSandbox: true }).join(" ");
  assert.match(seatbelt, /--sandbox read-only/, "controlled is read-only even inside Seatbelt");
  assert.doesNotMatch(seatbelt, /danger-full-access|--dangerously-bypass/);
  const full = registeredCliArgs({ ...common, permissionTier: "full-protected", osWriteSandbox: true }).join(" ");
  assert.match(full, /--dangerously-bypass-approvals-and-sandbox/, "only full-protected inside Seatbelt hands confinement to the outer boundary");
  const fullUnprotected = registeredCliArgs({ ...common, permissionTier: "full-protected", osWriteSandbox: false }).join(" ");
  assert.match(fullUnprotected, /--sandbox read-only/);
  const untiered = registeredCliArgs({ ...common, permissionTier: undefined, osWriteSandbox: true }).join(" ");
  assert.match(untiered, /--sandbox read-only/, "an unknown tier never bypasses");
  const hostDefault = registeredCliArgs(common).join(" ");
  assert.match(hostDefault, /--sandbox read-only/); assert.doesNotMatch(hostDefault, /danger-full-access|--dangerously-bypass/);
});
