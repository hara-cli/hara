# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the canonical contributor guide (style, release gates, security expectations, issue
intake) and is what **hara itself and Codex** load as project context — Codex is also actively developing
this repo. Policy and workflow rules belong there; this file adds the architecture map and the
Claude-Code-specific commands. Keep the two consistent when you change either.

## What this is

`@nanhara/hara` — a local-first TypeScript coding-agent CLI that runs as a governed *org* of role-agents.
One provider-neutral agent core is driven from five surfaces: the ink TUI, headless `-p`, `hara serve`
(WebSocket JSON-RPC for desktop/IDE shells), `hara gateway` (10 chat platforms), and `hara cron`.

## Commands

```bash
npm ci                    # Node >= 22.23.1 (hard floor, enforced at the entry point)
npm run dev -- --help     # run the CLI straight from src/ via tsx
npm run build             # tsc → dist/, normalize dist file modes, check the local bin link
npm test                  # build + feedback evals + every test/*.test.mjs
```

Running a single test — tests import **compiled** modules from `dist/`, so build first, and always keep
the `--import` preload: it gives each test process its own `HOME`, which every test touching `~/.hara`
(config, profiles, sessions, private-state hardening) depends on for isolation.

```bash
npm run build
node --import ./test/setup-isolated-home.mjs --test --test-timeout=120000 test/agent.test.mjs
node --import ./test/setup-isolated-home.mjs --test --test-name-pattern "delegates via ctx.spawn" test/agent.test.mjs
```

Other entry points:

- `npm run eval:feedback` — deterministic, credential-free regression gate over `evals/feedback/*.json`
  execution receipts (outcome, round/tool/approval budgets, completion honesty). Runs inside `npm test`;
  see `evals/README.md` for the baseline → one change → rerun loop.
- `npm run build:binary` / `build:binaries` — Bun standalone binaries (requires Bun).
- `npm run doctor:local-link` — diagnose a stale `npm link` still pointing at the old `dist/index.js`
  entry (symptom: `zsh: permission denied: hara`). Fix by re-running `npm link`, never `chmod`.

CI (`.github/workflows/ci.yml`) additionally runs a Node 20 "upgrade message" lane, a Windows lane (Bun
filesystem/shell/portable-HOME contracts), Docker, and standalone-binary smokes on four targets.

### Release

Version bump + CHANGELOG entry → commit to `main` → push tag `vX.Y.Z`. The tag *is* the deployment:
`publish-npm.yml` publishes to npm and `release.yml` cross-compiles the binaries. **Check both** — only
one failing has bitten this repo before. Never `npm publish` locally: the repo `.npmrc` pins
`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`, and with `NPM_TOKEN` unset it overrides your logged-in
credentials. Verify with `npm view @nanhara/hara version --registry https://registry.npmjs.org/`.

## Architecture

### Entry chain

`package.json bin` → `runtime-bootstrap.cjs` (dependency-free, parseable by old Node — prints an upgrade
instruction instead of a SyntaxError; also normalizes portable/Git-Bash `HOME`) → `dist/cli.js`
(`src/cli.ts`, re-checks the runtime gate before importing anything heavy) → `src/index.ts`.

`src/index.ts` (~7.4k lines) is the commander surface *and* the composition root: it builds providers,
supplies `spawn`/guardian/confirm callbacks, and injects `ServeDeps` into `hara serve` so `src/serve/`
never imports back into the CLI entry. Non-CLI entry points (`serve`, `gateway`, `cron`) must
`import "../tools/all.js"` themselves — see below.

### Agent core — `src/agent/loop.ts`

`runAgent` is the single turn loop for every surface. Around it:

- `prompt.ts` — `PromptAssembler` builds the system prompt as ordered parts (`static` → `session` →
  `turn`). Ordering is enforced at assembly time; placing stable material after a dynamic suffix throws,
  because it would destroy provider prefix-cache locality.
- `context-budget.ts` / `compact.ts` — history trimming, auto-compaction, working-set restore.
- `failover.ts` — classifies a *finished* provider error (the SDK already retried transient ones) and
  decides on one fallback-model retry. `auth` and `interrupted` never auto-recover.
- `repeat-guard.ts`, `reminders.ts`, `limits.ts` — stuck-loop detection, todo/synthesis nudges, run
  timeout and max rounds.
- `route.ts` — opt-in cheap-model routing for trivial turns; deliberately biased toward the strong model
  (note the separate CJK action vocabulary — Chinese commands have no whitespace word boundaries).

### Providers — `src/providers/`

Everything upstream of a provider speaks `NeutralMsg` / `TurnResult` (`types.ts`). Two files decide
behavior: `registry.ts` resolves a `(providerId, baseURL, model)` triple to capabilities
(`wireApi: anthropic | responses | chat`, a `ReasoningStyle`, cache mode), and `factory.ts` constructs
the matching client. `reasoning.ts` maps hara's portable effort dial (`off|low|medium|high|max`) onto
each platform's actual parameter shape. Adding or fixing a provider means editing the registry entry and
its reasoning style — not the agent loop.

`AssistantContinuation` is provider-owned opaque state (Responses reasoning items, DeepSeek chat
reasoning) that must round-trip beside tool calls; it is kept separate from visible assistant text so
renderers never see private reasoning.

### Tools — `src/tools/`

