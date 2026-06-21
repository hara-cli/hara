---
name: chrome-control
description: Operate a REAL Chrome (with your persistent logins) for web tasks on signed-in sites — via chrome-devtools-mcp (Chrome DevTools Protocol). Use instead of the isolated Playwright `browser` plugin when the task needs your existing accounts/sessions.
when_to_use: when a web task must run on a site you're logged into (your dashboards, accounts, web apps) rather than a fresh anonymous browser.
---

# Chrome (real, logged-in) via chrome-devtools-mcp

Tools appear as `mcp__chrome__*` (navigate, click, fill, snapshot, network, performance…). Same
DOM/accessibility-tree reliability as the `browser` plugin, but it drives a **real Chrome with a persistent
profile** — log into a site once and the session is remembered across runs.

## Modes
- **Persistent profile (default):** `npx chrome-devtools-mcp@latest` launches Chrome with a saved profile at
  `~/.cache/chrome-devtools-mcp/chrome-profile`. Log in once; it persists. Good default.
- **Attach to YOUR running Chrome:** launch Chrome with `--remote-debugging-port=9222`, then set the MCP command
  to `npx chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222` — hara then drives your actual browser
  and all its logins.

## Enable (alternative to `browser`, not both)
Running two browser MCPs at once is confusing. To switch from the default Playwright `browser`:
`hara plugin add file:<repo>/plugins/chrome && hara plugin disable browser`.

## Caution
This controls a **real** browser session. Confirm before destructive/irreversible actions (purchases, posting,
sending, deleting); take a snapshot to verify the page/state first.
