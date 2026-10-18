# Learnings

## [LRN-20261018-SETTINGS-READONLY-MIGRATION] correction

**Logged**: 2026-10-18
**Priority**: high
**Status**: implemented and synthetic-tested on isolated fix branch; not released
**Area**: workspace

- Jeff elevated four independent review findings to constraints, not optional polish. Read-only local
  discovery must disable npm's notifier and use offline mode even for `npm config get prefix`.
- Valid data plus a denied/timed-out/unsupported credential migration is pending, not corrupt. Validate
  every row before side effects, preserve original bytes and return empty/read-only connections; keep
  scoped roster/history available and model admission closed. Never serialize underlying vault errors.
- Remember a blocked source fingerprint for the Host lifetime so ordinary snapshots cannot repeatedly
  prompt. A confirmed generation/revision-scoped retry is distinct from refresh, polling or reconnect.
- A missing primary is empty only when its recovery copy is also absent. Existing backups, including
  older pure schemas, recover read-only in memory. A sole credential backup cannot trigger vault writes
  or be overwritten by a newly initialized empty store.
- Preview and import must share the 80-character label bound; do not shorten separate model-ID limits.
- Evidence: 11 pre-fix red tests, 15 new passing regressions; preserve the related-suite timing failure
  separately rather than silently replacing the full result with a later isolated pass.

---

## [LRN-20261018-STABLE-WORKSPACE-SETTINGS] Stable storage, explicit import and version-locked skills

**Logged**: 2026-10-18
**Priority**: high
**Status**: implemented on isolated fix branch; not released
**Area**: workspace

- A GUI's short launchd PATH and private SDK HOME are different boundaries. Pass trusted host Home
  separately for bounded discovery/import; never reuse it as a runtime's credential/config Home.
- Hara already stores Workspace resources under a bundle-independent root. Missing legacy connections
  came from intentional scope isolation without an import path, not evidence that bundle-id data vanished.
  Preview metadata only; require an explicit copy into the current scope; keep generations frozen per run.
- Fixed-service Keychain refs belong to scope/connection/generation. Rotate/revoke metadata before cleanup;
  persist pending removals so denial/crash is explicitly retryable without reviving an old binding.
- A recovery-copy error after primary commit is not a rollback. Remove a newly staged credential only
  when unchanged primary metadata positively proves no commit; uncertain outcomes preserve it. Fault
  injection must target the private writer's actual link-based commit, not an assumed rename-to-target.
- Schema migrations must back up recoverable, keyRef-only metadata before replacing a plaintext source.
  Unknown future schemas and backup recovery are read-only; a backup must not resurrect deleted keys.
- A global skill is versioned source material, not authority. Pin a verified text bundle per Workspace;
  private edits fork it. Pi reads only enabled locked copies, via supplied tools and the original scope.
  A skill's allowed-tools policy narrows execution, including same-round batched calls; it never widens it.
- Cron inventory is read-only evidence. Fixture migration/receipt and unchanged real scheduler state are
  separate from an approved live cutover. Never label an empty scoped list as absence of old schedules.

---

## [LRN-20261018-WIP-EXECUTION-RULES] best_practice

**Logged**: 2026-10-18
**Priority**: high
**Status**: resolved
**Area**: architecture

### Summary

Carry useful main-WIP execution lessons into the Workspace branch as bounded rules, not another
prompt or executor. Full originals remain at `wip/main-backup-20261018` / `864ef3a`.

### Retained rules

1. Acceptance is based on fresh, task-scoped tool/artifact receipts. Failed, unknown, bookkeeping,
   duplicate or stale evidence cannot close a task; a public prompting talk is not runtime authority.
2. An accepted completion receipt may produce a bounded human closeout without another paid model
   turn. Keep unfinished human dependencies and authoritative state visible; final prose is not
   proof that an upload, message or deployment actually completed.
3. Measure parent-loop round trips, input reuse and whole delegation-tree cost before adding engines.
   Historical 87% latency observations are measurements of their original corpus, not a current SLO.
4. Native question support is not parent-chat input wiring. Preserve the exact worker/provider,
   canonical worktree, frozen task/session lineage, single writer, original consent and input lease;
   UI reconnect must not upgrade authority or duplicate a child card.
5. Reuse one progress/budget decision across compatible adapters while preserving distinct task,
   turn and native-session lifetimes. Hiding execution UI alone does not reduce model consumption.
6. Bun Windows `B:/~BUN/...` and POSIX virtual entry forms require real compiled-platform checks.
   Local source execution cannot establish Windows bootstrap or installed-package correctness.

### Sources

Main-WIP entries `LRN-20261010-ACCEPTANCE-SOURCES`, `LRN-20261008-FB1521-RECEIPT-ONLY-FINALIZATION`,
`LRN-20261005-AGENT-LATENCY-IS-ROOT-LOOP-ROUNDS`, `LRN-20261008-STRUCTURED-WORKER-INPUT`,
`LRN-20261009-TASK-CLOSEOUT`, `LRN-20261009-RUNTIME-CONSOLIDATION` and the Windows virtual-entry
record. Dated candidate/test/publication states remain historical on the backup; no live Key call,
new runtime implementation or current release acceptance is implied by this consolidation.

---

## [LRN-20260828-EXTERNAL-SESSIONS-ONE-AUTHORITY] best_practice

**Logged**: 2026-08-28T00:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: architecture

### Summary

External coding-agent integration should separate persistent Agent identity, provider session, Hara task,
execution run, and transient workforce actors. Each provider session has one lifecycle authority, with Hara
defaulting to sanitized read-only discovery and fork-first continuation instead of screen scraping or
concurrent takeover.

### Details

Herdr's server-owned semantic state and Gas Town's identity/run/activity separation fit Hara when translated
into the existing Serve, Space, Session, Task, and Workforce contracts. The UI is a projection and game
animation is never work truth. Provider-native IDs, full paths, transcripts, reasoning, credentials, tool
arguments, and provider cursors stay behind Serve. Local external sessions remain Personal unless the user
later grants a specific audited company share. Structured events and bounded schedulers replace any
always-on LLM status patrol.

Desktop launchers often have a minimal `PATH`. Resolving an NVM/FNM-installed `codex` executable is not
enough when its shebang uses `/usr/bin/env node`; Core must bind the verified executable to its sibling
runtime directory in the scrubbed child environment. Automatic discovery should ignore arbitrary PATH
entries and use only explicit or bounded install roots, so a project-local lookalike cannot shadow Codex.

### Suggested Action

