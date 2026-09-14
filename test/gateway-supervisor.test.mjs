import test from "node:test";
import assert from "node:assert/strict";
import { GatewaySupervisor } from "../dist/gateway/supervisor.js";

function status(platform, overrides = {}) {
  return {
    platform,
    label: platform === "weixin" ? "WeChat" : "Feishu",
    configuration: "ready",
    configured: true,
    running: false,
    runningInstances: 0,
    runtimeState: "stopped",
    directMessageAccess: "unknown",
    recommendation: "start it",
    ...overrides,
  };
}

test("GatewaySupervisor starts and stops only its own connector through an AbortSignal", async () => {
  let running = false;
  let runCalls = 0;
  let savedEnabled = [];
  const supervisor = new GatewaySupervisor({
    loadEnabled: () => new Set(),
    saveEnabled: (platforms) => { savedEnabled = [...platforms]; },
    inspect: async (platform) => status(platform, running ? {
      running: true,
      runningInstances: 1,
      runtimeState: "connected",
      directMessageAccess: "ready",
      recommendation: "none",
    } : {}),
    run: async ({ signal, manageProcessSignals }) => {
      runCalls += 1;
      assert.equal(manageProcessSignals, false);
      running = true;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      running = false;
    },
  });

  const started = await supervisor.start("feishu");
  assert.equal(started.running, true);
  assert.equal(started.managedByServe, true);
  assert.equal(runCalls, 1);
  assert.deepEqual(savedEnabled, ["feishu"]);
  assert.equal((await supervisor.start("feishu")).managedByServe, true, "start is idempotent");

  const stopped = await supervisor.stop("feishu");
  assert.equal(stopped.running, false);
  assert.equal(stopped.managedByServe, false);
  assert.deepEqual(savedEnabled, []);
  await supervisor.close();
});

test("GatewaySupervisor never adopts or stops an external connector", async () => {
  let runCalls = 0;
  const supervisor = new GatewaySupervisor({
    loadEnabled: () => new Set(),
    saveEnabled: () => {},
    inspect: async (platform) => status(platform, {
      running: true,
      runningInstances: 1,
      runtimeState: "connected",
      recommendation: "none",
    }),
    run: async () => { runCalls += 1; },
  });
  const observed = await supervisor.start("weixin");
  assert.equal(observed.managedByServe, false);
  assert.equal(runCalls, 0);
  await assert.rejects(supervisor.stop("weixin"), /running outside Hara Desktop/);
  await supervisor.close();
});

test("GatewaySupervisor closes every Serve-owned connector", async () => {
  const running = new Set();
  const supervisor = new GatewaySupervisor({
    loadEnabled: () => new Set(),
    saveEnabled: () => {},
    inspect: async (platform) => status(platform, running.has(platform) ? {
      running: true,
      runningInstances: 1,
      runtimeState: "connected",
      recommendation: "none",
    } : {}),
    run: async ({ platform, signal }) => {
      running.add(platform);
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      running.delete(platform);
    },
  });
  await Promise.all([supervisor.start("weixin"), supervisor.start("feishu")]);
  await supervisor.close();
  assert.deepEqual([...running], []);
  await assert.rejects(supervisor.start("feishu"), /shutting down/);
});

test("GatewaySupervisor restores only connectors explicitly enabled by an earlier Desktop session", async () => {
  const running = new Set();
  const started = [];
  let savedEnabled = [];
  const supervisor = new GatewaySupervisor({
    loadEnabled: () => new Set(["feishu"]),
    saveEnabled: (platforms) => { savedEnabled = [...platforms]; },
    inspect: async (platform) => status(platform, running.has(platform) ? {
      running: true,
      runningInstances: 1,
      runtimeState: "connected",
      directMessageAccess: "blocked",
      recommendation: "authorize a sender",
    } : {}),
    run: async ({ platform, signal }) => {
      started.push(platform);
      running.add(platform);
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      running.delete(platform);
    },
  });

  await supervisor.resume();
  assert.deepEqual(started, ["feishu"]);
  assert.deepEqual([...running], ["feishu"]);
  assert.deepEqual(savedEnabled, ["feishu"]);
  await supervisor.close();
  assert.deepEqual([...running], []);
  assert.deepEqual(savedEnabled, ["feishu"], "shutdown preserves the user's auto-restore choice");
});

test("GatewaySupervisor cannot launch a connector after shutdown overtakes startup inspection", async () => {
  let releaseInspection;
  let runCalls = 0;
  const inspection = new Promise((resolve) => { releaseInspection = resolve; });
  const supervisor = new GatewaySupervisor({
    loadEnabled: () => new Set(),
    saveEnabled: () => {},
    inspect: async (platform) => {
      await inspection;
      return status(platform);
    },
    run: async () => { runCalls += 1; },
  });

  const starting = supervisor.start("feishu");
  await Promise.resolve();
  const closing = supervisor.close();
  releaseInspection();
  await closing;
  await assert.rejects(starting, /shutting down/);
  assert.equal(runCalls, 0);
});
