# Mailbox connections and Desk taskbus

This feature requires a Desk advertising `taskbus.v1` (Desk 0.9.0+) and an Engine
advertising `mail.connections.list`, `mail.command`, and `desk.taskbus.request`.
It is not included in the previously published CLI 0.186.1. CLI/Desktop integration
and native/Docker publication belong to the coordinated release owner.

Internal Agents use Desk HTTPS directly. A mailbox is an external intake and
notification channel; message text is never executed and role names in mail never
change the receiving Agent's identity. A human selects the company, project and
main Bot. One user can own multiple enrolled Agents. Desk enforces user/project
visibility, dispatch/execute/review grants and independent result acceptance.

## Setup on the receiving host

1. Join the intended company through the existing Control/organization flow.
2. The company admin creates a Desk project. Give the main Bot intake/dispatch,
   the worker execute, and a different reviewer review grants.
3. Install the canonical global `feishu-communicate` capability at
   `~/.codex/skills/feishu-communicate` and a working `python3`. Hara calls its
   `scripts/feishu_chat.py`; it does not bundle or create a second Feishu client.
   Ordinary IMAP/SMTP needs the version with `mail-imap-*`, `mail-smtp-send` and
   configurable six-field server settings. Provision this dependency on each
   actual receiver host; it is not automatically installed by npm or Desktop.
4. In Desktop Settings → Connections, enter the exact mailbox, dedicated client
   password and IMAP/SMTP servers. Feishu is a one-click server preset, not a
   required provider choice. No Tencent account setup is needed.
5. Verify and bind on that host, then explicitly enable receipt. New binding is
   paused. Enabling SMTP permits individually confirmed sends, not auto-replies.

TLS and STARTTLS always validate certificates before credentials. The same mailbox
is the login name; dedicated mail-client passwords are supported, OAuth-only mail
is not. Binding verifies list/body access separately (empty inbox remains pending
first-body verification); SMTP authentication is distinct from actual sending.
It does not send a test message. Failed verification preserves the previous account.

Credentials and pending/attempt journals stay under private `~/.hara/mail`
(0700 directories/0600 files). Never commit, upload or log them. Desk synchronizes
nonsecret binding metadata and work; passwords are not cloud-synchronized. A
second receiver requires its own explicit authorization on that host. Do not
change server parameters remotely to reuse an old password: Hara requires rebind.

## CLI

Commands select an enrolled organization profile and its exact Space:

```sh
hara mail list --profile COMPANY_PROFILE
hara mail bind --profile COMPANY_PROFILE --input-file /private/path/binding.json
hara mail start --profile COMPANY_PROFILE --input-file /private/path/start.json
hara mail watch --profile COMPANY_PROFILE
hara desk bus projects.list --profile COMPANY_PROFILE
hara desk bus tasks.list --profile COMPANY_PROFILE --input-file /private/path/project.json
```

Use a private 0600 bind file with mailbox, password, projectId, mainBotId,
ownership (`personal` by default), receiverMode (`local`/`server`), allowReplies,
expectedRevision and a stable requestKey. Omit provider. Supply `servers`:

```json
{
  "imapHost": "imap.example.test", "imapPort": 993, "imapSecurity": "tls",
  "smtpHost": "smtp.example.test", "smtpPort": 587, "smtpSecurity": "starttls"
}
```

Start/pause/remove use `{id,expectedRevision,requestKey}` from the current list.
`sync` takes `{id}` and performs one bounded receiver pass. `watch` keeps only this
profile/Space's enabled receivers alive until SIGINT/SIGTERM. Serve also manages
enabled receivers during its lifetime. Do not run duplicate consumers deliberately;
Desk leases ensure only one effective receiver. No listener is enabled by installation.

`desk bus` exposes fixed operations: identity/directory/capabilities,
members.list/save, projects.list/save, bindings.list/save, tasks.all/list/get/create,
tasks.claim/renew/result/accept/reject/cancel/release/close, deliveries.list/ack,
audit.list and outbox.list/draft/confirm/cancel/resolve. Input is one JSON object
≤64 KB. Mutations require stable requestKey; taskbus fields follow Desk TASKBUS.md.
Claims/results use runtime Sessions; human configuration uses enrollment credentials.
LLM tools do not expose mailbox credentials, user/project administration or mail
confirmation. Desktop's authenticated RPC methods are pinned to profile and Space.

## Recovery and limits

- The receiver polls short HTTPS/provider calls; no Tailscale dependency. Lock-screen
  receipt requires the Engine to remain running. During sleep/exit, providers and
  Desk retain data; recovery catches up after restart, not while powered down.
- Initial intake starts at binding time. Bounded paginated recovery overlaps the
  watermark and deduplicates stable message identities. UID validity changes require
  explicit recovery; no silent cursor reset or unlimited mailbox history scan.
- Full plaintext is bounded; HTML-only parts are converted to text without remote
  resources. Attachments are not fetched. A private queue survives lost responses.
- SMTP outbox requires exact-content review and confirmation. One privately journaled
  attempt produces acceptance or unknown outcome. Unknown outcomes are never resent
  automatically. Verify sent mail and record evidence before a separately approved
  new message. SMTP acceptance does not establish recipient delivery.
- Offline Desk copies are bounded, private, identity-scoped and read-only. Only
  temporary unavailability uses them; 401/403/404 never use old cached authority.
  There is no offline mutation queue. Switching company invalidates late responses.
- High-risk task execution remains closed. Feedback needs child task dispatch, a
  result, independent acceptance, and release verification before final closure.
- Server receipt is supported by running an enrolled persistent receiver on that
  server. Deploying Desk alone does not install/authorize this worker. No live mail
  access, server worker or end-to-end Grok mail flow is established by mock tests.

Historical explicitly selected Tencent/Feishu API adapters remain for compatibility;
new product binding uses ordinary mail and never falls back automatically.

## Verification

Use the repository-approved modern Node runtime. Run `npm test` (its test HOME is
isolated), build, production dependency audit and package dry run. Focused mail tests
also import `test/setup-isolated-home.mjs`; never test against real `~/.hara/mail`.
Native binaries, Docker images and real receiver-host prerequisite checks are release
owner gates. Live mailbox list/body/send/receipt tests require the user's actual
authorization and remain separate from offline tests.
