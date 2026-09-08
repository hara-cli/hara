// Explicit Feishu-group → WeChat-DM subscriptions and stable group aliases for cross-channel sends.
// The registry is owner-only private state. A known WeChat peer is never treated as consent: every person
// joins from their own authorized DM, and a source group must first be enabled by the gateway owner.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "../security/private-state.js";

const STORE_FILE = "channel-bridges.json";
const STORE_BYTES = 512 * 1024;
const MAX_BRIDGES = 64;
const MAX_SUBSCRIBERS = 256;
const MAX_NAME_CHARS = 48;
const MAX_PEER_CHARS = 512;

interface StoredSubscriber {
  platform: "weixin";
  peerId: string;
  addedAt: number;
  label?: string;
}

interface StoredChannelBridge {
  id: string;
  name: string;
  source: { platform: "feishu"; chatId: string };
  subscribers: StoredSubscriber[];
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
}

interface StoredChannelBridges {
  version: 1;
  bridges: StoredChannelBridge[];
}

export interface ChannelBridgeSummary {
  name: string;
  sourcePlatform: "feishu";
  subscribers: number;
  enabled: boolean;
  subscribed?: boolean;
}

export interface ChannelBridgeCommandContext {
  platform: string;
  chatType?: "p2p" | "group";
  chatId: string | number;
  userId: string | number;
  userName?: string;
  isOwner: boolean;
  home?: string;
}

function binding(home: string) {
  return bindPrivateHaraStateFile(home, ["gateway"], STORE_FILE);
}

function normalizeName(value: string): string {
  const name = value.trim().replace(/\s+/gu, " ");
  if (
    !name
    || name.length > MAX_NAME_CHARS
    || /[\u0000-\u001f\u007f/:]/u.test(name)
  ) throw new Error(`桥接名称需为 1-${MAX_NAME_CHARS} 个字符，且不能包含 / 或 :`);
  return name;
}

function normalizePeer(value: string | number, label: string): string {
  const peer = String(value).trim();
  if (!peer || peer.length > MAX_PEER_CHARS || /[\u0000-\u001f\u007f]/u.test(peer)) {
    throw new Error(`invalid ${label}`);
  }
  return peer;
}

function normalizeLabel(value: string | undefined, peerId: string): string | undefined {
  const label = value?.trim().replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ");
  return label && label !== peerId ? label.slice(0, 80) : undefined;
}

function bridgeId(chatId: string): string {
  return createHash("sha256").update("hara-channel-bridge-v1\0feishu\0").update(chatId).digest("hex");
}

function parseStore(text: string, path: string): StoredChannelBridges {
  if (Buffer.byteLength(text, "utf8") > STORE_BYTES) throw new Error(`channel bridge registry is too large: ${path}`);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`invalid channel bridge registry: ${path}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid channel bridge registry: ${path}`);
  const store = value as Partial<StoredChannelBridges>;
  if (store.version !== 1 || !Array.isArray(store.bridges) || store.bridges.length > MAX_BRIDGES) {
    throw new Error(`invalid channel bridge registry: ${path}`);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  let subscriberCount = 0;
  const bridges = store.bridges.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`invalid channel bridge registry: ${path}`);
    const entry = raw as Partial<StoredChannelBridge>;
    if (
      typeof entry.id !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.id)
      || ids.has(entry.id)
      || typeof entry.name !== "string"
      || normalizeName(entry.name) !== entry.name
      || names.has(entry.name.toLocaleLowerCase())
      || !entry.source
      || entry.source.platform !== "feishu"
      || typeof entry.source.chatId !== "string"
      || normalizePeer(entry.source.chatId, "bridge source") !== entry.source.chatId
      || bridgeId(entry.source.chatId) !== entry.id
      || !Array.isArray(entry.subscribers)
      || typeof entry.enabled !== "boolean"
      || !Number.isFinite(entry.createdAt)
      || (entry.createdAt as number) <= 0
      || !Number.isFinite(entry.updatedAt)
      || (entry.updatedAt as number) < (entry.createdAt as number)
    ) throw new Error(`invalid channel bridge registry: ${path}`);
    const peerIds = new Set<string>();
    const subscribers = entry.subscribers.map((rawSubscriber) => {
      if (!rawSubscriber || typeof rawSubscriber !== "object" || Array.isArray(rawSubscriber)) {
        throw new Error(`invalid channel bridge registry: ${path}`);
      }
      const subscriber = rawSubscriber as Partial<StoredSubscriber>;
      if (
        subscriber.platform !== "weixin"
        || typeof subscriber.peerId !== "string"
        || normalizePeer(subscriber.peerId, "bridge subscriber") !== subscriber.peerId
        || peerIds.has(subscriber.peerId)
        || !Number.isFinite(subscriber.addedAt)
        || (subscriber.addedAt as number) <= 0
        || (subscriber.label !== undefined && (
          typeof subscriber.label !== "string"
          || normalizeLabel(subscriber.label, subscriber.peerId) !== subscriber.label
        ))
      ) throw new Error(`invalid channel bridge registry: ${path}`);
      peerIds.add(subscriber.peerId);
      subscriberCount += 1;
      return subscriber as StoredSubscriber;
    });
    ids.add(entry.id);
    names.add(entry.name.toLocaleLowerCase());
    return { ...entry, subscribers } as StoredChannelBridge;
  });
  if (subscriberCount > MAX_SUBSCRIBERS) throw new Error(`invalid channel bridge registry: ${path}`);
  return { version: 1, bridges };
}

