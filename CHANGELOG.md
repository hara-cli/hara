# Changelog

All notable changes to `@nanhara/hara`.

> Versioning (pre-1.0, SemVer-style): the **minor** (middle) number bumps for a **new feature**; the
> **patch** (last) number bumps for **optimizations/fixes of existing features**.

## 0.88.0 — unreleased (gateway: Feishu/Lark adapter)

- **Feishu/Lark** — `hara gateway --platform feishu` via the official `@larksuiteoapi/node-sdk` (the one new
  dependency): a **WSClient long-connection** for inbound (no public webhook needed — fits the local daemon) and
  the REST Client for outbound. Inbound text / rich-text post / image / file / audio (media downloaded to
  `~/.hara/feishu/media` → the agent SEES images); outbound text + `sendFile` (image upload → image message,
  else file upload → file message) so `send_file` / `/send` work. Creds via `HARA_FEISHU_APP_ID` /
  `HARA_FEISHU_APP_SECRET` (+ `HARA_FEISHU_DOMAIN=lark` for larksuite.com), users via `HARA_GATEWAY_ALLOWED`
  (open_id). v1 = p2p DMs; group support is a fast-follow. `parseFeishuContent` / `flattenPost` are pure + tested.

## 0.87.0 — unreleased (gateway: Discord adapter)

- **Discord** — `hara gateway --platform discord` connects to the Discord gateway over Node's native global
  WebSocket (zero new dep on Node ≥ 22): HELLO→heartbeat→IDENTIFY, dispatches MESSAGE_CREATE, auto-reconnects.
  Inbound text + image attachments (downloaded to `~/.hara/discord/media` → the agent SEES them); outbound text
  (2000-char chunks) and `sendFile` (multipart) so `send_file` / `/send` work. Token via `HARA_DISCORD_TOKEN`,
  users via `HARA_GATEWAY_ALLOWED` (Discord user ids). Needs the bot's privileged Message Content Intent.
  Same `ChatAdapter` seam as Telegram/WeChat — all cross-platform gateway logic worked unchanged.

## 0.86.1 — unreleased (gateway: Telegram reaches image parity with WeChat)

- **Telegram two-way images** — `parseTelegramUpdate` now accepts photo messages (caption or a `[图片]` marker)
  and the receive loop downloads the largest photo to `~/.hara/telegram/media` → `InboundMsg.images`, so the
  agent sees it just like on WeChat. Added `sendFile` (sendPhoto for images, sendDocument otherwise) so `send_file`
  and `/send` work on Telegram too. All the cross-platform gateway plumbing (send_file tool, in-chat system
  context, stuck-guard, `-p` image attach/describe) was already platform-agnostic — only the adapter changed.

## 0.86.0 — unreleased (gateway: the agent SEES inbound images)

- **Inbound image understanding** — a photo you send in chat now reaches the model as a real image, not just a
  `[图片: /path]` text breadcrumb. The WeChat adapter routes downloaded images into `InboundMsg.images`; the
  gateway forwards their paths to the headless run (`HARA_GATEWAY_IMAGES`); the `-p` handler attaches them inline
  for a vision-capable main model, or describes them via the configured `visionModel` sidecar and folds the
  description into the message for a text-only model (e.g. glm-5 main + qwen3.7-plus vision). Together with 0.85's
  `send_file`, the chat is now two-way for images. Verified live: glm-5 correctly described a sent picture via the
  qwen3.7-plus sidecar.

## 0.85.0 — unreleased (gateway: agent sends files in conversation + stuck-guard)

- **`send_file` tool** — the agent can now deliver a file/image to the chat *conversationally* ("生成 X 发我"),
  not just via the manual `/send` command. Self-gates on `HARA_GATEWAY`, so it appears only inside `hara gateway`.
  It queues the path to a per-message outbox file; the daemon drains it after the headless run and delivers each
  file via the platform adapter (`sendMediaFile` — images inline, others as attachments). This closes the gap
  where hara, asked to "send an image", would generate it fine but then try to UI-automate the desktop WeChat
  client with the `computer` tool (wrong surface, and blind without a vision model) and silently deliver nothing.
- **In-chat system context** — when running under the gateway, the agent is told it's in a `${platform}` chat:
  deliver files via `send_file` (the only channel that reaches the peer), do **not** drive the desktop client /
  `computer` tool, and never claim a file was sent unless `send_file` succeeded.
- **Stuck-guard (gateway only)** — once per run, if the agent keeps repeating one non-read tool (≥5×) or acts
  blind (≥2 screenshots it can't read), a one-shot self-check nudge is injected so it steps back and picks a
  working path instead of grinding forever (no human there to hit Esc). Off outside the gateway.

## 0.84.0 — unreleased (gateway: file + image send/receive)

- **Receive** — a file / image / (untranscribed) voice you send is now downloaded + AES-decrypted to a local
  file under `~/.hara/weixin/media/`, and hara is handed a `[图片|文件 name|语音: /path]` reference so it can
  read/process it (images → a vision-capable model). Ported iLink's inbound media path (CDN download →
  AES-128-ECB decrypt) including the image `aeskey` hex-hack, the `encrypt_query_param` vs `encrypted_query_param`
  naming, the conditional PKCS7 strip, the CDN-host SSRF allowlist, and a 128 MiB cap. Media-only messages
  (no text) are now processed too.
- **Send** — `sendMediaFile` sends any local file: images go **inline** (`image_item`), everything else
  (zip / pdf / doc / audio / …) as a **file attachment** (`file_item`) carrying the filename. New `/send <path>`
  command (absolute / `~` / relative to the chat's dir). Voice replies + `/say` now ride the same generic path.
- `ChatAdapter.sendAudio?` → **`sendFile?`** (generic seam). Live-validated end-to-end: ZIP attachment + inline
  image delivered. 265 tests.

## 0.83.0 — unreleased (gateway: voice replies — pluggable TTS, /voice + /say)

- The gateway can now **reply with voice** — a WeChat audio-file attachment (iLink's native voice bubble is
  unreliable). `/voice` toggles spoken replies for a chat (each reply is also sent as audio); `/say <text>`
  speaks one message. Ported iLink's media-upload path (getuploadurl → AES-128-ECB → CDN → `file_item`) into
  `weixin.ts` byte-exact (incl. the dual AES-key encoding: hex in getuploadurl, base64-of-hex in sendmessage)
  + live-validated end-to-end.
- **Pluggable TTS** (`src/gateway/tts.ts`) — config-driven via env, nothing vendor-hardcoded, mirrors the video
  project's provider design; both API and local:
  - `say` (default) — local macOS, ~0.5s, Chinese voices (Tingting…), zero config → m4a.
  - `openai` — any OpenAI-compatible `/audio/speech` endpoint (point `HARA_TTS_BASE_URL` at Aliyun DashScope or
    a local TTS server); reuses the existing `openai` dep, no new dependency.
  - `cmd` — a configurable local command (point `HARA_TTS_CMD` at VoxCPM or any local TTS; text on stdin).
  - Select via `HARA_TTS_PROVIDER` (+ `HARA_TTS_VOICE`/`MODEL`/`BASE_URL`/`API_KEY`/`CMD`); a failed API
    provider falls back to local `say`. New optional `ChatAdapter.sendAudio?` seam (weixin implements it).

## 0.82.2 — unreleased (gateway: fix the voice tag that made hara disclaim)

- 0.82.1's bare `[voice message]` prefix backfired — hara read it as raw audio to process and replied "I can't
  handle voice," even though the message was already transcribed text (verified: the transcription reaches hara
  correctly). Replaced with an explicit note ("…already transcribed to text below — just reply to it normally,
  you don't have or need the audio") so hara answers the content instead of disclaiming.

## 0.82.1 — unreleased (gateway: tag transcribed WeChat voice messages)

- WeChat **voice input already works** — iLink transcribes voice server-side (`voice_item.text`) and the gateway
  reads it. But the text reached hara unlabeled, so when the spoken words referenced "this voice," hara replied
  as if it only got text. Now a transcribed voice message is tagged `[voice message] <text>`, so hara knows the
  input came from voice. (Sending voice back is deferred — iLink's native voice bubble is unreliable per the
  Hermes reference; only audio-file attachments are possible, and that needs the media-upload + TTS path.)

## 0.82.0 — unreleased (gateway: roam projects + threads from chat — /cd, /pwd, project-scoped /sessions)

- A chat can now **switch working directory at runtime**, and its session follows: `/cd <dir>` (absolute, `~`,
  or relative to the current dir) moves the chat into that project and opens that project's own thread; `/pwd`
  shows the current dir + thread; `/sessions` lists the **current dir's** threads; `/new` forks the current
  dir's thread; `/resume <id>` jumps to a thread and adopts its dir so it runs in the right place. Each
  (chat, dir) pair gets its own stable, resumable session id (`<platform>-<chatId>-<cwdTag>[-fork]`) — so one
  gateway roams across projects while keeping per-project history, and switching back resumes. Foundation for
  a future desktop client.
- The chat-session store (`~/.hara/gateway/chats.json`) is now cwd-aware (`chatContext`/`chatCd`); old entries
  migrate in place (keep their existing thread). Tested.

## 0.81.6 — unreleased (headless `-p --resume`: auto-compact long sessions)

- The `hara -p … --resume <id>` / `--continue` path (used by the chat gateway and cron) now runs
  `maybeAutoCompact` before saving, so a long chat/cron thread **auto-compacts** (summarizes old turns)
  instead of growing until it overflows the model's context window. Silent in headless mode (no notify) so
  nothing leaks into a captured reply. Opt-out via `autoCompact: false` / `HARA_AUTO_COMPACT=0`. Previously
  auto-compaction was wired only into the interactive/TUI loops, so gateway/cron sessions could overflow.

## 0.81.5 — unreleased (gateway: default workspace = ~/.hara/workspace — dir-free, Hermes-style)

- `hara gateway` (no `--cwd`) now operates in a dedicated **`~/.hara/workspace`** (created + seeded on first
  run) instead of the launch directory — so the chat bot is dir-free + safe-by-default (like Hermes' own
  `~/.hermes`), never landing full-auto on whatever repo you happened to launch from. `--cwd <dir>` still
  targets a real project.
- This only sets where *files* are created. hara's **global memory (`~/.hara/memory`) and roles
  (`~/.hara/roles` + B-end `~/.hara/org-roles`) are cwd-independent and always loaded**, so a chat session
  shares the same global brain as the terminal CLI regardless of workspace. `~/.hara/` is hara's home:
  memory · roles · sessions · skills · checkpoints · config · per-platform gateway state.

## 0.81.4 — unreleased (gateway: clean chat replies — strip MCP logs + token footer)

- The chat gateway scraped the `hara -p` subprocess output and sent it verbatim, so WeChat/Telegram replies
  were wrapped in CLI chrome — `mcp: … → N tool(s)`, `mcp: … failed …`, and the `model · ↑N ↓N tok` footer.
  New `cleanReply()` strips those, leaving just the assistant's answer. (Tool/diff streaming for multi-step
  tasks is untouched; this only removes the always-present MCP-startup + token-footer noise.) Tested.

## 0.81.3 — unreleased (fix: gateway/cron subprocess spawn when hara runs via the `hara` bin symlink)

