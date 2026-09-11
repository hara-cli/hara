import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectFeishuGatewayCredentials,
  removeStoredFeishuGatewayCredentials,
  saveFeishuGatewayCredentials,
} from "../dist/gateway/credentials.js";
import { gatewayStatus } from "../dist/gateway/serve.js";
import { classifyDeliveryFailure, deliveryConfigurationError } from "../dist/cron/deliver.js";

const APP_ID = "cli_test_private_credential";
const APP_SECRET = "private-secret-never-returned";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hara-gateway-credentials-"));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  return {
    root,
    home,
    path: join(home, ".hara", "gateway-credentials.json"),
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Feishu credentials are owner-only, write-only to callers, and usable by delivery preflight", async () => {
  const fx = fixture();
  const savedId = process.env.HARA_FEISHU_APP_ID;
  const savedSecret = process.env.HARA_FEISHU_APP_SECRET;
  try {
    delete process.env.HARA_FEISHU_APP_ID;
    delete process.env.HARA_FEISHU_APP_SECRET;
    const summary = saveFeishuGatewayCredentials({
      appId: APP_ID,
      appSecret: APP_SECRET,
      domain: "lark",
    }, fx.home);

    assert.deepEqual(summary, { configured: true, source: "stored", domain: "lark" });
    assert.doesNotMatch(JSON.stringify(summary), new RegExp(`${APP_ID}|${APP_SECRET}`));
    if (process.platform !== "win32") assert.equal(lstatSync(fx.path).mode & 0o777, 0o600);

    const raw = JSON.parse(readFileSync(fx.path, "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.feishu.appId, APP_ID);
    assert.equal(raw.feishu.appSecret, APP_SECRET);
    assert.equal(raw.feishu.domain, "lark");

    const inspected = inspectFeishuGatewayCredentials({ home: fx.home });
    assert.equal(inspected.state, "ready");
    assert.equal(inspected.source, "stored");
    assert.equal(inspected.credentials.domain, "lark");
    assert.equal(deliveryConfigurationError("feishu:oc_test", process.env, fx.home), null);
    const status = await gatewayStatus("feishu", { home: fx.home, env: {} });
    assert.equal(status.configuration, "ready");
    assert.equal(status.credentialSource, "stored");
    assert.doesNotMatch(JSON.stringify(status), new RegExp(`${APP_ID}|${APP_SECRET}`));

    const removed = removeStoredFeishuGatewayCredentials(fx.home);
    assert.deepEqual(removed, { configured: false, source: "missing" });
    assert.equal(inspectFeishuGatewayCredentials({ home: fx.home }).state, "missing");
    assert.match(deliveryConfigurationError("feishu:oc_test", process.env, fx.home) ?? "", /Hara Settings/);
  } finally {
    if (savedId === undefined) delete process.env.HARA_FEISHU_APP_ID;
    else process.env.HARA_FEISHU_APP_ID = savedId;
    if (savedSecret === undefined) delete process.env.HARA_FEISHU_APP_SECRET;
    else process.env.HARA_FEISHU_APP_SECRET = savedSecret;
    fx.cleanup();
  }
});

test("Feishu environment credentials override as one record and never mix with stored values", () => {
  const fx = fixture();
  try {
    saveFeishuGatewayCredentials({ appId: APP_ID, appSecret: APP_SECRET }, fx.home);
    const environment = inspectFeishuGatewayCredentials({
      home: fx.home,
      env: {
        HARA_FEISHU_APP_ID: "cli_environment_identity",
        HARA_FEISHU_APP_SECRET: "environment-secret-value",
        HARA_FEISHU_DOMAIN: "lark",
      },
      allowStored: true,
    });
    assert.equal(environment.state, "ready");
    assert.equal(environment.source, "environment");
    assert.equal(environment.credentials.appId, "cli_environment_identity");
    assert.equal(environment.credentials.appSecret, "environment-secret-value");
    assert.equal(environment.credentials.domain, "lark");

    const legacyLauncher = inspectFeishuGatewayCredentials({
      env: {
        HARA_FEISHU_APP_ID: "legacy-launcher-identity",
        HARA_FEISHU_APP_SECRET: "legacy-launcher-secret",
      },
      allowStored: false,
    });
    assert.equal(legacyLauncher.state, "ready", "existing trusted launcher values retain their legacy contract");

    const partial = inspectFeishuGatewayCredentials({
      home: fx.home,
      env: { HARA_FEISHU_APP_ID: "cli_environment_identity" },
      allowStored: true,
    });
    assert.deepEqual(partial, { state: "incomplete", source: "environment" });
  } finally {
    fx.cleanup();
  }
});

test("malformed, symlinked, and hard-linked credential state fails closed without reflecting values", {
  skip: process.platform === "win32",
}, () => {
  const malformed = fixture();
  try {
    mkdirSync(join(malformed.home, ".hara"), { recursive: true, mode: 0o700 });
    writeFileSync(malformed.path, `{"version":1,"feishu":{"appSecret":"${APP_SECRET}"}}\n`, { mode: 0o600 });
    const inspected = inspectFeishuGatewayCredentials({ home: malformed.home });
    assert.deepEqual(inspected, { state: "unreadable", source: "stored" });
    assert.doesNotMatch(JSON.stringify(inspected), new RegExp(APP_SECRET));
    const configurationError = deliveryConfigurationError("feishu:oc_test", process.env, malformed.home);
    assert.match(configurationError ?? "", /credentials are unreadable/);
    assert.deepEqual(classifyDeliveryFailure(configurationError, 1), {
      state: "blocked",
      code: "configuration_required",
    });
  } finally {
    malformed.cleanup();
  }

  const symlinked = fixture();
  try {
    mkdirSync(join(symlinked.home, ".hara"), { recursive: true, mode: 0o700 });
    const outside = join(symlinked.root, "outside.json");
    writeFileSync(outside, "{}\n", { mode: 0o600 });
    symlinkSync(outside, symlinked.path);
    assert.throws(
      () => saveFeishuGatewayCredentials({ appId: APP_ID, appSecret: APP_SECRET }, symlinked.home),
      /symbolic link/,
    );
  } finally {
    symlinked.cleanup();
  }

  const hardLinked = fixture();
  try {
    mkdirSync(join(hardLinked.home, ".hara"), { recursive: true, mode: 0o700 });
    const outside = join(hardLinked.root, "outside.json");
    writeFileSync(outside, "{}\n", { mode: 0o600 });
    chmodSync(outside, 0o600);
    linkSync(outside, hardLinked.path);
    assert.throws(
      () => saveFeishuGatewayCredentials({ appId: APP_ID, appSecret: APP_SECRET }, hardLinked.home),
      /hard links|nlink|regular file/,
    );
  } finally {
    hardLinked.cleanup();
  }
});
