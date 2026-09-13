import { createInterface } from "node:readline/promises";

import {
  MobileAccountClient,
  type VerificationChannel,
} from "./account-client.js";
import { LocalServeClient } from "./local-serve-client.js";
import { MobileDesktopAuthorizationCoordinator } from "./desktop-authorization.js";
import { MobilePairingCoordinator } from "./pairing.js";
import { MobileRelayBridge } from "./relay-bridge.js";
import { MobileCompanionRouter } from "./router.js";
import { generateDeviceKey } from "./security.js";
import {
  clearMobileState,
  configureMobileSessionPublication,
  loadMobileState,
  mobilePublicationEntries,
  mobileSessionPublications,
  saveMobileState,
  setMobileSessionPublication,
  type MobilePublicationCapabilities,
  type MobileCompanionState,
} from "./state.js";

const ACCOUNT_ORIGIN = "https://api.hara.nanhara.tech";
const RELAY_URL = "wss://relay.hara.nanhara.tech/v1/connect";

export type MobileCommandOptions = Readonly<{
  approve?: boolean;
  code?: string;
  email?: string;
  phone?: string;
  send?: boolean;
  session?: string;
  terminalControl?: boolean;
  terminalView?: boolean;
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
  if (options.phone?.trim() && options.email?.trim()) {
    throw new Error("--phone 与 --email 只能选择一个");
  }
  const enteredIdentifier = options.phone?.trim()
    || options.email?.trim()
    || await prompt("Hara 登录手机号或邮箱");
  const channel: VerificationChannel = options.email?.trim()
    || (!options.phone?.trim() && enteredIdentifier.includes("@"))
    ? "email"
    : "phone";
  await account.sendCode(channel, enteredIdentifier);
  write(channel === "phone" ? "短信验证码已发送。\n" : "邮箱验证码已发送。\n");
  const code = options.code?.trim() || await prompt("验证码", true);
  const platform = desktopPlatform();
  const signedIn = await account.loginWithCode(
    channel,
    enteredIdentifier,
    code,
    platform,
  );
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
    refreshToken: signedIn.refreshToken,
    refreshTokenExpiresAt:
      observedAt + signedIn.refreshExpiresInSeconds * 1_000,
    ...(previous?.account.id === signedIn.account.id
      && previous.desktop.id === desktop.deviceId
      && previous.commandReceipts
      ? { commandReceipts: previous.commandReceipts }
      : {}),
    ...(previous?.account.id === signedIn.account.id
      && previous.desktop.id === desktop.deviceId
      && previous.relayCursor
      ? { relayCursor: previous.relayCursor }
      : {}),
    publishedSessions:
      previous?.account.id === signedIn.account.id
        && previous.desktop.id === desktop.deviceId
        ? mobilePublicationEntries(previous)
        : [],
    schemaVersion: 1,
  };
  saveMobileState(state);
  write(`已登录 ${state.account.displayName}，Desktop 设备已注册。\n`);
}

async function pair(options: MobileCommandOptions): Promise<void> {
  if (!loadMobileState()) {
    throw new Error("请先运行 `hara mobile login`，再开始配对");
  }
  const pairing = new MobilePairingCoordinator();
  const created = await pairing.create();
  write("\n在 Hara Mobile 扫描 Desktop 显示的二维码，或手动输入一次性配对码：\n\n");
  write(`  ${created.pairingCode}\n\n`);
  write(`  ${created.qrPayload}\n\n`);
  write("正在等待手机申请配对…\n");
  let challenge = await pairing.inspect(created.challengeId);
  while (challenge.state === "pending" && challenge.expiresAt > Date.now()) {
    await pause(1_000);
    challenge = await pairing.inspect(created.challengeId);
  }
  if (
    challenge.state !== "claimed"
    || !challenge.mobile
  ) {
    throw new Error("配对请求已失效，请重新运行 `hara mobile pair`");
  }
  const approved = await confirm(
    `允许 ${challenge.mobile.label} (${challenge.mobile.platform}) 访问当前明确发布的会话和终端`,
    options.yes === true,
  );
  const decided = await pairing.decide(created.challengeId, approved);
  if (
    !approved
    || (decided.state !== "approved" && decided.state !== "consumed")
    || !decided.pairedDeviceId
  ) {
    write("已拒绝这次配对。\n");
    return;
  }
  write("配对已批准。手机完成确认后，可运行 `hara mobile connect`。\n");
}

