# Changelog

All notable changes to `@nanhara/hara`.

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