Complete the capability-gated phases in order: metadata, explicit read, fork/lease/epoch/idempotency,
Hara-owned live runtimes, phone publication, then company governance. Add the Claude Agent SDK as an
optional signed capability rather than adding its approximately 206 MB native binary to every Hara install.

### Metadata

- Source: architecture_review
- Related Files: src/external-sessions/, src/serve/server.ts, hara-desktop/docs/EXTERNAL_SESSION_RUNTIME_PLAN.md
- Tags: codex, claude, sessions, identity, lifecycle, mobile, tenancy
- Pattern-Key: architecture.external_sessions_one_authority_fork_first
- Recurrence-Count: 1

---

## [LRN-20260929-JIT-CODING-RUNTIME-ROUTING] correction

**Logged**: 2026-09-29T02:13:50+08:00
**Priority**: high
**Status**: in_progress
**Area**: frontend

### Summary

Hara users should not preconfigure a Codex or Claude Code runtime on each Agent; the Agent should select a
coding executor from the conversation and request approval only when it actually launches one.

### Details

The previous Agent collaboration surface exposed runtime selection and persistent Codex/Claude grant
checkboxes while creating a Hara Agent. That models an internal routing decision as user setup. OpenBot and
Grok Bot establish the clearer interaction: the user talks to an Agent, the Agent decides when specialist
coding execution is warranted, and the consequential launch is reviewed in context. Hara should preserve its
permission boundary without forcing a separate setup step.

### Suggested Action

Keep Hara Agents as persistent identities, automatically inherit eligible local coding runtimes, remove
runtime/grant setup from the Agent creation UI, and require a just-in-time approval card for every Codex or
Claude Code launch. Keep the bundled OpenCode executable product-neutral as Hara Code Runtime.

### Metadata

- Source: user_feedback
- Related Files: `src/subagent/team.ts`, `src/tools/collaboration.ts`, `../hara-desktop/src/AgentCollaborationSurface.tsx`
- Tags: agents, codex, claude-code, opencode, routing, approval, ux
- Pattern-Key: agents.runtime_selection_is_jit_not_profile_setup
- Recurrence-Count: 1
- First-Seen: 2026-09-29
- Last-Seen: 2026-09-29

### Resolution

- **Resolved**: 2026-09-29T02:45:00+08:00
- **Notes**: Removed runtime selection and standing Codex/Claude grant controls from Desktop Agent creation,
  made eligible Hara Agents inherit available coding executors automatically, and changed every actual
  Codex/Claude launch to require a fresh in-context approval. Added CLI, Serve, and Desktop regression tests.

### Updated product decision (2026-10-14)

Jeff now explicitly wants one configured Runtime per persistent Agent, with built-in Pi as the eventual
main/general-Agent default and OpenCode/Codex/Claude as alternatives. This supersedes the September
recommendation to omit Runtime identity configuration, not the tool-authorization boundary. Runtime,
model connection, persona, native Session and live tool grants are distinct. Only trusted host/human
configuration selects an engine; imported Markdown cannot do so. New tasks freeze that configuration,
old work keeps its original binding, and unavailable engines never silently fall back. Pi is still only
a coding worker until a governed general-Agent adapter is implemented and verified; do not advertise
that migration as complete from a selector, fixture driver or coding preference change.

---

## [LRN-20260923-003] architecture

**Logged**: 2026-09-23T22:10:00+08:00
**Priority**: high
**Status**: resolved
**Area**: agent-runtime

### Summary

Provider-only context and user-authored conversation are different data planes; an internal reminder must
remain available to the model without ever becoming a visible user message. Deterministic policy failures
must also be grouped by root cause rather than by changing shell or Python arguments.

### Resolution

Serve now removes complete `<system-reminder>` envelopes from every Desktop/Mobile history projection while
retaining them in private provider history. Desktop independently filters reminders returned by older Engines.
The repeat guard now coalesces understanding, capability, runtime, organization, permission, and trusted-
extension gates across command variants and stops after three unresolved attempts; a successful `task_intake`
transition starts a fresh understanding-gate audit. Focused Engine and Desktop regressions pass locally.

### Metadata

- Source: user_feedback
- Related Files: src/agent/reminders.ts, src/agent/repeat-guard.ts, src/serve/server.ts, hara-desktop/src/user-visible-text.ts
- Tags: codex, transcript, system-context, progress, policy-gate, no-progress
- Pattern-Key: architecture.private_model_context_and_root_cause_progress
- Recurrence-Count: 1

---

## [LRN-20260923-002] correction

**Logged**: 2026-09-23T21:00:00+08:00
**Priority**: critical
**Status**: resolved
**Area**: backend

### Summary

OCR confidence and OCR readback uncertainty must not be mistaken for conversation identity changes or a
safe-to-retry input failure. Dynamic controls must also be verified at the stage where they are usable:
WeChat can render Send in a disabled state while the editor is empty and enable it only after text lands.

### Details

The local WeChat bridge included per-capture confidence decimals in its conversation digest. An unchanged
screen could therefore produce a different digest between the managed scan and pre-send revalidation,
pausing a correctly bound group as though the user had switched chats. On macOS 27, the visual fill path also
used Apple's Vision OCR for Chinese readback even though the scanning path had already switched to RapidOCR;
text could visibly land while Hara reported failure and left the same draft retryable.

### Suggested Action

Build safety identity only from normalized title/message content, sender and side; keep confidence as telemetry.
Use one OCR backend for both scan and input verification on affected systems. When input events occurred but
readback remains uncertain, consume the one-shot draft and surface a review-required result so retry cannot
duplicate text. Preflight should prove only the empty input route; resolve and revalidate Send after the
draft has been filled and verified.

### Metadata

- Source: user_feedback
- Related Files: scripts/jev-wechat-bridge.py, src/wechat-group-scene.ts
- Tags: wechat, ocr, digest, managed-mode, idempotency
- Pattern-Key: computer_use.uncertain_write_must_not_remain_retryable
- Recurrence-Count: 2
- Last-Seen: 2026-09-24

### Resolution

The stable digest now excludes confidence, macOS 27 input readback uses the same RapidOCR path as scanning,
and an attempted-but-unconfirmed fill is consumed as a review state. Managed delivery also performs a
read-only route preflight, supports the guarded visual writer when WeChat hides its AX editor, revalidates
title plus digest immediately before the single Send press, and pauses without retrying an uncertain result.
The preflight now accepts a verified empty input even when Send is visible-but-disabled, then resolves the
enabled control after the draft lands through scoped Accessibility or a single OCR-verified label.
Real-device follow-up showed that a Unicode draft can visibly land one frame before RapidOCR catches up;
managed delivery now performs a bounded exact readback after that uncertain writer result and proceeds only
when the newly visible text exactly contains the draft that was written into a previously empty input.
Controller, bridge-simulation, Serve, and Desktop regression tests passed locally; no public release is
implied by this learning entry.

