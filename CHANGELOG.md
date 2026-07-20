# Changelog

All notable changes to `@nanhara/hara`.

> Versioning (pre-1.0, SemVer-style): the **minor** (middle) number bumps for a **new feature**; the
> **patch** (last) number bumps for **optimizations/fixes of existing features**.

## 0.130.1 — 2026-07-21 — Windows private-state portability

- `hara serve` no longer calls the inapplicable POSIX `fchmod` operation on Windows discovery
  directory and file handles. Official Windows standalone builds can now create the authenticated
  `serve.json` record instead of exiting with `EPERM`.
- The same descriptor-mode boundary is shared by all private-state readers and writers: Windows
  retains file type, identity, no-replace, atomic-write, and symlink/reparse-point checks while
  omitting only POSIX owner bits; macOS and Linux still fail closed if permission tightening fails.
- Upgrade with `npm i -g @nanhara/hara@0.130.1`.

## 0.130.0 — 2026-07-20 — ordered task-state delivery

- Typed `event.task_state` notifications now carry a server-stream identity and a positive,
  monotonically increasing sequence. Desktop and other authenticated Serve clients can reject
  duplicated or stale lifecycle transitions instead of letting a late event overwrite the current
  task, approval, checkpoint, or completion state.
- Ordering spans every session and every resume within one `hara serve` process. A server restart
  creates a new stream identity, so clients can accept the fresh sequence without confusing it with
  an older connection.
- Conversation streaming remains independent from execution state, and task event payloads retain
  the same redacted ambient-data boundary. Existing protocol-v1 clients remain compatible because
  the ordering fields are additive.
- Upgrade with `npm i -g @nanhara/hara@0.130.0`.

## 0.129.0 — 2026-07-20 — durable revisions and workspace recovery

- Authenticated Serve clients can commit a user-selected file as a new immutable Artifact revision with
  `artifact.commit`. Every write carries `baseRevisionId`; a stale editor receives the dedicated protocol
  conflict code and cannot replace the current revision.
- `artifact.revert` restores an earlier ancestor by creating another immutable revision rather than moving
  the pointer backward or mutating history. The imported original and every prior revision remain unchanged.
- Revision pointer updates now use a private-state compare-and-swap guard that also closes a cross-process
  race. The authenticated host assigns the user actor, so a Desktop client cannot forge an Agent/migration
  audit identity.
- This slice does not yet export files or claim Office fidelity. ExportReceipt, validation reports, worker
  identity, format-specific editing, and Panel v2 remain separate release gates.
- Interactive launches from the home directory now offer an explicit, one-step switch to a recent or
  registered project before provider and MCP startup. Hara never enumerates the home directory and never
  changes workspace scope without confirmation.
- Repeated protected-home failures are now grouped by semantic root cause across `ls`, `grep`, `glob`, and
  other filesystem tools. A run stops after the bounded retry threshold with a focused recovery instruction
  instead of trying different tools against the same boundary indefinitely.
- Git plugin installation now rejects credential-bearing source URLs, bounds clone time, and safely
  distinguishes missing Git, network, authentication/access, and private/not-found repository failures
  without echoing URLs, tokens, or Git stderr.
- Feishu WebSocket gateways now report connected, disconnected, and reconnected lifecycle events with
  one-hour and 24-hour counters. Repeated disconnects raise rate-limited alerts, while terminal SDK recovery
  failures stop the adapter after a safe drain so a process supervisor can restart it.
- Upgrade with `npm i -g @nanhara/hara@0.129.0`.

## 0.128.0 — 2026-07-20 — local deliverable foundation

- Hara Serve now provides the first `artifact/1` local runtime through authenticated
  `artifact.import`, `artifact.list`, `artifact.get`, and `artifact.revisions` methods. Presentations,
  spreadsheets, and documents receive opaque Artifact/revision identities and a stable content receipt.
- Import is copy-on-write and leaves the selected file untouched. The private store rejects relative paths,
  symbolic links, hard links, protected credential/configuration files, macro-enabled Office extensions,
  type-confused Office packages, empty files, and files over 64 MiB; activation and immutable binary writes
  are crash-safe, owner-only, and digest-verified.
- Local metadata never retains the selected absolute path. Corrupt entries remain hidden without hiding
  healthy work, and unexpected filesystem failures cross the Desktop RPC boundary as path-free errors.
- This release intentionally stores and verifies deliverables but does not render, edit, export, or execute
  them. Those actions remain gated on a matching reviewed Office capability in the next vertical slices.
- Upgrade with `npm i -g @nanhara/hara@0.128.0`.

## 0.127.2 — 2026-07-20 — quiet scheduled monitoring

- Cron delivery now supports `--deliver-mode always|on-output|on-error`. Existing jobs retain the
  `always` heartbeat; high-frequency monitors can use `on-output` to stay silent unless redacted stdout
  is non-empty, while `on-error` sends only failed outcomes.
- Failure streak alarms remain independent of outcome filtering, so an `on-output` watchdog still sends
  its configured `--alert-after N` alert even when routine runs and stderr-only diagnostics are quiet.
- CLI, agent tool, and Desktop Serve automation APIs validate, persist, list, and display the same policy.
- Upgrade with `npm i -g @nanhara/hara@0.127.2`.

## 0.127.1 — 2026-07-20 — managed access lifecycle

- Managed enrollment now persists the control plane's authoritative device-token expiry. Hara warns
  during the final 24 hours, reports the boundary in `whoami`/`enroll --status`, and fails closed with
  a focused re-enrollment command once access expires or lifecycle data is corrupt.
- Serve provider settings expose only expiry metadata—not the token—so Hara Desktop can distinguish
  an authenticated managed route from an expired one.
- Upgrade with `npm i -g @nanhara/hara@0.127.1`.

## 0.127.0 — 2026-07-20 — structured context and typed task lifecycle

- **Prompt assembly is now an explicit, ordered runtime layer.** Cache-stable policy, tool, project, and
  session context are separated from turn-specific execution state and memory digests, deduplicated, and
  assembled in a deterministic order. Anthropic requests preserve a stable cache prefix while other
  providers continue to receive the same complete system contract.
- **Conversation and execution state now travel on separate protocol planes.** Authenticated Serve clients
  can negotiate the versioned `event.task_state` stream for running, waiting, paused, completed, and blocked
  work, with stable task/turn identities, phases, accepted task briefs, checkpoints, approvals, outcomes,
  restore snapshots, and explicit stop/finish transitions.
- **Mid-turn input uses expected-turn steering.** `session.steer` durably accepts an update only for the
  intended live turn, so Desktop and other clients can distinguish a real refinement from the next queued
  task without parsing model prose or losing an end-of-turn race.
- Ambient lifecycle events never include command or path previews, and resumed client history removes the
  internal steering-triage wrapper before display. Detailed tool output remains confined to the explicit
  conversation surface.
- Upgrade with `npm i -g @nanhara/hara@0.127.0`.

## 0.126.1 — 2026-07-19 — verified plugin packages and ownership-safe lifecycle

- **Plugin packages now fail closed at staging.** Hara validates a bounded manifest schema, portable IDs and
  relative paths, declared Skills/roles/binaries/panels, and MCP entry points before activation. Complete
  package scans reject symbolic links, hard-linked or special files, protected credential-shaped files,
  filesystem-boundary crossings, and excessive file/byte counts.
- **Install, update, and removal have an ownership transaction.** A same-filesystem private staging directory
  is atomically activated; command collisions never overwrite foreign entries; and a private receipt binds the
  installed root device/inode, manifest digest, and exact command links. Update rollback preserves the previous
  package and commands, while uninstall refuses a changed root, a foreign command replacement, or an older
  unreceipted install. A legacy plugin remains usable; reinstalling it from the same reviewed source performs
  the one-time receipt migration, after which later updates and removal use the verified ownership path.
- **Plugin MCP processes are rooted in their installed package.** Relative executables and conventional
  Node/Bun/Deno/Python entry scripts are verified and converted to absolute installed paths, and each server
  receives the immutable plugin root as its working directory instead of the user's project.
- Install warnings no longer echo manifest-provided MCP arguments or hook command bodies, which could contain
  credentials. They still identify each executable surface so the package source can be reviewed before use.
- Upgrade with `npm i -g @nanhara/hara@0.126.1`.

## 0.126.0 — 2026-07-19 — provider control plane, bounded tools, and honest execution time

- **Desktop can configure providers through an authenticated, redacted Serve control plane.** The shared
  catalog distinguishes cloud, local, OAuth, and managed routes; settings can list, test, and save a Personal
  route without returning credentials to the UI. Switching provider or endpoint requires a matching new key
  instead of replaying another vendor's credential, named/managed profiles remain explicit, and launch-time
  environment overrides stay immutable from Desktop.
- **Ollama and LM Studio are first-class local providers.** They require no fake API key, accept only
  loopback HTTP endpoints, omit the Authorization header on the wire, and can discover installed models
  through the same bounded connection-test path. Cloud custom endpoints continue to require HTTPS except
  for an explicit loopback target.
- **Tool execution has conservative runtime traits.** Tools without a complete declaration default to
  side-effect-capable and serial; input-level classification can narrow a real read but cannot turn a
  mutating call into an inherited read approval. Parallel calls share an aggregate result budget so one
  round cannot flood the next model request.
- **Long-tail tool schemas and large results are demand-loaded.** `tool_search` activates only matched,
  role-allowed capabilities for the next model round. Oversized, redacted tool output is kept in a
  quota/TTL-bounded private store and exposed only through opaque `tool_result_read` continuation IDs, never
  arbitrary filesystem paths.

- Human clarification and approval waits no longer consume `runTimeoutMs`. The non-renewable budget now
  measures active model/tool execution, resumes with the exact remaining time after an answer, and still
  stops genuinely stuck providers, tools, and loops. Esc, shutdown, and explicit cancellation continue to
  dismiss a waiting prompt immediately.
- The TUI distinguishes this state as `waiting for your answer · task timer paused`; five-minute and 80%
  lifecycle notices no longer fire while Hara is waiting for a person.
- `hara serve` now exposes authenticated `server.shutdown` so Desktop can gracefully release sessions and
  locks before relaunching after an update.
- Timed-out or interrupted provider/tool calls retain their Serve session lease until the underlying
  operation physically settles. A second turn, session deletion, or updater shutdown receives `BUSY`
  instead of overlapping a non-cooperative request or releasing its lock early.
- Headless resumed sessions use the same physical-lifetime rule for dynamically nested sub-agents and
  automatic compaction, so a late child request cannot escape a cleanup snapshot and release the
  cross-process lock early.
- The WeCom gateway now uses the bundled `ws` transport because Node 22's native WebSocket handshake is
  rejected by WeCom's production endpoint before authentication. A late authentication frame can no longer
  revive an already-aborted connection or install a heartbeat after cleanup.
- Upgrade with `npm i -g @nanhara/hara@0.126.0`.

## 0.125.3 — 2026-07-18 — conversation/task boundary and deliberate execution

- **Chat delivery is now separate from task execution.** Slash controls such as `/model` no longer create a
  fake steer target; input typed while a picker or other local control is busy is visibly queued as the next
  turn. If a real turn ends between enqueue and delivery, Hara promotes the raced steer to a normal turn
  instead of rejecting it with `there is no task to steer` or dropping the input. Queued controls execute
  alone rather than absorbing the following task as command arguments, and paused/completed tasks are never
  implicit steer targets—only explicit `/continue` may reopen one. User-invocable slash Skills remain real
  Agent turns, so refinements typed while `/design`, `/video`, or another Skill is running steer that Skill
  instead of becoming an unrelated task.
- **Main tasks now establish an explicit understanding checkpoint before side effects.** The engine-owned
  `task_intake` records intent, interpreted goal, constraints, acceptance checks, and short steps in the
  durable task state. Reads and diagnosis may happen first, but edits, non-read-only commands, computer
  actions, external agents, and MCP connections are blocked until the brief is accepted in a completed tool
  round. Starting or stopping a background process is also treated as a state change even when its command or
  job tool is otherwise read-only; malformed string-valued `background` flags are rejected. Read-only actions
  inside mixed tools (`task list`, `cronjob list`) stay available for evidence gathering. Brief revisions
  replace the old prompt copy and cannot share a round with a side effect. A later steer cannot be overwritten
  by a concurrent or revised checkpoint.