- `selfArgv()` (used by the chat gateway and the cron tick to spawn a fresh `hara` per task) **dropped the
  script path** when hara was invoked via the installed `hara` bin symlink: that path has no `.js` extension,
  so the old extension-based heuristic returned just `[node]`, making the spawn `node -p <text> --approval …`
  — which node rejected with `bad option: --approval` (the gateway replied with that error instead of running).
  Now keyed on whether `execPath` is node (the real compiled-binary discriminator): it re-invokes the entry
  (`dist/index.js` **or** the bin symlink) under node, and only re-invokes `execPath` directly for a true
  single-binary build. Test covers all three cases.

## 0.81.2 — unreleased (gateway: `--cwd` flag to point at a workspace without `cd`)

- `hara gateway [--platform …] --cwd <dir>` sets the directory hara operates in for each incoming message,
  so you can launch the daemon against a chosen workspace without `cd`-ing first (resolved to an absolute
  path). Defaults to the current dir as before. Recommended pattern: a dedicated safe scratch dir (e.g.
  `~/work/projects/tools/hara`) rather than a sensitive repo, since each message runs `--approval full-auto`.

## 0.81.1 — unreleased (WeChat gateway: auto-allowlist the bot owner)

- `hara gateway --platform weixin` now **auto-allows the bot owner** (the iLink `user_id` from login — i.e.
  whoever scanned the QR), since on a personal-WeChat bot that id equals the `from_user_id` on your own
  messages. Removes the "run once with an empty allowlist to discover your wxid, then re-run" dance — just
  log in and run the daemon. Additional ids can still be added via `HARA_GATEWAY_ALLOWED`. (Validated the full
  receive→reply round-trip against the live iLink server.)

## 0.81.0 — unreleased (WeChat (iLink) gateway adapter — drive your local hara from personal WeChat)

- **`hara gateway --platform weixin`** adds **WeChat (personal)** as a second chat channel, via Tencent's
  official iLink bot API (`ilinkai.weixin.qq.com`, no ban risk) — the same `ChatAdapter` seam as Telegram,
  so per-chat resumable sessions / allowlist / `/new` `/sessions` `/resume` all carry over. Text DMs (v1):
  the bot reads & edits files and runs bash in the gateway's cwd, and replies in WeChat.
- **`hara gateway --platform weixin --login`** — interactive QR login (scan with WeChat); saves
  `{account_id, token, base_url}` to `~/.hara/weixin/creds.json`. The per-peer `context_token` and the
  long-poll cursor are persisted, so replies route correctly and a restart resumes mid-stream. Handles
  iLink's `-14` / stale-`-2` session-expiry (tokenless retry on send; re-login prompt on poll). Built-in
  fetch; the login QR renders via the **optional** `qrcode-terminal` dep (falls back to printing the URL).
  No crypto needed on the text path.
- The allowlist now logs the sender id of unauthorized messages, so you can discover your WeChat id to add
  to `HARA_GATEWAY_ALLOWED`. 256 tests.

## 0.80.0 — unreleased (chat gateway — drive your local hara from Telegram; + headless session continuity)