---

## [LRN-20260923-WECHAT-MANAGED-INBOUND-IDENTITY] best_practice

**Logged**: 2026-09-23T16:40:00+08:00
**Priority**: high
**Status**: resolved
**Area**: wechat-group

### Summary

Managed chat deduplication must identify the visible incoming-message sequence, not the whole conversation
digest. An Agent's own outgoing reply changes the whole digest and can otherwise retrigger the old incoming
message.

### Suggested Action

Keep the stale-window send check on the full conversation digest, but use a separate hash of incoming
sender/text observations for trigger deduplication. Require the newest classified visible message to be
incoming before claiming an automatic reply, and regression-test the post-send view.

### Metadata

- Source: implementation_review
- Related Files: `src/wechat-group-scene.ts`, `test/wechat-group-scene.test.mjs`
- Tags: wechat, managed-mode, deduplication, auto-reply, safety
- Pattern-Key: messaging.auto_reply_dedupe_on_inbound_identity
- Recurrence-Count: 1

### Resolution

Managed mode now separates its inbound observation key from the full stale-window digest and ignores the
conversation update caused by its own verified outgoing reply.

---

## [LRN-20260830-PERSONAL-SPACE-OWNS-ONE-CONNECTION] correction

**Logged**: 2026-08-30T09:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: profiles

### Summary

Personal is a durable user Space, not a container for an arbitrary list of visible BYOK identities. It
owns one replaceable model connection. Company Control connections are a separate, repeatable collection.

### Details

A compatibility repair restored the reserved `personal` profile beside an active named BYOK profile. The
data remained technically routable, but Desktop exposed both rows as peer “personal connections”, made the
reserved row impossible to delete, and hid recovery actions behind different detail modes. The result made
one person appear to have two Personal identities even though both routes belonged to the same Space.

Historical route IDs can still be needed to resume sessions. Preserve those only as hidden compatibility
records, promote the selected route into canonical Personal, and expose exactly one replace/clear workflow.
An explicit clear must also remove compatibility credentials; merely hiding a row is not deletion.

### Suggested Action

Model identity and connection cardinality separately: one Personal Space → one current personal model
connection; zero or more company Spaces → one or more administrator-enrolled Control connections. Migration
tests must cover both the missing-Personal shape and the already-duplicated shape.

### Metadata

- Source: correction
- Related Files: src/profile/profile.ts, src/index.ts, ../hara-desktop/src/ProviderSettings.tsx
- Tags: profiles, personal-space, migration, desktop, credentials
- Pattern-Key: profiles.personal_space_owns_one_connection
- Recurrence-Count: 1

---

## [LRN-20260822-AGENT-OWNS-AUTHORIZED-ACTIONS] correction

**Logged**: 2026-08-22T00:00:00+08:00
**Priority**: critical
**Status**: in_progress
**Area**: agent-runtime

### Summary

An accepted `change` task must not end with instructions that transfer an available, authorized, low-risk
action back to the user. Hara owns execution and evidence-based verification; conversational advice is not
task completion.

### Details

The runtime currently accepts a provider response with text and no tool calls as a completed run even when
the authoritative task brief says `change` and has no fresh completion receipt. In addition,
`awaiting_user` accepts an untyped free-form reason and one permission-denial message explicitly suggests
that the user run the action. Together these paths allow a model preference to override the product's Agent
execution contract.

### Suggested Action

Add a deterministic execution-ownership guard for accepted change tasks, require a structured and evidenced
human dependency before `awaiting_user`, remove handoff language from tool denials, and make wrong-user-
delegation a zero-tolerance release evaluation. Capture the correction as a reviewable execution-time
learning candidate so recurrence can be measured without treating history as authority.

### Metadata

- Source: user_feedback
- Related Files: src/agent/loop.ts, src/agent/context-budget.ts, src/session/task.ts, test/task-intake.test.mjs, test/context-budget.test.mjs, evals/feedback/
- Tags: agent, execution-ownership, task-state, awaiting-user, self-improvement
- Pattern-Key: agent.authorized_action_execution_ownership
- Recurrence-Count: 2
- Feishu-Messages: om_x100b67bdce6a30a0b49d3a5ee863df7, om_x100b67dc41e8f8b0b32ea25bdc362c2

### Recurrence 2026-08-26

MiniMax-M3 treated Hara's historical tool-output compression marker as a broken live tool, repeated broad
reads, then recorded `external_state` and told the user to open another conversation, run Hara's script, and
paste the output back. The invariant now also requires preferential retention of the newest narrow tool round
and rejects context/tool-output truncation as any human dependency.

---

## [LRN-20260725-FEISHU-AUTOMATION-USES-OPENAPI] correction

**Logged**: 2026-07-25T06:05:00+08:00
**Priority**: high
**Status**: resolved
**Area**: tooling

### Summary

Hara feedback-group intake, attachment retrieval, replies, and release notices must use the Feishu OpenAPI
workflow, not Feishu desktop UI automation.

### Resolution

Use the `feishu-communicate` script for all canonical Hara feedback-group operations and preserve returned
message IDs for thread closure. Fall back to UI only if the user explicitly changes this policy.

### Metadata
- Source: user_feedback
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/SKILL.md
- Tags: feishu, openapi, feedback, automation
- Pattern-Key: integrations.feishu_feedback_openapi_only
- Recurrence-Count: 1

---

## [LRN-20260814-SUBAGENT-DURABLE-CHILD-RUNTIME] best_practice

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: architecture

### Summary

Evolve Hara subagents as durable child sessions with a separate process-local activation, not as longer-lived
versions of the current synchronous `spawn` callback. Stable lineage, an immutable policy snapshot, one FIFO
inbox, manager-owned settlement delivery, and root-scoped budgets are the minimum invariants for safe
continuation, interruption, restart recovery, and UI observability.

### Details

The deepseek-harness capability seam cleanly separates provider composition from lifecycle management, while
Codex adds stronger product controls for persistent thread graphs, residency, execution quotas, and explicit
queue-versus-wakeup messaging. Hara should combine those invariants with its existing read-only tool floor,
session identity binding, atomic session submission, and task steering instead of importing Cordis or adding a
second agent loop. A message's source is attribution rather than authority; control operations must be
authorized from durable parent/ancestor lineage and the exact live caller.