- **Alibaba Coding Plan discovery follows the current exact model contract.** `/model` prefers the endpoint's
  live response and uses the documented ten-model list only for official Coding Plan hosts. Context guards now
  use each model's published window, and `qwen3-coder-next` / `qwen3-coder-plus` no longer expose an unsupported
  thinking control. Desktop/serve derives the reasoning dial from each session's pinned model rather than the
  current global default.
- **Configured MCP servers no longer execute or ask for permission when Hara starts.** Hara exposes a
  zero-side-effect `mcp_connect` capability; the agent calls it only when the current task materially needs
  one named server, receives the existing external-boundary approval, and discovers that server's tools for
  the next model round. Other configured servers remain stopped.
- Interactive calls to connected MCP tools still require confirmation every time, protected-file-shaped
  inputs remain blocked, read-only roles cannot receive the launcher, and headless runs remain fail-closed
  unless `HARA_ALLOW_TRUSTED_EXTENSIONS=1` was set before launch.
- MCP stderr now drops only npm 11's repeated `Unknown user config "always-auth"` and `"home"` deprecation
  lines. Other npm warnings and all actual server errors remain visible and redacted. Hara does not read,
  rewrite, or weaken the user's `.npmrc`. Esc, interruption, and the active-execution deadline now also cancel a
  lazy MCP startup/tool call and close an unresponsive child instead of leaving it behind.
- Upgrade with `npm i -g @nanhara/hara@0.125.3`.

## 0.125.1 — 2026-07-18 — installed plugin commands inside agent tasks

- **Commands contributed by an installed Hara plugin are now available to Hara's own tool subprocesses.**
  Hara appends the user-approved `~/.hara/bin` directory after the inherited `PATH`, so a plugin command
  such as `hara-video` can be called during an agent task without shadowing a project or system executable.
  Interactive shells remain user-controlled and still receive the existing one-time PATH hint.
- This closes the failure mode where the Video Skill was loaded but the agent saw `hara-video: command not
  found`, hand-built an ungoverned replacement project, and then bypassed the plugin's verification command.
- Upgrade with `npm i -g @nanhara/hara@0.125.1`.

## 0.125.0 — 2026-07-18 — Claude-compatible specialist orchestration

- **Personal Claude Code subagents now work in Hara without copying prompts.** Hara discovers
  `~/.claude/agents/*.md` as portable global roles in addition to project `.claude/agents`, translates common
  Claude tool names, inherits the active Hara model for Claude aliases/provider-specific ids, and preserves
  native/project Hara precedence on id collisions. Workflow-only prompts and prompts that require a private
  Claude notification/skill dependency stay explicit-only rather than being selected automatically.
- **Ordinary Hara conversations can now discover the right specialist.** The main agent receives a bounded,
  guarded name/description catalog and loads only the selected role body. Delegation guidance requires a
  minimal self-contained brief, distinct non-overlapping work, and parent-side synthesis; fan-out specialists
  remain read-only so role prompts cannot bypass the edit/command approval boundary.
- **Plans route by responsibility instead of role name alone.** The atom planner receives bounded role
  descriptions and read-only status, excludes `disable-model-invocation` roles from automatic selection, and
  removes unknown role ids instead of silently executing under a generic persona. Explicit role execution
  remains available for host-coupled prompts.

## 0.124.4 — 2026-07-18 — deadline-aware task checkpoints

- **The 80% run-budget warning now reaches the Agent, not only the user.** Before the next model turn,
  Hara injects a hidden checkpoint instruction to finish the current atomic step, persist artifacts,
  update the checklist, and defer a new multi-minute stage to `/continue`. A video/image batch, full
  validation, preview, render, install, or deployment should no longer begin with too little turn budget
  and then appear to stop mysteriously at the 30-minute safety pause.

## 0.124.3 — 2026-07-17 — project-aware resume and runtime hardening

- **Saved sessions now resume in the project they belong to.** `hara resume <id>` validates the persisted
  project root and relaunches there even when invoked from another directory; session lists show each project
  path. Inside Hara, `/resume <id>` switches saved sessions while `/continue` exclusively resumes the active
  task. Missing project roots, corrupt records, concurrent writers, and raw/headless cross-project resumes
  remain fail-closed.
- **A total run deadline is now a resumable safety pause.** The 80% warning tells the agent to finish or
  checkpoint its current step, the hard-stop notice explains that the task/checklist remains resumable with
  `/continue`, and deadline outcomes persist as `paused` instead of looking irrecoverably blocked. Loop and
  repeated-failure breakers remain blocked until the approach changes.
- **Home protection now covers recursive ancestor scopes.** Launching from `/`, `/Users`, a symlink alias, or
  any directory that contains Home cannot implicitly enumerate or mutate private user state. Explicit child
  projects remain usable, and interactive `/cd <project>` safely relaunches Hara in the selected project while
  preserving explicit profile/model/approval/sandbox choices.
- **Windows portable Home is consistent for direct module consumers.** Explicit Git Bash/MSYS `HOME` wins over
  a different `USERPROFILE` even when callers bypass the normal CLI bootstrap, keeping config, sessions,
  indexes, permissions, cron state, and project boundaries on one private root.
- **Session input is bounded before parsing and recursive processing.** Resume/list reject oversized,
  excessively deep, structure-heavy, symlinked, or hard-linked session files through a verified no-follow
  snapshot; saves fail atomically with compact/new-session guidance before unsafe allocations.
- Upgrade with `npm i -g @nanhara/hara@0.124.3`.

## 0.124.2 — 2026-07-17 — reliable WeCom gateway transport

- **The WeCom gateway is ready only after WeCom accepts its credentials.** Hara now waits for the
  `aibot_subscribe` acknowledgement, stops after five bounded credential failures, monitors heartbeat
  acknowledgements, reconnects half-open sockets with bounded exponential backoff, and stops cleanly when
  `disconnected_event` reports that another active connection replaced it.
- **A failed WeCom delivery is no longer reported as success.** Correlated requests reject on timeout,
  cancellation, connection loss, malformed/nonzero acknowledgements, or missing upload results. Text and file
  transfers have hard deadlines and credential-scoped per-chat FIFO ordering; chunk uploads retry within a
  fixed bound, and transport diagnostics redact the configured Secret.
- **WeCom callbacks now participate in Hara's cross-restart execution boundary.** Stable `msgid` and
  `create_time` metadata feed stale-event filtering, deduplication, and cached no-rerun outcomes so a redelivery
  cannot silently launch the same coding/file task again.
- **Inbound media fails closed and keeps file types separate.** Images remain vision attachments, while files
  and videos become explicit private local-path references. Invalid AES ciphertext/padding is rejected instead
  of returning padded bytes, and unfinished handoffs remove adapter-owned temporary files.
- A deterministic local WebSocket suite covers auth failure, heartbeat reconnection, request errors, strict
  decryption, media classification, two-chunk upload, and a spawned `hara gateway --platform wecom` allowlist
  round trip without using real enterprise credentials.
- Upgrade with `npm i -g @nanhara/hara@0.124.2`.

## 0.124.1 — 2026-07-16 — Windows native private-state and file-identity portability

- **Windows private state works in both Node and the native Bun executable.** Exclusive staging creation now
  uses the portable `wx`/`CREATE_NEW` contract instead of passing Bun numeric flags that could surface a false
  `ENOENT`. Config, credentials, gateway state, discovery records, and other private atomic writers retain
  create-if-absent publication, hard-link fencing, fsync, and fail-closed alias checks.
- **Descriptor-to-path identity checks follow the host's real guarantees.** Windows Node may report a
  volume-derived `dev` from `fstat` but `dev=0` from `lstat` for the exact same NTFS file. Hara now correlates
  an already-open descriptor with its already-bounded path using the stable file id and link count, while
  POSIX still requires device, inode, and owner-only mode. Arbitrary path-to-path protected-file detection
  continues to require device + inode, so the portability fix does not weaken hard-link protection.
- **The release gate now exercises the reported failure on a real Windows runtime.** CI installs the pinned
  Bun 1.3.9 x64-baseline runtime, runs portable file-state contracts, compiles `hara.exe`, and executes the
  hostile-cwd standalone smoke including an isolated `hara doctor`. Bounded failure annotations keep future
  Windows-only regressions diagnosable without exposing credentials. Production dependency audits retry a
  transient registry failure only within a fixed bound and still require a real successful audit result.
- Windows users on 0.124.0 should upgrade with `npm i -g @nanhara/hara@0.124.1`; Desktop releases that bundle
  a sidecar should pin this patch or newer.

## 0.124.0 — 2026-07-16 — task-safe interaction, bounded context, and private-state hardening

- **Idle conversation no longer hijacks an unfinished task.** Ordinary input starts a new execution while
  keeping the conversation thread; explicit `继续` / `continue` / `resume` / `go on` resumes the paused task,
  and `/new` creates a visible task boundary. While a turn is live, Enter still steers it; `/next <message>`
  queues a separate next task.
- **Accepted Desktop steering is crash-safe and exactly-once.** `session.steer` persists a bounded pending
  inbox entry before ACK, writes the projected transcript before delivery, then marks it consumed. Legacy
  audit entries are never replayed, a full pending inbox applies backpressure, and secrets remain redacted.
- **Every model request has a total context boundary.** Oversized historical user/assistant/tool payloads,
  tool-call arguments, and old images are normalized in a provider-only snapshot without rewriting durable
  history. A context-overflow response gets one tighter same-model retry before configured fallback.
- **Compaction is now a bounded execution checkpoint.** The summarizer receives a guarded source snapshot,
  emits structured goals/constraints/decisions/verification/files/errors/checkpoint/blockers/next action,
  and keeps the last three user-turn groups as an anti-drift anchor instead of copying every user message
  into the summary. CLI and Serve use the same contract and restore current touched files.
- **Self-evolution is explicit and auditable.** `/evolve status|now` exposes the mode and manual curation;
  classic and TUI exits share proactive reflection. Candidate observations go to logs, only stable evidence-
  backed facts/preferences enter memory, verified repeatable procedures may become skills, and autonomous
  code/config/permission/system-prompt mutation is explicitly outside the feature.
- **Credential files share one no-alias storage boundary.** Desk registration, identity profiles, Qwen OAuth,
  Weixin credentials/cursors/context tokens, legacy org enrollment, and global config mutations now use
  symlink-free 0700 directories, bounded no-follow reads, hard-link rejection, 0600 fsynced staging, and
  identity-checked compare-and-swap publication. Preseeded aliases fail closed without changing external file
  bytes or permissions; legacy `org.json` archival/removal is bound to the exact verified inode.
- **Text tools no longer rewrite undecodable bytes.** Existing-file preflight for `edit_file`, `write_file`,
  and single/multi-file `apply_patch` uses fatal UTF-8 decoding and keeps the NUL/binary refusal. Invalid input
  fails before the first commit with its original bytes intact, while a valid UTF-8 BOM is preserved across an
  edit instead of being silently stripped.

## 0.123.1 — 2026-07-15 — restore default TUI keyboard input

- **The bracketed-paste proxy now resumes the real terminal stream.** The main TUI closes its temporary
  readline owner before Ink mounts, which leaves `process.stdin` explicitly paused. 0.123.0 forwarded raw-mode
  calls through the new proxy but did not resume that wrapped stream, so the interface rendered while ordinary
  keystrokes never reached the input box. The proxy now mirrors Ink's read/raw lifecycle by resuming on demand
  and pausing again during cleanup.
- **The regression starts from production's actual precondition.** A paused-stdin test verifies ordinary input,
  raw-mode enable/disable, and cleanup instead of relying only on a naturally flowing test stream. Real PTY
  smoke covers ordinary typing, multiline bracketed paste without auto-submit, and terminal-mode restoration.
  Users on 0.123.0 should upgrade; `HARA_TUI=0 hara` remains a temporary classic-input workaround.

## 0.123.0 — 2026-07-15 — task-aware interaction and input/security hardening

- **Conversation and execution are separate state.** Sessions now persist a bounded, redacted task record
  beside the transcript: stable task/turn IDs, the original objective, running/paused/completed/blocked
  status, outcomes, and steering audit. A crashed running task recovers as paused/interrupted; the first
  input after resume continues an unfinished objective instead of silently replacing it. Legacy sessions
  without task state still load normally, and `/task` shows or clears only execution state while preserving
  the conversation.
