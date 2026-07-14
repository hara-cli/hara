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
- **Protected reads in built-in paths.** `.env`, `.env.*` (except explicit templates such as
  `.env.example`), credential stores, private keys, and private Hara state are rejected before the ordinary
  approval/dispatch path can authorize them. The same canonical/real-path check covers built-in file reads,
  edit/patch pre-reads, grep/glob/ls, `@file`, completion, semantic/lexical indexes, checkpoints, gateway file
  delivery, cron command admission, and symlink aliases. Headless, gateway, sub-agent, cron, and `full-auto`
  execution cannot approve those built-in paths past the check. `HARA_ALLOW_SENSITIVE_FILES=1` is an explicit
  launch-time exposure switch for one process: it removes the built-in denies and that process's shell
  protected-read preflight/Seatbelt mask.
- **Standalone launch configuration is closed.** Released Bun-compiled binaries explicitly disable runtime
  loading of the working directory's `.env`, `bunfig.toml`, `package.json`, and `tsconfig.json`. This prevents
  a project preload or ambient environment file from running/injecting values before Hara's own boundaries.
  Native CI executes each release binary from a hostile fixture directory and fails if either path activates.
- **Shell guardrails differ by platform.** With the protected-file policy enabled, shell admission statically
  rejects literal protected paths and environment-dump commands on every OS. On macOS, Hara additionally
  applies a Seatbelt read mask to existing
  protected files/directories even when the general write sandbox is off. Linux and Windows have no equivalent
  kernel-enforced read mask: their arbitrary shell code is outside the protected-file boundary, and static
  preflight can be bypassed by indirection or generated code.
- **Subprocess credentials.** Model-controlled Bash/background jobs, hooks, external agents, and MCP servers
  inherit an environment with secret-shaped and code-injection variables removed. MCP `env` entries are an
  explicit per-server grant; other commands can receive named variables only when the user launches Hara with
  `HARA_SUBPROCESS_ENV_ALLOW=NAME,OTHER`. Tool output is pattern- and exact-value-redacted. Hara's own provider
  process retains its keys.
- **Secrets at rest.** `~/.hara/config.json` (API keys) and `~/.hara/qwen-oauth.json` (tokens) are written
  `0600`. The optional semantic index skips secret-named files and filters old indexes at query time, so keys
  aren't embedded or sent to an embedding provider. The memory guard screens secret-shaped strings out of
  what the agent saves.
- **Repository config is untrusted by default.** A project `.hara/config.json` can set only `model`, `theme`,
  `vimMode`, `autoCompact`, and `reasoningEffort`. Endpoint/credential routing, hooks/MCP commands, approval,
  sandbox, guardian, computer control, and all other keys remain global unless the user launches Hara with
  `HARA_TRUST_PROJECT_CONFIG=1` after reviewing that repository. Warnings name ignored/enabled keys but never
  their values. Project config reads reject a symlink `.hara`, final symlinks, hard links, oversized files,
  and files/directories that change identity during the read.
- **Identity pins are bound, not followed.** `.hara-profile` reads reject symlink/hard-link aliases and
  oversized or changing files. Writes use a canonical-parent, no-follow snapshot plus atomic compare-and-swap;
  invalid pin warnings never include the pin's raw content or untrusted path. Git-tracked pins are ignored by
  default so a cloned repository cannot silently switch to an existing personal/org identity; untracked local
  pins remain usable, and the reviewed-repository `HARA_TRUST_PROJECT_CONFIG=1` launch opt-in enables tracked pins.
- **MCP/external agents are trusted extensions.** They execute outside Hara's protected-file boundary. Every
  interactive tool call requires confirmation, including in `full-auto`; non-interactive runs disable them by
  default. Reviewed automation can explicitly enable them before launch with
  `HARA_ALLOW_TRUSTED_EXTENSIONS=1`. Their inherited environment is still scrubbed, but the extension may use
  its own credentials or access anything its host process permits.
- **Plugins are code you trust.** Installing a plugin (`hara plugin add`) grants its author code execution:
  its MCP servers and hooks run shell commands on launch. `hara plugin add` **prints the exact commands** a
  plugin will run so you can review them; disable with `hara plugin disable <name>`.
- **Coding-plan keys.** Provider keys you configure are used only to call the model endpoint you set.

## What is *not* a security boundary

- **The general sandbox confines file writes only** — not arbitrary reads, network, or process exec;
  `/private/tmp` stays writable. The protected-file policy is a narrow boundary for Hara's built-in paths,
  plus an OS-enforced shell read mask on macOS only; it is not a complete hostile-code jail. On Linux and
  Windows, treat any allowed network-capable shell as able to read and send anything the Hara process account
  can access. On macOS, the protected-path mask still does not confine ordinary files, network, or process exec.
- **`@file` mentions** can read ordinary files *you* name (including outside the project), but protected
  files are refused unless you made the launch-time opt-in. Mentions are expanded on user input only.
- **`full-auto` / `-y`** removes the human gate by your explicit choice. Use it on code and in directories
  you trust. It does not remove built-in protected-path checks or subprocess environment scrubbing, but it
  does not turn Linux/Windows shell preflight into a security boundary.

## Reporting a vulnerability

Please report security issues privately — open a GitHub **security advisory** on `hara-cli/hara`, or email
the maintainers — rather than a public issue. Include a minimal reproduction and the impact. We'll
acknowledge, fix, and credit you.