### Suggested Action

First extract the existing one-shot implementation behind a `SubagentRuntime` and native provider without
changing behavior. Then add versioned child descriptors and persisted sessions, followed by bounded background
continuation, a durable deduplicated settlement mailbox, and optional trusted external providers. Keep write
tools unavailable until children have isolated ownership such as a worktree, artifact revision, or patch-only
handoff.

### Metadata

- Source: architecture_review
- Related Files: src/index.ts, src/tools/agent.ts, src/tools/registry.ts, src/session/store.ts, src/session/task.ts, src/serve/sessions.ts
- Tags: subagent, sessions, lifecycle, authority, persistence, concurrency
- Pattern-Key: architecture.subagent_durable_child_runtime
- Recurrence-Count: 1

### Resolution

- **Resolved**: 2026-09-20T00:00:00+08:00
- **Notes**: Durable Agent trees now own stable lineage, idempotent mailboxes, root-turn fences, whole-tree
  budgets, restart recovery, bounded rooms, isolated writable Worktrees, reviewed Diff application, and
  approved Personal-Space Codex/Claude continuations through Hara Live. The older one-shot `agent` helper
  remains only as a narrow compatibility path rather than becoming a second orchestration system.

---

## [LRN-20260813-PROVIDER-CAPABILITY-DOC-DRIFT] correction

**Logged**: 2026-08-13T00:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: providers

### Summary

Time-sensitive provider capability decisions must be rechecked against the current official documentation
and encoded in one exported capability table with transport-level regression tests. They must not remain as
stale prose or duplicated one-model conditionals.

### Details

Hara CLI 0.146.1 routed only `deepseek-v4-flash` through DeepSeek Responses while sending
`deepseek-v4-pro` through Chat. DeepSeek's current official Responses and Codex integration documentation
now explicitly lists both V4 models. The user correctly challenged the outdated assumption.

### Resolution

Centralized the exact official V4 Responses model catalog and strict endpoint recognition, routed Flash and
Pro through the stateless Responses transport, retained Chat only for the explicit non-thinking mode and
unsupported/custom models, and added factory/SSE/model-picker/protocol tests. Managed Hara Control routing
remains separate because vendor support does not prove a proxy gateway exposes the same endpoint.

### Metadata

- Source: user_feedback
- Related Files: src/providers/deepseek.ts, src/providers/registry.ts, src/providers/factory.ts,
  src/providers/responses.ts, test/deepseek-factory.test.mjs, test/responses-provider.test.mjs
- Tags: deepseek, responses-api, capabilities, documentation-drift, routing
- Pattern-Key: providers.verify_current_official_capabilities_and_centralize_catalog
- Recurrence-Count: 1

---

## [LRN-20260724-LAUNCHD-INTERVAL-IS-NOT-WALL-CLOCK-CRON] correction

**Logged**: 2026-07-24T02:00:00+08:00
**Priority**: high
**Status**: in_progress
**Area**: cron

### Summary

A 60-second `launchd` `StartInterval` is not a reliable wall-clock cron source. macOS can coalesce the
background timer into sparse `:00`/`:30` ticks, while Hara cron expressions intentionally match exact
calendar minutes; the combination silently skips jobs at times such as 06:40 and 07:10.

### Resolution

Generate a `StartCalendarInterval` array covering all 60 minute values. Calendar events preserve the
wall-clock contract and coalesce missed wake events into one tick. Keep Hara's existing atomic tick lock and
run lifecycle unchanged. Because old plists are durable, release instructions must explicitly ask existing
macOS users to rerun `hara cron install` once.

### Metadata

- Source: user_feedback
- Related Files: src/cron/install.ts, test/cron.test.mjs, README.md
- Tags: cron, launchd, macos, timer-coalescing, scheduling
- Pattern-Key: cron.launchd_calendar_contract

---

## [LRN-20260724-SESSION-IDENTITY-MUST-COVER-AUXILIARY-ROUTES] correction

**Logged**: 2026-07-24T00:20:00+08:00
**Priority**: critical
**Status**: in_progress
**Area**: backend

### Summary
Persisting a session profile and rebinding the primary provider is insufficient: every auxiliary provider,
managed prompt source, heartbeat, and policy path must resolve through the same immutable session identity.

### Details
The first 0.134.2 candidate correctly rebound the primary chat provider but release review found remaining
paths that could reload the globally active profile by cwd: guardian, independently modeled sub-agents,
managed role synchronization, heartbeat, and organization-role prompt construction. The same review found
that generic session redaction could transform a legitimate `profileId`, while profile creation and session
loading accepted different identifier grammars. Together these defects could either cross an enterprise
routing boundary or make a valid saved session permanently unresumable.

### Suggested Action
Model the bound profile as run/session execution context rather than a one-provider wrapper. Pass it through
all provider factories and managed metadata requests, never consult mutable global enrollment from a bound
run, and share one profile-ID validator across creation and persistence. Mark identity fields as structural
metadata that are validated but never secret-redacted. Release tests must assert that the non-bound gateway
receives no chat, roles, heartbeat, guardian, or sub-agent traffic.

### Metadata
- Source: user_feedback
- Related Files: src/index.ts, src/serve/server.ts, src/session/store.ts, src/profile/profile.ts
- Tags: session, profile, enterprise, routing, guardian, sub-agent, redaction
- Pattern-Key: security.session_identity_full_execution_graph
- Recurrence-Count: 1
- First-Seen: 2026-07-24
- Last-Seen: 2026-07-24

---

## [LRN-20260722-FIELD-CLOSURE-REQUIRES-RELEASE-EVIDENCE] correction

**Logged**: 2026-07-22T11:30:00+08:00
**Priority**: high
**Status**: resolved
**Area**: release

### Summary
Code presence and passing unit tests are not sufficient evidence that a field-reported bug is fixed. A Hara
issue may be called closed only after the original scenario is reproduced, the corrected behavior is exercised
through a real user-facing interaction, and the exact installable release artifact is verified.

### Details
Replies in the canonical feedback group were sent before the complete acceptance pass. Zhao Dongqin then
provided a screenshot collecting 16 still-open or insufficiently-proven items. That screenshot became the
acceptance matrix, and the pending 0.133.0 release was paused. Evidence was rebuilt from the actual paths:
PTY session/cwd and TUI input behavior, a real Chromium render through the validating proxy, a real headless
CLI cross-session recall turn, document artifact inspection, runtime gateway stability, and package/release
gates. Safety or ownership boundaries such as explicit registry selection and a non-Hara mark-as-read handler
must be reported as boundaries rather than mislabeled as Hara fixes.

