# hara

**A coding agent CLI that runs like an engineering org.**

> Think "Claude Code, but it operates as a configurable, governed *organization* of role-agents" —
> with routing boundaries, a dispatcher, a single source-of-truth data layer, human-in-the-loop
> approvals, and cron autonomy.

🚧 **v0.21** · TypeScript · local-first · MIT/Apache-2.0

**Highlights**
- **An org, not just an agent** — `hara org "<task>"` routes work to the role that *owns* it; `hara plan "<task>"` decomposes a task into a verified DAG of atoms (frame → atomize → sequence → execute → **verify gate**).
- **Real terminal UX** — an **ink TUI**: bottom-pinned input box, **plan mode** (read-only → propose a plan → approve → execute), selectable approvals with "don't ask again", windowed reasoning, **paste images** (Ctrl+V) for vision models, light/dark theme.
- **Persistent memory + self-evolution** — `memory_*` tools over global/project `MEMORY.md`; the agent recalls before acting, **proactively saves** durable facts, and grows its own playbooks (a lexical guard screens what it writes).
- **Multi-provider, all streamed** — Anthropic (Claude) or any OpenAI-compatible endpoint (Qwen/DashScope, GLM, Kimi, OpenAI) with live Markdown + visible reasoning.
- **Solid coding core** — `edit_file` / `apply_patch` (atomic multi-file) with colored diffs · `grep`/`glob`/`ls`/`web_fetch` · fuzzy `@file` · `/undo` · `/compact` · **Esc-to-interrupt** · parallel sub-agents · MCP client · macOS sandbox.

Track it: https://github.com/hara-cli/hara · https://hara.run

## Install

```bash
npm i -g @nanhara/hara
```

Or from source:

```bash
git clone https://github.com/hara-cli/hara && cd hara
npm install        # builds via the prepare script
npm install -g .   # or: npm link
```

## Quickstart

```bash
npm i -g @nanhara/hara
hara login qwen          # free Qwen OAuth  (or: export ANTHROPIC_API_KEY=…)
cd your-project
hara                     # offers to write AGENTS.md, then drops you into the TUI
```

Then just type a task — e.g. `fix the null check in @src/login.ts and run the tests`.
**shift+tab** cycles approvals (incl. **plan mode**) · **Esc** interrupts · `@`+Tab attaches a file · `/exit` quits.

One-shot, no REPL:

```bash
hara -p "summarize @README.md and list any TODOs"
```

## Setup

hara is **multi-provider** — pick a provider + key.

**Anthropic (default)**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**Qwen — free OAuth** ("Qwen Code" tier, no API key — same flow as OpenClaw)
```bash
hara login qwen      # device login: open the printed URL, approve — token auto-refreshes
```

**Qwen — DashScope API key** (Alibaba Model Studio, OpenAI-compatible)
```bash
hara config set provider qwen
hara config set apiKey   sk-...      # your DashScope model-studio key
hara config set model    qwen-plus   # or qwen-max, qwen3-coder-plus, …
# endpoint defaults to dashscope compatible-mode/v1
#
# coding-plan keys (sk-sp-…) use the coding endpoint instead:
#   hara config set baseURL https://coding.dashscope.aliyuncs.com/v1
#   hara config set model   qwen3.7-plus
#   plan models: qwen3.7-plus, qwen3.6-plus, qwen3-coder-plus, qwen3-coder-next,
#                qwen3-max-2026-01-23, glm-5, glm-4.7  (switch with -m or /model)
```

> Plan keys (Coding Plan / Token Plan) are licensed **only** for use inside AI coding agents /
> OpenClaw-type tools like hara — not Dify/n8n, API-testing tools, or direct script/backend calls.

**Any OpenAI-compatible endpoint** (GLM, Kimi, OpenAI, local servers)
```bash
hara config set provider openai
hara config set baseURL  https://your-endpoint/v1
hara config set apiKey   ...
hara config set model    ...
```