function readStore(home: string): { store: StoredChannelBridges; text: string | null } {
  const target = binding(home);
  const snapshot = readPrivateStateFileSnapshotSync(target.path, STORE_BYTES);
  if (!snapshot) return { store: { version: 1, bridges: [] }, text: null };
  return { store: parseStore(snapshot.text, target.path), text: snapshot.text };
}

function writeStore(home: string, store: StoredChannelBridges, expected: string | null): void {
  const text = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > STORE_BYTES) throw new Error("channel bridge registry exceeds its private-state limit");
  writePrivateStateFileSync(binding(home), text, expected === null
    ? { expectedMissing: true }
    : { expectedText: expected });
}

function withStore<T>(home: string, mutate: (store: StoredChannelBridges) => { value: T; changed: boolean }): T {
  return withPrivateStateLockSync(home, ["gateway"], "channel-bridges", () => {
    const current = readStore(home);
    const result = mutate(current.store);
    if (result.changed) writeStore(home, current.store, current.text);
    return result.value;
  }, { busyMessage: "channel bridge registry is busy; retry shortly" });
}

function readStoreSafely(home: string): StoredChannelBridges {
  return withPrivateStateLockSync(
    home,
    ["gateway"],
    "channel-bridges",
    () => readStore(home).store,
    { busyMessage: "channel bridge registry is busy; retry shortly" },
  );
}

function findBridge(store: StoredChannelBridges, nameValue: string): StoredChannelBridge | undefined {
  const name = normalizeName(nameValue).toLocaleLowerCase();
  return store.bridges.find((entry) => entry.name.toLocaleLowerCase() === name);
}

