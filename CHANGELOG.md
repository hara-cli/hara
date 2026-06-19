# Changelog

All notable changes to `@nanhara/hara`.

> Versioning (pre-1.0, SemVer-style): the **minor** (middle) number bumps for a **new feature**; the
> **patch** (last) number bumps for **optimizations/fixes of existing features**.

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
