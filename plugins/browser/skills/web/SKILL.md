---
name: web-automation
description: Operate web pages reliably — navigate, click, fill forms, log in, extract — via the Playwright MCP. Acts on the DOM/accessibility tree by selector/role (deterministic, auto-waiting), NOT screenshots or pixel coordinates. Far more reliable than desktop screen control.
when_to_use: when the user wants to do anything on a website — open a page, click, fill/submit a form, log in, scrape data, automate a web flow.
---

# Web automation (Playwright MCP)

Reliable browser tools are available as `mcp__browser__*` (navigate, snapshot, click, type, fill_form,
select_option, evaluate, …). They act on the page's **accessibility tree by element ref/role/text** — not
screenshots or pixel coordinates — so they're deterministic and auto-wait for elements. This is the reliable
counterpart to the fragile desktop `computer` tool: prefer it for anything on the web.

## Workflow
1. `browser_navigate` to the URL.
2. `browser_snapshot` — read the accessibility tree (elements + their `ref`s). This is your "eyes": use the
   refs to act precisely. Prefer it over a screenshot.
3. Act by ref/role/text: `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`.
4. `browser_snapshot` again to verify before the next step.

## Notes
- First run downloads a browser once: `npx playwright install chromium`.
- The Playwright MCP uses its **own** browser (no logins). For tasks needing your **real logged-in Chrome**, use
  `chrome-devtools-mcp` instead (drives your actual Chrome via CDP) — swap the mcpServers command to
  `npx chrome-devtools-mcp@latest`. (This is what openclaw/cc-haha use.)
- **Confirm before irreversible actions** — purchases, posting, sending messages, deleting. Verify the page/state
  with a snapshot first.
