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

hara talks to Claude. Provide an API key one of two ways:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or: ~/.hara/config.json  →  { "apiKey": "sk-ant-...", "model": "claude-opus-4-8" }
```

## Use

```bash
hara                       # interactive REPL in the current directory
hara -p "fix the lint errors in src/"   # one-shot, non-interactive
hara -y                    # auto-approve tool actions (no confirmations)
hara -m claude-sonnet-4-6  # pick a model
```

Inside the REPL: `/help`, `/reset`, `/exit`.

### What it can do (v0.1)

A streaming agent loop with three built-in tools — `read_file`, `write_file`, `bash` — and a
human-in-the-loop confirmation gate on the dangerous ones (`write_file`, `bash`) unless you pass `-y`.
Default model: `claude-opus-4-8`.

### Roadmap

MCP client · permission policies · session persistence (SQLite+FTS5) · multi-provider · and the
**governed role-agent org** (routing, dispatcher, SSOT, approval gates, cron) — see the design docs.

## License

Licensed under either **MIT** ([LICENSE-MIT](LICENSE-MIT)) or **Apache-2.0**
([LICENSE-APACHE](LICENSE-APACHE)) at your option. Contributions per [CLA.md](CLA.md).

© 2026 Nanhara
