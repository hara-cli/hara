import "./setup-isolated-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedTaskbusRead } from "../dist/taskbus-cache.js";

test("offline replicas are pinned to the enrollment and never mask authorization failures", async () => {
  const scope = { profileId: "cache", spaceId: "org-cache", identityKey: "cache-identity" };
  const unavailable = () => Promise.reject(Object.assign(new Error("network unavailable"), { code: "UNAVAILABLE" }));
  const fresh = await cachedTaskbusRead(scope, "tasks.list", { projectId: "p" }, async () => ({ tasks: [{ title: "Own task" }] }));
  assert.equal(fresh.offline, false);
  const cached = await cachedTaskbusRead(scope, "tasks.list", { projectId: "p" }, unavailable);
  assert.equal(cached.offline, true); assert.equal(cached.tasks[0].title, "Own task");
  await assert.rejects(cachedTaskbusRead({ ...scope, identityKey: "new-user" }, "tasks.list", { projectId: "p" }, unavailable), /unavailable/);
  for (const code of ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"]) await assert.rejects(cachedTaskbusRead(scope, "tasks.list", { projectId: "p" }, async () => { throw Object.assign(new Error(code), { code }); }), new RegExp(code));
});