async function authorizeDesktop(): Promise<void> {
  if (loadMobileState()) {
    write("Hara Desktop 已登录；无需再次由手机授权。\n");
    return;
  }
  const authorization = new MobileDesktopAuthorizationCoordinator();
  const created = await authorization.create();
  write("\n请使用已登录同一 Hara 账号的手机扫描：\n\n");
  write(`  ${created.authorizationCode}\n\n`);
  write(`  ${created.qrPayload}\n\n`);
  write("手机会先显示这台 Desktop 的名称和密钥尾号；确认后 Desktop 将自动登录并完成配对。\n");
  let current = await authorization.status();
  while (current.state === "pending" && (current.expiresAt ?? 0) > Date.now()) {
    await pause(1_000);
    current = await authorization.status();
  }
  if (!current.signedIn) {
    throw new Error("手机授权已失效，请重新运行 `hara mobile authorize`");
  }
  write(`Desktop 已加入 ${current.account?.displayName ?? "Hara"}，并与批准它的手机完成配对。\n`);
}

async function connect(): Promise<void> {
  const stored = loadMobileState();
  if (!stored) throw new Error("请先运行 `hara mobile login`");
  if (stored.pairedMobileDevices.length === 0) throw new Error("请先运行 `hara mobile pair`");
  const account = new MobileAccountClient(ACCOUNT_ORIGIN);
  const capabilities = await account.capabilities();
  if (!capabilities.sessionRelay) {
    throw new Error("Hara 云会话暂未开放；账号和配对信息已保留，无需重新配对");
  }
  const pairing = new MobilePairingCoordinator();
  const local = await LocalServeClient.connect();
  let currentState = await pairing.currentState();
  let activeBridge: MobileRelayBridge | null = null;
  let stopping = false;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    stopping = true;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await activeBridge?.close().catch(() => undefined);
    await local.close().catch(() => undefined);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    let announced = false;
    while (!stopping) {
      currentState = await pairing.currentState();
      const router = new MobileCompanionRouter(
        local,
        currentState.desktop.id,
        currentState.desktop.credentialExpiresAt,
        {
          commandReceipts: currentState.commandReceipts,
          persistCommandReceipts: (commandReceipts) => {
            const latestState = loadMobileState();
            currentState = {
              ...(latestState ?? currentState),
              commandReceipts,
            };
            saveMobileState(currentState);
          },
          publishedSessions: () => {
            const latestState = loadMobileState();
            return latestState ? mobilePublicationEntries(latestState) : [];
          },
        },
      );
      const bridge = new MobileRelayBridge(
        RELAY_URL,
        currentState,
        router,
        Date.now,
        (relayCursor) => {
          currentState = {
            ...(loadMobileState() ?? currentState),
            relayCursor,
          };
          saveMobileState(currentState);
        },
      );
      activeBridge = bridge;
      await bridge.start();
      if (!announced) {
        announced = true;
        write("手机桥接已上线；已配对手机可读取明确发布的 Personal 会话，并按权限申请控制。\n");
        write("账号和设备凭证会安全轮换；保持 `hara serve` 运行，按 Ctrl+C 停止发布。\n");
      }
      let renewalTimer: ReturnType<typeof setTimeout> | null = null;
      const renewAt = Math.max(
        1_000,
        currentState.desktop.credentialExpiresAt - Date.now() - 60_000,
      );
      const outcome = await Promise.race([
        bridge.waitUntilClosed().then(() => "closed" as const),
        new Promise<"renew">((resolve) => {
          renewalTimer = setTimeout(() => resolve("renew"), renewAt);
        }),
      ]);
      if (renewalTimer) clearTimeout(renewalTimer);
      if (stopping) break;
      if (outcome === "closed") {
        throw new Error("Hara Relay 意外断开，请检查网络后重新运行 `hara mobile connect`");
      }
      await bridge.close();
      activeBridge = null;
    }
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
  write(`手机可访问会话：${mobilePublicationEntries(state).length}\n`);
}

type LocalSessionSummary = Readonly<{
  id: string;
  sourceId: string;
  state: string;
  title: string;
  workspaceName: string;
}>;

