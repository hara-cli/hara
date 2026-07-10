// Session source stamping (R1): env-derived creator + automated-title strategy — the raw prompt must
// never become an automated session's title.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionSourceFromEnv, automatedTitle } from "../dist/session/store.js";

const withEnv = (env, fn) => {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

test("sessionSourceFromEnv: cron > gateway > interactive", () => {
  withEnv({ HARA_CRON: "1", HARA_CRON_NAME: "晨间简报", HARA_GATEWAY: undefined }, () => {
    assert.deepEqual(sessionSourceFromEnv(), { source: "cron", sourceName: "晨间简报" });
  });
  withEnv({ HARA_CRON: undefined, HARA_CRON_NAME: undefined, HARA_GATEWAY: "weixin" }, () => {
    assert.deepEqual(sessionSourceFromEnv(), { source: "gateway", sourceName: "weixin" });
  });
  withEnv({ HARA_CRON: undefined, HARA_CRON_NAME: undefined, HARA_GATEWAY: undefined }, () => {
    assert.deepEqual(sessionSourceFromEnv(), { source: "interactive" });
  });
});

test("automatedTitle: name · MM-DD HH:mm; falls back to source when unnamed", () => {
  const at = new Date(2026, 6, 11, 9, 5); // 2026-07-11 09:05
  assert.equal(automatedTitle("cron", "晨间简报", at), "晨间简报 · 07-11 09:05");
  assert.equal(automatedTitle("gateway", undefined, at), "gateway · 07-11 09:05");
});