export function listChannelBridges(home = homedir(), weixinPeer?: string | number): ChannelBridgeSummary[] {
  const peer = weixinPeer === undefined ? undefined : normalizePeer(weixinPeer, "WeChat peer");
  return readStoreSafely(home).bridges
    .map((entry) => ({
      name: entry.name,
      sourcePlatform: entry.source.platform,
      subscribers: entry.subscribers.length,
      enabled: entry.enabled,
      ...(peer === undefined ? {} : { subscribed: entry.subscribers.some((subscriber) => subscriber.peerId === peer) }),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function createFeishuChannelBridge(
  nameValue: string,
  chatIdValue: string | number,
  home = homedir(),
  now = Date.now(),
): { created: boolean; name: string } {
  const name = normalizeName(nameValue);
  const chatId = normalizePeer(chatIdValue, "Feishu chat id");
  return withStore<{ created: boolean; name: string }>(home, (store) => {
    const existingSource = store.bridges.find((entry) => entry.source.chatId === chatId);
    if (existingSource) {
      if (existingSource.name.toLocaleLowerCase() !== name.toLocaleLowerCase()) {
        throw new Error(`这个飞书群已启用为“${existingSource.name}”`);
      }
      return { value: { created: false, name: existingSource.name }, changed: false };
    }
    if (findBridge(store, name)) throw new Error(`桥接名称“${name}”已被其他飞书群使用`);
    if (store.bridges.length >= MAX_BRIDGES) throw new Error(`最多只能建立 ${MAX_BRIDGES} 个渠道桥接`);
    store.bridges.push({
      id: bridgeId(chatId),
      name,
      source: { platform: "feishu", chatId },
      subscribers: [],
      createdAt: now,
      updatedAt: now,
      enabled: true,
    });
    return { value: { created: true, name }, changed: true };
  });
}

export function removeChannelBridge(nameValue: string, home = homedir()): boolean {
  return withStore(home, (store) => {
    const bridge = findBridge(store, nameValue);
    if (!bridge) return { value: false, changed: false };
    store.bridges = store.bridges.filter((entry) => entry.id !== bridge.id);
    return { value: true, changed: true };
  });
}

export function subscribeWeixinChannelBridge(
  nameValue: string,
  peerValue: string | number,
  labelValue?: string,
  home = homedir(),
  now = Date.now(),
): boolean {
  const peerId = normalizePeer(peerValue, "WeChat peer");
  const label = normalizeLabel(labelValue, peerId);
  return withStore(home, (store) => {
    const bridge = findBridge(store, nameValue);
    if (!bridge || !bridge.enabled) throw new Error(`找不到已启用的桥接“${normalizeName(nameValue)}”`);
    if (bridge.subscribers.some((subscriber) => subscriber.peerId === peerId)) {
      return { value: false, changed: false };
    }
    const total = store.bridges.reduce((sum, entry) => sum + entry.subscribers.length, 0);
    if (total >= MAX_SUBSCRIBERS) throw new Error(`渠道桥接最多只能保存 ${MAX_SUBSCRIBERS} 个订阅`);
    bridge.subscribers.push({ platform: "weixin", peerId, addedAt: now, ...(label ? { label } : {}) });
    bridge.updatedAt = now;
    return { value: true, changed: true };
  });
}

export function unsubscribeWeixinChannelBridge(
  nameValue: string,
  peerValue: string | number,
  home = homedir(),
  now = Date.now(),
): boolean {
  const peerId = normalizePeer(peerValue, "WeChat peer");
  return withStore(home, (store) => {
    const bridge = findBridge(store, nameValue);
    if (!bridge) throw new Error(`找不到桥接“${normalizeName(nameValue)}”`);
    const before = bridge.subscribers.length;
    bridge.subscribers = bridge.subscribers.filter((subscriber) => subscriber.peerId !== peerId);
    if (bridge.subscribers.length === before) return { value: false, changed: false };
    bridge.updatedAt = now;
    return { value: true, changed: true };
  });
}

export function resolveChannelBridgeTarget(nameValue: string, home = homedir()): string | null {
  const bridge = findBridge(readStoreSafely(home), nameValue);
  return bridge?.enabled ? `feishu:${bridge.source.chatId}` : null;
}

export function channelBridgeWeixinTargets(
  sourcePlatform: string,
  sourceChatId: string | number,
  home = homedir(),
): string[] {
  if (sourcePlatform.trim().toLowerCase() !== "feishu") return [];
  const chatId = normalizePeer(sourceChatId, "Feishu chat id");
  const bridge = readStoreSafely(home).bridges.find((entry) => entry.enabled && entry.source.chatId === chatId);
  return bridge ? bridge.subscribers.map((subscriber) => `weixin:${subscriber.peerId}`) : [];
}

export function channelBridgeNameForSource(
  sourcePlatform: string,
  sourceChatId: string | number,
  home = homedir(),
): string | null {
  if (sourcePlatform.trim().toLowerCase() !== "feishu") return null;
  const chatId = normalizePeer(sourceChatId, "Feishu chat id");
  return readStoreSafely(home).bridges.find((entry) => entry.enabled && entry.source.chatId === chatId)?.name ?? null;
}

function commandHelp(platform: string): string {
  if (platform === "feishu") {
    return [
      "飞书群桥接：",
      "/bridge on <名称> — 在当前群启用（仅所有者）",
      "/bridge list — 查看桥接（不显示成员身份）",
      "/bridge remove <名称> confirm — 停用并删除（仅所有者）",
      "同事随后在各自的 Hara 微信私聊发送 /bridge join <名称>。",
    ].join("\n");
  }
  return [
    "微信桥接订阅：",
    "/bridge list — 查看可订阅的飞书群",
    "/bridge join <名称> [--as 姓名] — 订阅到当前微信并可关联同事姓名",
    "/bridge leave <名称> — 取消当前微信的订阅",
  ].join("\n");
}

function summariesForCommand(home: string, peer?: string | number): string {
  const rows = listChannelBridges(home, peer).map((bridge) => {
    const own = bridge.subscribed === undefined ? "" : bridge.subscribed ? " · 已订阅" : " · 未订阅";
    return `${bridge.enabled ? "●" : "○"} ${bridge.name} · 飞书 · ${bridge.subscribers} 位微信订阅者${own}`;
  });
  return rows.join("\n") || "（尚未建立飞书群桥接）";
}

/** Handle only an explicit `/bridge …` command. It never exposes chat ids or subscriber peer ids. */
export function handleChannelBridgeCommand(argument: string, context: ChannelBridgeCommandContext): string {
  const platform = context.platform.trim().toLowerCase();
  const home = context.home ?? homedir();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(argument.trim());
  const action = match?.[1]?.toLowerCase() ?? "help";
  const arg = match?.[2]?.trim() ?? "";
  try {
    if (action === "help") return commandHelp(platform);
    if (action === "list" || action === "status") {
      const peer = platform === "weixin" && context.chatType === "p2p" ? context.userId : undefined;
      return `${summariesForCommand(home, peer)}\n\n${commandHelp(platform)}`;
    }
    if (platform === "feishu" && context.chatType === "group") {
      if (action === "on" || action === "create") {
        if (!context.isOwner) return "⛔ 只有已配置的 Hara 网关所有者可以启用飞书群桥接。";
        if (!arg) return "用法：/bridge on <名称>";
        const result = createFeishuChannelBridge(arg, context.chatId, home);
        return result.created
          ? `✓ 已将当前飞书群启用为“${result.name}”。同事可在各自的 Hara 微信私聊发送：\n/bridge join ${result.name}`
          : `✓ 当前飞书群已启用为“${result.name}”。`;
      }
      if (action === "remove" || action === "off") {
        if (!context.isOwner) return "⛔ 只有已配置的 Hara 网关所有者可以删除飞书群桥接。";
        const removeMatch = /^([\s\S]+?)\s+confirm$/iu.exec(arg);
        if (!removeMatch) return "删除会同时取消所有微信订阅。请确认：/bridge remove <名称> confirm";
        return removeChannelBridge(removeMatch[1], home) ? "✓ 已删除桥接及其微信订阅。" : "✗ 找不到该桥接。";
      }
      return commandHelp(platform);
    }
    if (platform === "weixin" && context.chatType === "p2p") {
      if (action === "join" || action === "subscribe") {
        if (!arg) return "用法：/bridge join <名称>";
        const subscription = /^([\s\S]*?)(?:\s+--as\s+([^\r\n]+))?$/iu.exec(arg);
        const bridgeName = subscription?.[1]?.trim() ?? "";
        const colleagueName = subscription?.[2]?.trim() || context.userName;
        if (!bridgeName) return "用法：/bridge join <名称> [--as 姓名]";
        const added = subscribeWeixinChannelBridge(bridgeName, context.userId, colleagueName, home);
        return added ? `✓ 当前微信已订阅“${normalizeName(bridgeName)}”。` : `✓ 当前微信已经订阅“${normalizeName(bridgeName)}”。`;
      }
      if (action === "leave" || action === "unsubscribe") {
        if (!arg) return "用法：/bridge leave <名称>";
        const removed = unsubscribeWeixinChannelBridge(arg, context.userId, home);
        return removed ? `✓ 当前微信已取消订阅“${normalizeName(arg)}”。` : `当前微信没有订阅“${normalizeName(arg)}”。`;
      }
      return commandHelp(platform);
    }
    return "渠道桥接目前支持：在飞书群启用来源，并在 Hara 微信私聊订阅。";
  } catch (error) {
    return `✗ ${error instanceof Error ? error.message : String(error)}`;
  }
}