const safeLabel = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized.slice(0, 240) || fallback;
};

async function localSessions(): Promise<readonly LocalSessionSummary[]> {
  const local = await LocalServeClient.connect();
  try {
    const result = await local.call<Record<string, unknown>>(
      "external.sessions.list",
      { limit: 100 },
    );
    if (!Array.isArray(result?.sessions)) {
      throw new Error("Hara Serve 没有返回可用会话目录");
    }
    return result.sessions.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const session = value as Record<string, unknown>;
      if (
        typeof session.id !== "string"
        || session.id.length < 1
        || session.id.length > 160
        || /\s/u.test(session.id)
      ) return [];
      return [{
        id: session.id,
        sourceId: safeLabel(session.sourceId, "unknown"),
        state: safeLabel(session.state, "unknown"),
        title: safeLabel(session.title, "Untitled Session"),
        workspaceName: safeLabel(session.workspaceName, "workspace"),
      }];
    });
  } finally {
    await local.close().catch(() => undefined);
  }
}

async function listSessions(): Promise<void> {
  const state = loadMobileState();
  if (!state) throw new Error("请先运行 `hara mobile login`");
  const published = new Map(mobilePublicationEntries(state).map((entry) => [entry.sessionId, entry.capabilities]));
  const sessions = await localSessions();
  if (sessions.length === 0) {
    write("当前没有可开放到手机的 Session。\n");
    return;
  }
  for (const session of sessions) {
    const capabilities = published.get(session.id);
    const access = capabilities
      ? Object.entries(capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(",")
      : "";
    write(`${capabilities ? `[手机可见:${access}]` : "[仅电脑]"} ${session.id}  ${session.sourceId} · ${session.workspaceName} · ${session.title}\n`);
  }
}

function requestedPublicationCapabilities(
  options: MobileCommandOptions,
): MobilePublicationCapabilities {
  const terminalControl = options.terminalControl === true;
  const submit = options.send === true;
  return {
    approve: options.approve === true,
    interrupt: submit,
    read: true,
    submit,
    terminalControl,
    terminalObserve: terminalControl || options.terminalView === true,
  };
}

async function updatePublication(
  options: MobileCommandOptions,
  published: boolean,
): Promise<void> {
  if (!loadMobileState()) throw new Error("请先运行 `hara mobile login`");
  const sessionId = options.session?.trim() || await prompt("Session ID");
  if (published) {
    const sessions = await localSessions();
    if (!sessions.some((session) => session.id === sessionId)) {
      throw new Error("找不到这个本地 Session；先运行 `hara mobile sessions` 查看可用列表");
    }
  }
  const result = published
    ? configureMobileSessionPublication(
        sessionId,
        requestedPublicationCapabilities(options),
      )
    : setMobileSessionPublication(sessionId, false);
  write(published
    ? `已允许手机访问这个 Session；当前共 ${result.sessionIds.length} 个。\n`
    : `已撤销手机访问；当前共 ${result.sessionIds.length} 个。\n`);
}

function listPublications(): void {
  const result = mobileSessionPublications();
  if (result.sessionIds.length === 0) {
    write("当前没有向手机开放任何 Session。\n");
    return;
  }
  for (const publication of result.publications) {
    const access = Object.entries(publication.capabilities)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(",");
    write(`${publication.sessionId}  ${access}\n`);
  }
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
    case "authorize":
      await authorizeDesktop();
      return;
    case "connect":
      await connect();
      return;
    case "status":
      status();
      return;
    case "sessions":
      await listSessions();
      return;
    case "publications":
      listPublications();
      return;
    case "publish":
      await updatePublication(options, true);
      return;
    case "unpublish":
      await updatePublication(options, false);
      return;
    case "logout":
      {
        const state = loadMobileState();
        if (state?.refreshToken) {
          await new MobileAccountClient(ACCOUNT_ORIGIN)
            .logout(state.refreshToken)
            .catch(() => undefined);
        }
      }
      clearMobileState();
      write("Hara Mobile Desktop 本地登录和配对状态已清除。\n");
      return;
    default:
      throw new Error("mobile action must be login, authorize, pair, connect, status, sessions, publications, publish, unpublish, or logout");
  }
}
