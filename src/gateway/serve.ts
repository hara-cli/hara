// `hara gateway` — an opt-in long-running daemon that lets you drive your LOCAL hara from a chat app
// (Telegram now; WeChat-iLink / Feishu via the same ChatAdapter next). Each inbound message → a fresh `hara`
// subprocess (the cron pattern) on that chat's session → the reply is sent back. This is hara's first
// persistent process; it is never required by the core CLI.
import { spawn } from "node:child_process";
import { telegramAdapter, type ChatAdapter, type InboundMsg } from "./telegram.js";
import { chatSessionId, newChatSession, setChatSession } from "./sessions.js";
import { selfArgv } from "../cron/runner.js";
import { listSessions, resolveSessionId } from "../session/store.js";

/** Parse a leading slash-command from a chat message (pure). null if it isn't one. */
export function parseCommand(text: string): { cmd: string; arg: string } | null {
  const m = /^\/([a-z]+)\b\s*([\s\S]*)$/i.exec(text.trim());
  return m ? { cmd: m[1].toLowerCase(), arg: m[2].trim() } : null;
}

/** Whether a user may drive the gateway. Empty allowlist = nobody (safe default — never wide-open). */
export function isAllowed(userId: number | string, allowlist: Set<string>): boolean {
  return allowlist.size > 0 && allowlist.has(String(userId));
}

/** Strip hara's CLI chrome from captured `-p` output so a chat reply is just the answer: MCP status lines
 *  (`mcp: …`) and the token-usage footer (`… · ↑N ↓N tok`). Colors are off when piped, so no ANSI to strip. */
export function cleanReply(raw: string): string {
  return raw
    .split("\n")
    .filter((ln) => !/^\s*mcp: /.test(ln) && !/·\s*↑\d+\s*↓\d+\s*tok\s*$/.test(ln))
    .join("\n")
    .trim();
}

/** Run hara headlessly on a chat's session, returning its cleaned output (tail-capped — replies are short). */
function runHara(text: string, sessionId: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const self = selfArgv();
    const child = spawn(self[0], [...self.slice(1), "-p", text, "--approval", "full-auto", "--resume", sessionId], { cwd, env: process.env });
    let out = "";
    const cap = (d: Buffer): void => {
      out = (out + d.toString()).slice(-12000);
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    child.on("error", (e) => resolve(`(error: ${e.message})`));
    child.on("close", () => resolve(cleanReply(out) || "(no output)"));
  });
}

/** Re-exported so `hara gateway --platform weixin --login` can run the QR flow. */
export { weixinLogin } from "./weixin.js";

async function buildAdapter(platform: string): Promise<{ adapter: ChatAdapter; ownerId?: string } | null> {
  if (platform === "weixin") {
    const { loadWeixinCreds, weixinAdapter } = await import("./weixin.js");
    const creds = loadWeixinCreds();
    if (!creds) {
      console.error("hara gateway: no WeChat login found. Run `hara gateway --platform weixin --login` first.");
      return null;
    }
    // The iLink user_id is whoever scanned the QR — the bot owner. Auto-allow them so there's no wxid dance.
    return { adapter: weixinAdapter(creds), ownerId: creds.user_id || undefined };
  }
  const token = process.env.HARA_TELEGRAM_TOKEN;
  if (!token) {
    console.error("hara gateway: set HARA_TELEGRAM_TOKEN (from @BotFather) and HARA_GATEWAY_ALLOWED=<your telegram user id>.");
    return null;
  }
  return { adapter: telegramAdapter(token) };
}

/** Allowlist = the env ids ∪ the bot owner (on WeChat, whoever scanned the QR is always allowed). */
export function resolveAllowlist(envValue: string | undefined, ownerId?: string): Set<string> {
  const set = new Set((envValue ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  if (ownerId) set.add(ownerId);
  return set;
}

export async function runGateway(opts: { cwd: string; platform?: string }): Promise<void> {
  const platform = opts.platform || "telegram";
  const built = await buildAdapter(platform);
  if (!built) process.exit(1);
  const { adapter, ownerId } = built;
  const allowlist = resolveAllowlist(process.env.HARA_GATEWAY_ALLOWED, ownerId);
  if (allowlist.size === 0) {
    const hint = platform === "weixin" ? "your WeChat id" : "your Telegram user id (DM @userinfobot)";
    console.error(`hara gateway: ⚠ HARA_GATEWAY_ALLOWED is empty — nobody is allowed. Set it to ${hint}.`);
  } else if (ownerId) {
    console.error(`hara gateway: bot owner auto-allowed (${ownerId}).`);
  }
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  process.on("SIGTERM", () => ac.abort());
  console.error(`hara gateway: ${adapter.name} up · cwd=${opts.cwd} · ${allowlist.size} allowed user(s) · Ctrl-C to stop`);

  await adapter.start(async (m: InboundMsg) => {
    if (!isAllowed(m.userId, allowlist)) {
      console.error(`hara gateway: ✗ message from ${m.userId} — not in allowlist. Add it to HARA_GATEWAY_ALLOWED to authorize.`);
      await adapter.send(m.chatId, "⛔ not authorized.");
      return;
    }
    const cmd = parseCommand(m.text);
    if (cmd) {
      if (cmd.cmd === "help") return adapter.send(m.chatId, "commands: /new (fresh session) · /sessions · /resume <id> · /help — anything else runs hara on this chat's session.");
      if (cmd.cmd === "new") return adapter.send(m.chatId, `✨ new session: ${newChatSession(adapter.name, m.chatId)}`);
      if (cmd.cmd === "sessions") {
        const list = listSessions(opts.cwd).slice(0, 10).map((x) => `${x.id.slice(0, 14)}  ${x.title || "(untitled)"}`).join("\n");
        return adapter.send(m.chatId, list || "(no sessions yet)");
      }
      if (cmd.cmd === "resume") {
        const id = resolveSessionId(cmd.arg);
        if (!id) return adapter.send(m.chatId, `no session '${cmd.arg}'`);
        setChatSession(adapter.name, m.chatId, id);
        return adapter.send(m.chatId, `↩ now chatting on ${id.slice(0, 14)}`);
      }
      // any other slash word → treat as a normal task
    }
    const sessionId = chatSessionId(adapter.name, m.chatId);
    await adapter.send(m.chatId, "⟳ working…");
    await adapter.send(m.chatId, await runHara(m.text, sessionId, opts.cwd));
  }, ac.signal);
}
