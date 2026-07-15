import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { saveCreds } from "../dist/desk.js";
import { addProfile } from "../dist/profile/profile.js";
import { setPluginEnabled } from "../dist/plugins/plugins.js";
import { loadQwenToken } from "../dist/providers/qwen-oauth.js";
import { loadWeixinCreds, weixinKnownPeers } from "../dist/gateway/weixin.js";
import { enrollDevice } from "../dist/org-fleet/enroll.js";
import { resetPrivateHaraStateForTests } from "../dist/security/private-state.js";

async function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), "hara-private-credentials-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  resetPrivateHaraStateForTests();
  try {
    await run(home);
  } finally {
    resetPrivateHaraStateForTests();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

function installCredentialSymlink(home, relativePath, original) {
  const external = join(home, `outside-${relativePath.replaceAll("/", "-")}`);
  const alias = join(home, ".hara", relativePath);
  mkdirSync(dirname(alias), { recursive: true, mode: 0o700 });
  writeFileSync(external, original, { mode: 0o640 });
  chmodSync(external, 0o640);
  symlinkSync(external, alias);
  return { alias, external, mode: lstatSync(external).mode & 0o777 };
}

function assertPreserved(fixture, original) {
  assert.equal(readFileSync(fixture.external, "utf8"), original);
  assert.equal(lstatSync(fixture.external).mode & 0o777, fixture.mode);
  assert.equal(lstatSync(fixture.alias).isSymbolicLink(), true);
}

test("credential writers reject preseeded symlinks without changing external bytes or modes", { skip: process.platform === "win32" }, async () => {
  await withHome(async (home) => {
    const deskOriginal = '{"outside":"desk"}\n';
    const desk = installCredentialSymlink(home, "desk.json", deskOriginal);
    assert.throws(
      () => saveCreds({ url: "https://desk.invalid", agentId: "a", owner: "o", token: "placeholder" }),
      /symbolic link/i,
    );
    assertPreserved(desk, deskOriginal);
  });

  await withHome(async (home) => {
    const profilesOriginal = '{"outside":"profiles"}\n';
    const profiles = installCredentialSymlink(home, "profiles.json", profilesOriginal);
    assert.throws(
      () => addProfile({ id: "org", kind: "gateway", gatewayUrl: "https://gateway.invalid", deviceToken: "placeholder" }),
      /symbolic link/i,
    );
    assertPreserved(profiles, profilesOriginal);
  });

  await withHome(async (home) => {
    const configOriginal = '{"outside":"config"}\n';
    const config = installCredentialSymlink(home, "config.json", configOriginal);
    assert.throws(() => setPluginEnabled("example", false), /symbolic link/i);
    assertPreserved(config, configOriginal);
  });
});

test("legacy enrollment storage rejects a symlink after a successful token exchange", { skip: process.platform === "win32" }, async () => {
  await withHome(async (home) => {
    const original = '{"outside":"org"}\n';
    const fixture = installCredentialSymlink(home, "org.json", original);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      device_token: "placeholder",
      device_id: "device",
      model: "model",
    }), { status: 200, headers: { "content-type": "application/json" } });
    try {
      await assert.rejects(() => enrollDevice("https://gateway.invalid", "code"), /symbolic link/i);
    } finally {
      globalThis.fetch = previousFetch;
    }
    assertPreserved(fixture, original);
  });
});

test("credential readers fail closed on qwen/weixin symlinks and never chmod their targets", { skip: process.platform === "win32" }, async () => {
  await withHome(async (home) => {
    const qwenOriginal = '{"access":"outside","refresh":"outside","expires":9999999999999}\n';
    const qwen = installCredentialSymlink(home, "qwen-oauth.json", qwenOriginal);
    assert.equal(loadQwenToken(), null);
    assertPreserved(qwen, qwenOriginal);

    const weixinOriginal = '{"account_id":"outside","token":"outside","base_url":"https://invalid","user_id":"outside"}\n';
    const weixin = installCredentialSymlink(home, "weixin/creds.json", weixinOriginal);
    assert.equal(loadWeixinCreds(), null);
    assertPreserved(weixin, weixinOriginal);

    const peersOriginal = '{"outside@im.wechat":"outside-token"}\n';
    const peers = installCredentialSymlink(home, "weixin/account.context-tokens.json", peersOriginal);
    assert.deepEqual(weixinKnownPeers("account"), []);
    assertPreserved(peers, peersOriginal);
  });
});
