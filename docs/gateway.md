# Chat gateway — drive hara from a chat app

`hara gateway` is an opt-in long-running daemon that lets you drive your **local** hara from a chat app
(Telegram, WeChat, Discord, Feishu/Lark, Slack, Mattermost, Matrix, DingTalk). Each inbound message spawns a
headless `hara` run on that chat's own session; the reply is sent back. It is never required by the core CLI.

```bash
hara gateway --platform <name>
```

Because the daemon **connects out** to each platform (long-poll or WebSocket), it needs no public webhook URL —
it runs fine on your laptop behind NAT.

## Platforms at a glance

| Platform | Transport | Extra dep | Two-way images | Notes |
|---|---|---|---|---|
| Telegram | long-poll | none | ✅ in / ✅ out | |
| WeChat (微信) | iLink long-poll | none | ✅ in / ✅ out | QR login |
| Discord | WebSocket gateway | none (Node ≥ 22) | ✅ in / ✅ out | needs Message Content Intent |
| Feishu / Lark | WS long-connection | `@larksuiteoapi/node-sdk` | ✅ in / ✅ out | p2p DMs in v1 |
| Slack | Socket Mode (WS) | none | ✅ in / ✅ out | |
| Mattermost | WebSocket + REST | none | ✅ in / ✅ out | self-host or cloud |
| Matrix | `/sync` long-poll | none | ✅ in / ✅ out | unencrypted rooms only (v1) |
| DingTalk (钉钉) | Stream Mode (WS) | none | ⬜ in / ⬜ out | text only in v1 |
| WeCom (企业微信) | AI-Bot WS gateway | none | ✅ in / ✅ out | connects out; AES media |
| Signal | local signal-cli (JSON-RPC) | none* | ✅ in / ✅ out | *needs the signal-cli daemon |

## Common setup (every platform)

- **`HARA_GATEWAY_ALLOWED`** — comma-separated list of user ids allowed to drive the bot. **Empty = nobody**
  (safe default — the gateway is never wide-open). Each platform's section says which id to use.
- **`--cwd <dir>`** — point the gateway at a real project. Default is a safe scratch workspace at
  `~/.hara/workspace`, so a full-auto chat bot never lands on a real repo by accident.
- Each `(chat × directory)` is a stable, resumable session. In-chat slash commands:
  `/help` · `/pwd` · `/cd <dir>` · `/new` · `/sessions` · `/resume <id>` · `/voice` · `/say <text>` · `/send <path>`.
  Anything else runs hara on that session.
- **Two-way images**: send the bot a photo and it sees it (inline for a vision model, else described via your
  configured `visionModel`); ask it to send a file/image back and it uses the `send_file` tool — both work in
  plain conversation, no slash command needed (on platforms marked ✅ above).

Each run is `--approval full-auto`, so set `--cwd` deliberately.