**Vision** — hara **auto-detects** whether your main model can see images. A vision model (Claude, gpt-4o,
qwen-vl, glm-4v…) gets pasted images **inline**. For a **text-only** model (DeepSeek, coding models), set a
describer — the "eyes" — and hara OCRs/describes each pasted image into text first:
```bash
hara config set visionModel qwen-vl-max   # a vision model on the same plan/key
# point it elsewhere if your endpoint doesn't serve vision:
#   hara config set visionBaseURL https://dashscope.aliyuncs.com/compatible-mode/v1
#   hara config set visionApiKey  sk-...
```
If a model's capability is unknown, hara **asks once and remembers**. In the TUI, `/vision <model>` sets the
describer and `/vision main yes|no|auto` corrects a model's detected capability.

Config lives in `~/.hara/config.json`. Env vars override it: `HARA_PROVIDER`, `HARA_MODEL`,
`HARA_BASE_URL`, `HARA_API_KEY`, or the provider key (`ANTHROPIC_API_KEY` / `DASHSCOPE_API_KEY`).

## Use

```bash
hara                       # interactive REPL (offers to create AGENTS.md on first run)
hara init                  # analyze the project & (re)generate AGENTS.md
hara doctor                # check your setup (auth / model / node / assets / roles)
hara roles init            # scaffold role-agents (implementer / reviewer / docs)
hara org "review src/ for bugs"   # dispatch a task to the role that owns it (or --role <id>)
hara plan "add a /health endpoint with a test"   # decompose → sequence (DAG) → run each step + verify
hara -p "summarize @README.md and fix the lint errors in src/"   # one-shot; @path attaches a file
hara --approval auto-edit  # suggest (default) | auto-edit | full-auto   (-y = full-auto)
hara --sandbox workspace-write   # confine shell writes to the project (macOS Seatbelt)
hara -c                    # resume the most recent session in this directory
hara --profile work        # use a named profile from ~/.hara/config.json
hara -m glm-5              # pick a model
```

Inside the REPL: `/help` `/init` `/tools` `/model` `/approval` `/org` `/plan` `/roles` `/usage` `/doctor` `/sessions` `/undo` `/compact` `/recall` `/reset` `/exit` (type `/`+Tab to complete). Type `@` + Tab to attach a file (fuzzy, walks subdirectories).

The interactive REPL is an **ink TUI**: a bordered **input box pinned at the bottom** — session name in
the top-right corner, approval modes + token usage + concurrency in the bottom border — with the
conversation scrolling above it. Streaming text, reasoning, tool calls, and colored diffs render as live
blocks; a spinner runs during a turn. **shift+tab** cycles the approval mode, **Esc** interrupts a running
turn, and tool approvals appear inline (y/N). **Ctrl+V** pastes an image from your clipboard (a screenshot,
or a copied image) — or drag an image file into the terminal — and it appears as a highlighted `[Image #N]`
token inline where your cursor is (backspace over it to remove it). hara auto-detects the model's capability —
a vision model sees the image directly; a text-only model routes it through a `visionModel` describer (see
Setup), shown in the header at startup. Set `HARA_TUI=0` for the classic readline REPL.

Each session gets a **UUID** and an **auto-summarized name** from your first message (kept verbatim, CJK
included); `hara sessions` lists them by short id, and `--resume <prefix>` accepts the short id.

Assistant output is **rendered as Markdown** (headers, bold, inline code, lists; code fences verbatim),
and a model's **reasoning** shows dimmed before the answer when available. Both are interactive-terminal
only; `HARA_MD=0` disables Markdown rendering.

**Skills** — reusable capabilities on the **agentskills.io standard** (`SKILL.md`, interoperable with Claude
Code / codex / openclaw). Drop a `~/.hara/skills/<name>/SKILL.md` (or project `.hara/skills/`) with `name` +
`description` frontmatter and Markdown instructions; the agent sees the list and calls the `skill` tool to load
a skill's full body only when it's relevant (progressive disclosure). `hara skills init` scaffolds one, `hara
skills` lists them, `/skill <id>` loads one into your next message, and the agent saves its own with
`skill_create` (`scope: project|personal`). Optional frontmatter: `when_to_use`, `allowed-tools`, `context: fork` (run as a sub-agent), `paths`.
When the agent saves a skill, secrets are **redacted** and local paths/emails **generalized** (`<project>` / `~` / `<email>`),
and a near-duplicate is flagged so it updates instead of piling up. `assetCapture: off|ask|auto` controls proactive end-of-session capture.

