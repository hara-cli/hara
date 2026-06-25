// `hara gateway` — an opt-in long-running daemon that lets you drive your LOCAL hara from a chat app
// (Telegram now; WeChat-iLink / Feishu via the same ChatAdapter next). Each inbound message → a fresh `hara`
// subprocess (the cron pattern) on that chat's session → the reply is sent back. This is hara's first
// persistent process; it is never required by the core CLI.
import { spawn } from "node:child_process";
import { telegramAdapter, type ChatAdapter, type InboundMsg } from "./telegram.js";
import { chatContext, chatCd, newChatSession, setChatSession, toggleVoice } from "./sessions.js";
import { pickPaneForReply, capturePane, injectTmux, outputDelta } from "./tmux-routes.js";
import { synthesize } from "./tts.js";
import { selfArgv } from "../cron/runner.js";
import { listSessions, resolveSessionId, loadSession } from "../session/store.js";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";

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

let outboxSeq = 0;
export interface HaraRun {
  reply: string;
  /** absolute paths the agent asked to deliver to the chat via the send_file tool (drained from the outbox) */
  files: string[];
}

/** Run hara headlessly on a chat's session. Returns its cleaned text reply plus any files the agent queued
 *  via send_file. The gateway env (HARA_GATEWAY + a per-message outbox file) is what makes send_file and the
 *  in-chat system context active in the subprocess; the daemon delivers the queued files after it exits. */
