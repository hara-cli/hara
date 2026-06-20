# Changelog

All notable changes to `@nanhara/hara`.

> Versioning (pre-1.0, SemVer-style): the **minor** (middle) number bumps for a **new feature**; the
> **patch** (last) number bumps for **optimizations/fixes of existing features**.

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
