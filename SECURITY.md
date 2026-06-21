# Security

hara is a coding agent that reads/writes files, runs shell commands, drives a browser/desktop, and calls
LLMs — so it takes a layered, **human-in-the-loop-by-default** stance. This documents the threat model, the
controls, what is deliberately *not* a security boundary, and how to report a vulnerability.

## Threat model

hara runs on **your** machine under **your** account, on code **you** point it at. It is not a multi-tenant
sandbox. The adversary we defend against is primarily **the model going wrong** — a bad suggestion, a
prompt-injected web page or file steering it toward a destructive or exfiltrating action — not a malicious
local user (who already has your shell).

## Controls

- **Approval gate.** Every file edit, shell command, and screen action is classified (`read` / `edit` /
  `exec` / `computer`) and gated by an approval mode: `suggest` (confirm edits & commands), `auto-edit`
  (auto-apply edits, confirm commands), `full-auto` (no prompts — opt-in). Read-only tools never prompt.
- **Screen control is gated on *every* action.** The `computer` tool always asks before each click/type,
  even in `full-auto`, and "don't ask again" never applies to it. Guarded further by a frontmost-app
  **allowlist** (exact match), a dangerous-key **blocklist** (quit/close/logout across macOS/Windows/Linux
  syntaxes), and a per-session grant. Off by default.
- **Sub-agents are read-only.** The parallel `agent` fan-out tool runs sub-agents that can never edit or run
  shell — a role may *narrow* their tools but never *grant* write/exec. Write-capable roles run in the main
  loop (`hara org`), behind the gate.
- **Shell sandbox (macOS).** `--sandbox workspace-write|read-only` runs the `bash` tool under Seatbelt —
  **file-write confinement** (see the non-boundary note below). Commands/paths are passed as argv / a profile
  file, not interpolated into a shell string.
- **`web_fetch` SSRF guard.** Refuses to fetch private / loopback / link-local / CGNAT addresses (resolving
  the hostname first), re-checks on every redirect hop, and reads the body under a byte ceiling — so the
  model can't reach cloud-metadata endpoints or internal services.
- **Secrets.** `~/.hara/config.json` (API keys) and `~/.hara/qwen-oauth.json` (tokens) are written `0600`.
  The optional semantic index respects `.gitignore` and skips secret-named files, so keys aren't embedded or
  sent to an embedding provider. The memory guard screens secret-shaped strings out of what the agent saves.
- **Plugins are code you trust.** Installing a plugin (`hara plugin add`) grants its author code execution:
  its MCP servers and hooks run shell commands on launch. `hara plugin add` **prints the exact commands** a
  plugin will run so you can review them; disable with `hara plugin disable <name>`.
- **Coding-plan keys.** Provider keys you configure are used only to call the model endpoint you set.

## What is *not* a security boundary

- **The sandbox confines file writes only** — not reads, not network, not process exec; `/private/tmp`
  stays writable. It stops a stray `rm`/overwrite escaping the project, not a determined exfiltration. Treat
  a `full-auto` + network-capable shell as able to read and send anything your account can.
- **`@file` mentions** read any file *you* name (including outside the project) — that's you attaching
  context, not the model exfiltrating; mentions are expanded on your typed input only, never on model output.
- **`full-auto` / `-y`** removes the human gate by your explicit choice. Use it on code and in directories
  you trust.

## Reporting a vulnerability

Please report security issues privately — open a GitHub **security advisory** on `hara-cli/hara`, or email
the maintainers — rather than a public issue. Include a minimal reproduction and the impact. We'll
acknowledge, fix, and credit you.