- **`hara gateway`** (opt-in daemon, hara's first long-running process) lets you drive your **local** hara from
  a chat app — **Telegram** first ("message your bot → hara reads/edits files, runs bash, replies"). Each chat
  is a **continuous, resumable session**: `/new` forks a fresh thread · `/sessions` lists · `/resume <id>`
  jumps to one — backed by the stored sessions. Access is **allowlist-gated** (`HARA_GATEWAY_ALLOWED` user ids;
  empty = nobody, never wide-open); token from `HARA_TELEGRAM_TOKEN`. Generic `ChatAdapter` shape → WeChat-iLink
  / Feishu are same-interface fast-follows. **Zero new dep** (built-in `fetch` long-poll). `src/gateway/` + tests.
- **`hara -p "<task>" --resume <id>` / `--continue`** now does **headless session continuity** — loads the
  session, appends the prompt, runs, saves it back (a `--resume <id>` with no match is created with that id);
  plain `hara -p` stays stateless. Useful for cron, scripts, and the gateway's per-chat threads.
- This is the chat layer of the multi-terminal plan; the ACP server (for a custom App / editors) is deferred
  until that App exists. 249 tests.

## 0.79.0 — unreleased (app-level failover — retry an errored turn on a fallback model)

- **`fallbackModel`** (opt-in): when a turn ends in a *recoverable* provider error — overload (529/503),
  rate-limit (429), timeout, transient 5xx, or context-overflow — hara retries it **once on the fallback
  model** instead of dying (a different model may not be overloaded / may have a larger window). `auth` errors
  and user interrupts are never auto-retried. The SDK's transient `maxRetries:4` still handles the first line;
  this is the app layer for what's left. `fallbackBaseURL`/`fallbackApiKey` default to the primary's.
- Errors now also carry a short **actionable hint** by kind (auth → check key · overloaded → set fallbackModel
  · context-overflow → /compact). Classification handles DashScope/GLM/Qwen **Chinese** error strings too. New
  `src/agent/failover.ts` (pure classify + decide, fully tested); runAgent just executes the decision, guarded
  to one retry. Tests (244 total). Completes the Sprint-2 spine (⑤ rewind + ⑥ failover).

## 0.78.0 — unreleased (file-state checkpoints — shadow-git "undo the agent's edits")

- **Durable file checkpoints** complete the rewind story (beyond the edit-only in-memory undo, which missed
  `bash`-made changes). Before each turn, hara snapshots the whole working tree into a **shadow git repo** kept
  OUTSIDE the project (`~/.hara/checkpoints/<hash>`, `GIT_DIR` there + `GIT_WORK_TREE` = project root) — so it
  captures everything (incl. `bash`), **never touches your real `.git`/index**, and the model never sees it.
  **`/checkpoint`** lists them; **`/checkpoint restore <n>`** reverts files to one.
- **Safe by construction**: restore snapshots the current state first (so it's undoable) and only reverts
  changed/deleted files — it **never deletes files created since** the checkpoint. Heavy/derived dirs
  (`node_modules`, `.git`, `dist`, …) are excluded; only the first snapshot is a full scan (git's index makes
  the rest incremental). Default on; opt out with `fileCheckpoints:false` / `HARA_CHECKPOINTS=0`.
  `src/checkpoints.ts` + tests (241 total).

## 0.77.0 — unreleased (/rewind — fork the conversation back to an earlier turn)

- New **`/rewind`** — `/rewind` lists recent user turns; `/rewind <n>` forks the conversation back to before
  one, so when the agent goes down a wrong path you can snip back to a good turn and re-steer, instead of
  `/clear` (lose everything) or living with a poisoned context (codex's backtrack). **Conversation only —
  file edits are NOT reverted** (durable file-state checkpoints via shadow-git are the planned heavier
  follow-up). Both UIs; pure in-memory + session store. `src/agent/rewind.ts` + tests (239 total).

## 0.76.0 — unreleased (/context — see what's filling the context window)

- New **`/context`** command: a token-spend breakdown of the conversation — which tool's output, assistant
  text, and your messages are using the window (biggest first, with the share of the model's window) — so on a
  long session you can see *why* you're near the limit, not just the `ctx%` number. Pairs with auto-compaction.
  chars/4 estimate, zero-dep, both UIs. `src/agent/context-report.ts` + tests (237 total).

## 0.75.0 — unreleased (lazy subdirectory AGENTS.md / CLAUDE.md — monorepo-local conventions reach the model)

- When a tool touches a directory not seen yet this session, hara loads that directory's **`AGENTS.md` /
  `CLAUDE.md`** (the local conventions for that package) and appends it to the tool result — so in a monorepo,
  `packages/api/AGENTS.md` or `growth/CLAUDE.md` reaches the model exactly when work moves there, not just the
  root doc loaded at startup. Each directory loads once per session; only dirs **under cwd** (startup already
  covers cwd→root); paths are taken from a tool's `path` or path-like tokens in a `bash` command. Zero-dep,
  additive (never removes context). `src/context/subdir-hints.ts` + tests (235 total).

## 0.74.1 — unreleased (bash output keeps head + tail, not just head)

- Long command output (build / test logs) is now truncated **keeping both the head and the tail** instead of
  only the first 100k chars — so the model still sees the **end**, where the error/result usually is (plain
  head-truncation cut exactly the part that matters). `read_file` truncation is unchanged. New `capHeadTail`
  used on `bash` success + failure output; + test (233 total).

## 0.74.0 — unreleased (auto-compaction — summarize before the context overflows, like Claude Code)

- **Auto-compaction**: when a turn fills the model's context past ~85%, hara now **summarizes the conversation
  and continues automatically** (a "✻ Auto-compacting conversation…" notice) instead of only warning — so a
  long session no longer dead-ends at the context limit. Opt out with `autoCompact: false` (or
  `HARA_AUTO_COMPACT=0`); below the threshold the ≥80% warning still shows. Works in the TUI **and** the classic
  REPL.
- The summarize-and-replace logic is now a single shared `compactConversation` (manual `/compact` and auto both
  use it — no drift); it keeps the working-memory notes that survive the wipe and resets the context gauge off
  the (small) summary. New `src/agent/compact.ts` (`shouldAutoCompact` trigger) + test (232 total).
- The two distinct controls (unchanged, just clarified): **`/compact`** summarizes → replaces history to free
  tokens while keeping the thread; **`/clear`** (= `/reset`) wipes the conversation for a fresh start.

## 0.73.0 — unreleased (Sprint 2: background shell jobs — run dev servers / watchers without blocking)

- **`bash {background: true}`** starts a long-lived command (dev server, `tsc --watch`, a long build) as a
  background job and returns a job id immediately — the agent keeps working instead of blocking on a command
  that never exits. New **`job` tool** (`list` / `tail` / `kill`) manages them; output is captured to a capped
  tail buffer. Background jobs reuse `bash`'s exact **sandbox write-confinement** (shared `shellCommand`) and
  pass the same permission gate when started; they're the agent's own children and are **terminated when hara
  exits** (no orphaned dev servers). `src/exec/jobs.ts` + tests (231 total). First slice of the exec-subsystem
  gap from the 4-expert analysis — persistent/interactive PTY + docker/ssh backends come next.

## 0.72.0 — unreleased (per-turn model routing: strong model for code, cheap/general for trivial turns)

- **Opt-in per-turn model routing** — the answer to "use a coding model for real work, a cheap/general model
  for trivial chat" *without* splitting hara into two tools. Set `routeModel` (+ optional `routeBaseURL` /
  `routeApiKey`, which default to the primary's) and each turn routes by its latest user message: trivial,
  non-coding turns (short · single-line · no code / URL · no action keyword) go to `routeModel`; anything with
  a coding/action signal stays on the primary `model`. **Conservative by design** — a coding tool errs toward
  the strong model, so routing only fires on clear Q&A / chit-chat.
- Implemented as a transparent provider wrapper at the single main-chat entry (`withRouting`), so every
  interactive / `-p` / TUI turn gets it while role / review / sub-agent providers stay untouched. The decision
  reads the last `role:"user"` message (tool results are `role:"tool"`), so it's stable across a turn's tool
  rounds. New `src/agent/route.ts` + tests. Env: `HARA_ROUTE_MODEL` / `HARA_ROUTE_BASE_URL` / `HARA_ROUTE_API_KEY`.

## 0.71.0 — unreleased (Sprint 1: governance + safety — command permissions · untrusted-content wrapping · structured compaction)

Three zero-dep items distilled from a 4-expert (codex/cc-haha/hermes/openclaw) C-end gap analysis; all reinforce hara's governance moat.

- **Command-level permission rules for `bash`** (`~/.hara/permissions.json` + project `.hara/permissions.json`):
  an `allow` / `deny` + read-only-autorun policy that **composes with** approval modes. A **deny** rule blocks a
  command even in `--full-auto`; an **allow** rule (or a recognized **read-only** command — `ls`/`grep`/`git
  status`…) auto-runs even in `suggest` mode — ending the "confirm every command vs. unguarded full-auto" false
  choice. Commands are canonicalized (unwrap `bash -lc`, strip `NODE_ENV=…`/`timeout` wrappers) so approving
  `npm test` once sticks across phrasings; a compound command (`&&`/`||`/`;`/`|`) takes its **strictest** part's
  decision; anything unparseable (`$()`/backticks/unbalanced quotes) fails **closed** to a prompt. New
  `hara permissions` (list · `--init [--project]`). `src/security/permissions.ts` + tests.
- **Untrusted-content wrapping** for `web_fetch` / `web_search`: external page/search text is wrapped in a
  "treat as DATA, not instructions" notice with a **random per-call boundary id**, and homoglyph / zero-width
  tricks (fullwidth/CJK/math angle brackets, ZWSP/BOM/soft-hyphen) are defanged so a hostile page can't forge
  the boundary or smuggle hidden instructions — closing the realistic indirect-prompt-injection vector for an
  agent that holds `bash`. `src/security/external-content.ts` + tests.
- **Structured `/compact` template**: replaces the one-line summary with a 6-section brief (goal · key decisions
  · files & code · errors & fixes · current state · next step) that **quotes the user's most recent request
  verbatim** and drafts in an `<analysis>` scratchpad first — so resuming after a compaction doesn't drift or
  drop the error→fix history.

## 0.70.0 — unreleased (B-end: devices pull their governed org-role bundle)

- An enrolled device now **syncs its digital-employee roles from hara-control** — `GET {gateway}/v1/roles`
  (Bearer device token) returns the governed bundle the control plane resolved for this device's
  person/team, and hara materializes it into `~/.hara/org-roles/*.md`. This closes the B3 gap where the
  server could resolve+govern roles but the CLI never consumed them (it only read local `.hara/roles/`).
- **Precedence layer** (in `loadRoles`): `plugins < org(B-end push) < global < .claude/agents < project`
  — the org baseline sits above third-party plugins, but a dev's own global/project roles still win, so
  pushed roles are a managed default, not a lock. (Org policy can tighten this later.)
- **Authoritative replace**: the org bundle owns `~/.hara/org-roles/` — each sync wipes and rewrites it,
  so a server-side role revoke/rename actually removes the local file. A `_policy.json` sidecar carries
  the org governance floor (model/tool/approval) for later enforcement.
- Wired on `hara enroll` (reports the count) and best-effort in the background on startup when
  `provider=hara-gateway` (alongside the heartbeat). Never throws / never blocks — returns 0 on any
  failure or when not enrolled. snake_case wire fields (`allow_tools`/`deny_tools`) map to the CLI's
  `allowTools`/`denyTools` frontmatter. New `syncOrgRoles()` in `src/org-fleet/enroll.ts` + test.

## 0.69.1 — unreleased (@file expands inline, not appended at the bottom)

- `@path` mentions now expand **in place** — the referenced file/dir content lands exactly where it's
  written, so "compare `@a.ts` with `@b.ts`" reads in context instead of keeping the bare `@a.ts`
  tokens and dumping both files in a block at the very end. A repeated mention keeps the bare `@path`
  the second time (no double-inlining); a non-readable ref is left as typed. Labels ("Referenced file
  `x`:") and the image/dir handling are unchanged — only the position moved.

## 0.69.0 — unreleased (real local vector store via zvec)

- Local semantic search now uses **zvec** (`@zvec/zvec`, an in-process native vector DB) for ANN
  retrieval, replacing the brute-force-cosine scan as the query path. zvec was previously referenced
  only in comments as the "scale-up path"; it's now actually wired (it ships a darwin-arm64/linux
  prebuilt, added as an **optionalDependency**).
- Design keeps the JSON store as the durable embedding cache + SSOT for hit text, and recomputes the
  cosine **score from the JSON vectors** after zvec returns candidate ids — so ranking/threshold
  semantics are byte-identical to before (no change to `hybrid.ts`), zvec just does fast candidate
  retrieval. Build writes the zvec index alongside the JSON cache (`~/.hara/index/<name>.zvec`).
- **Graceful fallback preserved**: if `@zvec/zvec` is absent or its native binding fails to load (a
  platform with no prebuilt), `queryIndex` falls back to the JSON brute-force — so installs without
  the binding keep working. Lexical remains the zero-dep floor when no embedder is configured at all.
- New `src/search/zvec-store.ts` (lazy load · read-only open for queries · best-effort build) + test.

## 0.68.0 — unreleased (run hara in Docker)

- **Dockerfile** — run hara in a container against any mounted repo, no Node install needed, and as an
  isolated/ephemeral environment (handy for CI). Multi-stage build → a slim runtime that still ships a
  shell + `git` + `ripgrep` (the bash/search tools need them; a distroless image would break them).
  `docker run --rm -v "$PWD:/workspace" -e HARA_API_KEY=… ghcr.io/hara-cli/hara -p "…"`.
- **Release pipeline** now also builds + pushes a multi-arch (amd64/arm64) image to
  `ghcr.io/hara-cli/hara` on a version tag, alongside the existing standalone binaries — so the Docker
  and binary distributions stay in lockstep. (Single-binary distribution shipped in 0.60.0; this
  rounds out "install hara any way you like": npm · binary · Docker.)

## 0.67.0 — unreleased (bounded parallel concurrency)

- hara already runs work in parallel — fan-out **`agent`** sub-agents, concurrent read-kind tools in a turn,
  and `hara plan --parallel` waves — but with **no cap**: the model spawning 20 `agent` calls in one turn
  started 20 LLM loops at once (provider rate-limits / resource thrash). Now a **bounded pool** (`mapLimit`)
  caps in-flight parallelism to **8** by default (tunable via `HARA_MAX_CONCURRENCY`), matching cc-haha's
  safeguard (it caps at 10). Excess work queues and runs as slots free; ordering + behavior otherwise
  unchanged. Applied to the loop's read/agent batch and the parallel-plan wave.

## 0.66.0 — unreleased (B-end: device enrollment + `hara-gateway` provider)

- First slice of the **B-end** (fleets / control plane): `hara enroll <gateway-url> --code <code>` trades a
  one-time code for a scoped, revocable **device token** (stored `0600` in `~/.hara/org.json`) and switches
  hara to the new **`hara-gateway`** provider — an OpenAI-compatible client pointed at your org's gateway.
  **The real provider key never touches the device** (it stays at the gateway). A heartbeat fires on start
  for fleet visibility; `--status` / `--clear` manage it. The device↔gateway protocol (enroll / heartbeat /
  OpenAI-compatible proxy) is documented in `docs/b-end.md` and **verified end-to-end against a stub control
  plane**. The control-plane server (`hara-control`) + the LiteLLM data-plane are the next, separate increment.

## 0.65.0 — unreleased (frontmatter-aware asset recall)

- Asset/skill recall (`searchAssets`, behind `hara recall` / `/recall` / skill dedup) now **ranks by the
  asset's declared dimensions** — a query word in the `title` or the frontmatter `tags`/`lang` counts more
  than one buried in the body. The asset format already declared these (the scaffold seeds `tags`/`lang`);
  retrieval now actually uses them. The base relevance score (distinct query words present) is unchanged,
  so the dedup-before-save threshold is unaffected — this only improves *ordering*. (Studied codex + cc-haha:
  both stay lexical + manual-file curation with no semantic search or auto-capture; hara's hybrid lexical+
  opt-in-semantic recall over a unified skills/code-assets/memory corpus is already ahead.)

## 0.64.0 — unreleased (session export)

- **`hara export [session] [--out file]`** renders a saved session to a Markdown transcript — the header
  (title/model/cwd/date), each turn (you / hara), tool calls inline, and tool results in collapsible
  `<details>` blocks (capped). Default is the latest session in the current directory. For sharing a
  decision, pasting into a PR, or archiving. Pure renderer (`src/export.ts`), unit-tested.

## 0.63.0 — unreleased (first-run setup wizard)

- **`hara setup`** — an interactive wizard (provider → optional base URL → API key → model) that writes
  `~/.hara/config.json` (0600), so a new user doesn't have to know the individual `hara config set` keys.
  It's also **auto-offered** when you start `hara` unconfigured ("Not authenticated — run setup now?")
  instead of just erroring. TTY-only (scripts get a clear pointer to `hara config set`).

## 0.62.0 — unreleased (shell completions)

- **`hara completions bash|zsh|fish`** prints a completion script (eval it in your shell rc) that
  tab-completes the top-level subcommands and the subcommands of each group (`cron`, `memory`, `plugin`,
  `roles`, `skills`, `config`), falling back to file completion. Generated from the live command tree so it
  never drifts; hand-rolled (no new dependency).

## 0.61.3 — unreleased (audit follow-through: session robustness + SECURITY.md)

- **Corrupt/hand-edited session files no longer crash** `--resume` or `/sessions` (audit M4): `loadSession`
  validates the shape (meta object + history array), `deriveTitle` tolerates a non-string, and `listSessions`
  skips metaless files instead of throwing.
- New **`SECURITY.md`** — the threat model, the controls (approval gate, read-only sub-agents, write-confinement
  sandbox, `web_fetch` SSRF guard, 0600 secrets, plugin trust), what is deliberately *not* a security boundary,
  and how to report a vulnerability. Captures the posture from the two audit passes.

## 0.61.2 — unreleased (security hardening — second audit: SSRF, RPA, secrets)

A second audit (RPA / network / auth / search) found more real issues; fixed:
- **`web_fetch` SSRF (critical).** It would fetch any host — incl. `169.254.169.254` (cloud metadata),
  `localhost`/`127.0.0.1` internal services, and private ranges — and followed redirects blindly. Now it
  **refuses private/loopback/link-local/CGNAT targets** (resolving the hostname first), **re-checks on every
  redirect hop** (manual redirects), and reads the body under a **byte ceiling** (no multi-GB / bomb body).
- **`computer` "don't ask again" defeated the per-action grant (high).** Screen control is supposed to
  confirm every action; the shared "always" approval silently auto-approved all future clicks/types. Now
  `computer` is **never** satisfied by a prior "always" — it always prompts.
- **Key blocklist bypassable (high).** It only caught spelled-out combos, so Windows SendKeys `%{F4}`/`^w`
  and Linux `XF86LogOff`/`XF86PowerOff` slipped through. Now caught on all three platforms (bare editing
  keys like Delete stay allowed).
- **Secrets could be embedded into the semantic index (medium).** The asset/skill/memory dirs aren't
  `.gitignore`-filtered, so a stray `credentials.json`/`secrets.yaml` there could be POSTed to the embedding
  provider + persisted. Now secret-named files are skipped in both index collectors.
- **Token/config files were world-readable (medium).** `~/.hara/qwen-oauth.json` (access+refresh tokens)
  and `~/.hara/config.json` (`apiKey`) are now written **0600** (and tightened on save).
- **RPA app allowlist was substring-matched (low).** `"Notes"` matched `"Notes - Evil"`; now an exact
  (case-insensitive) frontmost-app match.

The RPA + clipboard shell-outs were confirmed injection-safe (argv arrays, JSON-quoted scripts). 198 tests
(2 new: the SSRF private-IP guard + the widened key blocklist).

## 0.61.1 — unreleased (security + correctness hardening — core audit)

A security/correctness audit of the core (sandbox, confirmation gate, file tools, MCP client) found real
issues; fixed:
- **Confirmation-gate bypass via sub-agents (critical).** The read-kind `agent` tool never prompts, yet
  spawned sub-agents ran **full-auto, unconfirmed** — so a role granting `edit_file`/`bash` let a fan-out
  sub-agent mutate files / run shell with no approval, even in `suggest` mode. Sub-agents are now **always
  read-only** (a role may narrow further but can never grant write/exec — `subagentToolFilter`). Write-capable
  roles run in the main loop via `hara org`, behind the gate.
- **`apply_patch` wasn't actually atomic (critical / data-loss).** It claimed all-or-nothing but Phase 2 wrote
  files sequentially — a mid-way failure left a half-patched tree with no undo. Now it **rolls back** every
  applied write on any failure (restores updated/deleted, removes created), so it's truly all-or-nothing.
- **Sandbox honesty.** It's **file-write confinement only** (not reads/network/exec; `/private/tmp` stays
  writable) — clarified in the header, `--sandbox` docs, and label so it no longer oversells containment.
- The non-macOS "runs unsandboxed" warning now fires from `runShell` (every entry point: `-p`, org, cron),
  not just the REPL; a runaway `bash` whose output exceeds `maxBuffer` is now **killed** (not streamed to
  the timeout); and `hara plugin add` now **shows the commands a plugin will run** on every launch (its MCP
  servers + hooks are arbitrary code — surface the trust surface).

196 tests (2 new: the sub-agent read-only guard + the apply_patch rollback). The edit tools, hooks matcher,
and sandbox profile-injection safety were audited and confirmed solid.

## 0.61.0 — unreleased (`hara memory` — inspect + distill durable memory)

- New **`hara memory`** command group, giving memory a CLI surface it lacked:
  - **`hara memory show`** — print the digest injected at session start (what the agent actually sees).
  - **`hara memory init`** — scaffold the global + project memory dirs/seed files.
  - **`hara memory distill [--days N] [--scope global|project|all]`** — **promote short-term → long-term**:
    consolidate recent daily logs (`log/YYYY-MM-DD.md`) into durable `MEMORY.md`/`USER.md`, deduped against
    what's already there, skipping the ephemeral. This closes the one tiering gap the PAI/hermes study
    surfaced (the daily-log tier was previously write-only). The agent routes each fact to the right
    target/scope (user pref → `USER.md`, project fact → project memory). Verified live with glm-5.
- `.hara/` is now gitignored in this repo so dogfooding doesn't leave runtime state (memory/roles/plans).

## 0.60.2 — unreleased (memory digest: per-source budgets)

- After studying the PAI and hermes memory systems (both lexical-first; both treat vectors as an *optional*
  optimization, not a requirement — which validates hara's design), tightened the frozen-snapshot digest:
  the old `slice(0, 4000)` on the **concatenated** sources could cut an entry mid-line and let a large
  project `MEMORY.md` **crowd `USER.md` out entirely**. Each source (project MEMORY / global MEMORY / USER)
  now gets its **own** budget and is truncated at a **line boundary**, so high-value user prefs are always
  injected and no entry is split. The rest stays reachable via `memory_search` (which is already hybrid
  lexical + opt-in semantic). No behavior change when memory is small.

## 0.60.1 — unreleased (cron hardening — from a code-review pass)

A review of the fast-built `hara cron` module surfaced real bugs; fixed:
- **Malformed cron expressions were silently accepted** (`Number("")===0` etc.) — `"0 9 * * 1,"`, `"/5 * * * *"`, `"5/"` parsed as valid jobs that fire at the wrong time. Now strictly validated and rejected; `N/step` correctly extends to max (Vixie semantics).
- **`hara cron install` could emit a broken plist/crontab** when a path contained `&`/`<`/`>` (launchd XML) or a space/metacharacter (crontab shell line). Now XML-escaped / shell-quoted, and an install is refused if a path contains a newline.
- **Per-job logs grew unbounded** — capped to the last ~256KB once over ~1MB.
- **The tick lock could poison the scheduler for 30 min after a crash, or double-fire a long job** — now keyed on PID liveness (a dead owner is taken over within one tick; a live owner is respected for long runs).
- **An ambiguous id-prefix silently deleted/toggled the *first* match** — `cron remove/enable/disable/run/logs` now error on an ambiguous prefix instead of guessing.

The vim reducer, type-ahead steering, Anthropic message coalescing, the MCP allowlist, and the binary build were reviewed and confirmed clean. 192 tests (4 new hardening cases).

## 0.60.0 — unreleased (single-binary distribution)

- **Standalone binaries** — hara can now be a single self-contained executable (no Node required):
  `curl -fsSL .../install.sh | sh`. Built with `bun build --compile` (`npm run build:binary`, or
  `build:binaries` to cross-compile darwin-arm64/x64 + linux-x64/arm64 from one machine). A tagged
  release (`.github/workflows/release.yml`) builds + attaches them; `install.sh` grabs the right one.
- Build fixes for the bundled binary: a Bun plugin **stubs ink's dev-only `react-devtools-core`** (lazy-
  imported under `DEV`, never in production) so it bundles clean; the version is **baked in via a build
  define** (a compiled binary has no `package.json` to read at runtime); and cron's self-reinvoke now
  detects script-vs-binary mode (`selfArgv`) so `hara cron` works from the binary too. The 60 MB binaries
  are kept out of the npm tarball (`!dist/bin`), which stays ~140 kB.

## 0.59.0 — unreleased (vim keybindings in the input box)

- **Vim mode** (opt-in: `hara config set vimMode true`, or `HARA_VIM=1`). The TUI prompt becomes modal —
  **Esc** → normal, **i/a/I/A/o** → insert. Normal-mode motions `h l 0 $ w b e` (+ `gg`/`G`), edits
  `x D C dd cc dw cw`, and paste `p`/`P` with a delete/yank register. A distinct prompt marker (`◆` yellow)
  + a `-- NORMAL -- / -- INSERT --` hint show the mode. Off by default (normal typing is unchanged). The
  editing logic is a pure reducer (`src/tui/vim.ts`), fully unit-tested; `hara doctor` shows the input mode.

## 0.58.0 — unreleased (`hara cron` — scheduled tasks)

- **Scheduled tasks.** `hara cron add "<schedule>" "<task>"` runs a task on a schedule — the fired job is a
  fresh `hara` session (the run *is* the agent, like openclaw/hermes). Schedules: a 5-field **cron expr**
  (`"0 9 * * 1-5"`), an **interval** (`"every 30m"`), or a **one-shot** (`"in 2h"` / an ISO timestamp).
  `--org` routes it through the role org instead of a plain prompt.
- **Fires via your OS, no daemon to babysit.** `hara cron install` registers a per-minute `hara cron tick`
  with **launchd** (macOS) or **crontab** (Linux); `tick` runs whatever's due (lock-guarded so a slow job
  doesn't double-fire) and logs each run. Manage with `hara cron list / run <id> / enable / disable /
  remove / logs / uninstall`. Jobs persist atomically in `~/.hara/cron/jobs.json`; `hara doctor` shows the
  count + scheduler status. Cron matching is hand-rolled (no new dependency), minute-granular, local-time.

## 0.57.0 — unreleased (in-session `/diff`, `/review`, `/commit` in the TUI)

- The default TUI now wires three more slash commands so the **change → review → commit** loop happens
  in-session instead of dropping to a subcommand (they used to print "isn't wired into the TUI yet"):
  - **`/diff`** — show the working-tree diff vs HEAD (`/diff staged` for the index), rendered as a colored diff block. No model call.
  - **`/review`** — a senior-reviewer pass over `git diff HEAD` (read-only), streamed inline.
  - **`/commit`** — stage everything and commit with an AI-written message (reuses the review→commit machinery).
  Reuses existing, already-verified pieces (`autoCommit`, `REVIEW_SYSTEM`, `runShell`). Other subcommands
  (`init`/`index`/`plan`/`org`/…) still point you to `hara <cmd>` or `HARA_TUI=0`.

## 0.56.0 — unreleased (review → commit capstone + robust verdict parsing)

- **`hara org --review --commit`** closes the loop: once the reviewer approves, hara stages the work and
  commits it with an AI-written message (reusing `hara commit`'s generation). **Guarded** — it only
  auto-commits when the working tree was **clean before the run** (so it captures this run's work, never
  pre-existing WIP), and with `--review` only **after approval** (a review that doesn't pass leaves the
  changes in your tree, uncommitted). `--commit` works without `--review` too (commit the implementer's
  result). Verified live end-to-end: implement → review → approve → `✓ committed`.
- **Robust verdict parsing** (hardening v0.55, found via live smokes). Real models don't emit the literal
  `VERDICT: APPROVED` token — across runs glm-5 wrote `**VERDICT**: No issues found`, `**VERDICT**: PASS`,
  and `VERDICT: LGTM`. The parser now anchors on a markdown-tolerant `VERDICT` marker and **classifies the
  phrase after it** (approve vs changes synonyms), with a changes-signal veto and an ambiguous-→-not-approved
  safe default (worst case is one extra review round, never a bad auto-commit). `not approved` correctly
  vetoes despite containing "approv". Unit tests now cover the exact shapes seen in live runs.

## 0.55.0 — unreleased (multi-role review chain — `hara org --review`)

- **Review chains** — `hara org --review "<task>"` runs the org like an actual engineering team: the owning
  role implements, then a **reviewer** role inspects the diff and either **approves** or sends it back with
  concrete fixes, looping implement → review → fix until approved or a round cap (`--rounds`, default 3).
  This is hara's differentiation — not "one agent + temp sub-agents" but roles that hold each other to a
  bar. The reviewer is read-only (uses your `reviewer` role if defined, else a built-in persona) and ends
  with a machine-parseable `VERDICT: APPROVED | CHANGES_REQUESTED`; on changes-requested the issues feed
  back into the implementer's own conversation so it keeps context. New `src/org/review-chain.ts` (verdict
  parsing, non-destructive `git diff HEAD` capture, prompts) — all unit-tested. **Verified live end-to-end**
  (implementer edits a file → reviewer approves → loop exits).

## 0.54.0 — unreleased (`hara mcp` — run hara as an MCP server)

- **MCP server mode** — `hara mcp` runs hara as an MCP server over stdio, so other MCP clients (Claude
  Desktop, Cursor, another hara…) can call its tools. hara was already an MCP *client*; this completes
  the loop. The high-value one is **`codebase_search`** — point any MCP client at a repo and it gets
  hara's semantic/lexical code search, plus `read_file`/`grep`/`glob`/`ls`/`web_fetch`/`web_search`.
  **Read-only by default** — no `edit_file`/`bash`/`computer`, so an external client can't mutate your
  machine through hara; override the exposed set with `HARA_MCP_TOOLS=a,b,c` at your own risk. Reuses
  hara's tool registry (`src/mcp/server.ts`, built on `@modelcontextprotocol/sdk` — already a dep).
  Verified end-to-end (a real MCP client lists the tools + calls `ls`/`codebase_search`). `hara doctor`
  now shows both the client (servers connected) and serve (tools exposed) sides.

  ```jsonc
  // e.g. in a client's mcpServers config:
  "hara": { "command": "hara", "args": ["mcp"] }   // run from the repo you want searchable
  ```

## 0.53.0 — unreleased (task-done notifications + steering in plan mode)

- **Notifications** — get pinged when a turn finishes so you can walk away during a long run
  (codex/Claude-Code parity). `hara config set notify bell` rings the terminal BEL; `notify system` fires
  an OS notification (macOS `osascript` / Linux `notify-send`) plus the bell; default `off`. Gated on
  elapsed time (≥8s) so quick turns you were watching stay silent. Wired into the TUI turn, plan-mode
  execute, and the plain REPL; `hara doctor` shows the setting. New `src/notify.ts` (`notifyDone`).
- **Type-ahead steering now covers plan mode too.** v0.52 wired steering into the regular turn only;
  the `pendingInput` builder is now hoisted so plan-mode *investigation* and *execution* also fold in
  messages you type mid-turn (previously they fell back to the old wait-for-turn-end behavior — an
  inconsistency). All three turn paths now steer.

## 0.52.0 — unreleased (type-ahead steering — mid-turn messages course-correct the live task)

- **Type-ahead now *steers* the running turn** instead of waiting for it to finish. Previously a message
  typed while hara worked was held and replayed as a brand-new turn once the turn ended — so a
  supplement ("also handle the error case", "use TS not JS") arrived *after* the task had already
  finished on the old understanding, becoming rework. Now, studying how **codex** does it (its
  `pending_input` drains at the next model-call boundary *inside* the same turn) vs **cc-haha/Claude
  Code** (waits for full completion), hara adopts the codex model: queued messages are **folded into the
  next model call** (drained after each tool round), so the model course-corrects mid-task. Each shows
  inline in the transcript at the point it's folded in. Messages typed during the *final* step (no more
  tool rounds) still start a fresh turn; **Esc** drops the queue and stops.
- New `RunOpts.pendingInput` (the loop drains it before each model call; unused outside the TUI = zero
  change for `-p`/sub-agents/plain REPL). The TUI hands the queue through `Helpers.drainQueue`.
- **`toAnthropic` now coalesces consecutive `user` messages** — required since a steered message lands
  right after tool-results (which map to a `user` message) and Anthropic rejects two `user` turns in a
  row. Dormant in normal alternating histories. Unit-tested.

## 0.51.0 — unreleased (lifecycle hooks — PreToolUse / PostToolUse)

- **Hooks dispatch** — run your own shell commands around every tool call (codex / Claude-Code parity, which
  hara lacked). A **`PreToolUse`** hook runs *before* a tool and can **veto** it (non-zero exit blocks the
  call; its stdout/stderr becomes the denial the model sees) — e.g. forbid `bash rm -rf`, gate edits to a
  path, require a clean tree. A **`PostToolUse`** hook runs *after* (observe-only) — e.g. `prettier` a file
  the agent just wrote, log/notify. The command gets `{tool, payload}` as JSON on stdin + `HARA_TOOL_NAME`
  in its env; each is matched by a `matcher` (regex/literal on the tool name, `*`/omitted = all) with a 30s
  timeout. Configure in `config.json` `"hooks"`; **plugins can contribute hooks** too. `hara doctor` shows
  the active count. No hooks configured = zero overhead (fast no-op).

  ```jsonc
  // ~/.hara/config.json
  "hooks": {
    "PreToolUse":  [{ "matcher": "bash", "command": "grep -q 'rm -rf' && { echo 'no rm -rf'; exit 1; } || exit 0" }],
    "PostToolUse": [{ "matcher": "edit_file|write_file", "command": "prettier --write \"$(jq -r .payload.input.path)\" 2>/dev/null; exit 0" }]
  }
  ```

## 0.50.0 — unreleased (web_search — find pages, not just fetch)

- New **`web_search`** tool — search the web (title/URL/snippet), then `web_fetch` a result to read it. Closes
  the other codex/cc-haha gap (hara could previously only fetch a *known* URL). **Reliable with a Tavily key**
  (`HARA_SEARCH_API_KEY` / `TAVILY_API_KEY`, free tier); a **keyless DuckDuckGo** fallback works best-effort
  (POST endpoint; may rate-limit). Read-kind, available to sub-agents. Verified live (keyless: "anthropic
  claude" → real results); parser unit-tested (incl. the DDG `uddg` redirect decode).

## 0.49.0 — unreleased (inline todo tool — `todo_write`)

- New **`todo_write`** tool — the agent maintains a live task checklist during multi-step work (codex's
  `update_plan` / Claude Code's `TodoWrite`, which hara lacked). Plan up front, keep one item `in_progress`,
  flip to `done` as you go; pass the full list each call. Read-kind (never prompts); the system prompt nudges
  its use for multi-step tasks; sub-agents can use it too. Renders a `☐/▶/☑` checklist with a done count.
  *(Gap analysis vs codex + cc-haha: this was the top missing capability.)*

## 0.48.0 — unreleased (chrome plugin: drive your real logged-in Chrome)

- New first-party **`chrome` plugin** — web automation via **`chrome-devtools-mcp`** against a **real Chrome with
  a persistent-login profile** (sign into a site once, reused across runs), or attach to your running Chrome via
  `--browserUrl http://127.0.0.1:9222`. The "drive my actual sessions" complement to the isolated-Playwright
  `browser` plugin (enable one, not both) — this is the openclaw/cc-haha route.
- Shipped as an option (not auto-installed — `browser` stays the default). `chrome-devtools-mcp` verified
  resolvable; both plugin manifests validated.

## 0.47.0 — unreleased (browser plugin: reliable web automation via Playwright MCP)

- New first-party **`browser` plugin** wires the **Playwright MCP** (`@playwright/mcp`) into hara → the agent gets
  reliable web automation: `mcp__browser__navigate / snapshot / click / type / fill_form …` acting on the page's
  **DOM/accessibility tree** (selectors, auto-waiting), NOT screenshots or pixel coordinates. This is the
  reliable counterpart to the fragile desktop `computer` tool — no permission walls, no coordinate-guessing.
- Ships a `web-automation` skill (snapshot-driven workflow; notes the `chrome-devtools-mcp` alternative for
  driving your real logged-in Chrome, à la openclaw/cc-haha).
- Install: `hara plugin add file:<repo>/plugins/browser`; `npx playwright install chromium` once. Verified
  `@playwright/mcp@0.0.76` resolves + the plugin loads (`hara doctor` → plugins: browser).

## 0.46.0 — unreleased (screen control: bounded-failure circuit breaker)

- The `computer` tool now **stops after 3 consecutive failures** instead of letting the agent loop forever on a
  broken setup (learned from codex, which bounds Computer Use attempts then gives up). After 3 in a row it
  returns a clear stop + the likely cause (missing Accessibility/Screen Recording permission, or the app isn't
  reachable) + how to fix; resets on any success. Each failure shows the running `[n/3]` count.

## 0.45.1 — unreleased (activate via `open -a`; Accessibility gotcha)

- `activateApp` uses `open -a <app>` on macOS — `osascript … to activate` often left another window on top.
- Documented (gotcha #0 in `computer.ts`) that **cliclick needs the Accessibility permission, separate from
  Screen Recording** — without it, clicks/keys silently no-op (the #1 cause of "it does nothing").

## 0.45.0 — unreleased (screen control: activate, IME-safe typing)

- **`activate` action** — bring the target app to the foreground before screenshot/click. Fixes clicks landing
  on the terminal hara runs in (the "Ghostty" problem): the agent must `activate WeChat` *first*.
- **IME-safe typing** — `type` now sets the clipboard and pastes (Cmd/Ctrl+V) instead of injecting keystrokes,
  which a Chinese input method garbles. Reliable for **CJK + emoji** (verified pbcopy round-trip: `你好 hello 😀`);
  falls back to keystrokes for ASCII if the clipboard set fails.
- The hard-won **RPA gotchas** (foreground trap, IME, Retina coords, grounding fragility, placeholder text like
  "AAAA") are documented at the top of `computer.ts`.
- TUI: the type-ahead pool shows each queued line **highlighted** (accent color) above the input — no verbose
  header (per feedback).

## 0.44.0 — unreleased (type-ahead pool: visible + coalesced)

- The type-ahead queue is now a **visible pool**: messages typed while the agent works are listed above the
  input (`📥 pool (N) — sent together when this turn finishes`), so Enter visibly *enters the pool* instead of
  appearing to vanish (the reported "回车消失了/没显示在对话池").
- On turn-end the pool is **coalesced into one turn** — your "also do X" / "and Y" additions reach the agent
  together, in order, rather than as separate sequential turns.
- Esc still clears the pool (stop means stop). 130 tests (+1 coalesce; existing type-ahead tests updated).

## 0.43.0 — unreleased (grounding for screen control — accurate clicks)

- The `computer` tool now **locates UI elements by description** instead of guessing pixels from a text read.
  Pass `target` to `click`/`move` (e.g. "the Send button") — hara screenshots, asks a vision model for the
  element's position (resolution-independent fractions, Retina-safe), and clicks there. New **`find`** action
  returns coordinates without clicking.
- This is codex's "native computer-use" lesson applied **locally**: codex's `computer_use` is a remote browser
  sandbox; hara grounds against your own screen + apps. Needs a grounding-capable vision model (e.g. a qwen-VL).
- `screenSize()` per OS converts fractions → click coords; `parseLocate` accepts per-mille/percent/fraction
  replies (tested). cliclick installed → `hara doctor` shows screencapture ✓ + cliclick ✓.
- **Still requires you to grant macOS Screen Recording + Accessibility** to actually drive the screen — those
  toggles can only be set by you in System Settings.

## 0.42.0 — unreleased (type-ahead: keep typing while the agent works)

- You can now **type while the agent is working** — the message enters a **FIFO queue** and is sent
  automatically when the current turn finishes (the input box stays active mid-turn; a "⌨ working — Enter
  queues" hint shows the depth). Fixes the "input does nothing while working" dogfooding feedback.
- **Esc stops everything** — interrupts the turn AND clears the queue, so a stopped turn never fires queued
  messages. The queue drain is idempotent (guarded against double-send under React StrictMode).
- Expert-reviewed for queue correctness (FIFO, exactly-once), the Esc/abort UX, and input-handler conflicts.

## 0.41.0 — unreleased (English session names, auto-summarized)

- After the first turn a session gets a short **English kebab-case name** summarizing what it's about
  (e.g. `add-semantic-search`) via one tiny model call — replacing the literal first-message title. A non-English
  conversation is translated to an English gist (pinyin only if untranslatable). Names stay short + ASCII.
- The stable session **id is still the UUID** (unchanged — this only improves the human-friendly name); falls
  back to the lexical title if the naming call fails. New `slugify()` helper (tested).

## 0.40.0 — unreleased (TUI polish: markdown rendering + numbered choices)

- The ink TUI now **renders assistant Markdown** (headers, bold, inline code, bullets; code fences kept
  verbatim) instead of showing raw `**`/`##`/backticks. The renderer (`md.ts`) had only been wired into the
  classic REPL; the default TUI showed markdown literally.
- **Selection prompts are numbered**: each choice shows `1.`, `2.`, … and you can **press the number to pick it
  directly** (in addition to ↑↓ + Enter). The hint reads "↑↓ or 1–N to choose".

## 0.39.0 — unreleased (hara commit — AI commit messages)

- **`hara commit`** generates a conventional-commits message from your staged diff, shows it, and commits after
  a `Y/n` confirm. `-a` stages tracked changes first; the global `-y` skips the confirm. Pairs with `hara
  review` (review → commit). Verified live (glm-5): generated `feat(util): add mul function` and committed it.
- Note: the skip-confirm reuses the global `-y/--yes` (a subcommand `-y` would collide with it — same lesson as
  `hara plan resume`).

## 0.38.0 — unreleased (hara review — review your changes)

- **`hara review`** reviews your uncommitted changes (`git diff HEAD`) for correctness bugs, security issues,
  missing error handling, naming, and missing tests — grouped by severity (**Blocker / Should-fix / Nit**) with
  file:line and concrete fixes. **Read-only**: it can read files for context but never edits. `--staged`
  reviews staged changes; `--base <ref>` reviews against a ref (e.g. `main`).
- Verified live (glm-5): on a planted diff it flagged a hardcoded secret (Blocker), an unguarded divide, and
  dead code, then gave a clear "do not merge" verdict.
- `codebase_search` added to the read-only tool set (so reviewers / sub-agents can search the repo).

## 0.37.0 — unreleased (task-aware screenshots for screen control)

- Screenshots from the `computer` tool are now read with a **screenshot-tuned prompt** aimed at *acting*, not
  transcribing: interactive elements (buttons/fields/menus) with labels and approximate positions, the active
  element, and any errors. A text-only main model driving the desktop gets something it can actually click.
- New optional **`focus`** on the screenshot action ("the Login button") narrows the read to the current goal.
- Internal: `describeImages` gains `system`/`hint` options, `SCREENSHOT_SYSTEM` added, `ctx.describeImage`
  takes a hint. (For contrast: codex's `computer_use` is a remote/hosted *browser* MCP plugin with no local
  syscalls — hara stays **native + local** so it can operate your own desktop software.)

## 0.36.0 — unreleased (resumable plans)

- **`hara plan resume`** continues the saved plan (`.hara/org/plan.json`): atoms already marked done are
  skipped, pending/failed ones run. When a verify gate stops a plan midway, fix the issue and resume instead
  of starting from scratch. Interrupted atoms (running/failed) reset to pending; works with `--parallel` too.
- Internal: execution extracted into a shared `executePlan` (skips completed atoms) used by both fresh runs and
  resume; `loadPlan` wired into the CLI. Verified: a half-done plan resumed, skipped the done atom, ran only
  the pending one.

## 0.35.0 — unreleased (parallel plan execution — the org works in parallel)

- **`hara plan --parallel`** runs independent atoms concurrently. The planner already builds a dependency DAG;
  now `topoWaves` groups atoms into dependency *waves* (every atom in a wave depends only on earlier waves), and
  each wave's atoms execute at the same time. A diamond plan `a1 → (a2,a3) → a4` runs a2 and a3 together.
- This is the org differentiator made literal: not one agent stepping through a list, but a team working the
  independent parts at once. Verified live (glm-5): two independent atoms ran in one wave and completed
  out-of-order; both check-gates passed.
- Sequential remains the default (and is what interactive approval uses, since concurrent atoms can't share a
  prompt). `hara plan` is full-auto, so `--parallel` is safe there. A wave stops the run if any of its atoms fail.
- Internal: `executeAtom` extracted (shared by both paths); `topoWaves(atoms)` added alongside `topoOrder`.

## 0.34.0 — unreleased (incremental indexing)

- **`hara index` is now incremental.** Re-running it re-embeds only the files whose mtime changed since the
  last build; unchanged files keep their existing vectors, and deleted files drop out. A changed embedding
  model still forces a full rebuild. Output reports `(N embedded, M reused)`.
- Turns indexing from a run-once-and-go-stale command into something you can re-run after every edit. Measured
  on hara's own repo with local `bge-m3`: full build **~68s** → unchanged rebuild **~0.4s** (~150×); editing one
  file re-embeds just that file's chunks.
- Internal: each chunk records its source file's mtime; `buildIndex` returns `{total, embedded, reused}`.

## 0.33.0 — 2026-06-20 · first public release (semantic recall + memory)

- **`recall` and `memory_search` go hybrid too.** The semantic layer added in 0.32 now also powers your
  code-asset library and durable memory — `hara index --assets` embeds `~/.hara/code-assets`, global skills,
  and `~/.hara/memory` into `assets` + `memory` indexes. `hara recall`, `/recall`, and the `memory_search` tool
  then blend meaning-based hits with lexical (semantic leads, lexical fills, deduped by path).
- **`hara index [--repo|--assets|--all]`** — `--repo` (default) for `codebase_search`, `--assets` for recall +
  memory, `--all` for everything. Each index is still a self-`.gitignore`d derived artifact; `hara doctor` lists
  which of `repo / assets / memory` are built.
- **Lexical stays the default everywhere** — with no index/embedder, recall and memory behave exactly as before.
  Capture/dedup (`skill_create`) stays purely lexical by design (saving shouldn't depend on an embedding model).
- Verified end-to-end with local `bge-m3`: "retrying a request that failed" → a backoff snippet; "how do I ship
  a release" → the deploy note — both matched by meaning, not keywords.
- **License simplified to Apache-2.0** (from `MIT OR Apache-2.0`). Apache-2.0 adds an explicit patent grant +
  trademark protection — the right fit for a company-backed tool with a commercial future, and matches the peer
  norm (Codex, Goose). `LICENSE-MIT` removed; `LICENSE-APACHE` → `LICENSE`.

## 0.32.0 — unreleased (semantic search for `codebase_search`)

- **Opt-in semantic index — `hara index`.** `codebase_search` (the "this repo is a knowledge base" tool) can
  now blend **meaning-based** results with its lexical ranking. Build the index once with `hara index`; queries
  then find the right file even when they share no keywords with the code (e.g. "read an image pasted from the
  clipboard" → `src/images.ts`).
- **Zero new dependency, lexical stays the default.** The store is a built-in JSON cosine index (fine for repo /
  code-asset scale); when no index or embedding provider is configured, `codebase_search` is exactly as before.
  No native vector DB is required (zvec remains the documented scale-up path).
- **Bring your own embeddings**: `hara config set embedProvider ollama` (local & offline — e.g. `bge-m3`,
  `nomic-embed-text`), `qwen` (DashScope `text-embedding-v3`), or any OpenAI-compatible `/embeddings` endpoint
  (`embedModel` / `embedBaseURL` / `embedApiKey`). Embeddings never run unless you opt in.
- The index is a **derived, rebuildable artifact** — written under `.hara/index/` with a self-`.gitignore` so it
  can never be committed (it may embed file contents). `hara doctor` shows the search/semantic/index state.

## 0.31.0 — unreleased (native screen control)

- **`computer` tool — operate desktop software, not just the browser.** Screenshot → read → click / move /
  type / press keys at coordinates. Native shell-out per OS (no heavy deps): macOS `screencapture` + `cliclick`,
  Windows PowerShell (.NET / user32, built-in), Linux `scrot` + `xdotool`.
- **Strict, opt-in safety**: `computerUse: off|read|click|full` (default **off**) gates capability tiers;
  `computerApps` is a frontmost-window **allowlist** checked before any click/type (the key guard against
  wrong-window actions); a **dangerous-key blocklist** (cmd+q, ctrl+alt+del…); and a **once-per-session grant**
  (the `computer` tool kind always confirms once, even in full-auto).
- Screenshots are **read via the vision sidecar** (a screenshot is described to text) so a text-only main
  model can still act on what's on screen. `hara doctor` shows the tier, per-OS backend availability, and the
  app allowlist.

## 0.30.1 — unreleased

- Capture honors `assetCapture`: in **ask** (default) the end-of-session distill now **prompts before saving**
  each skill/memory — the "remind me to confirm" flow — instead of writing silently; **auto** stays silent;
  **off** disables proactive capture. `hara doctor` shows the capture mode.

## 0.30.0 — unreleased (codebase search — the repo as a knowledge base)

- **`codebase_search`** — the current project is now a searchable knowledge base. Relevance-ranked **lexical**
  search over the repo's code/text (respects `.gitignore` via `listProjectFiles`), returning the top files +
  their densest snippet (`file:line`). Distinct from `grep` (exact pattern): the agent finds *related* code
  from a natural-language query ("where's auth handled?") while working. Zero new deps; it's the interface a
  semantic (zvec) index slots into later.

## 0.29.0 — unreleased (asset capture & curation — phase 1)

- **Unified asset search** (the fix that enables the rest): `recall` / `searchAssets` now cover **skills +
  code-assets** as one corpus — they were disconnected, so agent-saved skills were invisible to recall (and
  dedup was impossible).
- **`skill_create` is now curated capture:**
  - **`scope`** — `project` (this repo's `.hara/skills`) or `personal` (`~/.hara/skills`, default). Sharing to
    company / public stays a separate, human-confirmed step.
  - **Sanitize on save** — secrets are **redacted** to typed placeholders (`<REDACTED:sk-key>`…) rather than
    blocking the whole save; local identifiers are generalized (`<project>` / `~` / `<email>`); injection
    phrases are still hard-blocked.
  - **Dedup signal** — searches the unified corpus before saving and flags a near-duplicate so you update
    instead of piling up.
- **`assetCapture: off | ask | auto`** gates proactive end-of-session capture (the distill turn).
- `guard.ts` gains `redactSecrets()` / `scrubLocal()` — redact on the way in; `scanMemory` still blocks on load.

## 0.28.0 — unreleased (plugins)

- **Plugins** — a distribution unit bundling skills + roles + MCP servers; it owns nothing at runtime, the
  existing loaders pick its contents up. Manifest is **Claude-Code-compatible** (`.claude-plugin/plugin.json`,
  `.hara-plugin/plugin.json`, or bare `plugin.json`) so hara can consume community plugins.
- `hara plugin add file:<path> | github:<owner/repo> | git:<url>` installs into `~/.hara/plugins/<name>`;
  `hara plugin` lists; `hara plugin enable/disable/remove`. Enabled plugins' skills/roles/MCP auto-contribute
  (lowest precedence — project & global override). `hara doctor` shows them.
- **Claude-Code subagent interop**: `.claude/agents/*.md` load as roles (`tools:` → allowTools).

## 0.27.0 — unreleased (skills)

- **Skills** — agentskills.io-standard reusable capabilities at `~/.hara/skills/<name>/SKILL.md` (+ project
  `.hara/skills`). The system prompt lists each skill (id + description); the agent calls the new **`skill`**
  tool to load a skill's full instructions on demand — progressive disclosure (the body returns as a tool
  result, keeping the prompt cache stable). `context: fork` runs the skill as a sub-agent; `allowed-tools` /
  `when_to_use` / `paths` / `user-invocable` frontmatter supported (Claude-Code-compatible).
- **`skill_create`** replaces `playbook_save` — the agent saves a reusable how-to as a real SKILL.md (lexical
  guard scans it). Playbooks are now just the agent-authored corner of the one skills system.
- **`hara skills` / `hara skills init`**, plus `/skills` (list) and `/skill <id>` (load into your next
  message). `hara doctor` lists your skills. Reuses the existing recall lexical engine — no new deps.

## 0.26.0 — unreleased (inline image tokens + session UUID & auto-name)

- **Pasted images are inline `[Image #N]` tokens** (Claude Code / codex style) — highlighted in the input
  where you paste, carried inline in the message; **backspace over a token removes it + its attachment**
  (and renumbers the rest). Replaces the chip experiment (a desktop-GUI pattern) with the terminal-native
  one both reference tools use.
- **Sessions now have a full UUID** (was an 8-char stub) + an **auto-summarized name** from the first
  message that's **language-aware (keeps CJK)** — a Chinese first line names the session meaningfully
  instead of a random word; it never shows "new session" (falls back to the short id).
- Startup header shows `session <uuid>`; the top border shows the name (or short id); `/sessions` + `/name`
  show the short id / full UUID; **`--resume` accepts a short-id prefix**, not just the full UUID.

## 0.25.0 — unreleased (vision UX polish + ground-truth capability map)

- **Header shows image routing at startup** — the banner now states whether the main model reads images
  directly, routes them through a describer (`👁 glm-5 is text-only → images read by qwen3.7-plus`), or will
  ask on first paste.
- **Cleaner paste** — a pasted/dragged image is a 🖼 **chip** below the prompt (no more `[Image #N]` token in
  your text); the input stays clean, you can submit an image with no text, and **backspace on empty input
  removes the last attachment** (cc-haha style).
- **Capability map corrected to the Alibaba Coding Plan** (ground truth): `qwen3.5/3.6/3.7-plus` + `kimi-k2.5`
  → vision; `qwen3-max`, `qwen3-coder-*`, `glm-5`, `glm-4.7`, `MiniMax-M2.5` → text-only. So `glm-5` no longer
  hits the "unknown" prompt — it routes straight to the describer.
- **Hardening** (expert review): `/vision` is now one implementation shared by both REPLs; setting a
  non-vision describer warns; `/model` resets the describer cache + reminder; Esc during describe reads as
  "cancelled" not "failed".

## 0.24.1 — unreleased

- Capability map: recognize the Alibaba coding-plan **Qwen3 flagships** (`qwen3.x-plus` / `qwen3-max`) as
  **vision-capable** — verified `qwen3.7-plus` accepts image input and describes/OCRs accurately. (As a
  `visionModel` describer it already worked; this corrects its classification when used as the *main* model.)

## 0.24.0 — unreleased (auto-detect vision capability)

- **Automatic** image routing — hara classifies the main model and decides each turn:
  - vision-capable (Claude, gpt-4o, qwen-vl, glm-4v…) → image sent **inline**, describer suspended;
  - text-only (DeepSeek, qwen-coder, glm-4-flash…) → image **auto-described** by `visionModel` into text,
    or — if none set — a **reminder** to add one (`/vision <model>`);
  - **unknown** model → hara **asks once** ("Can <model> see images? Yes / No / Skip") and remembers the
    answer per-model.
- Built-in, extensible **capability map** (`classifyVision`) for the major families — Claude / GPT / Qwen /
  GLM / DeepSeek / Gemini / Mistral / Llama / Kimi / Grok / Pixtral·Llava·InternVL.
- **`/vision <model>`** sets the describer in-place; **`/vision main yes|no|auto`** overrides/clears the
  current model's detected capability (stored per-model in `modelVision`). `hara doctor` shows it.

## 0.23.0 — unreleased (vision sidecar for text-only models)

- **Use pasted images with text-only models** (DeepSeek, coding models, …) via a configurable vision
  **sidecar**: `hara config set visionModel <model>` (e.g. a `qwen-vl-*` on the same Alibaba plan) — hara
  OCRs/describes each pasted image into text with that model, then your main model continues. Reuses the
  main provider's endpoint + key; override with `visionBaseURL` / `visionApiKey` if vision lives elsewhere.
  Unset = images go inline (needs a vision main model).
- The describe prompt is coding-tuned: verbatim transcription of text/code in fenced blocks, plus UI /
  diagram / error description. `hara doctor` shows the vision status.

## 0.22.0 — unreleased (image paste / vision)

- **Paste images into the prompt** (ink TUI) — **Ctrl+V** pastes an image from the OS clipboard (a
  screenshot, or an image copied from a browser); **dragging an image file** into the terminal (or
  pasting its path) attaches it too. Each shows as an `[Image #N]` token in the input with a 🖼 chip
  below the box. Zero new deps — shells out to `osascript`/`sips` (macOS), `wl-paste`/`xclip` (Linux),
  or PowerShell (Windows), the same posture as the sandbox.
- **Vision on every provider** — attachments are sent as image blocks: base64 `image` blocks for
  Anthropic (Claude), `image_url` data-URLs for OpenAI-compatible endpoints (Qwen-VL / GLM-4V /
  OpenAI). Use a vision-capable model. Oversized images are auto-downsized (macOS `sips`, ≤1568 px)
  and capped at ~5 MB.
- Only image **paths** ride in the conversation/session JSON (sessions stay small); bytes are read +
  base64-encoded at request time. `@image.png` mentions no longer inline binary — they hint to paste.
- 85 offline tests (clipboard capture, path detection, provider image blocks, TUI paste).

## 0.21.2 — unreleased (memory everywhere)

- Memory now injects into **every execution mode** — `hara -p` one-shot, `hara org`, `hara plan` atoms,
  and sub-agents — not only the interactive REPL (M1 had wired just the interactive turns).
- `hara doctor` / `/doctor` shows memory status + the `evolve` level.

## 0.21.1 — unreleased (TUI command parity)

- Wire the missing slash commands into the default ink TUI: **`/compact`** (with the proactive pre-compact
  flush + working-set distill), **`/sessions`**, **`/usage`**, **`/doctor`**, **`/roles`**, **`/approval [mode]`**.
  (`runDoctor` now returns a string so both the classic REPL and the TUI can render it.) `/org` and `/plan`
  remain `hara org`/`hara plan` subcommands.

## 0.21.0 — unreleased (self-evolution · M2)

- **`playbook_save`** — the agent grows its own reusable playbooks (`~/.hara/code-assets/playbooks/<slug>.md`,
  frontmatter + body), found later by `recall` / `memory_search`.
- **AGENTS.md self-refinement** — the agent may propose AGENTS.md edits via `edit_file`, reviewed through the
  normal diff/approval gate (no new write path).
- **Guard** (`src/memory/guard.ts`) — a lexical scan on agent-written memory + playbooks blocks prompt-injection
  phrases, secret-shaped tokens (`sk-…`/`AKIA…`/PEM/`ghp_…`), and `file://` URLs before they hit disk.
- **Session-end distill** — with `evolve: proactive` (default), `/exit` runs one reflection turn that persists
  durable learnings via `memory_write` / `playbook_save`. Set `evolve: light` (no distill) or `off` to disable.
- 76 offline tests.

## 0.20.0 — unreleased (memory + self-evolution · M1)

- **Long-term memory** — a lexical, file-backed store (no embeddings): global `~/.hara/memory/` + project
  `<root>/.hara/memory/` (`MEMORY.md` / `USER.md` / daily logs). Tools: `memory_search`, `memory_get`,
  `memory_write`, `memory_forget`. The agent recalls before answering about prior decisions and is nudged to
  **proactively save** durable facts (conventions, your preferences, tricky solutions).
- **Injection** — a capped MEMORY/USER digest is added to the system prompt (frozen snapshot at session
  start), reusing the `recall` lexical engine over the memory roots.
- **Short-term working memory** — `SessionMeta.workingSet` survives `/compact` (which used to wipe it) and
  resume; `/compact` distills its summary into it.
- **Global roles** — `~/.hara/roles/*.md` (reusable personas) alongside project `.hara/roles/`; project wins
  on name clash — the same global/project scoping as memory + config.
- 74 offline tests; zero new runtime deps. (M2 = playbooks + AGENTS.md self-refine + a guard + session-end distill.)

## 0.19.0 — unreleased (plan mode + theme)

- **Plan mode** — a 4th `shift+tab` mode. hara goes **read-only** (`read_file`/`grep`/`glob`/`ls`/`web_fetch`),
  investigates, and proposes a step-by-step plan; then a **selectable "proceed?"** prompt — *Yes, auto-apply
  edits · Yes, approve each edit · No, keep planning* — flips the approval mode and executes the plan.
  Matches codex (`Default`+`Plan`) / Claude Code.
- **Selectable prompts** — the tool-approval confirm and the plan-proceed share one `↑↓` / Enter / shortcut
  select component; the input box stays visible underneath.
- **Theme switch** — `hara config set theme dark|light` (or `HARA_THEME`). Banner/accent is the brand
  vermilion **#FF6B5C** on dark, **#C0392B** on light. Truecolor; chalk degrades on 256/16-color terminals.

## 0.18.0 — unreleased (ink TUI)

- **New terminal UI — a real TUI (ink 6 + React 19).** The interactive REPL is now a **bordered input
  box pinned at the bottom**: the session name sits in the top-right corner, and the approval modes +
  token usage + concurrent-agent count live in the bottom border, with the conversation scrolling above.
  Streaming assistant text, dim reasoning, tool calls, and colored diffs render as live blocks; a spinner
  shows while a turn runs (**Esc** interrupts); tool-approval prompts appear inline (y/N); **shift+tab**
  cycles the approval mode. Same approach Claude Code itself uses (ink). `HARA_TUI=0` falls back to the
  classic readline REPL.
- The agent loop + tools now emit through a `UiSink` so output is rendered by ink (not raw stdout),
  keeping the TUI uncorrupted; the plain path is unchanged when no sink is present (`-p`, pipes, sub-agents).
- TUI slash commands: `/help` `/tools` `/model` `/undo` `/recall` `/reset` `/exit` (others → `HARA_TUI=0`).

## 0.17.1 — unreleased (status bar actually renders)

- **Fix: the status bar now shows.** The pinned-footer (v0.6) used a terminal scroll region that
  doesn't compose with Node's `readline`, so it silently never rendered. It's now a status **header
  printed above each prompt** — session · the three approval modes · tokens + ctx% · concurrent ops —
  visible in any terminal. (True bottom-pinning needs a full TUI; deferred.) `HARA_FOOTER=0` hides it.

## 0.17.0 — unreleased (doctor + command completion)

- **`hara doctor` / `/doctor`** — a setup health check: Node version, provider + model, whether auth
  is configured (with a fix hint), config path, code-assets, roles, MCP servers. Diagnoses the common
  "not authenticated / wrong model" pitfalls at a glance.
- **`/command` Tab-completion** — typing `/` (or `/mo`) + Tab completes slash-command names in the REPL.

## 0.16.1 — unreleased (terminal UX polish)

- **`@<dir>` loads a directory** — mentioning a directory now attaches a listing of its files (the
  agent can then read specific ones); previously `@dir` did nothing.
- **`@src/` Tab drills in** — completing a path that ends in `/` lists that folder's immediate
  children (directories first), like a file picker.
- **Tool calls show their argument** — `↳ read_file src/x.ts`, `↳ bash npm test`, `↳ grep TODO`
  instead of a bare tool name.
- **"working Ns" spinner** while a turn is in flight (cleared the moment output/reasoning streams).

## 0.16.0 — unreleased (parallel sub-agents)

- **`agent` tool** — delegate an independent sub-task to a fresh sub-agent; spawn several in one turn
  to run them **in parallel** (the footer's `⛁ N agents` count is now real). Sub-agents are read-only
  by default (analysis/search/review/web), so they're safe to parallelize; pass a `role` id to use
  that role's persona + tools. The agent loop gained a `quiet` mode so parallel sub-agents don't
  interleave output — only their results return to the parent. Sub-agents can't recurse (no nested
  fan-out).

## 0.15.0 — unreleased (code-asset recall)

- **`hara recall "<query>"` / `/recall`** — a personal, git-versionable library of snippets/playbooks
  at `~/.hara/code-assets` (override with `HARA_ASSETS`). Lexical search ranks `*.md` assets by
  query-word matches; in the REPL `/recall` pulls the top matches into your **next message's context**.
  `hara recall --init` scaffolds the directory with an example. Phase-C v0 — lexical-first (embeddings
  deferred until proven necessary).

## 0.14.1 — unreleased (planner: objective verify gate)

- **`hara plan` verify can run a command** — an atom may carry a `check` shell command; the verify
  gate passes only if it exits 0 (objective), falling back to the LLM self-check when no `check` is
  given. Makes plans trustworthy — e.g. `npm test`, `tsc --noEmit`, `test -f path`.

## 0.14.0 — unreleased (web_fetch)

- **`web_fetch`** — fetch an `http(s)` URL and return its text (HTML reduced to readable text), for
  pulling docs / references / pages into context. Read-only, follows redirects, 30s timeout,
  size-capped. Not sandboxed (network egress is in-process, not via `bash`).

## 0.13.0 — unreleased (context management)

- **`/compact`** — summarize the conversation so far into a brief and replace the history with it, to
  free up context in long sessions (preserves goal, decisions, files changed, next steps).
- **Context budget warning** — after a turn, if the context reaches ≥80% of the model's window, hara
  warns and suggests `/compact` / `/reset`. (The status bar already shows live `ctx %`.)

## 0.12.0 — unreleased (rendered output + visible reasoning)

- **Markdown rendering** — assistant output renders in the terminal: headers, **bold**, `inline
  code`, and bullets are styled; code fences pass through verbatim (copy-paste accurate). Line-buffered
  streaming (`src/md.ts`); interactive terminal only — pipes/`-p` stay raw, disable with `HARA_MD=0`.
- **Reasoning/thinking display** — when a model streams reasoning (GLM-5 / DeepSeek `reasoning_content`,
  or Anthropic thinking), hara shows it dimmed before the answer. Interactive terminal only.

## 0.11.0 — unreleased (undo + live shell output)

- **`/undo`** — revert the last file change(s) made this session. Every edit tool
  (`write_file`/`edit_file`/`apply_patch`) records the prior file state; `/undo` restores it (and
  deletes files that were freshly created). In-session, up to 50 steps. (`src/undo.ts`)
- **Live bash output** — the `bash` tool now streams stdout/stderr **as the command runs**
  (interactive terminal only) instead of waiting for completion. `runShell` rewritten on `spawn` with
  an `onData` hook; the full output is still captured for the model.

## 0.10.0 — unreleased (multi-file patches + interrupt)

- **`apply_patch`** — change several files in one **atomic** step (all-or-nothing). `changes` is an
  array of `{path, type:'update'|'create'|'delete', edits?|content?}`; everything is validated and
  computed in memory first, and **nothing is written if any change fails**. Shows a diff per file.
  Prefer it over multiple `edit_file` calls for multi-file work. (Shared edit core extracted to
  `src/tools/apply-core.ts`, reused by `edit_file`.)
- **Esc interrupts a running turn** — press Esc while the agent is working to abort the in-flight
  request and return to the prompt (the session is kept). Plumbed via `AbortSignal` through both
  providers; an interrupt renders as a dim `(interrupted)`, not an error.

## 0.9.0 — unreleased (daily-driver polish: streaming + diffs)

- **Streaming for OpenAI-compatible providers** — Qwen/GLM/OpenAI now stream tokens live (the whole
  response used to appear at once). Tool calls are accumulated from the stream by index, and usage is
  read from the final chunk (`stream_options.include_usage`). Anthropic already streamed.
- **Diff display on edits** — after `edit_file`/`write_file`, hara prints a colored unified diff
  (`◇ path +N -M` with `+`/`-` lines) so you see exactly what changed. Zero-dependency line diff
  (`src/diff.ts`); shown in an interactive terminal only (pipes/scripts stay clean).
- **Sturdier retries** — both SDK clients now retry transient errors (429/5xx/network) up to 4×.

## 0.8.0 — unreleased (atomization planner — the org plans, not just routes)

- **`hara plan "<task>"` / `/plan`** — decompose a task into atoms, sequence them as a DAG, then
  execute each step (optionally routed to a role) behind a **verify gate**. This is the execution
  methodology made real: frame → atomize → sequence → execute → verify.
- **Planner** (`src/org/planner.ts`): `decompose` (LLM → atoms + deps), `topoOrder` (Kahn ordering +
  cycle detection), per-atom `verify` (checks the step's done-criteria), and an SSOT plan state at
  `.hara/org/plan.json` — inspectable, and execution stops on the first failed verification.
- Atoms may carry a `role`, so the planner routes steps to the org's role-agents
  (implementer/reviewer/docs) with their persona, tool subset, and model.

## 0.7.0 — unreleased (fuzzy matching + did-you-mean)

- **Fuzzy `@file` completion** — `@path` now ranks by a built-in subsequence fuzzy matcher (zero new
  deps): `@idx` finds `src/index.ts`, `@sc` finds `src/`. Handles insertions/skips (not transpositions).
- **Path did-you-mean** — when `read_file`/`edit_file` get a path that doesn't exist, the error now
  suggests the nearest real project files ("Did you mean: src/index.ts?") instead of just failing.
- **Slash-command did-you-mean** — a mistyped command suggests the closest one ("`/modl` → Did you
  mean /model?").
- New `src/fuzzy.ts` (`fuzzyScore`/`fuzzyRank`/`nearest`) + `nearestPaths` in `fs-walk.ts`.

## 0.6.0 — unreleased (CLI UX + search tools)

- **Status bar** — a persistent footer pinned below the REPL transcript (terminal scroll region):
  session name · the three approval modes with the current one highlighted · live token usage + ctx% ·
  a concurrent-operation count (`⛁ N`). TTY-only; degrades to the plain after-turn status line when
  piped. Disable with `HARA_FOOTER=0`.
- **Approval mode switching** — bare `/approval` now cycles suggest → auto-edit → full-auto (still
  `/approval <mode>` to set); **shift+tab** cycles it from anywhere (TTY).
- **Search tools** — `grep` (regex across files, `path:line: text`), `glob` (`**`/`*`/`?` path
  patterns), `ls` (one directory). All read-only, so they never prompt and run in parallel.
- **Parallel safe-tool execution** — read-only tool calls in a turn now run concurrently (edit/exec
  still run alone, in order); the footer's `⛁` count reflects live concurrency.
- **`edit_file` hardened** — accepts multiple `edits` applied in order, and falls back to
  quote-insensitive matching (straight ↔ curly) when an exact match isn't found.
- **`@file` completion fixed** — now walks subdirectories (git-tracked + untracked, or a filesystem
  walk outside git), drills into directories (`@src/…`), and works in non-git projects. Previously it
  only consulted `git ls-files` and silently returned nothing otherwise.

## 0.5.0 — unreleased (Phase 2: governed role-agent org — the differentiator)

- **Roles** — markdown role-agents in `.hara/roles/*.md` (frontmatter: `name`, `description`, `owns[]`,
  `rejects[]`, `model?`, `allowTools[]`/`denyTools[]`; body = persona). `hara roles` lists, `hara roles init` scaffolds.
- **Dispatcher** — `hara org "<task>"` routes a task to the role that **owns** it (keyword match → LLM
  fallback), or `--role <id>` to force one; runs that role's agent with its persona, tool subset, and model.
  `/org` and `/roles` in the REPL.
- hara now runs like an engineering org, not a single agent — a read-only `reviewer` vs an editing
  `implementer`, each owning its slice of the work.

## 0.4.0 — unreleased (Tier-3)

- **Sessions & resume** — conversations saved under `~/.hara/sessions`; `-c`/`--continue` resumes the latest
  in the cwd, `--resume <id>` a specific one, `hara sessions` / `/sessions` list them.
- **MCP client** — connect stdio MCP servers via an `mcpServers` map in config (global or project);
  their tools register as `mcp__<server>__<tool>` and become available to the agent.
- **OS sandboxing** — `--sandbox` / `config set sandbox` (`off` | `workspace-write` | `read-only`): the
  `bash` tool runs under macOS Seatbelt — workspace-write confines writes to the project (+ temp),
  read-only blocks writes. Non-macOS runs unsandboxed (the approval gate still applies).

## 0.3.0 — unreleased (Tier-2 coding-CLI polish)

- **Approval modes** — `suggest` (confirm edits & shell), `auto-edit` (auto file edits, confirm shell),
  `full-auto` (no prompts). Set via `--approval`, `hara config set approval`, or `/approval`; `-y` = full-auto.
- **Slash-command registry** — `/help` `/init` `/tools` `/model` `/approval` `/usage` `/reset` `/exit`,
  data-driven (auto-listed in `/help`).
- **Config profiles & project config** — named `profiles` in `~/.hara/config.json` (`--profile` /
  `HARA_PROFILE`), plus a project-level `.hara/config.json` that overrides the global config.
- **Status line** — model + cumulative token usage (`↑in ↓out`) after each turn and in `-p` output;
  `/usage` shows it on demand.

## 0.2.0 — unreleased (coding-CLI features, borrowed from Codex)

- **Project context (`AGENTS.md`)** — auto-loaded each run (walks up to the project root, concatenates,
  32 KiB cap). On first run in a project with no `AGENTS.md`, hara offers to analyze the repo and write
  one; `hara init` / `/init` (re)generate it. Uses the cross-tool `AGENTS.md` standard.
- **`@file` mentions** — `@path` in the REPL or `-p` attaches that file's contents to your message;
  Tab-completes `@paths` from `git ls-files`.
- **`edit_file` tool** — surgical exact-string edits to existing files (unique-match guard / `replace_all`),
  instead of overwriting whole files with `write_file`. Behind the same confirm gate.

## 0.1.0 — unreleased (first functional release)

- Streaming **agentic loop** with a manual tool-use cycle.
- Built-in tools: `read_file`, `write_file`, `bash`, with a **human-in-the-loop confirmation gate**
  on the dangerous ones (`write_file`, `bash`) unless `-y` is passed.
- Interactive **REPL** (`/help`, `/tools`, `/model`, `/reset`, `/exit`), one-shot `-p` mode, `-y`/`-m` flags.
- **Multi-provider**: Anthropic (Claude — streaming + adaptive thinking) and any OpenAI-compatible
  endpoint (Qwen/DashScope, GLM, Kimi, OpenAI) via a provider-neutral conversation core.
- **`hara config`** (`provider` / `apiKey` / `model` / `baseURL`) → `~/.hara/config.json`; env vars override.
- Offline **test suite** for the built-in tools.
- Dual-licensed **MIT OR Apache-2.0**; CLA in place.

## 0.0.2

- Placeholder package reserving `@nanhara/hara` on npm (dual MIT/Apache + CLA, functional stub).
