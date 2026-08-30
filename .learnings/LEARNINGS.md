# Learnings

## [LRN-20260828-EXTERNAL-SESSIONS-ONE-AUTHORITY] best_practice

**Logged**: 2026-08-28T00:00:00+08:00
**Priority**: high
**Status**: in_progress
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
**Status**: pending
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