### Suggested Action
For every field issue, keep a row linking the original message to reproduction, code/tests, real interaction,
release artifact, and focused verification steps. Reply to the original report only after the public artifact
passes those checks; then send the group-level release notice. If any row lacks evidence, say it remains open.

### Metadata
- Source: user_feedback
- Related Files: CHANGELOG.md, test/session-recall-cli.test.mjs, src/tools/headless-web.ts
- Tags: feedback, acceptance, release, evidence, feishu
- Pattern-Key: release.field_closure_evidence

---

## [LRN-20260721-MEMORY-RECALL-IS-A-LAYERED-CONTRACT] correction

**Logged**: 2026-07-21T19:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: memory

### Summary
Adding a raw transcript tool and terminating the run after three empty calls does not by itself make memory
reliable. Recall needs a natural failure handoff, workspace-aware discovery, match-centered multilingual
retrieval, correct durable-write scope, duplicate control, and a real load-time safety boundary.

### Details
The first cross-session implementation still defaulted strictly to the new cwd, which missed the exact
reported case because `hara --cwd` had split the old Home-root session from the new project session. Its hard
breaker also returned a host error after the third miss instead of letting the model tell the user no history
was found. Separately, whitespace-only lexical search treated unspaced Chinese as one term and returned the
start of `MEMORY.md`, `target=user` silently defaulted to a project `USER.md` that was not injected, and the
documented `scanMemory` load boundary was not actually called by durable-memory readers/indexing.

### Resolution
- Default transcript recall now prefers the current project and reserves bounded capacity for a local
  interactive cross-workspace fallback only after no project match.
- Three empty calls hide recall tools for the remaining turn but preserve one normal answer round.
- Chinese-aware terms and match-centered snippets make lexical recall usable without embeddings.
- User preferences default global; durable appends deduplicate; model-driven whole-file replacement is blocked.
- Prompt, retrieval, distillation, and embedding-index loads share a sanitizer for editable legacy memory.

### Metadata
- Source: user_feedback
- Related Files: src/agent/loop.ts, src/recall.ts, src/tools/session-search.ts, src/tools/memory.ts,
  src/memory/store.ts, src/memory/guard.ts, src/search/hybrid.ts, src/search/semindex.ts
- Tags: memory, recall, sessions, cjk, provenance, safety
- Pattern-Key: memory.layered_recall_contract

---

## [LRN-20260716-WINDOWS-OPENED-FILE-IDENTITY] best_practice

**Logged**: 2026-07-16T23:38:00+08:00
**Priority**: high
**Status**: resolved
**Area**: security

### Summary
On Windows Node/Bun, correlate an already-open file descriptor with its bounded pathname by stable file ID
(`ino`), not by POSIX-style `dev` or permission mode fields.

### Details
GitHub `windows-latest` demonstrated that `fstatSync(fd)` and `lstatSync(path)` for the exact same NTFS hard
link reported the same `ino=1407374884232977` and `nlink=2`, but descriptor `dev=1115898621` versus pathname
`dev=0`. Windows also exposes only limited owner read/write mode semantics. Requiring `dev`/mode equality
across those APIs rejected a valid file after a safe O_EXCL + hard-link commit. Comparing only inode without
an existing path boundary would be unsafe across arbitrary roots, so the helper is intentionally scoped to
an already-open descriptor and the same verified path/parent.

Bun Windows additionally returned a misleading ENOENT for numeric exclusive-create flags. The portable
`"wx"` flag expresses CREATE_NEW/O_EXCL directly and remains no-clobber/symlink-safe for an unpredictable
staging path.

### Suggested Action
Use `sameOpenedFileIdentity` only after lexical/canonical parent binding, regular-file and symlink checks.
Retain `dev + ino` for arbitrary path-to-path hard-link detection and all POSIX comparisons. Prefer `"wx"`
for portable exclusive file creation, and keep a real Windows native binary smoke in CI.

### Metadata
- Source: error
- Related Files: src/fs-identity.ts, src/security/private-state.ts, src/fs-read.ts, .github/workflows/ci.yml
- Tags: windows, ntfs, node, bun, file-identity, atomic-write
- Pattern-Key: harden.windows_opened_file_identity
- Recurrence-Count: 1
- First-Seen: 2026-07-16
- Last-Seen: 2026-07-16

### Resolution
- **Resolved**: 2026-07-16T23:39:00+08:00
- **Commit**: 8c3e9e6
- **Notes**: Added a shared scoped identity helper, portable exclusive create, regression coverage, and a
  Windows Node + native baseline `.exe doctor` CI lane.

---

## [LRN-20260806-FEEDBACK-TRIAGE-RETAINS-FIX-SCOPE] correction

**Logged**: 2026-08-06T20:03:47+08:00
**Priority**: high
**Status**: resolved
**Area**: release

### Summary

When a Hara release request already authorizes handling, publishing, and closing feedback, a follow-up to
"look at the group bug reports" refines issue intake; it does not reduce the task to a read-only triage.

### Resolution

After refreshing and classifying the canonical feedback, continue directly with verified bug fixes, release
gates, public artifact checks, original-thread replies, and the group notice unless the user explicitly asks
to stop at diagnosis.

### Metadata

- Source: user_feedback
- Related Files: HARA_RELEASE_HANDOFF_2026-08-06.md
- Tags: feishu, feedback, release, scope, closure
- Pattern-Key: workflow.feedback_triage_preserves_authorized_fix_and_release_scope
- Recurrence-Count: 1

---

## [LRN-20260814-CLI-ANSWER-VS-STATUS] correction

**Logged**: 2026-08-14T04:20:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

In headless Hara output, the first plain line is the model answer and the indented model/token line is the
run status. A short answer equal to the product name can look like a CLI banner and must not be classified
as an empty response without comparing it to the test oracle.

### Details

An image smoke asked for the most prominent title and printed `hara`, followed by an indented
`qwen3.7-plus` usage line. The answer was initially misread as branding, but an isolated provider probe and
a serial rerun confirmed that `hara` was the correct OCR result and the Qwen image route succeeded.

### Suggested Action

Use a distinctive expected phrase in future visual smoke fixtures, or request schema/JSON output so answer
and status cannot be confused. Never report a failed visual route solely from compact CLI presentation.

### Metadata

- Source: correction
- Related Files: src/index.ts, docs/assets/hara-gateway-hero.png
- Tags: diagnostics, cli-output, qwen, vision
- Pattern-Key: diagnostics.distinguish_headless_answer_from_status
- Recurrence-Count: 1