- **Mid-turn input targets an exact run.** TUI type-ahead carries an `expectedTurnId`, late input remains a
  steer rather than becoming an accidental new task, and Desktop/serve exposes additive `session.steer`,
  task/turn events, resumed task metadata, plus explicit `newTask: true`. Task context is injected separately
  from transcript/project context so a conversational reply cannot redefine the active coding objective.
- **Terminal text paste follows bracketed-paste framing.** Hara enables terminal mode 2004, buffers split
  `ESC[200~`/`ESC[201~` frames into one logical insert, handles immediate paste+Enter correctly, restores the
  terminal on exit, and fails visibly on incomplete or over-2 MiB input. Multiline Claude output no longer
  freezes, disappears, or requires Ctrl+C before it can be pasted.
- **Three reported path/alias escapes are closed.** Windows Guardian containment uses platform-aware relative
  paths; global `~/.hara/config.json` reads reject symlink/hard-link aliases and writes use a private atomic
  replacement without modifying an external inode; organization role sync accepts only portable role IDs
  and verifies every final path remains directly below `~/.hara/org-roles`.
- **Home remains private without becoming inconvenient.** `hara --cwd /path/to/project` explicitly selects a
  project as an alternative to `cd`, and every Home-boundary refusal now shows both choices. Hara deliberately
  does not scan Home and guess a repository, avoiding ambiguous selection and renewed private-directory
  inventory.
- **Cancellation gates no longer probe PID 0.** Computer/cron process-tree fixtures wait for a fully published
  positive child PID before cancellation assertions, retaining the original strict settlement and process
  disappearance deadlines under full-suite contention.

## 0.122.7 — 2026-07-15 — isolated build-context parity

- **Docker builds carry every package-build dependency.** The image build stage now copies the local-link
  diagnostic script before `npm run build`, fixing the `MODULE_NOT_FOUND` failure that blocked the 0.122.6
  Docker CI and GHCR multi-architecture image while npm and native standalone lanes succeeded.
- **The gate follows the build graph instead of one remembered filename.** Runtime packaging tests parse every
  `node scripts/...` dependency from the package build command and require a matching Dockerfile `COPY`, so a
  future build helper cannot pass host-only gates while disappearing from an isolated container context.
- `v0.122.6` remains immutable and is treated as a partial release; 0.122.7 supersedes it after npm, native
  binaries, GitHub Release, and both GHCR architectures are independently verified.

## 0.122.6 — 2026-07-15 — resumed continuity and workspace/input hardening

- **Resume continues the persisted task instead of rediscovering the workspace.** CLI `--resume`/`-c`,
  headless gateway/cron continuations, Desktop `session.resume`, and session forks tell the model that the
  existing history is already authoritative context. A process restart is no longer a reason to restart the
  task, inventory files, or answer with an unrelated workspace summary.
- **Home cannot be promoted into a project one child directory at a time.** When Hara is rooted at the user's
  Home, runtime guards now reject `ls`, directory `grep`, `glob`, `codebase_search`, `@directory` expansion,
  fuzzy `@` inventory, and coding mutations even when the model supplies a named child path. Explicit
  single-file reads remain available; launching Hara from that concrete child project restores normal project
  search, completion, and coding behavior.
- **The regression exercises a disobedient model, not only the prompt.** An end-to-end resumed session uses a
  temporary Home containing a sentinel project, forces the provider to call `ls`, and verifies the tool result
  is a bounded refusal while the persisted history and latest request reach the model without any Home entry
  or file name.
- **Composer tabs no longer move the cursor away from the text.** Literal tabs render and wrap as one-column
  spaces while the editable and submitted prompt preserves the original tab characters.
- **Source builds diagnose stale pre-bootstrap npm links.** If an old `npm link` still points `hara` at the
  now-internal non-executable `dist/index.js`, builds and `npm run doctor:local-link` print the owning Node bin
  directory and the exact relink/`rehash` repair instead of suggesting an unsafe `chmod` workaround. Clean npm
  installs and standalone binaries are unaffected.

## 0.122.5 — 2026-07-15 — standalone ambient-config security boundary

- **Standalone binaries no longer trust the directory they are launched from.** Bun's runtime `.env` and
  `bunfig.toml` autoloading is now explicitly disabled, together with the already-default-off project
  `package.json` and `tsconfig.json` loaders. A repository can no longer run a `bunfig` preload before Hara's
  permission checks or inject project `.env` values into the standalone/desktop-sidecar process. Users of the
  `0.122.4` standalone binary should upgrade promptly; the npm/Node runtime was not affected by Bun's compiled
  executable autoload path.
- **The release gate exercises the real boundary.** Native standalone CI and tag publication launch the actual
  binary from a hostile fixture directory containing both a marker-writing preload and a model-changing test
  `.env`; the build fails if either executes or loads. A source-policy regression test also requires all four
  ambient config loaders to remain explicitly disabled and the smoke to stay wired into CI/release.
- **x64 standalone assets use Bun's baseline CPU target.** Intel macOS, Linux, and Windows sidecar callers no
  longer inherit the modern/AVX assumption from an unqualified x64 target, improving compatibility with older
  Intel machines and Rosetta validation without changing ARM64 builds.
- **Optional native search stays optional at build time.** TypeScript now has an explicit ambient contract for
  `@zvec/zvec`, so npm can omit the unsupported macOS Intel binding without breaking `npm ci`; runtime loading
  still falls back to the durable JSON search path when the native module is unavailable.

## 0.122.4 — 2026-07-14 — bounded agent lifecycle and chat delivery hardening

- **An active agent can no longer renew itself forever.** Every CLI, headless, org, and Desktop/serve turn
  now has a 30-minute total wall-clock deadline and a 64 model/tool-round ceiling, independent of streaming
  activity and per-tool timeouts. A visible warning fires after five minutes or at 75% of the round budget;
  reaching either hard boundary returns an actionable `halted` outcome to the terminal, Desktop protocol, or
  gateway reply. `runTimeoutMs` (friendly `30m`/`90s` values; hard max 2h) and `maxAgentRounds` (hard max 256)
  can raise/lower the bounds but cannot disable them.
- **Repeated failures now trip a real circuit-breaker.** The third identical failing tool call closes its
  protocol round and stops the run instead of merely asking the model not to repeat itself. A final round cap
  still catches alternating or superficially changing loops.
- **Cancellation reaches owned work.** Tools receive the combined user/deadline signal; foreground shell and
  external-agent process trees terminate on it, and read-only sub-agents inherit the parent's cancellation
  with tighter 8-minute/24-round limits. Providers/tools that ignore `AbortSignal` are raced at the core, so
  Hara itself still settles on time and never executes a late next tool call. File, memory, skill, and gateway
  outbox writes re-check cancellation immediately before commit, while session ownership remains held until an
  uncooperative tool physically settles, preventing a timed-out write from racing the next turn.
- **One-shot model helpers are hard-bounded too.** Setup checks, role routing, plan decomposition and
  verification, commit-message generation, session naming, conversation compaction, vision analysis, and the
  security guardian now combine cooperative abort with a hard Promise deadline. A custom provider that ignores
  cancellation can no longer strand the CLI before or after the main agent loop.
- **Cron can no longer hold its global tick lock forever.** Scheduled jobs keep their 30-minute per-job
  deadline and the whole tick now has a non-renewable 60-minute wall-clock watchdog. Timeout cancellation
  force-stops the owned process tree, always releases the tick lock, records `running`/`timed_out`, duration and
  last error durably, counts timeouts toward `alertAfter`, and lets later due jobs run after an individual job
  timeout (a total-tick timeout stops the remainder). `HARA_CRON_JOB_TIMEOUT_MS` and
  `HARA_CRON_TICK_TIMEOUT_MS` tune the millisecond bounds, with hard maxima of 24 hours and 5 hours; a scheduled
  job is additionally capped by its tick. `hara cron list` now makes active and timed-out work explicit.
- **Cron timeout notifications survive transport outages and restarts.** Each outcome/threshold alarm is
  committed with terminal state before delivery, keeps one stable idempotency key across bounded per-tick
  retries, and is removed (with alert cooldown recorded) only after confirmed transport success. Each job's
  queue is capped at 64: launches reserve room for outcome + alert, disable before overflow, and recovery may
  compact only an old outcome while marking that loss explicitly; jobs.json also has schema/count/byte limits.
  Configure the failure threshold with `--alert-after 1..1000` or the cron tool's `alertAfter` field.
- **Cron recovery no longer mistakes PID reuse for a live owner forever.** The tick and synchronous jobs-store
  locks use Linux/macOS process-birth identity; store commits additionally use a conservative renewable lease,
  snapshot CAS, and a token fence.
  Unknown identity formats and live legacy identity-less commit guards fail closed instead of being age-stolen.
  A `running` record beyond the 24-hour hard job maximum plus grace is marked interrupted and disabled even if
  its PID is alive. Recovery never kills or replays the possibly orphaned task; it persists the failure
  notification for operator verification. Manual runs also refuse every unresolved `running` marker; if its
  parent is dead, Hara records an interrupted/disabled state and requires operator inspection before retrying.
- **Creation-minute cron jobs now use an explicit one-shot due marker.** A job added just after that minute's
  OS tick runs once on the next tick, while disabling it clears the marker so a later enable cannot replay a
  days- or months-old occurrence. Absolute one-shot schedules already in the past are rejected instead of being
  displayed forever as a misleading next run.
- **`hara resume <id>` now re-enters the correct runtime without blocking terminal input.** The launcher uses
  the same runtime-aware self command as cron/gateway and waits asynchronously with inherited stdio: npm/Node
  keeps its script entry, while a Bun-compiled standalone re-executes only the binary instead of treating its
  virtual/user `argv[1]` as JavaScript. This removes the standalone resume hang/high-CPU/dead-input failure.
- **The home directory is no longer an implicit repository.** Canonical/real-path checks suppress first-run
  AGENTS generation and reject `hara init`, repo indexing, codebase search, and recursive grep/glob/inventory at
  the Home root (including symlink aliases). Hara shows a `cd /path/to/project` hint; non-recursive `ls`, explicit
  file reads, and explicitly selected child directories remain usable.
- **Recursive project discovery is streaming and interruptible.** Glob/grep fallback, codebase search, semantic
  indexing, recall, Desktop file lookup, did-you-mean, and `@dir` expansion share file, directory, Dirent, and
  wall-clock bounds from the start of discovery. Cached empty-directory forests and a single extremely wide
  directory can no longer block the event loop past the agent deadline; truncated indexes are never published.
- **Windows shell and portable-home discovery are deterministic.** Hara probes the conventional Git Bash
  installation paths before falling back to `cmd.exe`, understands MSYS drive paths and UNC paths, and honors an
  explicit `HOME` ahead of `USERPROFILE` so portable/Git-Bash sessions do not silently load another profile.

- **Long chat replies now split on natural line/word boundaries without tearing Unicode.** Feishu and
  Telegram bubbles preserve the exact reply while keeping emoji ZWJ sequences, flags, combining marks, CRLF,
  and surrogate pairs intact whenever the platform limit permits.
- **Only one Hara gateway process may own a configured bot connection at a time.** A credential-scoped,
  crash-safe private lease refuses a second live Feishu/Telegram/etc. connection and reclaims only a
  proven-dead owner, preventing multiple WebSockets from replying to the same event.
- **Stable inbound message ids are deduplicated across restarts.** Successfully handled Feishu and Telegram
  ids are persisted for one hour in a byte- and count-bounded owner-only store; failures remain retryable,
  concurrent duplicates and startup replays older than 30 seconds are ignored, and different bot credentials
  use isolated stores. State contains ids/timestamps and a one-way connection namespace only—never message
  text, user data, or credentials.
- **Outbound chat transport is bounded and ordered across adapter instances.** Telegram and Feishu text/file
  requests use real `AbortSignal` cancellation plus a hard 30s/120s ceiling; a credential-scoped, process-wide
  per-chat lane prevents long multipart replies from interleaving with one-shot or flow delivery. A failed or
  timed-out call settles for its caller without freezing shutdown or the inbound retry claim; an ambiguous
  underlying transfer remains quarantined in that live process's lane until it actually settles.