`registry.ts` defines the `Tool` contract: `kind` (`read|edit|exec|computer`) drives the approval gate,
`classify(input, ctx)` refines effect and concurrency per call for multi-action tools, `visibility:
"deferred"` keeps a schema out of the prompt until `tool_search` activates it, and
`requiresProjectWorkspace` blocks project-scoped mutations when cwd is Home. `ToolContext` carries the
optional host capabilities (`spawn`, `ui`, `ask`, `describeImage`, `locate`) — a tool must degrade
gracefully when one is absent (e.g. `ask` is undefined in headless/gateway/sub-agent runs).

`all.ts` is a side-effect aggregate that imports every built-in. **A new tool not imported there is
silently unplannable** — the model calls it and nothing happens.

### Security stack — `src/security/`

Layers, evaluated in this order, each independent:

1. `sensitive-files.ts` — hard read boundary for credential-shaped files, evaluated *before* approval
   mode. Opt out only via `HARA_ALLOW_SENSITIVE_FILES=1` set before launch; a tool call cannot grant it.
2. `permissions.ts` — command-level allow/ask/deny for `bash` from `~/.hara/permissions.json` plus a
   project `.hara/permissions.json` (deny wins on merge). A compound command takes the strictest verdict
   of its parts; anything unparseable fails **closed** to `ask`.
3. `hooks.ts` PreToolUse hooks, then the approval mode (`suggest | auto-edit | full-auto`).
4. `guardian.ts` — deterministic risk classifier first (normal work is `low` in pure Node, zero latency);
   only `high` actions get a cheap-model veto that **fails open**. A circuit breaker hard-stops runaways.

`private-state.ts` keeps `~/.hara` owner-only and migrates older installs; `secrets.ts` redacts session
writes and subprocess output; `sandbox.ts` is macOS Seatbelt write-confinement for `bash` only (other
platforms are unsandboxed and say so).

### Identity and config

`~/.hara/profiles.json` holds the profile list and the active one; the legacy `~/.hara/config.json`
*is* the personal profile, so existing users never migrate. `src/profile/profile.ts` documents the
migration rules and is the runtime source of truth. Two ids matter downstream: `profileId` (mutable
connection) and `spaceId` (immutable Personal/company audience) — organization learning and gateway flow
audiences are keyed by `spaceId`, never by the reusable profile id.

### Org layer — `src/org/`

`roles.ts` loads markdown role definitions (hara + Claude Code formats) where frontmatter is public
metadata and the body is a private persona loaded only for the selected role. `router.ts` dispatches by
`owns`/`rejects` keywords, falling back to an LLM. `planner.ts` implements `hara plan`: frame → atomize →
sequence as a DAG → execute → verify gate, with `.hara/org/plan.json` as the single source of truth.

### Surfaces

- **TUI** — `src/tui/` (ink): `App.tsx`, `InputBox.tsx` (approval cycling, plan mode, bracketed paste).
- **serve** — `src/serve/protocol.ts` is the versioned JSON-RPC contract (pure, unit-tested); the header
  comment is the spec. `server.ts` runs the agent core in-process; `sessions.ts` owns per-session state.
- **gateway** — `src/gateway/serve.ts` runs one subprocess per inbound message. Each platform implements
  the `ChatAdapter`/`InboundMsg` shape from `telegram.ts`. `flows.ts` + `flows-pending.ts` are
  user-configured `~/.hara/flows.json` automations that run **tool-free with a forced schema** against the
  provider (a prompt-injected group message must never reach bash/edit/MCP). `runtime-state.ts` enforces
  one process owning a platform connection and persists dedupe/retry state.
- **cron** — `src/cron/` schedules prompts/org tasks fired by the OS scheduler.

### Extension points

Skills (`src/skills/`, `SKILL.md` with progressive disclosure; precedence plugins < global < project),
plugins (`src/plugins/`, `plugins/` ships browser + chrome), MCP client and server (`src/mcp/`), and
`external_agent` delegation to headless Claude Code / Codex (`src/external-sessions/`). Note the
deliberate split between `memory` (curated durable facts) and `learning` (execution-time candidates that
change nothing until explicitly approved and can never widen permissions).

### State layout

`~/.hara/`: `config.json`, `profiles.json`, `permissions.json`, `flows.json`, plus owner-only trees
`sessions/`, `checkpoints/`, `index/`, `gateway/`, `cron/`, `artifacts/`, `tool-results/`, `skills/`,
`memory/`. Project-local `.hara/`: `skills/`, `memory/`, `permissions.json`, `org/plan.json`.
`dist/` is generated — change `src/` and rebuild.

## Conventions that bite

- Relative imports must carry an explicit `.js` extension (ESM output, `"type": "module"`).
- Tests are `node:test` + `node:assert/strict` in `test/<feature>.test.mjs`, importing from `dist/`.
- No linter or formatter — `npm run build` is the style/type gate.
- Keep the actionable error text at trust boundaries; several tests assert on those messages.
- `.learnings/` is a git-tracked cross-session knowledge base (`ERRORS.md`, `LEARNINGS.md`,
  `FEATURE_REQUESTS.md`, `CLAUDE-MEMORY-IMPORT.md`). Read it before non-trivial work and append to it
  when you learn something durable — it is how Codex and Claude sessions hand off here.
- Because Codex works in this repo too, check `git status` / `git diff` before starting: the change you
  were asked for may already be in flight in the working tree.