---

## [LRN-20260830-REASONING-DEFAULT-BELONGS-TO-CALL-SHAPE] best_practice

**Logged**: 2026-08-30T00:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: providers

### Summary

A thinking-mode default belongs to the SHAPE of a call, not to one caller. A no-tool turn that also forces
a JSON schema is fill-in-the-blank classification by construction, so it defaults to `off` inside
`runNoToolModel`. Separately, an explicitly selected reasoning level is a latency/cost contract: a strict
endpoint that rejects it must fail visibly, never silently retry with the provider default.

### Details

Measured on the Alibaba Token Plan endpoint (qwen3.7-plus, same triage prompt, median of 3): the default
call spent 8.8s and 464 output tokens of which 423 were reasoning; `enable_thinking:false` spent 2.2s and
41 tokens with zero reasoning. Every provider measured (qwen family, DeepSeek, GLM) thinks by default, so
the waste was universal, silent, and invisible in error logs — only slower and more expensive.

The first fix put the `off` default in `dispatchFlows`. That turned a universal property of the call shape
into one dispatcher's local policy, and it immediately leaked: the owner-reply intent classifier in
`flows-pending.ts`, an identical no-tool + schema judgment, kept paying full reasoning cost. Sinking the
default into `runNoToolModel` fixes the whole class once and makes every future caller of that shape
inherit it; `"inherit"` remains the explicit opt-out.

Two provider-level cautions. Alibaba documents that `reasoning.effort` supersedes `enable_thinking`, but
live Token Plan calls with `effort:"none"` still emitted 227 reasoning tokens while the boolean reliably
returned zero — the observation lives in the `alibaba_responses` adapter comment, never in core logic. And
a dial is only safe to send everywhere if rejection semantics are explicit — and survivable is not the same
as silent. The wire helper strips its own keys and retries only when the caller marks the field advisory,
which is exactly the engine-chosen `off`: nobody asked for it, so a plain request beats a failed automation.
A level a user or rule selected is a latency/cost contract and surfaces the rejection instead of silently
restoring an expensive provider default. An unrelated 400 is always rethrown untouched.

### Suggested Action

When adding a provider parameter, decide three things explicitly: which call SHAPE owns its default, whether
it is user intent or merely advisory, and what happens when an unknown endpoint rejects it.
Vendor documentation is a hypothesis; measure before encoding it, and keep the measured exception in the
adapter.

### Metadata

- Source: architecture_review
- Related Files: src/gateway/flows-pending.ts, src/gateway/flows.ts, src/providers/reasoning.ts, src/providers/reasoning-fallback.ts
- Tags: reasoning, providers, flows, cost, latency, resilience
- Pattern-Key: providers.reasoning_default_by_call_shape_and_survivable_rejection
- Recurrence-Count: 1

---

## [LRN-20260830-MINIMAX-LATENCY-IS-NOT-THE-TRANSPORT] measurement

**Logged**: 2026-08-30T15:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: providers

### Summary

A "MiniMax feels slow" report did not reproduce. Measured on the Max tier, MiniMax-M3 is the fastest
route on this machine and beats qwen3.8-flash by 4-5x once the prompt reaches agent scale. The one defect
that produces the reported symptom is not speed but attribution: a provider rate limit and a slow model
looked identical in the spinner.

### Details

Sunday 2026-08-30 14:47, single-threaded, outside MiniMax's documented weekday 15:00-17:30 peak window.

