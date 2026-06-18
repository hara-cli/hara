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
```

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
hara                       # interactive REPL in the current directory
hara -p "fix the lint errors in src/"   # one-shot, non-interactive
hara -y                    # auto-approve tool actions (no confirmations)
hara -m claude-sonnet-4-6  # pick a model
```

Inside the REPL: `/help`, `/reset`, `/exit`.

### What it can do (v0.1)

A streaming agentic loop with three built-in tools — `read_file`, `write_file`, `bash` — and a
human-in-the-loop confirmation gate on the dangerous ones (`write_file`, `bash`) unless you pass `-y`.
**Multi-provider**: Anthropic (Claude) or any OpenAI-compatible endpoint (Qwen/DashScope, GLM, Kimi, OpenAI).

### Roadmap

MCP client · permission policies · session persistence (SQLite+FTS5) · streaming for OpenAI-compatible
providers · and the **governed role-agent org** (routing, dispatcher, SSOT, approval gates, cron).

## License

Licensed under either **MIT** ([LICENSE-MIT](LICENSE-MIT)) or **Apache-2.0**
([LICENSE-APACHE](LICENSE-APACHE)) at your option. Contributions per [CLA.md](CLA.md).

© 2026 Nanhara
