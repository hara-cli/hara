import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRuntimeUsageCache, planColleagueUsageDispatch } from "../dist/workspace/runtime-account-usage.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";

const now = Date.parse("2026-10-29T12:00:00Z");
const account = (agentId, connectionId, runtimeId = "pi", workspaceId = "space-a") => ({ workspaceId, agentId, runtimeId, connectionId });
const window = (a, availability, validUntil = "2026-10-29T12:05:00Z") => ({
  runtimeId: a.runtimeId, connectionId: a.connectionId, scope: a.runtimeId === "pi" ? "hara-pi" : "external-runtime",
  authority: "native-account-window", availability, fetchedAt: "2026-10-29T11:59:00Z", validUntil,
  resetAt: "2026-10-29T12:10:00Z",
});

test("periodic collector cache is account scoped; a failed refresh becomes unknown, not zero", async () => {
  let calls = 0;
  const cache = new WorkspaceRuntimeUsageCache(async a => {
    calls++;
    if (a.connectionId === "bad") throw new Error("parse failed");
    return window(a, a.connectionId === "pi-a" ? "exhausted" : "available");
  });
  const exhausted = account("writer", "pi-a"), other = account("coder", "pi-b"), failed = account("reviewer", "bad");
  await Promise.all([cache.refresh(exhausted), cache.refresh(other), cache.refresh(failed)]);
  assert.equal(calls, 3);
  assert.equal(cache.read(exhausted, now).state, "limit_reached");
  assert.equal(cache.read(other, now).state, "ok");
  assert.equal(cache.read(failed, now).state, "parse_unavailable");
  assert.equal(cache.read(other, now + 10 * 60_000).view.availability, "unknown");
  cache.prune("space-a", [other]);
  assert.equal(cache.read(exhausted, now).state, "parse_unavailable");
  assert.equal(cache.read(other, now).state, "ok");
});

test("exhausted colleague is not dispatched; alternatives and future reset are advisory only", async () => {
  const cache = new WorkspaceRuntimeUsageCache(async a => window(a, a.connectionId === "pi-a" ? "exhausted" : "available"));
  const blocked = account("writer", "pi-a"), alternative = account("coder", "pi-b");
  await cache.refresh(blocked); await cache.refresh(alternative);
  const plan = planColleagueUsageDispatch(cache.read(blocked, now), [{ agentId: "coder", usage: cache.read(alternative, now) }], now);
  assert.deepEqual(plan, { action: "exhausted", availability: "exhausted", fresh: true,
    alternatives: ["coder"], resetAt: "2026-10-29T12:10:00Z" });
  assert.equal(planColleagueUsageDispatch(cache.read(blocked, now + 20 * 60_000), [], now + 20 * 60_000).availability, "unknown");
  assert.equal(planColleagueUsageDispatch(cache.read(alternative, now), [], now).action, "dispatch");
});

test("external runtime cannot consume a Pi window even with the same connection ID", async () => {
  const cache = new WorkspaceRuntimeUsageCache(async a => window(a, "available"));
  const pi = account("writer", "shared", "pi"), codex = account("coder", "shared", "codex");
  await cache.refresh(pi); await cache.refresh(codex);
  assert.equal(cache.read(pi, now).view.scope, "hara-pi");
  assert.equal(cache.read(codex, now).view.scope, "external-runtime");
});

test("Host connection change refreshes a read-only account projection without blocking snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-usage-host-"));
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const host = new LocalWorkspaceHost(root, { usageCollector: async a => {
    await waiting;
    return { ...window(a, "exhausted", new Date(Date.now() + 60_000).toISOString()),
      fetchedAt: new Date(Date.now() - 1000).toISOString() };
  } });
  try {
    const created = host.createWorkspace("Test", host.list().revision);
    host.configureSynthetic(created.workspaceId, 0);
    assert.equal(host.snapshot(created.workspaceId).accountUsage[0].state, "parse_unavailable");
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(host.snapshot(created.workspaceId).accountUsage[0].state, "limit_reached");
  } finally { release(); await host.close(); rmSync(root, { recursive: true, force: true }); }
});