Transport parity, MiniMax-M3, five tasks x two rounds: `/v1` Responses (Hara's route) reached first token
in 0.5-1.0s and finished in 0.9-3.2s; `/anthropic` (the protocol MiniMax's own quick-start uses) reached
0.5-1.2s and 0.9-2.9s. There is no latency argument for switching transports, and correctness matched.

Thinking control is not a latency lever here. Default (no parameter) had a 939ms median first token and
1663ms median turn; explicit `off` had 863ms and 1522ms. Unlike the Alibaba endpoint, M3 does not spend a
large default reasoning budget on short prompts, so the Alibaba playbook does not transfer.

Time to first token against input size is where the real difference is, and it inverts the earlier
recommendation. At ~7k input MiniMax-M3 answered in 676ms vs qwen3.8-flash 1227ms; at ~49k, 1153ms vs
5745ms; at ~142k, 2613ms vs 11307ms. qwen3.8-flash being flat-rate to 1M context is a PRICE property and
was measured as one; its latency at long context is not flat, and an agent session is long by
construction. Short work still favors flash on cost; long-context work favors M3 on latency.

The reproducible defect: the OpenAI SDK is constructed with `maxRetries: 4`, so a 429 is retried with
backoff and no stream event. MiniMax documents per-tier agent concurrency (Max is roughly 4-5), RPM/TPM
limits recovering in about a minute, and dynamic peak throttling. Hara trips this more easily than most
clients because parallel sub-agents, Flows, and cron share one key, and the spinner said only "waiting for
the model". Being throttled and being slow to think were indistinguishable.

### Suggested Action

Record the HTTP status at Hara's own model fetch and name the cause in the spinner. Untested and still
open: the weekday 15:00-17:30 peak window, and concurrent multi-agent load against the tier ceiling.
Measure a provider before believing a latency report about it, and measure at agent-scale input rather
than a toy prompt - the toy prompt hid the only difference that mattered.

### Metadata

- Source: measurement
- Related Files: src/network/throttle-signal.ts, src/network/model-fetch.ts, src/providers/minimax.ts, src/tui/App.tsx
- Tags: minimax, latency, throttling, rate-limit, context-length, providers
- Pattern-Key: providers.latency_is_measured_at_agent_scale_not_toy_prompt
- Recurrence-Count: 1

---

## [LRN-20260830-CLAUDE-AGENT-ROSTER-SCOPE] reference

**Logged**: 2026-08-30T15:00:00+08:00
**Priority**: medium
**Status**: in_progress
**Area**: org-roles

### Summary

Hara's specialist roster on a developer machine is dominated by imported Claude Code agents. The import is
correctly scoped - no other project's agents leak in - but the roster is unconditional, costs about 2.5k
tokens of every system prompt, and its truncation order sacrifices Hara's own roles before imported ones.

### Details

Accounting on this machine: `loadRoles` returned 75 roles - 50 from `~/.claude/agents` (61 files, minus
those with no description or `modelInvocable: false`), 12 from `~/.openclaw`, 10 from `~/.hara/agents`,
2 plugin, 1 hermes. The digest is 62 lines and 10,258 characters, injected as a `session`-stability prompt
part on every non-override run.

Scope is correct and was verified, not assumed. Hara reads only `~/.claude/agents` and
`<projectRoot>/.claude/agents`. The nanhara checkout has 21 project agents of its own; they are not loaded
while the working directory is hara-cli. Claude Code's plugin agents under `~/.claude/plugins` are not a
`RoleSource` and are never read, which is why Claude Code lists roughly 100 agents while Hara loads 75.

Two open problems. There is no way to exclude imported agents - no `roleSources` or equivalent config
exists. And `roleCatalog` truncates by slicing the tail at 16,000 characters with `sourceRank` ordering
`project < claude-project < global < claude-global < org < openclaw < hermes < plugin`, so company-pushed
`org` roles and Hara's own bundled `plugin` roles are dropped BEFORE a user's personal imported Claude
agents. At 10,258 of 16,000 characters this is roughly 40 more agents away, and it truncates silently with
a single trailing ellipsis.

### Suggested Action

Truncate by per-source quota rather than slicing the tail, or at minimum rank `org` and `plugin` above
`claude-global`; add a config to exclude imported sources; and log what was dropped instead of appending
an ellipsis.

### Metadata

- Source: architecture_review
- Related Files: src/org/roles.ts, src/agent/loop.ts, src/context/agents-md.ts
- Tags: roles, agents, claude-interop, context-budget, truncation
- Pattern-Key: roles.truncation_must_not_sacrifice_governed_sources_first
- Recurrence-Count: 1

---

## [LRN-20260830-MODEL-BATTERY-HAS-NO-CAPABILITY-SPREAD] measurement

**Logged**: 2026-08-30T16:30:00+08:00
**Priority**: high
**Status**: resolved
**Area**: providers

### Summary

qwen3.8-flash, qwen3.7-plus, MiniMax-M3 and deepseek-v4-pro scored 100% on every business task that could
be designed for them, including executed code and real dense UI screenshots. Model choice for Hara is
therefore not a capability decision; it is decided by cost, by latency in the specific modality, and by
whether the model has vision at all.

### Details

Code was graded by execution, not keyword matching: each model wrote a function and the harness ran it
against fixed assertions. Four tasks - interval merging, Chinese currency parsing, an off-by-one pagination
fix, and a concurrency-limited `mapLimit` requiring input order, a concurrency ceiling, first-error
propagation and no further workers after a failure. All four models passed all 23 assertions.

Vision was graded against ground truth baked into generated images (invoice fields with a decoy invoice
code, a bar chart requiring a sum, an order table requiring a filtered total) and then against two real
Hara Desktop screenshots - dense Chinese UI at small sizes. All three vision-capable models read every
value correctly, including 110/3/0, engine 0.155.1, and the first agent name.

The differences are latency by modality and capability coverage, not correctness. Total code latency
(best of two rounds): MiniMax-M3 11.0s, qwen3.8-flash 12.4s, deepseek-v4-pro 16.2s, qwen3.7-plus 19.7s.
Vision latency inverts it: on the real screenshots qwen3.8-flash took 2.6s against MiniMax-M3's 9.5s, a
3.6x gap, and MiniMax was slowest on every vision task despite being fastest on text. Long-context first
token still favors MiniMax by 4.3x at 142k input. deepseek-v4-pro has no vision on this endpoint at all,
which disqualifies it as a Hara default because pasted images, inspect_image and computer use are core.

### Suggested Action

Default to qwen3.8-flash: cheapest, fastest vision, no capability gap. Reach for MiniMax-M3 on
long-context or multi-round agent work, where its first-token advantage compounds. Do not default to
deepseek-v4-pro (no vision) and do not default to qwen3.7-plus (best at nothing measured, and its price
triples above 256K). Note the limitation honestly: a battery where everything scores 100% cannot rank
capability ceilings - separating these models on capability needs multi-file, long-horizon agent tasks
that this harness does not model.

### Metadata

- Source: measurement
- Related Files: src/providers/registry.ts, src/providers/alibaba.ts, src/providers/minimax.ts
- Tags: models, benchmark, vision, code, latency, model-selection
- Pattern-Key: providers.choose_on_cost_latency_and_coverage_when_capability_ties
- Recurrence-Count: 1

---

## [LRN-20260906-PROVIDER-NATIVE-SUBSCRIPTION-METERING] correction

**Logged**: 2026-09-06T19:25:18+08:00
**Priority**: high
**Status**: resolved
**Area**: providers

### Summary

Hara may unify execution safety and a display contract, but it must never infer one token/cost formula for
BYOK, vendor subscription plans, and company-managed gateways.

### Details

The durable Agent-team roadmap incorrectly described the next guard as a universal tree-wide
"token/time/cost" budget. Time, rounds, and concurrency are provider-neutral runtime safety limits. Economic
allowance is not: each provider can meter different native units, coefficients, windows, tools, seats, or
overage rules, and a company gateway may apply its own subscribed entitlement. Hara token telemetry is useful
for context and diagnostics but is not proof of billable cost or remaining subscription allowance.

### Suggested Action

Model three separate layers: provider-neutral runtime safety; opaque provider-native usage/quota snapshots;
and administrator/user routing policy. Display native units and source attribution, use provider-reported
reset/remaining state for admission or switching, and show unavailable when the provider exposes no usage API.

### Metadata

- Source: user_feedback
- Related Files: docs/codex-runtime-learning-audit.md, src/providers/types.ts, src/providers/plan-notes.ts
- Tags: providers, subscriptions, managed-gateway, metering, quota, billing
- Pattern-Key: providers.preserve_native_subscription_metering
- Recurrence-Count: 1

### Resolution

- **Resolved**: 2026-09-06T20:05:00+08:00
- **Notes**: Split provider-neutral execution safety from provider/Control-native accounting, exposed the
  accounting authority per catalog entry and saved connection, removed hard-coded subscription formulas from
  setup and roadmap text, and gated automatic usage failover on a fresh authoritative exhaustion snapshot.

---

## [LRN-20260915-WINDOWS-BUN-VIRTUAL-ENTRY] knowledge_gap

**Logged**: 2026-09-15T14:12:00+08:00
**Priority**: high
**Status**: resolved
**Area**: runtime

### Summary

Bun 1.3.9 Windows standalone binaries expose their compiled entry as `B:/~BUN/...`, not the POSIX
`/$bunfs/...` form used by the existing Hara self-invocation discriminator.

### Details

HARA-FB-001363 showed both Feishu and WeChat transports online while every agent-backed message failed before
provider startup with Commander's `too many arguments` error. The gateway parent had forwarded
`B:/~BUN/root/cli.js` as a real CLI argument when spawning the same standalone executable.

HARA-FB-001381 independently reported the same Desktop-visible behavior and exact Windows virtual entry,
confirming that both managed chat transports share the affected standalone self-reentry boundary.

### Suggested Action

Treat both virtual-entry forms as compiled Bun internals, keep plain Bun script entries, and exercise actual
native standalone self-reentry in every platform CI lane so future runtime path changes fail before release.

### Metadata

- Source: user_feedback
- Related Files: `src/cron/runner.ts`, `scripts/standalone-boundary-smoke.mjs`, `test/self-invoke.test.mjs`
- Tags: bun, windows, standalone, gateway, argv, self-invocation
- Pattern-Key: runtime.bun_virtual_entry_is_platform_specific
- Recurrence-Count: 2
- First-Seen: 2026-09-15
- Last-Seen: 2026-09-16

### Resolution

- **Resolved**: 2026-09-15T14:12:00+08:00
- **Notes**: Added the Windows virtual-entry discriminator, exact regression cases, and a native standalone
  cron self-reentry smoke shared by Windows, Linux, and Darwin CI.

---

## [LRN-20261017-WORKSPACE-ATOMIC-CONTEXT] accepted_exception

**Logged**: 2026-10-17
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary

Jeff accepted the measured 26.1% recent-history retention exception after context compaction.
Tool-call/result pairs and the matching provider continuation are indivisible protocol units.

### Details

The real slice triggered compaction at 73.27125% of the unchanged 80k task budget, retained
3,352 / 12,828 characters (26.13034%) and generated a 1,111-character summary. Preserve the actual
measurement and full durable history. Never split a call/result pair, strip provider continuation,
or relabel the observed ratio as the configured 18% target to make a numerical gate look green.
This exception does not waive evidence, authorization, per-task token limits or request budgets.

### Metadata

- Source: user_feedback
- Related Files: `src/workspace/model-context.ts`, `test/workspace-model-context.test.mjs`
- Pattern-Key: workspace.atomic_context_units_override_recent_share_target
- See Also: ERR-20261017-WORKSPACE-REAL-CONTEXT-BUDGET

### Resolution

- **Resolved**: 2026-10-17, Jeff explicit approval in this task
- **Notes**: Accepted protocol-preserving exception; no ratio/history or runtime policy was rewritten.

---

## [LRN-20261017-CONFIG-ABSENCE-CONTENTION] best_practice

**Logged**: 2026-10-17
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary

A missing optional config is a normal read result, not a reason to publish/fsync a writer lock on every
policy lookup. Nested authority checks can turn that fallback into thousands of syncs and starve timers.

### Details

Keep every actual write's existing CAS, lock, permissions and durability. Return empty only after a
verified private-directory namespace is unchanged across the absence lookup and neither writer nor
reclaim marker is present. Use lstat, not existsSync (dangling links must not disappear). Namespace
changes, unsafe entries or unknown stamps retain the original serialized retry. Never cache absence
across future creation/credential rotation or mistake a CAS move-claim gap for a genuinely absent file.

Structural count regression: 30 absent reads, 90 fsyncs before / 0 after. Real child paused in the writer
gap, namespace ABA and unsafe marker tests pass; existing writer-race, rotation and Workspace isolation
tests remain unchanged. Synthetic controlled storage failures are separate evidence from naturally
reproducible full-suite failures; passing two full runs does not guarantee an arbitrary storage SLA.

### Metadata

- Source: error
- Related Files: src/config.ts, test/config-read-contention.test.mjs
- Pattern-Key: config.optional_absence_is_not_a_write_transaction
- See Also: ERR-20261017-LEGACY-SERVE-FULL-TIMING

### Resolution

- **Resolved**: 2026-10-17
- **Commit/PR**: 5a0716eb4bbd60680657ab18dd176f103a15e6f3 (local feat only)
- **Notes**: Only the missing-config amplification is resolved; 5s legacy completed-RPC storage stress
  remains in the error/report for Jeff's contract decision. No timeout/assertion or durability weakening.

---

## [LRN-20261018-WORKSPACE-RUNTIME-ACQUISITION] Installation authority is not execution authority

- Logged: 2026-10-18
- Category: architecture / verification
- Status: implemented on isolated feat; no deployment
- Freeze the human card's runtime/version/public origin/target/hash; renderer/model cannot choose a
  download URL, installer shell, global Home or replacement runtime. A refusal downloads no binary.
- Dismiss unapproved cards on view switch, including A→B→A epochs. After approval, a background
  install stays bound to its original resource generation rather than the foreground selection.
- Verify archive hash, bounded exact regular-file extraction, architecture, private output and registry
  binding; recheck the registered executable on every resolve. Never overwrite unsafe old residue.
- Cap/abort metadata reads as well as binary downloads. A late/disconnected notification cannot undo
  a durable outcome. Outcome-unknown Desktop Core startup must retain its original owned child.
- Pi-only proof needs dependency graph/actual npm artifact inventory, standalone native Pi execution
  and package inventory; a constant `--runtime-manifest` alone is not evidence. Registration does not
  prove general-Agent driver availability, vendor login, platform ABI compatibility or signing.
- Keep a fixed-source full-suite run distinct from intermediate tests while implementation changes;
  record old-contract failures and environmental errors rather than repeatedly rerunning for green.

---

## [LRN-20261018-SCOPED-SDK-DEFAULTS] An explicit API key does not isolate all SDK credential defaults

- Logged: 2026-10-18
- Status: implemented and tested only with fake credential subprocesses; no real Key access
- The pinned Anthropic SDK separately inherits an auth token when its `authToken` option is omitted,
  even with an explicit API key. The pinned OpenAI SDK similarly inherits organization/project IDs,
  admin/webhook metadata and debug logging preferences. A sanitized Desktop child alone does not
  protect an independently started CLI process.
- Workspace factories must explicitly null those ambient credential/audience options and disable
  SDK debug logging; do not temporarily mutate process.env (concurrent Workspaces could race).
- Preserve unspecified legacy factory behavior with a host-only scoped option. Test a completely
  replaced subprocess environment of fake poison values against a loopback endpoint and assert
  exact auth headers, absent foreign audience/token headers, quiet stdout/stderr and unchanged Home.
- Evidence: `/private/tmp/hara-pi-only-20261018.M9EdmB/provider-env-red-2.log`; local SDK source is the
  authority for constructor behavior. Official API authentication docs explain that explicit
  organization/project headers determine request audience; never assume API key choice alone clears them.

---