- **Flow side effects resume from durable receipts.** Each reply, notification target, and pending approval has
  a stable, credential-scoped receipt. Redelivery skips locally completed receipts, pending actions reuse their
  stable opaque id, and idempotency keys are forwarded where supported. A crash after remote acceptance but
  before the local receipt commit can still cause at-least-once delivery on transports without server-side
  deduplication. No-tool model decisions, bounded failure attempts, and partial target/chunk progress also
  survive restarts, so a retry cannot mix a newly generated answer into an older partially delivered flow.
- **Stable-id gateway events do not re-execute coding or stateful commands on delivery retry.** A private
  started marker is durable before coding, tmux injection, `/new`, `/voice`, `/say`, or `/send`; completed
  reply/file/default-voice bytes are durable before transport. Default voice retries therefore reuse the same
  synthesized bytes instead of rerunning coding or TTS. Speech now has a 60-second default/120-second hard
  deadline, propagates shutdown cancellation to remote requests, and terminates the full local
  `say`/custom-command process tree.
- **Interrupted gateway outcome markers have an explicit fail-closed recovery path.** A credential-scoped,
  single-instance `hara gateway --recover-outcome ... --confirm-recovery terminalize:<id>` command releases one
  abandoned active slot without rerunning its side effect; a separate exact confirmation can later delete only
  an already-terminal tombstone. Running or unacknowledged completed records cannot be silently erased.
- Feishu outbound REST now uses native abortable requests with an in-memory, early-refresh tenant-token cache;
  the official SDK remains responsible for the inbound WebSocket/resource surface. Hara resolves mentions
  from event metadata and drains tracked callbacks before releasing the single-instance lease on shutdown.

## 0.122.3 — 2026-07-14 — standalone runtime recovery

- **Bun-compiled standalone binaries no longer assume `SharedArrayBuffer` exists at module startup.**
  The short synchronous waits used by cross-process stores now prefer `Bun.sleepSync`, lazily use
  `Atomics.wait` only on Node when its primitives exist, and retain a bounded last-resort delay. This
  fixes the macOS arm64 `ReferenceError` that could make the 0.122.2 standalone binary exit before
  even printing `--version`; npm/Node and GHCR users were unaffected. CI now compiles and executes a
  native standalone binary on Linux and macOS, and the release job executes its native Linux asset
  before publishing, so a merely successful cross-compile is no longer accepted as runtime proof.

## 0.122.2 — 2026-07-14 — reproducible container release

- **The Docker build now includes the guarded runtime entry before normalizing package modes.** This fixes the
  `runtime-bootstrap.cjs` `ENOENT` that affected only the `v0.122.1` GHCR image job; its npm package and
  standalone binaries were already published and remain valid. CI now builds and starts the complete runtime
  image before a tag can be released, while old Node installations continue to receive the explicit 22.12+
  upgrade instruction.

## 0.122.1 — 2026-07-14 — protected files and explicit extension trust

- **The npm CLI now requires Node.js 22.12+.** Node 20 is end-of-life, so Hara no longer makes a security or
  compatibility promise for it. npm metadata, `hara doctor`, and startup diagnostics now agree; an older
  runtime exits with a direct `nvm install 22 && nvm use 22` upgrade hint. Standalone binaries and Desktop
  sidecars remain self-contained and do not require a host Node installation.
- **Built-in file access fails closed before ordinary approval/dispatch.** Canonical and real-path checks
  reject `.env`/`.env.*`, credential stores, private keys, and private Hara runtime state in file reads,
  edit/patch pre-reads, grep/glob/ls, `@file`/completion, codebase and stale semantic indexes, checkpoints,
  gateway file delivery, and cron command admission. Safe templates such as `.env.example`, `.env.sample`,
  and `.env.template` remain readable. `HARA_ALLOW_SENSITIVE_FILES=1` is an explicit launch-time exposure
  switch for one process; it removes both these built-in denies and that process's shell protected-read mask.
- **Shell protection now reflects the host's guarantees.** Tool subprocesses receive a scrubbed environment;
  inherited variables can be explicitly retained with the launch-time `HARA_SUBPROCESS_ENV_ALLOW` list, and
  output is redacted by secret pattern and exact inherited value. Under the default protected-file policy,
  shell admission blocks literal protected paths and environment dump commands on every platform. macOS
  additionally applies a Seatbelt read mask to existing protected
  files/directories, even when the general write sandbox is off. Linux and Windows do not have that kernel
  read mask: their arbitrary shell code is not a security sandbox and static preflight can be bypassed.
- **MCP servers and external coding agents are explicit trusted extensions.** They execute outside Hara's
  protected-file boundary, require confirmation on every interactive tool call (including `full-auto`), and
  are disabled in non-interactive runs by default. Reviewed automation may opt in before launch with
  `HARA_ALLOW_TRUSTED_EXTENSIONS=1`; inherited credentials are still scrubbed.
- **Repositories no longer silently control Hara's privileged configuration.** Project config is limited by
  default to validated presentation/model preferences; provider routes, credentials, hooks, MCP, sandbox,
  guardian, approval, and automation settings require the launch-time `HARA_TRUST_PROJECT_CONFIG=1` opt-in.
  Project permissions may tighten global policy but cannot grant new access, and Git-tracked `.hara-profile`
  pins are ignored unless that same trust decision was made before startup. Symlink, hard-link, size, identity,
  and concurrent-change checks protect each of these inputs, while diagnostics reveal key names but no values.
- **Coding and project-state writes are transactional.** Edit, patch, undo, memory, skills, plans, profiles,
  indexes, and gateway state use no-follow descriptors, inode checks, bounded reads, atomic replace or
  compare-and-swap semantics, and private modes where appropriate. Protected search uses the same verified
  descriptor path instead of handing sensitive-path decisions to `rg`, closing replacement and hard-link
  races. `AGENTS.md`, subdirectory hints, mentions, and touched-file recall are bounded and reject protected
  aliases before adding repository content to model context.
- **Semantic search and review automation distrust stale or historical content.** Semantic indexes carry a
  versioned manifest with content hashes and are rebuilt when source identity or bytes change. Review-chain
  prompts receive bounded status/path metadata rather than Git patches; an auto-commit proceeds only when the
  staged blob still matches the verified worktree descriptor, including deletion and SHA-256 repository edge
  cases. Read-only auto-run Git policy excludes commands that can expose historical blobs, credentials, remote
  URLs, or patch bodies.
- **Old private state is tightened and stale checkpoint history is rotated.** Startup repairs `~/.hara` and
  sensitive runtime trees to owner-only modes on POSIX systems. The protected checkpoint format rebuilds old
  derived shadow repositories, filters protected paths independently of the launch-time exposure switch, and
  purges a checkpoint repository if a protected blob ever reaches its index.
- **Long-running work has bounded ownership and shutdown.** Shell jobs, external agents, gateway children,
  approved organization flows, and cron commands terminate the whole process tree with TERM-to-KILL escalation
  and stop accepting output after cancellation. Background job counts, cron run time/log size, lock takeover,
  and context fan-out are capped; Windows shell aliases and environment-dump variants are denied consistently.
- **Gateway outbound files are immutable after admission.** Telegram, Feishu, Slack, Discord, Mattermost,
  Matrix, WeCom, and Weixin upload verified in-memory bytes plus a safe filename, so a queued path cannot be
  swapped for a secret before delivery. Counts and bytes are bounded at queue and consume time, cleanup checks
  inode identity, and Signal outbound files fail closed because its RPC accepts only reopenable filesystem paths.

## 0.122.0 — 2026-07-13 — structured runs, durable work, and a fail-closed gateway

- **Machine-safe headless runs.** `hara -p … --schema <json|file>` installs a run-scoped
  `structured_output` contract, validates the value against JSON Schema, and writes exactly one JSON value to
  stdout. Prose, auth notices, retries, and provider/schema failures cannot masquerade as machine output:
  diagnostics go to stderr and failures exit non-zero. `hara -p … --role <id>` now applies the role's persona,
  model, and allow/deny tool policy instead of changing the prompt alone.
- **Agents have stable homes.** `hara projects add/list/remove` maintains a private, atomic registry of project
  homes; `hara agents` builds one address book from global and registered-project roles.
  `hara org --role project:agent …` resolves unambiguously and executes at that home with its project context/config. Concurrent
  CLIs safely share the registry, and dead lock owners can be reclaimed without stealing a live lock.
- **Two levels of work state.** `todo_write` is now isolated per interactive/headless/sub-agent/serve session
  and persists with the session, so concurrent agents cannot overwrite each other's checklist. The new `task`
  tool is a durable cross-session project pool with owners, statuses, `blockedBy` dependencies, cycle checks,
  and private atomic cross-process persistence. `hara serve` exposes the pool through `tasks.list`.
- **10-platform gateway, with project-agent roaming.** Telegram, WeChat, Discord, Feishu/Lark, Slack,
  Mattermost, Matrix, DingTalk, WeCom, and Signal adapters now classify direct vs multi-party chats
  conservatively. The full coding agent accepts only verified private messages; unknown channel shapes fail
  closed. `/agent <name|project:name>` pins a thread to an indexed agent and its home, while `/agent main`
  restores the prior project thread. Chat/session preferences survive project round-trips and group-member
  state is isolated.
- **Untrusted group flows cannot reach coding tools.** Opt-in `~/.hara/flows.json` rules are hot-reloaded and
  evaluated through a bounded, stateless provider call with `tools: []` — no shell, files, MCP, session, or
  project context. Rules support trigger filters, JSON Schema, disposition-based notification/auto-reply,
  redacted rotating logs, and rate/concurrency caps. Proposed sends and agent dispatches are parked unless an
  explicitly configured safe `replyOn` disposition applies.
- **Single-owner, idempotent approvals.** Consequential flow actions require a unique allowlisted owner and a
  verified private channel. Deterministic `/approve <id>`, `/edit <id> <content>`, and `/reject <id>` commands
  avoid “latest draft” ambiguity; blank edits fail closed. Pending actions use private atomic storage and a
  compare-and-set execution claim, shared by chat and the new serve `approvals.list/resolve` inbox, so two
  approval surfaces cannot double-send. Deferred actions are parked only for one-shot delivery targets
  (Telegram, Feishu/Lark, or WeChat); other adapters fail closed instead of presenting an unusable approval.
- **Bounded gateway execution and media.** Turns are FIFO per session (depth 8), with four active children,
  bounded global/session-key backlogs, a 15-minute default/30-minute hard timeout, and TERM-to-KILL shutdown;
  non-zero or signalled children fail visibly. Inbound attachments are authorized before download, limited to
  four files and 20 MiB each, streamed into private random paths with time/concurrency/retention quotas, and
  expired after 24 hours. Progress markers are recalled in `finally`, gateway chat/session files are `0600`
  with lock-before-load persistence, and ambiguous/stale locks are never reclaimed merely by age.
- **Layered flow admission.** Group classifiers are capped globally (20/minute, 120/hour), per rule/platform/chat
  (10/minute, 60/hour), per sender (5/minute), and at four active runs. Rate maps and key sizes are bounded and
  saturation fails closed, so rotating identities cannot grow memory or bypass the host-wide ceiling.
- **Live config for persistent clients.** `hara serve` rebuilds cwd-specific provider routes, credentials, and
  guardian settings on sessions/turns; `initialize`, `models.list`, and new sessions reflect current defaults.
  Resumed sessions retain their explicit model pin while using the live provider route, so credential rotation
  and project config edits no longer require a server restart.
- **Coding-path robustness.** File reads/search/edit/patch now reject FIFOs/devices and symlink races, cap reads,
  use bounded subprocess search with a linear glob matcher, preserve exact file modes, and roll back multi-file
  patches without overwriting concurrent replacements; writes move-claim the expected inode and commit with
  create-if-absent semantics, while `/undo` applies the same identity checks. Blank
  project/env routing values no longer mask valid global config; precedence is environment > project > overlay
  > global. Web fetch/search blocks IPv4-mapped and full link-local IPv6 SSRF forms and tries regional providers
  sequentially instead of broadcasting a successful query. Package installs stay attached with bounded
  long-operation timeouts, tunnel commands preflight their binaries, TUI resize repaints reliably, persisted/
  public text redacts secrets, and session writes are private, atomic, and cross-process safe.
- **Interrupts and non-interactive outcomes are honest.** Cancelling a parallel tool round records matching
  interrupted results while preserving completed side effects; serve approvals settle immediately on interrupt.
  The stream-stall watchdog is a hard Promise boundary even when a provider ignores its abort signal.
  Headless and org runs now exit non-zero on provider errors, empty/halted turns, schema failures, and rejected
  reviews; plan atoms stop on the same outcomes instead of being verified as done, and failed implementers are
  never committed. Read-only roles are resolved before startup and launch neither hooks nor configured/plugin
  MCP subprocesses.
