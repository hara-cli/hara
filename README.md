# hara

**A coding agent CLI that runs like an engineering org.**

> Think "Claude Code, but it operates as a configurable, governed *organization* of role-agents" —
> with routing boundaries, a dispatcher, a single source-of-truth data layer, human-in-the-loop
> approvals, and cron autonomy.

🚧 **Early / v0.1** — a minimal but working single coding agent (the foundation). The governed
multi-agent "org" layer is next on the roadmap. Track it: https://github.com/hara-cli/hara · https://hara.run

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

Config lives in `~/.hara/config.json`. Env vars override it: `HARA_PROVIDER`, `HARA_MODEL`,
`HARA_BASE_URL`, `HARA_API_KEY`, or the provider key (`ANTHROPIC_API_KEY` / `DASHSCOPE_API_KEY`).

## Use

```bash
hara                       # interactive REPL (offers to create AGENTS.md on first run)
hara init                  # analyze the project & (re)generate AGENTS.md
hara -p "summarize @README.md and fix the lint errors in src/"   # one-shot; @path attaches a file
hara --approval auto-edit  # suggest (default) | auto-edit | full-auto   (-y = full-auto)
hara --sandbox workspace-write   # confine shell writes to the project (macOS Seatbelt)
hara -c                    # resume the most recent session in this directory
hara --profile work        # use a named profile from ~/.hara/config.json
hara -m glm-5              # pick a model
```

Inside the REPL: `/help` `/init` `/tools` `/model` `/approval` `/usage` `/sessions` `/reset` `/exit`. Type `@` + Tab to attach a file.

**Approval modes**: `suggest` confirms edits & shell · `auto-edit` auto-applies file edits but confirms shell · `full-auto` runs everything.
**Sandbox** (macOS): `--sandbox workspace-write|read-only` runs the `bash` tool under Seatbelt (writes confined to the project / blocked).
**Sessions**: conversations are saved automatically — `-c` / `--resume <id>` to continue, `hara sessions` to list.
**MCP**: add an `mcpServers` map to config (global or project `.hara/config.json`); their tools appear to the agent as `mcp__<server>__<tool>`.
**Profiles**: add a `profiles` map to `~/.hara/config.json` (`--profile <name>`), or drop a project-level `.hara/config.json` that overrides the global config.

### What it can do (v0.2)

A streaming agentic loop with built-in tools — `read_file`, `write_file`, **`edit_file`** (surgical
exact-string edits), `bash` — behind a human-in-the-loop confirmation gate on the dangerous ones unless `-y`.
- **Project context**: auto-loads `AGENTS.md` (the cross-tool standard) walking up to the repo root; `hara init` writes one by analyzing the repo.
- **`@file` mentions**: attach file contents to a message (`@path`, Tab-completes from `git ls-files`).
- **Multi-provider**: Anthropic (Claude) or any OpenAI-compatible endpoint (Qwen/DashScope, GLM, Kimi, OpenAI).

### Roadmap

MCP client · permission policies · session persistence (SQLite+FTS5) · streaming for OpenAI-compatible
providers · and the **governed role-agent org** (routing, dispatcher, SSOT, approval gates, cron).

## License

Licensed under either **MIT** ([LICENSE-MIT](LICENSE-MIT)) or **Apache-2.0**
([LICENSE-APACHE](LICENSE-APACHE)) at your option. Contributions per [CLA.md](CLA.md).

© 2026 Nanhara
