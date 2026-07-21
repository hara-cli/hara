// Startup update check — pure decision + cache + background probe (fetch stubbed; no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNewer, updateNotice, readCache, writeCache, refreshLatest, checkForUpdate, fetchLatestVersion, CHECK_EVERY_MS } from "../dist/update-check.js";

test("isNewer: numeric triple compare, unparsable never nags", () => {
  assert.equal(isNewer("0.101.0", "0.100.0"), true);
  assert.equal(isNewer("1.0.0", "0.100.0"), true, "major beats minor (no lexicographic trap)");
  assert.equal(isNewer("0.100.0", "0.100.0"), false);
  assert.equal(isNewer("0.99.9", "0.100.0"), false);
  assert.equal(isNewer("v0.100.1", "0.100.0"), true, "leading v tolerated");
  assert.equal(isNewer("beta", "0.100.0"), false, "garbage → false");
  assert.equal(isNewer("", "0.100.0"), false);
});

test("updateNotice: fires only when the cached latest is newer", () => {
  assert.equal(updateNotice("0.100.0", null), null, "no cache → silent");
  assert.equal(updateNotice("0.100.0", { checkedAt: 1, latest: "0.100.0" }), null, "same → silent");
  const n = updateNotice("0.100.0", { checkedAt: 1, latest: "0.101.0" });
  assert.ok(n.includes("0.100.0 → 0.101.0") && n.includes("hara update"), "notice routes through the source-aware updater");
});

test("fetchLatestVersion: falls back across fixed registries and rejects non-stable metadata", async () => {
  let calls = 0;
  const latest = await fetchLatestVersion(async () => {
    calls++;
    return calls === 1
      ? { ok: true, json: async () => ({ version: "latest" }) }
      : { ok: true, json: async () => ({ version: "0.130.3" }) };
  });
  assert.equal(latest, "0.130.3");
  assert.equal(calls, 2);
});

test("cache round-trip + malformed cache reads as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-upd-"));
  const file = join(dir, "sub", "update-check.json");
  assert.equal(readCache(file), null, "missing → null");
  writeCache({ checkedAt: 42, latest: "1.2.3" }, file);
  assert.deepEqual(readCache(file), { checkedAt: 42, latest: "1.2.3" });
  rmSync(dir, { recursive: true, force: true });
});

test("refreshLatest: first responding registry wins; total failure still stamps checkedAt (daily backoff)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-upd-"));
  const file = join(dir, "c.json");
  // First registry fails, second answers.
  let calls = 0;
  const fetchOk = async (url) => {
    calls++;
    if (calls === 1) throw new Error("blocked");
    return { ok: true, json: async () => ({ version: "9.9.9" }) };
  };
  await refreshLatest(file, fetchOk);
  assert.equal(readCache(file).latest, "9.9.9", "fallback registry result cached");
  // Total failure: latest preserved, checkedAt stamped.
  const before = readCache(file);
  await refreshLatest(file, async () => { throw new Error("offline"); });
  const after = readCache(file);
  assert.equal(after.latest, "9.9.9", "previous latest survives a failed probe");
  assert.ok(after.checkedAt >= before.checkedAt, "checkedAt stamped → offline machines back off to daily");
  rmSync(dir, { recursive: true, force: true });
});

test("checkForUpdate: returns the cached notice and fires the probe only when stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-upd-"));
  const file = join(dir, "c.json");
  const now = Date.now();
  // Fresh cache with a newer version → notice, no probe needed (probe is fire-and-forget; can't observe
  // directly here, so we pin the DECISION path: fresh cache → notice from cache).
  writeCache({ checkedAt: now - 1000, latest: "99.0.0" }, file);
  const n = checkForUpdate("0.100.0", file, now);
  assert.ok(n && n.includes("99.0.0"), "fresh cache → notice");
  // Stale cache → still returns the (old) notice immediately; the background probe updates for next time.
  writeCache({ checkedAt: now - CHECK_EVERY_MS - 1, latest: "99.0.0" }, file);
  const n2 = checkForUpdate("0.100.0", file, now);
  assert.ok(n2, "stale cache still notices from last-known latest");
  rmSync(dir, { recursive: true, force: true });
});
