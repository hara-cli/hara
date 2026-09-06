import { createInterface } from "node:readline/promises";

import { MobileAccountClient } from "./account-client.js";
import { LocalServeClient } from "./local-serve-client.js";
import { MobileRelayBridge } from "./relay-bridge.js";
import { MobileCompanionRouter } from "./router.js";
import { generateDeviceKey } from "./security.js";
import {
  clearMobileState,
  loadMobileState,
  saveMobileState,
  type MobileCompanionState,
} from "./state.js";

const ACCOUNT_ORIGIN = "https://api.hara.nanhara.tech";
const RELAY_URL = "wss://relay.hara.nanhara.tech/v1/connect";

export type MobileCommandOptions = Readonly<{
  code?: string;
  phone?: string;
  yes?: boolean;
}>;

const write = (value: string): void => {
  process.stdout.write(value);
};
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function desktopPlatform(): "macos" | "windows" | "linux" {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

async function prompt(label: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${label} is required in a non-interactive terminal`);
  }
  // readline cannot reliably mask input across all supported terminals. The SMS code is short-lived;
  // avoid echo-control tricks that can leave a terminal in an unsafe state after interruption.
  void hidden;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await input.question(`${label}: `)).trim();
  } finally {
    input.close();
  }
}

async function confirm(label: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  const answer = (await prompt(`${label} [y/N]`)).toLowerCase();
  return answer === "y" || answer === "yes";
}

async function login(options: MobileCommandOptions): Promise<void> {
  const account = new MobileAccountClient(ACCOUNT_ORIGIN);
  const phone = options.phone?.trim() || await prompt("Nayi 手机号");
  await account.sendSms(phone);
  write("验证码已发送。\n");
  const code = options.code?.trim() || await prompt("短信验证码", true);
  const platform = desktopPlatform();
  const signedIn = await account.login(phone, code, platform);
  const previous = loadMobileState();
  const key = previous?.desktop.key ?? generateDeviceKey();
  const desktop = await account.registerDesktop({
    accessToken: signedIn.accessToken,
    accountId: signedIn.account.id,
    accountRegion: signedIn.account.region,
    key,
    platform,
  });
  const observedAt = Date.now();
  const state: MobileCompanionState = {
    accessToken: signedIn.accessToken,
    accessTokenExpiresAt: observedAt + signedIn.expiresInSeconds * 1_000,
    account: signedIn.account,
    desktop: {
      credential: desktop.credential,
      credentialExpiresAt: observedAt + desktop.expiresInSeconds * 1_000,
      id: desktop.deviceId,
      key,
      platform,
    },
    pairedMobileDevices:
      previous?.account.id === signedIn.account.id && previous.desktop.id === desktop.deviceId
        ? previous.pairedMobileDevices
        : [],
    schemaVersion: 1,
  };
  saveMobileState(state);
  write(`已登录 ${state.account.displayName}，Desktop 设备已注册。\n`);
}

async function pair(options: MobileCommandOptions): Promise<void> {
  const state = loadMobileState();
  if (!state || state.accessTokenExpiresAt <= Date.now() + 5_000) {
    throw new Error("请先运行 `hara mobile login`，再开始配对");
  }
  const account = new MobileAccountClient(ACCOUNT_ORIGIN);
  const created = await account.createChallenge(state.accessToken, state.desktop.id);
  write("\n在 Hara Mobile 的配对页输入下面的一次性配对码：\n\n");
  write(`  ${created.pairingCode}\n\n`);
  write("正在等待手机申请配对…\n");
  let challenge = created.challenge;
  while (challenge.state === "pending" && challenge.expiresAt > Date.now()) {
    await pause(1_000);
    challenge = await account.inspectChallenge(state.accessToken, challenge.id, state.desktop.id);
  }
  if (
    challenge.state !== "claimed"
    || !challenge.mobileLabel
    || !challenge.mobilePlatform
    || !challenge.mobilePublicKeySpki
    || !challenge.mobilePublicKeyThumbprint
  ) {
    throw new Error("配对请求已失效，请重新运行 `hara mobile pair`");
  }
  const approved = await confirm(
    `允许 ${challenge.mobileLabel} (${challenge.mobilePlatform}) 访问当前明确发布的会话和终端`,
    options.yes === true,
  );
  const decided = await account.decideChallenge(
    state.accessToken,
    challenge.id,
    state.desktop.id,
    approved,
  );
  if (!approved || decided.state !== "approved" || !decided.pairedDeviceId) {
    write("已拒绝这次配对。\n");
    return;
  }
  if (
    decided.mobilePublicKeySpki !== challenge.mobilePublicKeySpki
    || decided.mobilePublicKeyThumbprint !== challenge.mobilePublicKeyThumbprint
  ) {
    throw new Error("配对期间手机设备身份发生变化，请重新配对");
  }
  const pairedMobileDevices = [
    ...state.pairedMobileDevices.filter((device) => device.id !== decided.pairedDeviceId),
    {
      id: decided.pairedDeviceId,
      publicKeySpki: decided.mobilePublicKeySpki,
      publicKeyThumbprint: decided.mobilePublicKeyThumbprint,
    },
  ].slice(-20);
  saveMobileState({ ...state, pairedMobileDevices });
  write("配对已批准。手机完成确认后，可运行 `hara mobile connect`。\n");
}

async function refreshedState(state: MobileCompanionState): Promise<MobileCompanionState> {
  if (state.desktop.credentialExpiresAt > Date.now() + 60_000) return state;
  if (state.accessTokenExpiresAt <= Date.now() + 60_000) {
    throw new Error("Desktop 云凭证已过期，请重新运行 `hara mobile login`");
  }
  const account = new MobileAccountClient(ACCOUNT_ORIGIN);
  const desktop = await account.registerDesktop({
    accessToken: state.accessToken,
    accountId: state.account.id,
    accountRegion: state.account.region,
    key: state.desktop.key,
    platform: state.desktop.platform,
  });
  const next: MobileCompanionState = {
    ...state,
    desktop: {
      ...state.desktop,
      credential: desktop.credential,
      credentialExpiresAt: Date.now() + desktop.expiresInSeconds * 1_000,
      id: desktop.deviceId,
    },
  };
  saveMobileState(next);
  return next;
}

async function connect(): Promise<void> {
  const stored = loadMobileState();
  if (!stored) throw new Error("请先运行 `hara mobile login`");
  if (stored.pairedMobileDevices.length === 0) throw new Error("请先运行 `hara mobile pair`");
  const state = await refreshedState(stored);
  const local = await LocalServeClient.connect();
  const router = new MobileCompanionRouter(
    local,
    state.desktop.id,
    state.desktop.credentialExpiresAt,
  );
  const bridge = new MobileRelayBridge(RELAY_URL, state, router);
  const stop = async (): Promise<void> => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await bridge.close().catch(() => undefined);
    await local.close().catch(() => undefined);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await bridge.start();
    write("手机桥接已上线；已配对手机可读取明确发布的 Personal 会话，并按权限申请控制。\n");
    write("保持此进程和 `hara serve` 运行；按 Ctrl+C 停止发布。\n");
    await bridge.waitUntilClosed();
  } finally {
    await stop();
  }
}

function status(): void {
  const state = loadMobileState();
  if (!state) {
    write("Hara Mobile Desktop：未登录。\n");
    return;
  }
  const access = state.accessTokenExpiresAt > Date.now() ? "有效" : "已过期";
  const device = state.desktop.credentialExpiresAt > Date.now() ? "有效" : "已过期";
  write(`Hara Mobile Desktop：${state.account.displayName}\n`);
  write(`账号会话：${access} · 设备凭证：${device} · 已配对手机：${state.pairedMobileDevices.length}\n`);
}

export async function runMobileCommand(
  rawAction: string | undefined,
  options: MobileCommandOptions,
): Promise<void> {
  const action = rawAction ?? "status";
  switch (action) {
    case "login":
      await login(options);
      return;
    case "pair":
      await pair(options);
      return;
    case "connect":
      await connect();
      return;
    case "status":
      status();
      return;
    case "logout":
      clearMobileState();
      write("Hara Mobile Desktop 本地登录和配对状态已清除。\n");
      return;
    default:
      throw new Error("mobile action must be login, pair, connect, status, or logout");
  }
}