---

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the token.
2. Find your numeric user id (DM [@userinfobot](https://t.me/userinfobot)).

```bash
HARA_TELEGRAM_TOKEN=123:abc HARA_GATEWAY_ALLOWED=<your-user-id> hara gateway --platform telegram
```

## WeChat (微信)

Uses Tencent's official personal-bot iLink API. First log in by scanning a QR, then run the daemon:

```bash
hara gateway --platform weixin --login     # scan the QR with WeChat; stores creds in ~/.hara/weixin
hara gateway --platform weixin             # run the daemon (the scanner is auto-allowed as owner)
```

DMs only. Voice in is auto-transcribed; voice out via `/voice` / `/say`.

## Discord

1. Create an app + bot at <https://discord.com/developers/applications> → copy the **bot token**.
2. **Enable the privileged "Message Content Intent"** (Bot → Privileged Gateway Intents) — without it, message
   text arrives empty.
3. Invite the bot to your server (or DM it). `HARA_GATEWAY_ALLOWED` = your Discord user id.

```bash
HARA_DISCORD_TOKEN=… HARA_GATEWAY_ALLOWED=<your-user-id> hara gateway --platform discord
```

## Feishu / Lark

Uses the official `@larksuiteoapi/node-sdk` over a WebSocket long-connection (no public webhook needed).

1. Create an app at the [Feishu open platform](https://open.feishu.cn) → copy **App ID** + **App Secret**.
2. Add the **bot** capability; subscribe to the `im.message.receive_v1` event; enable **长连接 (long-connection)**
   event delivery. Grant scopes to read/send messages and read message resources (for image download).
3. `HARA_GATEWAY_ALLOWED` = your `open_id`. For larksuite.com (international), set `HARA_FEISHU_DOMAIN=lark`.

```bash
HARA_FEISHU_APP_ID=cli_… HARA_FEISHU_APP_SECRET=… HARA_GATEWAY_ALLOWED=<your-open_id> \
  hara gateway --platform feishu
```

v1 handles p2p (direct) messages; group support is a fast-follow.

## Slack

Drives hara over **Socket Mode**, so the daemon connects out — no public Request URL needed.

1. Create an app at <https://api.slack.com/apps>.
2. **Enable Socket Mode** and generate an **App-Level token** (`xapp-…`) with the `connections:write` scope.
3. **Bot Token scopes** (OAuth & Permissions): `chat:write`, `files:write`, `files:read`, plus the `*:history`
   scopes for the surfaces you use (`channels:history`, `im:history`, …). Install to the workspace → copy the
   **Bot token** (`xoxb-…`).
4. **Event Subscriptions → bot events**: add `message.channels` and `message.im`.
5. `HARA_GATEWAY_ALLOWED` = your Slack user id (the `Uxxxx` id, not the @handle).

```bash
HARA_SLACK_APP_TOKEN=xapp-… HARA_SLACK_BOT_TOKEN=xoxb-… HARA_GATEWAY_ALLOWED=U0123 \
  hara gateway --platform slack
```

## Mattermost

Works against a self-hosted or cloud Mattermost server (v4 WebSocket + REST).

1. Create a **bot account** (System Console → Integrations → Bot Accounts) or a **personal access token**
   (Account Settings → Security) → copy the token.
2. Add the bot to any channels/DMs you want it to respond in.
3. `HARA_GATEWAY_ALLOWED` = your Mattermost user id (`GET /api/v4/users/me`).

```bash
HARA_MATTERMOST_URL=https://mm.example.com HARA_MATTERMOST_TOKEN=… HARA_GATEWAY_ALLOWED=<user-id> \
  hara gateway --platform mattermost
```

## Matrix

Uses the client-server API with a `/sync` long-poll.

1. Get an **access token** for the bot account (in Element: Settings → Help & About → Access Token; or via the
   `/_matrix/client/v3/login` API).
2. Note the **homeserver** base URL (e.g. `https://matrix.org`) and the bot's **user id** (`@bot:matrix.org`).
3. Invite the bot into an **unencrypted** room. `HARA_GATEWAY_ALLOWED` = your Matrix user id.

```bash
HARA_MATRIX_HOMESERVER=https://matrix.org HARA_MATRIX_TOKEN=syt_… HARA_MATRIX_USER_ID=@bot:matrix.org \
  HARA_GATEWAY_ALLOWED=@you:matrix.org hara gateway --platform matrix
```

**v1 limitation:** end-to-end-encrypted rooms are skipped (E2EE needs libolm + a crypto store, which would break
the zero-dependency design). Use an unencrypted room.

## DingTalk (钉钉)

Uses **Stream Mode**, so the daemon dials out — no public webhook.

1. Create an org-internal app at the [DingTalk open platform](https://open.dingtalk.com) → copy **Client ID
   (AppKey)** + **Client Secret (AppSecret)** from 凭证与基础信息.
2. Add a **bot** capability and set its message-receive mode to **Stream 模式**. Publish (上线) the app.
3. `HARA_GATEWAY_ALLOWED` = your `senderStaffId`.

```bash
HARA_DINGTALK_CLIENT_ID=… HARA_DINGTALK_CLIENT_SECRET=… HARA_GATEWAY_ALLOWED=<your-staff-id> \
  hara gateway --platform dingtalk
```

**v1 limitations:** replies route through the per-message `sessionWebhook` DingTalk includes in each inbound
message, so the bot can only reply after it has received a message in that chat (the window expires after a few
hours of silence). Sending files/voice is not supported, and inbound images arrive as a `[图片]` marker (not
downloaded).

## WeCom (企业微信 / Enterprise WeChat)

Connects out to WeCom's AI-Bot WebSocket gateway — no public webhook, works behind NAT.

1. In the WeCom Admin Console (work.weixin.qq.com) → Applications → create an **AI Bot** → copy its **Bot ID** + **Secret**.
2. `HARA_GATEWAY_ALLOWED` = your WeCom userid.

```bash
HARA_WECOM_BOT_ID=… HARA_WECOM_SECRET=… HARA_GATEWAY_ALLOWED=<your-userid> hara gateway --platform wecom
```

Inbound images (incl. AES-encrypted attachments) are downloaded to `~/.hara/wecom/media`; text/markdown replies are
chunked; outbound images/files supported. (`HARA_WECOM_WS_URL` overrides the gateway URL.)

## Signal

Signal has no official cloud API, so hara talks to a **local [signal-cli](https://github.com/AsamK/signal-cli)
daemon** you run yourself.

1. Install: `brew install signal-cli` (needs a JRE).
2. Register a new number (`signal-cli -a +1555… register` → `verify <code>`) **or** link as a secondary device
   (`signal-cli link -n hara` → scan from Signal → Linked devices).
3. Run the daemon: `signal-cli -a +1555… daemon --http localhost:8080`.
4. `HARA_GATEWAY_ALLOWED` = your Signal number/uuid.

```bash
HARA_SIGNAL_RPC_URL=http://localhost:8080 HARA_SIGNAL_NUMBER=+1555… HARA_GATEWAY_ALLOWED=<your-number> \
  hara gateway --platform signal
```

The signal-cli daemon must stay running alongside the gateway; phone numbers are redacted in logs. Inbound image
attachments are downloaded to `~/.hara/signal/media`.

---

## Running it as a daemon

`hara gateway` runs in the foreground. To keep it alive across sessions, run it under your process manager of
choice (launchd/systemd/pm2) or simply:

```bash
nohup hara gateway --platform <name> > ~/.hara/<name>-gw.log 2>&1 &
```

Stop with `Ctrl-C` (or kill the process); cursors/creds persist under `~/.hara/<platform>/`.