function runHara(text: string, sessionId: string, cwd: string, platform: string, images?: string[]): Promise<HaraRun> {
  const outbox = join(tmpdir(), `hara-outbox-${process.pid}-${Date.now()}-${outboxSeq++}.txt`);
  return new Promise((res) => {
    const self = selfArgv();
    const child = spawn(self[0], [...self.slice(1), "-p", text, "--approval", "full-auto", "--resume", sessionId], {
      cwd,
      env: {
        ...process.env,
        HARA_GATEWAY: platform,
        HARA_GATEWAY_OUTBOX: outbox,
        ...(images?.length ? { HARA_GATEWAY_IMAGES: images.join("\n") } : {}),
      },
    });
    let out = "";
    const cap = (d: Buffer): void => {
      out = (out + d.toString()).slice(-12000);
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const finish = (reply: string): void => {
      let files: string[] = [];
      try {
        if (existsSync(outbox)) {
          files = readFileSync(outbox, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
          rmSync(outbox, { force: true });
        }
      } catch {
        /* outbox is best-effort; a missing/unreadable file just means nothing to send */
      }
      res({ reply, files });
    };
    child.on("error", (e) => finish(`(error: ${e.message})`));
    child.on("close", () => finish(cleanReply(out) || "(no output)"));
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
  if (platform === "discord") {
    const token = process.env.HARA_DISCORD_TOKEN;
    if (!token) {
      console.error("hara gateway: set HARA_DISCORD_TOKEN (Discord bot token) and HARA_GATEWAY_ALLOWED=<your discord user id>. Enable the Message Content Intent on the bot.");
      return null;
    }
    const { discordAdapter } = await import("./discord.js");
    return { adapter: discordAdapter(token) };
  }
  if (platform === "feishu" || platform === "lark") {
    const appId = process.env.HARA_FEISHU_APP_ID;
    const appSecret = process.env.HARA_FEISHU_APP_SECRET;
    if (!appId || !appSecret) {
      console.error("hara gateway: set HARA_FEISHU_APP_ID + HARA_FEISHU_APP_SECRET (Feishu app console) and HARA_GATEWAY_ALLOWED=<your open_id>. (HARA_FEISHU_DOMAIN=lark for larksuite.com.)");
      return null;
    }
    const { feishuAdapter } = await import("./feishu.js");
    return { adapter: feishuAdapter(appId, appSecret) };
  }
  if (platform === "slack") {
    const appToken = process.env.HARA_SLACK_APP_TOKEN;
    const botToken = process.env.HARA_SLACK_BOT_TOKEN;
    if (!appToken || !botToken) {
      console.error("hara gateway: set HARA_SLACK_APP_TOKEN (xapp-, Socket Mode app-level token w/ connections:write) + HARA_SLACK_BOT_TOKEN (xoxb-, bot token w/ chat:write,files:write,files:read,*:history) and HARA_GATEWAY_ALLOWED=<your slack user id>.");
      return null;
    }
    const { slackAdapter } = await import("./slack.js");
    return { adapter: slackAdapter(appToken, botToken) };
  }
  if (platform === "mattermost") {
    const url = process.env.HARA_MATTERMOST_URL;
    const token = process.env.HARA_MATTERMOST_TOKEN;
    if (!url || !token) {
      console.error("hara gateway: set HARA_MATTERMOST_URL (e.g. https://mm.example.com) + HARA_MATTERMOST_TOKEN (bot or personal-access token) and HARA_GATEWAY_ALLOWED=<your mattermost user id>.");
      return null;
    }
    const { mattermostAdapter } = await import("./mattermost.js");
    return { adapter: mattermostAdapter(url, token) };
  }
  if (platform === "matrix") {
    const homeserver = process.env.HARA_MATRIX_HOMESERVER;
    const token = process.env.HARA_MATRIX_TOKEN;
    const userId = process.env.HARA_MATRIX_USER_ID;
    if (!homeserver || !token || !userId) {
      console.error("hara gateway: set HARA_MATRIX_HOMESERVER (e.g. https://matrix.org), HARA_MATRIX_TOKEN (access token), HARA_MATRIX_USER_ID (@bot:server) and HARA_GATEWAY_ALLOWED=<@you:server>. Unencrypted rooms only (no E2EE in v1).");
      return null;
    }
    const { matrixAdapter } = await import("./matrix.js");
    return { adapter: matrixAdapter(homeserver, token, userId), ownerId: userId };
  }
  if (platform === "dingtalk" || platform === "ding") {
    const clientId = process.env.HARA_DINGTALK_CLIENT_ID;
    const clientSecret = process.env.HARA_DINGTALK_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.error("hara gateway: set HARA_DINGTALK_CLIENT_ID + HARA_DINGTALK_CLIENT_SECRET (钉钉开放平台 app AppKey/AppSecret, Stream mode enabled on the bot) and HARA_GATEWAY_ALLOWED=<your senderStaffId>.");
      return null;
    }
    const { dingtalkAdapter } = await import("./dingtalk.js");
    return { adapter: dingtalkAdapter(clientId, clientSecret) };
  }
  if (platform === "wecom" || platform === "wework") {
    const botId = process.env.HARA_WECOM_BOT_ID;
    const secret = process.env.HARA_WECOM_SECRET;
    if (!botId || !secret) {
      console.error("hara gateway: set HARA_WECOM_BOT_ID + HARA_WECOM_SECRET (企业微信 admin console → AI Bot credentials) and HARA_GATEWAY_ALLOWED=<your wecom userid>. (HARA_WECOM_WS_URL overrides the gateway URL.)");
      return null;
    }
    const { wecomAdapter } = await import("./wecom.js");
    return { adapter: wecomAdapter(botId, secret, process.env.HARA_WECOM_WS_URL) };
  }
  if (platform === "signal") {
    const rpcUrl = process.env.HARA_SIGNAL_RPC_URL;
    const number = process.env.HARA_SIGNAL_NUMBER;
    if (!rpcUrl || !number) {
      console.error("hara gateway: set HARA_SIGNAL_RPC_URL (e.g. http://localhost:8080) + HARA_SIGNAL_NUMBER (the bot's registered phone, E.164) and HARA_GATEWAY_ALLOWED=<your signal number/uuid>. Requires a local signal-cli daemon: `signal-cli -a <number> daemon --http localhost:8080`.");
      return null;
    }
    const { signalAdapter } = await import("./signal.js");
    return { adapter: signalAdapter(rpcUrl, number), ownerId: number };
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

/** The gateway's default workspace when no --cwd is given: a dedicated safe home under ~/.hara (like Hermes'
 *  ~/.hermes), NOT the launch dir — so a full-auto chat bot never lands on a real repo by accident. */
export function defaultWorkspace(): string {
  const dir = join(homedir(), ".hara", "workspace");
  mkdirSync(dir, { recursive: true });
  const agents = join(dir, "AGENTS.md");
  if (!existsSync(agents)) {
    writeFileSync(
      agents,
      "# hara chat workspace\n\nDefault working directory for `hara gateway` (Telegram/WeChat). Each message runs here with `--approval full-auto`. A safe scratch — pass `--cwd <dir>` to point the gateway at a real project instead.\n",
    );
  }
  return dir;
}

export async function runGateway(opts: { cwd?: string; platform?: string }): Promise<void> {
  const platform = opts.platform || "telegram";
  const cwd = opts.cwd ?? defaultWorkspace(); // dir-free default: hara's own ~/.hara/workspace, like Hermes' ~/.hermes
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
  console.error(`hara gateway: ${adapter.name} up · cwd=${cwd} · ${allowlist.size} allowed user(s) · Ctrl-C to stop`);

  await adapter.start(async (m: InboundMsg) => {
    if (!isAllowed(m.userId, allowlist)) {
      console.error(`hara gateway: ✗ message from ${m.userId} — not in allowlist. Add it to HARA_GATEWAY_ALLOWED to authorize.`);
      await adapter.send(m.chatId, "⛔ not authorized.");
      return;
    }
    // If a tmux session opted in (via `hara remote ask/bind`), this reply is its input → inject it into that
    // pane, let it react, and reply with the session's NEW output (on-inbound relay — quiet + iLink-friendly:
    // one reply per message, no continuous push). Owner-gated by the allowlist check above.
    if (!parseCommand(m.text)) {
      const pane = pickPaneForReply();
      if (pane) {
        console.error(`hara gateway: routed reply → tmux pane ${pane}`);
        const before = capturePane(pane) ?? "";
        injectTmux(pane, m.text);
        await new Promise((r) => setTimeout(r, 3000)); // give the session a moment to react
        const after = capturePane(pane) ?? "";
        const delta = outputDelta(before, after).trim();
        const body = delta ? (delta.length > 1500 ? "…\n" + delta.slice(-1500) : delta) : "(已注入,暂无新输出 — 发 ? 再看)";
        await adapter.send(m.chatId, `🖥 ${pane}\n${body}`);
        return;
      }
    }
    const ctx = chatContext(adapter.name, m.chatId, cwd); // this chat's current { cwd, sessionId }
    const cmd = parseCommand(m.text);
    if (cmd) {
      if (cmd.cmd === "help")
        return adapter.send(
          m.chatId,
          "commands:\n/pwd · /cd <dir> — project\n/sessions · /new · /resume <id> — threads\n/voice · /say <text> — speech · /send <path> — send a file\n/detach — stop injecting replies into bound tmux panes\n/help\nanything else = run hara here",
        );
      if (cmd.cmd === "detach") {
        const { unbindBinds } = await import("./tmux-routes.js");
        const n = unbindBinds();
        return adapter.send(m.chatId, n ? `🔓 detached ${n} bound tmux pane(s) — replies go to hara again.` : "(no tmux panes were bound)");
      }
      if (cmd.cmd === "pwd") return adapter.send(m.chatId, `📂 ${ctx.cwd}\n🧵 ${ctx.sessionId.slice(-18)}`);
      if (cmd.cmd === "cd" || cmd.cmd === "project") {
        if (!cmd.arg) return adapter.send(m.chatId, `📂 ${ctx.cwd}\nusage: /cd <dir> (absolute, ~, or relative to here)`);
        const target = resolve(ctx.cwd, cmd.arg.replace(/^~(?=\/|$)/, homedir()));
        if (!existsSync(target) || !statSync(target).isDirectory()) return adapter.send(m.chatId, `✗ not a directory: ${target}`);
        const sid = chatCd(adapter.name, m.chatId, target);
        return adapter.send(m.chatId, `📂 now in ${target}\n🧵 ${sid.slice(-18)} · /sessions lists this dir's threads`);
      }
      if (cmd.cmd === "new") return adapter.send(m.chatId, `✨ new thread: ${newChatSession(adapter.name, m.chatId, cwd).slice(-18)}`);
      if (cmd.cmd === "sessions") {
        const list = listSessions(ctx.cwd).slice(0, 10).map((x) => `${x.id.slice(-18)}  ${x.title || "(untitled)"}`).join("\n");
        return adapter.send(m.chatId, `📂 ${ctx.cwd}\n${list || "(no threads in this dir yet)"}`);
      }
      if (cmd.cmd === "resume") {
        const id = resolveSessionId(cmd.arg);
        if (!id) return adapter.send(m.chatId, `no session '${cmd.arg}'`);
        const target = loadSession(id)?.meta.cwd || ctx.cwd; // follow the session's own dir so it runs in the right place
        setChatSession(adapter.name, m.chatId, id, target);
        return adapter.send(m.chatId, `↩ resumed ${id.slice(-18)}\n📂 ${target}`);
      }
      if (cmd.cmd === "voice") {
        if (!adapter.sendFile) return adapter.send(m.chatId, "this platform can't send voice yet.");
        const on = toggleVoice(adapter.name, m.chatId);
        return adapter.send(m.chatId, on ? "🔊 voice replies ON — I'll speak each reply too." : "🔇 voice replies OFF.");
      }
      if (cmd.cmd === "say") {
        if (!adapter.sendFile) return adapter.send(m.chatId, "this platform can't send voice yet.");
        if (!cmd.arg) return adapter.send(m.chatId, "usage: /say <text to speak>");
        const audio = await synthesize(cmd.arg);
        if (!audio) return adapter.send(m.chatId, "✗ TTS failed (check HARA_TTS_* config).");
        await adapter.sendFile(m.chatId, audio);
        rmSync(audio, { force: true });
        return;
      }
      if (cmd.cmd === "send") {
        if (!adapter.sendFile) return adapter.send(m.chatId, "this platform can't send files yet.");
        const p = cmd.arg ? resolve(ctx.cwd, cmd.arg.replace(/^~(?=\/|$)/, homedir())) : "";
        if (!p || !existsSync(p) || !statSync(p).isFile()) return adapter.send(m.chatId, `✗ not a file: ${p || "(none)"}\nusage: /send <path> (abs, ~, or relative to current dir)`);
        await adapter.sendFile(m.chatId, p);
        return;
      }
      // any other slash word → treat as a normal task
    }
    await adapter.send(m.chatId, "⟳ working…");
    const { reply, files } = await runHara(m.text, ctx.sessionId, ctx.cwd, adapter.name, m.images);
    const hasReply = reply && reply !== "(no output)";
    if (hasReply) await adapter.send(m.chatId, reply);
    else if (files.length) await adapter.send(m.chatId, "📎");
    // Deliver any files the agent queued via send_file (images inline, others as attachments).
    for (const f of files) {
      if (!adapter.sendFile) {
        await adapter.send(m.chatId, "(this platform can't send files yet)");
        break;
      }
      try {
        await adapter.sendFile(m.chatId, f);
      } catch (e: any) {
        await adapter.send(m.chatId, `✗ couldn't send ${f}: ${e.message}`);
      }
    }
    if (hasReply && ctx.voice && adapter.sendFile) {
      const audio = await synthesize(reply);
      if (audio) {
        await adapter.sendFile(m.chatId, audio);
        rmSync(audio, { force: true });
      }
    }
  }, ac.signal);
}