- **Private serve lifecycle.** `~/.hara`/`serve.json` are tightened to `0700`/`0600` and discovery is fsynced,
  atomically replaced without following symlinks, and removed only by its owning instance. Discovery failures
  close the listening socket. Serve-side compaction is mutually exclusive with turns/config changes, carries an
  abort signal, releases locks on interrupt/shutdown, and has a 60-second hard deadline.

## 0.121.1 — field-feedback reliability & credential safety

- **Terminal resize no longer erases the composer.** Hara clears stale Ink output only before a real
  width change; height-only window drags keep the input box visible and width changes repaint immediately.
- **Credentials stay out of durable transcripts and generated code.** Session writes deeply redact likely
  keys/tokens/passwords (including tool inputs/results); legacy content is redacted when loaded and migrated
  on its next atomic, private save. Interactive pastes get a warning without echoing the value. The agent must use environment references,
  never literal secrets in code/commands, and may only populate a real-secret `.env` when explicitly asked.
- **`web_search` has a verified mainland path.** A configured Tavily request races the keyless Bing China
  HTML path; Baidu, Google, and DuckDuckGo remain concurrent secondary fallbacks. Provider timeouts are
  isolated, and JavaScript-only `web_fetch` pages now explain that a browser/API/connector is required
  instead of returning a misleading empty body.
- **Long setup commands fail usefully.** Package installs automatically become background jobs unless the
  caller explicitly sets timeout/background, while ngrok tunnels preflight local authentication once and
  stop with a focused fix instead of cycling through unrelated tunnel tools.
- **Persistent desktop sessions re-read configuration.** New/resumed `hara serve` sessions pick up rotated
  `apiKey`/model/baseURL values without a restart; empty env/project values no longer mask valid global
  config, and a 401 says the configured credential expired rather than asking users to paste it into chat.

## 0.121.0 — `hara desk` · crash-safe coding/files · bounded interactive I/O

- **`hara desk` connects the CLI to the shared coordination desk.** Register an agent, post/list/
  claim/complete/ack/cancel tasks, and persist the desk token with owner-only file permissions. The
  client identifies itself as `hara-cli`, so mixed Codex/Claude Code/hara fleets remain legible.
- **Coding edits are transaction-safe.** `write_file` uses same-directory atomic replacement;
  multi-file patches validate every destination before writing and roll back already-committed
  files if a later commit fails. Undo snapshots are captured before mutation, failed writes do not
  create false undo history, and symlink/non-regular destinations are rejected consistently.
- **Large files stay useful without flooding memory or context.** Slice reads stream only the
  requested line window, `@file` mentions have explicit byte/line caps, and tool results are
  bounded centrally (including plugin/MCP results) with clear truncation metadata.
- **Interactive input is friendlier and bounded.** The TUI composer has shell-style up/down history
  with draft restoration, duplicate suppression, navigation reset after edits, and a fixed maximum
  history size. The ask-mode sentinel is also source-safe on every supported Node runtime.
- **Faster cold start.** Unicode-width data and the write/edit tool graph are loaded only when the
  active command needs them, reducing startup work for lightweight commands such as `--version`.
- **Production dependency hardening.** The Lark SDK's Axios transport is pinned to a patched 1.x
  release instead of its vulnerable `~1.13.3` range; the production npm audit is clean at release.

## 0.120.0 — `hara feedback`: one door for humans and agents

- **`hara feedback "what happened"`** files a structured GitHub issue (repo hara-cli/hara,
  label `feedback`) via the gh CLI, with a copy-paste fallback. Auto-collects hara version /
  OS / Node / provider:model (never keys) and aggressively redacts credentials
  (sk-/ghp_/AWS/Bearer/JWT/key=value families). `--session` opt-in attaches a redacted session
  tail (issues are public); `--dry-run` prints without filing. Matching .github issue forms
  ship in the repo — hand-filed and command-filed reports read identically.
- **Security stance (documented)**: hara agents exchange structured data — they never accept
  task instructions from untrusted parties. Cross-trust-boundary agent task-passing is
  permanently out of scope; feedback/issues are the entire agent-to-agent surface.

## 0.119.2 — TUI: update notices actually visible · CJK-correct input wrapping

- **Update notices now render INSIDE the TUI** (yellow line under the header card). They used to
  print to stdout before ink mounted and vanished when the TUI took the screen — which is why TUI
  users never saw them and versions silently went stale (field report: stuck on 0.112.5).
- **Input wrapping measures terminal CELLS, not characters.** CJK/emoji render 2 cells wide;
  mixed 中文+ASCII prompts used to overflow the real width and get soft-wrapped a second time
  mid-word ("output" torn into "ou/tput"). Long words hard-break per code point so a double-width
  char never straddles the terminal edge.

## 0.119.1 — field-feedback robustness: param gate · no-hang git · actionable timeouts · stale-artifact rule