**Plugins** — bundle skills + roles + MCP servers in one installable unit (Claude-Code-compatible
`plugin.json` / `.claude-plugin/`). `hara plugin add file:<path> | github:<owner/repo> | git:<url>` installs it;
`hara plugin` lists; `enable`/`disable`/`remove`. A plugin's skills/roles/MCP auto-contribute (your project &
global override them). `.claude/agents/*.md` subagents load as roles too.

**Recall** — `hara recall --init` creates a personal `~/.hara/code-assets` library (snippets as `*.md`);
`hara recall "<query>"` searches it **plus your skills** (one corpus), and `/recall <query>` pulls the best
matches into your next message. A git-versionable library of code/patterns you want to reuse (`HARA_ASSETS` overrides the path).

**Approval modes**: `suggest` confirms edits & shell · `auto-edit` auto-applies file edits but confirms shell · `full-auto` runs everything.
**Sandbox** (macOS): `--sandbox workspace-write|read-only` runs the `bash` tool under Seatbelt (writes confined to the project / blocked).
**Sessions**: conversations are saved automatically — `-c` / `--resume <id>` to continue, `hara sessions` to list.
**MCP**: add an `mcpServers` map to config (global or project `.hara/config.json`); their tools appear to the agent as `mcp__<server>__<tool>`.
**Profiles**: add a `profiles` map to `~/.hara/config.json` (`--profile <name>`), or drop a project-level `.hara/config.json` that overrides the global config.

### The org — what makes hara different

Define role-agents in `.hara/roles/*.md` — each is a persona (the file body) plus frontmatter: `owns`
(keywords that route a task here), optional `rejects`, `model`, and `allowTools`/`denyTools`. `hara org
"<task>"` routes the task to the role that **owns** it (keyword match, LLM fallback) and runs that role's
agent — e.g. a read-only `reviewer` that reports issues vs an `implementer` that edits code. `hara roles`
lists them, `hara roles init` scaffolds a starter set, and `--role <id>` forces a specific role. The
**`agent`** tool spawns **parallel read-only sub-agents** for fan-out — analyze / review / search
several things at once (each can take a `role`).

Beyond routing, **`hara plan "<task>"`** makes the org *plan*: it decomposes the task into atoms,
sequences them as a DAG, and executes each step (optionally routed to a role) behind a per-step
**verify gate** — frame → atomize → sequence → execute → verify. Each atom may carry a `check` shell
command, so verification is **objective** (e.g. `npm test`, `tsc --noEmit`) rather than a
self-assessment. Plan state is the SSOT at `.hara/org/plan.json` (inspectable; execution stops on the
first failed verification).

### What it can do

A streaming agentic loop with built-in tools — `read_file`, `write_file`, **`edit_file`** /
**`apply_patch`** (surgical edits — single file, or **atomic multi-file** changes), `bash`, and
read-only **`grep`** / **`glob`** / **`ls`** / **`web_fetch`** — behind a human-in-the-loop confirmation gate on the
dangerous ones unless `-y`. Read-only tools run in parallel within a turn, and edits print a
**colored diff** of what changed. Shell output streams live; press **Esc** to interrupt a running
turn, or **`/undo`** to revert the last edit.
- **Project context**: auto-loads `AGENTS.md` (the cross-tool standard) walking up to the repo root; `hara init` writes one by analyzing the repo.
- **`@file` mentions**: attach file contents to a message (`@path`); Tab-completes with a **fuzzy** matcher over the project (subdirs, git-tracked + untracked) — `@idx` → `src/index.ts`. `@<dir>` loads a directory listing, `@src/`+Tab drills into a folder, and mistyped tool/file paths get a "did you mean" suggestion.
- **Multi-provider**: Anthropic (Claude) or any OpenAI-compatible endpoint (Qwen/DashScope, GLM, Kimi, OpenAI) — **all streamed live**.

### Roadmap

**Shipped:** ink TUI · plan mode · persistent memory + self-evolution · atomization planner · parallel sub-agents · `/compact` context management.
**Next:** parallel plan atoms · multi-role review chains · cron autonomy for the org · single-binary distribution · an enterprise control-plane (fleet + central token management).

## License

Licensed under either **MIT** ([LICENSE-MIT](LICENSE-MIT)) or **Apache-2.0**
([LICENSE-APACHE](LICENSE-APACHE)) at your option. Contributions per [CLA.md](CLA.md).

© 2026 Nanhara