- **Required-parameter gate.** A tool call arriving WITHOUT its required parameters (observed:
  qwen3.7-plus dropping write_file's path/content, then retrying the same broken call forever) is
  now rejected before execution with an error naming exactly what's missing; repeat-guard
  escalates if the model loops anyway. Empty strings stay legal.
- **git can no longer hang to the timeout.** Shell commands run with `GIT_TERMINAL_PROMPT=0` +
  `GCM_INTERACTIVE=never` (user env overrides win): an https op that wants credentials fails in
  seconds with a real auth error instead of sitting silently for 5 minutes.
- **Timeouts tell you what to do next**: larger `timeout_ms` for long builds, `background:true`
  for servers, and for network ops — diagnose or skip, never blind-retry.
- **Stale-artifact rule** (prompt): before previewing generated artifacts, verify they're newer
  than their sources; AGENTS.md/README command sequences are authoritative — middle steps (render/
  build) are never skipped. Pairs with hara-design 0.3.6's deterministic staleness tripwire +
  preview idle auto-exit.

## 0.119.0 — project panels: the chat ↔ live-preview split

- **Plugin panels become project-aware.** A plugin panel can declare `detect` markers (e.g.
  `.hara/design`, `remotion.config.ts`); `project.panels` returns the panels applicable to a
  project's cwd. In Hara Desktop, opening a design/video project surfaces a preview toggle right
  on the conversation — talk to the agent on the left, watch the live preview react on the right.
  Detect-less panels stay global-only (settings page).

## 0.118.0 — session delete & fork · slash skills over serve

- **`session.delete`** — permanent removal (codex thread/delete; archive stays the soft path).
  Lock-aware: refuses when a live other process holds the session; busy-guarded on live turns.
- **`session.fork`** — duplicate a session's history into a new live session (codex thread/fork),
  rewind's non-destructive sibling: explore a different direction without losing the original.
  Forks persist immediately.
- **Slash skills over the wire** — `session.send` with a leading `/skill-id request…` expands into
  the CLI's skill-entering flow, so a desktop composer's "/" popup triggers exactly what the
  terminal gets. Unknown ids fall through as plain text.

## 0.117.0 — serve batch 3: context watermark · compact · rewind · fuzzy file search

Codex-desktop parity for the conversation-hygiene set — everything a client needs to keep a long
session healthy without dropping to the CLI:

- **Context watermark everywhere.** Every `session.send` result and `event.turn_end` now carries
  `ctx: { lastInput, window, pct }` — how full the model's window was on the last turn. Clients
  render a live meter with zero extra round-trips. `session.context` returns the same watermark
  plus the spend breakdown (your messages / assistant / per-tool) on demand.
- **`session.compact`** — the CLI's `/compact`, serve-side: summarize-and-replace with the same
  8-section brief, working-memory notes kept on the session, and the recently-touched-file restore
  (limited to files under the session's own cwd — serve is multi-session; nothing leaks across
  projects). Busy-guarded like a turn.
- **`session.rewind`** — fork the thread back to before the n-th-most-recent user turn (codex
  `thread/rollback`). History-only; file edits are not reverted.
- **`files.search`** — fuzzy project-file lookup (git-aware listing + the CLI's fuzzy ranker),
  powering @-mention autocomplete in the desktop composer. Resolves the search root from an
  explicit `cwd` or a `sessionId`.

## 0.116.0 — the desktop-grade serve protocol (models · automation · rename/archive · capabilities)

- **Session source stamping.** Sessions now record WHO created them (`interactive` / `gateway` / `cron`,
  env-derived; the cron runner passes the job name along) — and automated sessions get a
  **"name · MM-DD HH:mm" title at creation**, so a cron prompt never becomes a session title again.
- **`hara serve` protocol, batch 2** (everything the Hara desktop app drives):
  - `models.list` (endpoint model catalog + thinking-effort levels) and `session.set-model`
    (per-session model/effort switch, applies next turn)
  - `automation.list` — cron jobs with last outcome + automated sessions, for the desktop's
    automation timeline
  - `session.rename` + `session.archive` (archived sessions hidden from lists, kept on disk)
  - `initialize` now advertises `capabilities.methods` — clients feature-detect instead of
    probing for method-not-found
  - `session.send` expands `@file` mentions (CLI parity)
  - `session.list` carries `source` / `sourceName` / `archived`

## 0.115.0 — serve exposes plugins & skills (desktop plugin panel)

- **`hara serve` protocol grows a plugin surface**: `plugins.list` (installed plugins with enabled state +
  contribution counts), `plugins.set` (enable/disable by name — applies to future sessions/turns), and
  `skills.list` (the skill index for a cwd). This powers the hara desktop app's plugin manager panel;
  any WS client gets it for free.

## 0.114.0 — long files read in slices · repeat-guard anti-spinning · `hara serve` (the desktop/IDE backbone)

- **Long files no longer flood the context.** `read_file` now returns cat-n numbered lines with
  `offset`/`limit` slicing (2000-line default window, per-line truncation, a header that says how to
  continue). The old behavior dumped the whole file (100K-char cap) — ~25k tokens per read, tail
  unreachable. Paired prompt rules: grep-then-slice on long files, and **no whole-file re-read after a
  successful edit** (the slowest habit an agent can have). This is the "hara is slow on long files" fix.
- **Repeat-guard — the anti-spinning tripwire.** When the EXACT same tool call (same tool, same
  arguments) fails twice in a row, the result now carries an explicit "repeating this unchanged will
  fail again — change something or ask the user" note. The guardian breaker covers DENIED actions;
  this covers FAILED ones (observed: 4× the same `git pull` into a dead network). Successes reset the
  streak; `/reset` clears it. Plus prompt rules: diagnose before retrying, two failed variants → step
  back and re-plan.
- **`hara serve` — a persistent local server (WebSocket JSON-RPC v1)** that desktop shells, ACP and
  IDE clients drive: `initialize` (token auth) · `session.create/resume/list/send/interrupt` ·
  streamed `event.text/reasoning/tool/diff/notice/turn_end` · **approval round-trips**
  (`approval.request` ⇄ `approval.reply`, 5-min deny-timeout, deny-on-disconnect) · sessions are the
  SAME `~/.hara/sessions` store the CLI uses (single-writer lock respected) · `~/.hara/serve.json`
  discovery file. This is the backbone the new hara desktop app (Tauri) speaks to.
- `tools/all.ts` — library entries (serve, embedders) now register the full built-in toolset; an
  unregistered tool was silently unplannable.

## 0.113.0 — DeepSeek reasoning control (thinking + effort, incl. `max`) · host-unreachable memory

- **DeepSeek reasoning is now a real dial.** DeepSeek's V4 models (`deepseek-v4-pro` / `deepseek-v4-flash`)
  added a per-request thinking switch on the OpenAI-compatible chat path — `thinking: {type}` plus
  `reasoning_effort` (native `high`|`max`; `low`/`medium` map → high server-side). hara now sends both via a
  new `deepseek` reasoning style: **`off` → `thinking:{type:"disabled"}`** (reasoning_effort has no "off"),
  any level → `thinking:{type:"enabled"}` + the effort. The `/model` picker's ←→ thinking dial now lights up
  for DeepSeek. Verified against the live API: `off` emits no `reasoning_content`, `high`/`max` stream it
  (`max` thinks measurably harder than `high`), and tool-calls work with reasoning on.
- **New `max` reasoning level.** `hara config set reasoningEffort max` (and the picker's ←→) now accept
  **`max`**, the top of the dial. On DeepSeek it becomes `reasoning_effort:"max"`; on OpenAI reasoning models
  it clamps to `high` (OpenAI has no `max`, so it never 400s); on Anthropic it takes the largest thinking
  budget. Existing `off`/`low`/`medium`/`high` are unchanged.
- **Host-unreachable memory — stop re-hanging on a dead host.** When a network command (git clone/pull/fetch,
  curl, …) fails to CONNECT — a TCP connect timeout or DNS failure (macOS's ~75s SYN timeout), *not* an
  auth/404/connection-refused — hara now remembers that host for the session and **fast-fails later network
  ops to it instantly** instead of eating another ~75s per retry. The failure output also flags that git
  ignores the macOS system / Clash proxy unless configured (`git config --global http.proxy`). Cleared by
  `/reset`. Paired with a system-prompt rule: reuse a local checkout before cloning, don't swap in a public
  mirror for a private repo, and verify connectivity yourself rather than trusting "the network is fine".

## 0.112.5 — single-writer session lock

- **A double-resume can no longer corrupt session history.** A single-writer lock serializes session writes
  so two processes resuming the same session don't interleave and clobber the transcript.

## 0.112.4 — reasoning models don't false-timeout · cross-provider fallback routes correctly

- **A reasoning model (qwen3.7-plus / GLM / DeepSeek) thinking on a long context no longer false-times-out.**
  These models stream `reasoning_content` (the thought) for a while — often long — before the first real
  `content` token. The stall watchdog was only fed by rendered output, so on a big context (e.g. 58
  messages) the model could still be thinking when the 120s "no output" timer fired. Now **every stream
  chunk — reasoning, tool-args, even suppressed reasoning — resets the watchdog** (new `onActivity`), and
  the default stall timeout is **120s → 240s** (still `HARA_STALL_TIMEOUT`-tunable). Confirmed: simple
  calls always worked; only the long-context interactive case timed out — a hara bug, not the API.
- **`bash` default timeout 120s → 300s** — a long file transform/build legitimately runs past two minutes;
  it was erroring out. (Set `timeout_ms`, or `background:true` for a server.)
- **Cross-provider fallback now targets the right endpoint.** With `fallbackModel` set but no
  `fallbackBaseURL`, the fallback reused the PRIMARY baseURL — so e.g. a `deepseek-v4-pro` fallback got
  posted to `coding.dashscope` → 400. New **`fallbackProvider`** config routes the fallback to that
  vendor's endpoint + its own key (`fallbackBaseURL`/`fallbackApiKey` still override); and a mismatched
  fallback (a different-vendor model with no routing configured) is now refused with a clear warning
  instead of silently 400-ing on failover.

## 0.112.3 — big file write no longer traps the model in a "params not passed" loop

- **Fixed the loop where a model (glm-5 / qwen via DashScope) repeats `write_file` / `bash` with empty or
  `undefined` arguments.** Two problems compounded: the OpenAI-compatible path capped output at
  `max_tokens: 8192`, so a large `write_file` (e.g. a 64-hexagram data file) ran PAST the limit and its
  tool-call-arguments JSON was cut off — and hara then **silently swallowed the unparseable JSON into an
  empty `{}`**. So the tool ran with no path/content (`bash` got `command: undefined` →
  `/bin/sh: undefined: command not found`), the model saw the failure, "fixed" it by calling again, and
  looped — never realizing its *output* had been truncated. Now: (1) `max_tokens` is raised to 32000
  (glm-5/qwen accept it), and (2) **truncated/malformed tool arguments surface as an actionable error**
  ("the model hit its output-length limit mid tool-call — write the file in smaller parts") instead of a
  silent `{}`, so the loop breaks and the fix is obvious.

## 0.112.2 — moving/resizing the window no longer garbles the UI

- **Terminal resize no longer stacks the status row + input box into a garble.** ink 6.8's resize
  handler only clears the screen when the terminal gets *narrower*; on a *widen* (or a resize it doesn't
  classify as narrowing) it just re-renders, so the old frame — reflowed at the new width — is never
  erased, and the ~125ms spinner tick stacks a fresh copy each time (the "I moved the window and the UI
  filled up with repeated `waiting for the model…` lines"). hara now hooks the resize event and, on ANY
  resize, resets ink's tracked output (debounced across a drag's burst of events) so the next render
  starts clean and subsequent ticks erase correctly. Not "just the terminal" — a real repaint fix.

## 0.112.1 — the background-job indicator is now LIVE (even at idle)

- **`⚙ N bg running` updates in real time — including when hara is idle.** In 0.112.0 the indicator only
  refreshed while a turn was running, so once the agent finished but a background task (a preview server,
  a watcher, a long render) was still going, the idle prompt looked exactly like "nothing running" — and
  the user reads that as *"why did it just stop?"*. Now `jobs.ts` emits on every start / self-exit / kill
  and the status row subscribes, so the indicator appears the moment a task starts, updates as tasks
  finish on their own, and clears when the last one ends — event-driven, no polling. (`/jobs` remains the
  on-demand detailed view.)

## 0.112.0 — /jobs: see (and manage) what's running in the background

- **`/jobs` — a user-facing view of the agent's background shell jobs** (dev servers, watchers, long
  builds started via `bash {background:true}`). hara already tracked these for the *agent* (the `job`
  tool), but the *user* had no way to glance and see "what's running back there" — the way codex and
  Claude Code surface it. Now: `/jobs` lists them (id · status · age · command), `/jobs tail <id>`
  shows recent output, `/jobs kill <id>` stops one. Works in the TUI and the readline REPL.
- **Status row shows a `⚙ N bg` indicator** when background jobs are running, so a preview server /
  watcher humming along is visible at a glance (live while working; `/jobs` is the on-demand truth).

## 0.111.0 — an interactive /model picker: ↑↓ a model, ←→ its thinking

- **`/model` (no argument) now opens an interactive picker** built on the provider registry — the
  "one key, many models" flow. It pulls the endpoint's **live model list** (`GET /models`; a coding-plan
  key exposes ~10: Qwen / GLM / Kimi / MiniMax / …), and you drive it with the arrow keys:
  - **↑↓** move through the models,
  - **←→** set the **thinking level** for this endpoint — the levels come from the registry's reasoning
    style, so a DashScope/Ollama endpoint shows `off / on` (the real speedup toggle) while an
    OpenAI/Anthropic one shows `off / low / medium / high`,
  - **⏎** applies (switches the model, sets the dial, rebuilds the provider, persists to the session),
    **esc** cancels.
  Endpoints that don't enumerate models still let you set the thinking level (and `/model <id>` still
  switches directly, as before). TUI only; the readline REPL keeps the text form.

## 0.110.0 — a provider registry: one key, many platforms, the right wire + thinking control for each

- **hara now speaks each platform its own way, chosen from a data-driven registry (a dictionary), not
  scattered if/else.** One row per platform declares its **wire protocol** (chat / Anthropic / Responses)
  + how it expresses the **thinking dial** + how it **caches**. Point hara at a custom baseURL and it Just
  Works:
  - **Any vendor's `.../anthropic` endpoint** — DeepSeek, Kimi/Moonshot, Zhipu GLM, MiniMax, and Alibaba's
    `…/apps/anthropic` — now routes through the **Anthropic wire** (so you get prompt caching + a native
    thinking budget). Verified end-to-end against Alibaba's endpoint.
  - **Local Ollama / LM Studio** (`localhost:11434` / `1234`) — `reasoning off` sends `think:false`, which
    actually stops a local reasoning model's thinking phase (**measured: deepseek-r1:14b 17s → 0.6s**).
  - **Alibaba DashScope** chat (coding plan / pay-as-you-go) — `reasoning off` → `enable_thinking:false`
    (**qwen3.7-plus ~14s → ~1.6s**); works for a custom `qwen3.7-plus`/`glm-5` profile, keyed on the
    endpoint, not the model name.
  - OpenAI reasoning models keep `reasoning_effort`; Anthropic keeps its thinking budget. The dial **UNSET
    leaves the request untouched** everywhere (model default, zero impact — the safe default).
  - The Responses API (Alibaba Token Plan's newest models) is a distinct wire hara doesn't speak yet; a
    Responses endpoint now returns a clear pointer to use the chat or `/apps/anthropic` endpoint instead
    (rather than sending a body it would reject). Coming once there's a Token-Plan key to verify against.
- **Windows: hara no longer hangs at startup / on the first command.** Three SYNCHRONOUS probes ran with
  no timeout, so on Windows a slow/hung one froze the whole process (main-thread block — nothing could
  interrupt it): the `where bash` shell probe (added in 0.109.0), `git ls-files` (the "which files exist"
  scan), and the per-turn shadow `git add -A`. All three are now bounded (3s / 5s / 10s) and fall back
  gracefully (cmd.exe / filesystem walk / skip the snapshot). This is the "stuck at shell/directory
  probing, never got to the actual work" hang.

## 0.109.5 — Enter enters the conversation instantly + reasoning off truly disables DashScope thinking

- **Pressing Enter now enters the conversation flow instantly — the message no longer sits stuck in the
  input box.** A turn's synchronous prep (reading an inlined `@file`, base64-encoding pasted images) used
  to run *before* ink could paint, so with a heavy message (a big spec + two images) Enter looked dead
  for seconds ("回车一直不动") until the work finished. The submit now yields one tick so the UI paints
  the committed message + cleared input + spinner FIRST, then does the prep and the (often slow) model
  call. Instant feedback regardless of how heavy the turn or how slow the first token.
- **On DashScope, `reasoning off` now actually stops the thinking phase — not just hides it.** DashScope
  models (Qwen, GLM, …) stream a "thinking" pass *before* the answer; that generation is the main latency
  there (measured: **qwen3.7-plus ~14s with thinking → ~1.6s without**). hara previously assumed chat
  models "can't be silenced server-side" and merely dropped the reasoning from the UI — so the model
  still spent the time. It *can* be silenced: reasoning **off** now sends `enable_thinking: false` (fast),
  low/medium/high sends `true`, and the dial **UNSET leaves the request untouched** (model default — zero
  impact, the safe default). Detected by the **DashScope endpoint** (built-in `qwen`/`qwen-oauth`, or a
  custom baseURL on `dashscope.aliyuncs.com`), not the model name — so a custom `qwen3.7-plus` profile is
  covered. Set it with `HARA_REASONING_EFFORT=off` or `reasoningEffort: "off"` in `~/.hara/config.json`.
  (A runtime `/reasoning` toggle — adjust it mid-session like Claude Code — is coming next.)
- Note: `enable_thinking:false` is reliable on qwen3.x-plus; on some other DashScope models it only
  suppresses the reasoning without the full speedup, which is why it's opt-in, not a forced default.
- Context on prompt caching (from 0.109.1): that path only ever applied to the raw **Anthropic** provider.
  DashScope/GLM/DeepSeek/gateway go through the OpenAI-compatible path, where caching is the provider's own
  automatic prefix cache — and hara's system prompt is stable across turns, so it engages on its own.

## 0.109.4 — a dropped file path is read, not "Unknown command"

- **Dragging/pasting a file into the prompt no longer errors.** A dropped file pastes as an absolute path
  (`/Users/…/spec.md`, often with trailing text or `[Image #N]` tokens). Because it starts with `/`, hara
  treated it as a slash command and replied `Unknown command /Users/…`. Now the command parser only fires
  when the first token has **no embedded slash** (real commands — `/help`, `/design` — never contain one),
  so a path falls through to the normal turn. And when a message *begins* with an existing absolute path,
  that path is rewritten to an `@`-mention so its content is **read into the turn** — i.e. "interpret this
  file" just works. Fixed in both the TUI and the readline REPL.

## 0.109.3 — an empty model response no longer looks like a hang

- **A turn that comes back with no text and no tool calls is no longer silently dropped.** The agent
  loop treated an empty completion as "done" and returned with zero feedback — so after e.g. a "继续"
  the box just sat there, idle, looking frozen for hours (CPU 0%, waiting at the prompt) when really
  the turn had vanished. It now **retries once** with a nudge (an empty response is usually a transient
  hiccup), and if it's still empty says so plainly (`✻ empty response — nothing to do. Rephrase…`)
  instead of disappearing. Matches how Claude Code / codex refuse to end on a blank turn.
- **Closed a matching spin:** a `tool_use` stop reason carrying an *empty* tool list used to push an
  empty tool round and re-request in a loop; it's now bounded by the same single-retry guard. (The
  120s stall-watchdog already covered a genuinely dead/silent socket — this covers the case where the
  request *succeeds* but returns nothing.)

## 0.109.2 — long paste no longer freezes the input box

- **The input box now draws a bottom-anchored viewport, not every wrapped row.** A long multi-line
  paste (a spec, a stack trace, a design brief) wraps to hundreds of rows; rendering *all* of them on
  every keystroke floods ink's layout+diff and the box appears frozen ("卡着" — you type and nothing
  moves). It now renders at most ~14 rows around the cursor with `⋯ N more lines above/below` markers,
  so a huge paste stays smooth and the box stays a sane height. (This closes the freeze that 0.109.0's
  "paste inserts as real multi-line text" could reach — the two ship as a pair.) A tip if a paste was
  meant to *launch* a skill: a plain long message relies on the model to pick the skill; prefixing the
  explicit command (e.g. `/design <brief>`) enters that mode deterministically and immediately.

## 0.109.1 — prompt caching + dynamic compaction (the "why is it slow" fix)

- **Prompt caching, finally on.** Every turn used to re-send *and re-process* the whole prompt —
  system + all tool definitions + the entire growing history — with **no cache breakpoints**, so the
  model re-billed and re-crunched everything from scratch each turn. The longer the session, the
  slower and pricier each reply. hara now sets Anthropic `cache_control` breakpoints on the static
  prefix (system, which covers tools+system in cache order) and two rolling points at the message tail,
  so each turn reads the unchanged prefix **from cache** (~10% the cost, and far lower time-to-first-
  token). This is the single biggest latency win as history grows. (Cache engages once the prefix
  passes Anthropic's ~1024-token minimum — i.e. any real coding session.)
- **Auto-compaction now actually fires on big-window models.** It triggered at 85% of the context
  window — but on a 1M-token model that's **850k tokens**, a size a session drags sluggishly toward and
  realistically never hits, so it never compacted and the prompt just kept bloating. Added a **dynamic
  absolute cap**: compact once the live context passes ~200k tokens *regardless* of window size (either
  trigger — % of window OR the cap — fires). Override with `HARA_AUTO_COMPACT_TOKENS`; opt out as before
  with `autoCompact: false` / `HARA_AUTO_COMPACT=0`.
- Studied codex (Rust `prompt_cache_key` + a 1000-char paste-fold threshold) and cc-haha (Claude Code's
  session-stable cache TTL) to land the breakpoint layout and keep the TTL steady within a session.

## 0.109.0 — real multi-line input + Windows shell

- **Pasted multi-line text is now real, editable text in the box** — not a `[Paste]` token, not an
  auto-submit. The input box renders `\n` as actual line breaks (deterministic wrap now treats a
  newline as a hard row break), so a pasted paragraph / code / stack trace shows in full, you edit it,
  and only a real **Enter** sends it. (0.108.1 over-corrected by folding every paste to a token; this
  is codex's behavior — the composer is a multi-line textarea, a pasted newline is content.) A truly
  enormous dump (>8000 chars) still folds to a token so it can't wall off the screen.
- **Windows: the shell no longer hard-fails.** The bash tool hardcoded `/bin/sh`, which doesn't exist
  on Windows — so every command errored. Now on Windows hara prefers a real **bash** (Git Bash / WSL,
  which it probes on PATH) so the POSIX commands the model writes keep working, and falls back to
  `cmd.exe` with a one-time notice pointing at the fix. (Still no auto-`cron install` or sandbox on
  Windows — those stay Unix-only, as before.)

## 0.108.1 — pasting no longer sends the message

- **A pasted newline is content, not "send".** Pasting multi-line text used to fire the message at
  the first newline (any 1–2 line paste under 600 chars auto-submitted) — the classic "I pasted and
  it sent before I could edit" bug. Now ANY paste containing a newline folds to a `[Paste #N +L lines]`
  token and waits; only a real **Enter** sends it (the token expands to the full text on submit). This
  is codex's paste-burst rule — Enter inside a paste is a newline, not a submit. A lone newline typed
  at the prompt still sends, as before.
- (Slow paste *recognition* over a remote/SSH terminal is chunk-delivery latency — network-bound, not
  something the client amplifies; local pastes arrive as one chunk and are instant.)

## 0.108.0 — cron grows up: chat-native scheduling, delivery, a deterministic lane

Distilled from a three-way study of openclaw (the production-grade scheduler running our company),
hermes (the best creation UX), and hara's own minimal cron:

- **`cronjob` model tool** (hermes parity): "every morning at 9, check X and send me a summary" in
  chat just works — one action-style tool (add/list/remove/enable/disable/run), approval-gated like
  any exec. **Recursion guard**: sessions spawned BY a cron job can't schedule more jobs.
- **`--command` deterministic lane**: run the task as a plain shell command — no agent, no tokens,
  exact exit codes. Fixed scripts stop burning an LLM round just to type `python script.py`.
- **Result delivery** (openclaw/hermes parity): `--deliver telegram:<chatId> | feishu:<chatId> |
  webhook:<url>` pushes each run's outcome (+ output tail) to a channel — no gateway process needed,
  adapters fire one-shot from the same env vars.
- **Failure alerts**: 3 consecutive failures (per-job `alertAfter`) → one 🚨 on the deliver channel,
  6h cooldown, streak resets on success.
- **Per-job timezone**: `--tz Asia/Shanghai` pins cron expressions to a wall clock (IANA, validated
  at add time) instead of whatever the machine happens to be set to.

Still the lightest of the three: no daemon — the OS (launchd/crontab) ticks `hara cron`.

## 0.107.0 — interjection triage: the model is the scheduler, the todo list is the queue

- **Mid-task messages get triaged, not blindly folded in.** Typing while hara works always reached
  the model between tool calls (type-ahead steering) — but nothing told it HOW to handle the
  interjection. Now every mid-task message carries a triage contract, backed by a standing policy in
  the system prompt: a **refinement** folds into the current task immediately; a **new independent
  task** goes onto the todo queue (`todo_write`, one-line acknowledgment, current work continues);
  something **urgent** — a bug, "stop", "this first" — finishes the current step safely (no half-done
  edits), re-plans the queue, and switches immediately. Same architecture codex and Claude Code
  landed on: no engine-level priority scheduler — classification is exactly what the model is best
  at, and the todo list (with its live panel + attention refresh) is the task queue.

## 0.106.0 — gateway session hygiene

- **Idle chats auto-rotate to a fresh thread.** A WeChat/Feishu chat is one endless surface — days-old
  context used to pile onto every new ask and the agent answered from stale state. Now a chat idle
  past **8 hours** (HARA_GATEWAY_IDLE_HOURS to tune; 0 disables) starts the next message on a fresh
  session, with a one-time notice carrying `/resume <id>` — the old thread persists, nothing is lost.
  Same-afternoon follow-ups continue as before.

## 0.105.0 — fan-outs synthesize before acting

- **Synthesis nudge** (the last adopted item from the Claude Code internals study — their KN5
  synthesizer, hara-shaped): when a round returns **3+ parallel agent reports**, a silent
  system-reminder tells the model to merge them first — reconcile overlaps and conflicts explicitly,
  note what only one report saw, state the merged conclusion — instead of anchoring on whichever
  report happens to sit last in context. Rides the 0.100.0 reminder layer; no new machinery.

## 0.104.0 — compaction keeps your working files + honest context accounting

Closes the last two adopted items from the Claude Code internals study, and un-breaks the release
pipeline.

- **Post-compaction file restore** (CC's TW5): compaction now re-attaches the CURRENT on-disk content
  of the files the conversation was most recently working with (top 5, byte-capped) — the summary is
  no longer the model's only anchor, so it doesn't re-read its own working set or act on a stale
  memory of an edited file.
- **Context threshold ladder + cache-aware accounting**: the footer's `ctx N%` turns yellow at 60%
  and red at 80% (auto-compact fires at 85), so compaction never surprises you. And on Anthropic
  endpoints, input accounting now includes cache reads/writes — cached sessions used to under-report
  context fullness so badly that auto-compact could never fire before overflow.
- **Release pipeline fixed** (every `v*` tag's release workflow had been failing silently):
  the Docker image's `npm ci` ran the `prepare → tsc` hook before src was copied; and the standalone
  binaries died on the Feishu SDK's default import under bun's ESM resolution. Both corrected —
  binaries + ghcr image ship again from this tag.

## 0.103.0 — the project-analysis SOP (why hara felt slow on "analyze this repo")

The execution layer could always parallelize reads and fan out read-only sub-agents — but nothing
TAUGHT the model, so it explored one call per turn. Distilled from codex's prompt discipline and
Claude Code's Explore-agent pattern:

- **System prompt playbook**: batch independent tool calls in one response (reads execute in
  parallel); analyzing a project starts with a ONE-batch wide sweep (manifest + README + build/CI
  config) then narrow grep/glob; more than ~3 searches → fan out `agent` sub-agents, several in one
  response.
- **`agent` tool grows WHEN-TO-USE / WHEN-NOT-TO-USE guidance** (CC's heuristic): narrow lookups go
  to direct tools; open-ended "how does X work across the codebase" goes to sub-agents.
- **Built-in `explore` persona** — `agent(role:"explore")` works with zero setup: read-only, parallel
  searches, excerpts not whole files, returns conclusions with path:line refs, never dumps. A
  user-defined explore role still wins.

## 0.102.0 — a slow network never feels dead

Jeff + a designer colleague both hit the same thing: press Enter on a slow connection and hara
"looks stuck — thought it failed". Studied codex's handling (15s connect timeout, 2–9s stream-idle
timeout, Working[Xs·Esc] status machine) and closed the gaps:

- **Stall watchdog.** A model attempt that streams NOTHING for 120s (HARA_STALL_TIMEOUT to tune) is
  aborted and routed through the normal error→failover path — `fallbackModel` picks it up
  automatically, or you get a clear "model stream timeout — no output for 120s" instead of an
  infinite spinner. A real Esc stays an interrupt (never rewritten).
- **"waiting for the model… Ns".** The status row now distinguishes the pre-first-token stretch from
  actual work (a new turn-phase channel published by the loop) — on a slow route you can SEE the
  request is out, ticking, interruptible.
- **Big pastes fold to a token.** Pasting a long/multi-line text used to flood the box AND could
  auto-submit at the first newline mid-paste. Now ≥3 lines or ≥600 chars folds to a highlighted
  `[Paste #1 +N lines]` token (Claude-Code style): the box stays small, typing stays smooth,
  backspace deletes it whole, and the FULL text expands into the message on submit.

## 0.101.1 — the input box stops running to the top

- **Live-region overflow guard.** A long streaming answer (or a big diff) used to grow the live region
  past the terminal height — at which point ink's in-place repaint breaks and the input box "runs to
  the top of the screen". Live blocks now render a bounded tail window (sized to your terminal, elided
  lines counted in a dim header); the FULL text lands in scrollback the moment the block finalizes,
  and ctrl+t shows it live. Same treatment reasoning got in 0.99.2, now for answers and diffs — the
  dynamic region can no longer outgrow the viewport, which is the invariant that kept codex stable
  (line-level commits) and pushed Claude Code to a fullscreen ScrollBox.

## 0.101.0 — startup update check

- **`hara` tells you when it's out of date.** On launch (interactive TTY only), a one-line notice —
  `⬆ Update available 0.100.0 → 0.101.0 · npm i -g @nanhara/hara` — driven by a daily background
  probe with a 3s timeout that NEVER delays startup (the notice always comes from the previous
  probe's cache, npm update-notifier style). npmjs first, npmmirror fallback for CN networks;
  offline machines fail silent and back off to daily retries. Disable with
  `hara config set updateCheck false` or `HARA_UPDATE_CHECK=0`.

## 0.100.0 — the agent keeps its own attention: system-reminders + anti-drift compaction

Distilled from a source-level study of Claude Code v1.0.33's agent internals (the Ie1/WD5 reminder
layer and the AU2 compaction template).

- **system-reminder injection layer.** An event queue (`agent/reminders.ts`) that lands queued context
  as ONE `<system-reminder>`-wrapped message before the next model call — visible to the model, never
  rendered in the transcript, and always carrying the "ignore unless relevant" disclaimer so a nudge
  can't derail unrelated work. Quiet (sub-agent) runs neither drain nor push, so parallel fan-outs
  can't steal the main conversation's reminders. First wired event:
- **Todo attention-refresh.** When a checklist has unfinished items and goes 5 tool-rounds untouched,
  the model gets a reminder re-showing the authoritative list and asking for a status pass — so long
  tasks stop silently abandoning their own plan. Any `todo_write` resets the clock; after firing it
  re-arms (at most one nag per 5 rounds).
- **Compaction brief: 6 → 8 sections (anti-drift).** `/compact` and auto-compaction now also preserve
  **All user messages** — your own words survive verbatim, in order, however hard the history is
  squeezed — and **Key technical concepts**, so the next turn doesn't re-derive the stack.
  (`COMPACT_SYSTEM` moved to `agent/compact.ts` where tests pin the structure.)

## 0.99.3 — TUI: rock-steady input box (constant-height chrome) + plan mode grows a real handshake

Built from a source-level study of codex-rs (bottom-anchored viewport, plan cells) and Claude Code
(flexShrink-pinned bottom region, ExitPlanMode handshake).

- **The input box no longer jumps at turn boundaries.** The bottom chrome is now a CONSTANT-height
  stack: a permanent one-row status slot above the box swaps its content — spinner + verb + queue count
  while working ⇄ dim key hints when idle — instead of appearing/disappearing (the old `Working` block +
  `⌨ working` hint row cost ±3 rows at every turn start/end). The shift+tab picker (`ModeLine`, now ONE
  row with short inline descriptions) swaps into the SAME slot, so popping/auto-hiding it moves nothing.
  The todo panel no longer folds on a 30s timer (which yanked the box up while you read) — it folds to
  its one-line summary when the NEXT turn starts, coinciding with your own submit.
  - `tui/App.tsx`: `StatusRow`/`ModeLine` + the constant slot; fold-on-submit; `tui/InputBox.tsx`: the
    working-hint row and two-row ModeBar are gone (mode still reads colored in the footer).
- **Plan mode: the MODEL now decides when the plan is ready** (Claude-Code style), instead of hara
  nagging "proceed?" after every read-only turn. A run-scoped `exit_plan` tool (new `extraTools` option
  on `runAgent` — per-run tools, never registered globally) is offered only in plan mode; when the model
  calls it, the plan renders as a bordered `╭─ Plan` block (codex ProposedPlanCell-style) and THEN the
  proceed picker appears. Investigation/Q&A turns end quietly, still in plan mode.
  - `agent/loop.ts`: `opts.extraTools` (advertised post-filter, resolved before the registry);
    `index.ts`: plan branch rewired + `PLAN_SYSTEM` teaches the exit_plan contract.

## 0.99.2 — TUI: steadier input box + transient approval selector

- **Approval-mode selector is now transient, not always-on chrome.** The persistent two-row ModeBar under every
  frame is gone; the current mode reads inline in the status footer (colored: red=full-auto, cyan=plan,
  green=edit), and **shift+tab** pops the full picker + descriptions, which auto-hides after ~2.5s. Reclaims two
  rows and cuts per-frame redraw during streaming — matching codex (transient approval overlay + compact status
  line) and Claude Code.
  - `tui/InputBox.tsx`: `footerParts`/`approvalColor` (colored mode in the footer); `ModeBar` gated on a new
    `showModeSelector` prop. `tui/App.tsx`: shift+tab arms a 2.5s auto-hide timer.
- **Input box no longer bobs up/down while the model thinks.** A streaming reasoning block used to render up to
  ~11 live rows above the input, then fold to a single "✻ thought · N lines" line on finalize — that N→1
  collapse yanked the box up every time. Reasoning now shows a **compact 1-line header by default** (same height
  as the folded form → zero jump); **ctrl+r** expands the full streaming body, and **ctrl+t** always has the full
  text. (ink can't bottom-pin the composer the way codex's ratatui viewport does, so this removes the dominant
  jump; minor spinner/panel shifts at turn boundaries remain.)
  - `tui/App.tsx`: the reasoning `Block` renders header-only unless `open` (ctrl+r).

## 0.94.1 — unreleased (gateway: relay is on-inbound, not a noisy push)

- **Fix the bind output relay to be quiet + platform-correct.** 0.94.0's continuous 3s timer-push flooded chat
  (a message every few seconds) and hit iLink's `ret=-2` (its bot model is passive-reply, no continuous push).
  Replaced with **on-inbound relay**: when you message a bound/registered pane, the daemon captures the pane,
  injects your text, waits ~3s, and replies **once** with the session's NEW output (`🖥 <pane>\n<delta>`). One
  reply per message — no spam, and it fits iLink's "one inbound → one reply" model. Send `?` to peek again.
  - `tmux-routes.ts`: `pickPaneForReply()` (pick+consume, no inject); the timer loop is gone.
  - `serve.ts` onMessage: capture-before → inject → settle → reply with `outputDelta`.

## 0.94.0 — unreleased (gateway: bind output relay — two-way remote terminal)

- **Output relay for `hara remote bind`** — the daemon now polls each bound tmux pane and pushes its NEW output
  back to chat once it settles, so a session you drive from your phone is **two-way**: your replies inject in
  (existing), and you SEE the session's output come back (`🖥 <pane>\n<delta>`). Only bound (`bind`) panes; the
  first sighting is baselined (no dump of the pre-existing screen); best-effort send (iLink cold-push may drop a
  message when the chat is cold). Pure `outputDelta` (append / unchanged / scroll-anchor / tail) unit-tested.
  - `src/gateway/tmux-routes.ts`: `boundRoutes`, `capturePane`, `outputDelta`.
  - `src/gateway/serve.ts`: a 3s relay loop in `runGateway` (capture → settle → send delta), cleared on abort.
  - Caveat: a full-screen TUI session (e.g. Claude Code's ink UI) relays the rendered frame; a non-TUI /
    `HARA_TUI=0` / `-p`-style session relays cleaner. 285 tests.
## 0.93.0 — unreleased (hara remote — universal chat-driven HITL for any tmux session)

- **`hara remote`** — a first-class, agent-agnostic command so ANY terminal session in tmux (Claude Code, codex,
  hara, a plain REPL) can be driven from chat, not just via the Claude-Code wechat-send skill:
  - `hara remote ask "<q>"` — register this pane (one-shot) + push the question to WeChat; your reply injects back.
  - `hara remote bind` — **persistent bind**: every WeChat reply injects into this pane until `unbind` / `/detach`
    (drive a whole session from your phone while you're out, many messages, not just one).
  - `hara remote unbind` · `hara remote status`.
- Route store gains `mode: "once" | "bind"`; the daemon consumes "once" routes but keeps "bind" ones
  (`pickRoute`/`deliverToTmux`). New `/detach` chat command unbinds all persistent panes from your phone.
- Generic by design: the injection is just `tmux send-keys`, so it works for any program reading stdin in the
  pane — the agent only needs to call `hara remote ask` when it wants your input (the confirm-loop pattern).
- 284 tests (+ bind-mode `pickRoute`); persistent-bind verified live (two replies → same pane, route persists).

## 0.92.0 — unreleased (gateway: reply-into-tmux — two-way HITL for any running session)

- **Reply routing into an already-running tmux session** — a session you started yourself (Claude Code / codex /
  hara, in tmux) can ping you on WeChat and, while you're away, your reply gets **injected back into that exact
  session** so it continues. No need to launch it under a supervisor or use a blocking tool — borrows the ccgram
  keystroke-injection pattern (the only way to retrofit a session the daemon doesn't own).
  - `src/gateway/tmux-routes.ts`: a route store (`~/.hara/gateway/tmux-routes.json`) + `tmux send-keys` injection.
    The gateway daemon, on an owner reply, injects it into the **oldest live registered pane** (`deliverToTmux`),
    one-shot per ask, dead panes pruned. Pure `pickRoute` + `paneAlive` (list-panes membership) unit-tested.
  - `serve.ts` `onMessage`: a non-slash reply is routed to a waiting pane (and the task isn't re-run) — owner-gated
    by the existing allowlist; only panes that **opted in** are ever touched.
  - The `wechat-send` skill gains `--ask`: send a question + register this tmux pane for the reply.
- Live-verified the injection path (send-keys → pane received the line); fixed `paneAlive` (display-message was
  too lenient → use `list-panes -a` membership). 283 tests.

## 0.91.0 — unreleased (external_agent: delegate to Claude Code / Codex)

- **`external_agent` tool** — hand a self-contained task to an EXTERNAL coding agent (**`claude`** / **`codex`**)
  running headless in the current dir, and get its result back. Zero new deps — drives each agent's native
  headless flag (`claude -p … --output-format text --permission-mode …`, `codex exec … --cd … --sandbox …`)
  over `node:child_process`, not openclaw's heavier ACP/acpx stack. Pick the best engine per task.
  - **Gated**: `kind:"exec"` → inherits the approval flow; and because read-only fan-out sub-agents only get the
    `READONLY_TOOLS` allow-list, this privileged tool is **never** exposed to them.
  - **Trust tiers** `externalAgentTrust` / `HARA_EXTERNAL_AGENT_TRUST` = `off | gated (default) | full`. `gated`
    runs the external agent in its safe sub-mode (`claude --permission-mode plan/acceptEdits`,
    `codex --sandbox read-only/workspace-write`); the dangerous bypass/full-access sub-modes are only reachable at
    `full`. Backend allow-list (claude/codex), timeout + output cap. Pure `buildExternalArgv` unit-tested.

## 0.90.0 — unreleased (gateway: WeCom + Signal → 10 platforms)

- **WeCom (企业微信)** — connects out to WeCom's AI-Bot WebSocket gateway (no public webhook). `HARA_WECOM_BOT_ID`
  + `HARA_WECOM_SECRET`. Two-way: inbound text + images (incl. AES-decrypted attachments → `~/.hara/wecom/media`),
  outbound text/image/file. Zero new deps (native WebSocket + node:crypto).
- **Signal** — talks to a local **signal-cli** daemon (JSON-RPC). `HARA_SIGNAL_RPC_URL` + `HARA_SIGNAL_NUMBER`.
  Inbound text + image attachments, outbound text/file; phone numbers redacted in logs. signal-cli is an external
  daemon the user runs (documented). Zero new npm deps.
- Pure parsers `parseWecomMessage` / `parseSignalMessage` unit-tested. docs/gateway.md + README updated to 10
  platforms. Ported from the openclaw + hermes adapters.

## 0.89.0 — unreleased (gateway: Slack · Mattermost · Matrix · DingTalk + docs)

- **Four more platforms**, all zero-new-dep (native WebSocket / `fetch`), same `ChatAdapter` seam:
  - **Slack** — Socket Mode (connects out, no public URL). `HARA_SLACK_APP_TOKEN` (xapp-) + `HARA_SLACK_BOT_TOKEN`
    (xoxb-). Inbound text + image files (downloaded via the bot token); outbound text + file upload.
  - **Mattermost** — v4 WebSocket + REST. `HARA_MATTERMOST_URL` + `HARA_MATTERMOST_TOKEN` (bot/PAT). Two-way images.
  - **Matrix** — `/sync` long-poll. `HARA_MATRIX_HOMESERVER` + `HARA_MATRIX_TOKEN` + `HARA_MATRIX_USER_ID`.
    Two-way images; **unencrypted rooms only in v1** (no E2EE).
  - **DingTalk (钉钉)** — Stream Mode (connects out). `HARA_DINGTALK_CLIENT_ID` + `HARA_DINGTALK_CLIENT_SECRET`.
    Text in/out via the per-message `sessionWebhook`; **v1: no file send, inbound images arrive as `[图片]`**.
  - Each platform's wire parser (`parseSlackEvent` / `parseMattermostPost` / `parseMatrixEvent` / `parseMxc` /
    `parseDingtalkMessage`) is pure + unit-tested.
- **Docs** — new **[docs/gateway.md](docs/gateway.md)** documents all 8 platforms (Telegram · WeChat · Discord ·
  Feishu/Lark · Slack · Mattermost · Matrix · DingTalk): a capabilities table, common config
  (`HARA_GATEWAY_ALLOWED`, `--cwd`, slash commands, two-way images), and per-platform setup. Linked from README.
- Ported by studying the openclaw + hermes adapter implementations; live-tested per platform as tokens become
  available.

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
