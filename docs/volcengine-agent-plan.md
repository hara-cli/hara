# Volcengine Ark Agent Plan

Volcengine exposes two intentionally different Agent Plan compatibility routes:

| client | protocol | base URL | credential variable |
|---|---|---|---|
| Hara / Codex | Responses API | `https://ark.cn-beijing.volces.com/api/plan/v3` | `ARK_API_KEY` |
| Claude Code | Anthropic Messages | `https://ark.cn-beijing.volces.com/api/plan` | `ANTHROPIC_AUTH_TOKEN` |

Do not mix the two base URLs. An Agent Plan key is also different from an ordinary pay-as-you-go Ark API
key or an older Coding Plan key. Generate and manage the dedicated key in the Agent Plan console, never
paste it into chat, and give each person a separate key so it can be rotated independently.

## Hara

Interactive setup (the key prompt is masked):

```bash
hara profile add ark-agent-plan --byok \
  --provider volcengine-agent-plan \
  --model ark-code-latest
hara profile use ark-agent-plan
hara doctor
```

For a trusted launcher that already exports the key, avoid storing another copy:

```bash
export ARK_API_KEY="<YOUR_AGENT_PLAN_KEY>"
hara profile add ark-agent-plan --byok \
  --provider volcengine-agent-plan \
  --model ark-code-latest \
  --no-key-prompt
hara profile use ark-agent-plan
```

`ark-code-latest` follows the model selected in the Ark console. Use `/model` or pass an explicit current
text-model id when a session needs to stay pinned. Hara uses Responses streaming and function calling,
keeps its durable transcript locally with `store:false`, and does not automatically enable provider-side
Harness tools because local approvals and organization policy remain the authority.

## Codex CLI or Codex mode in ChatGPT Desktop

Install current Codex, then put this provider in `~/.codex/config.toml` (Windows:
`%USERPROFILE%\.codex\config.toml`):

```toml
model = "ark-code-latest"
model_provider = "volcengine-agent-plan"
model_supports_reasoning_summaries = true
model_reasoning_effort = "medium"

[model_providers.volcengine-agent-plan]
name = "volcengine-agent-plan"
base_url = "https://ark.cn-beijing.volces.com/api/plan/v3"
env_key = "ARK_API_KEY"
wire_api = "responses"
```

Export `ARK_API_KEY` from a private shell/credential manager, restart the terminal or Desktop app, and run
`codex`. The documented reasoning values are `low`, `medium`, and `high`. If selecting
`kimi-k2.7-code`, remove `model_supports_reasoning_summaries = true` because that model does not support
the Codex reasoning-summary flag.

## Claude Code

Claude Code must use the Anthropic-compatible route instead. The recommended automatic setup is
`arkcli helper` with consumption type `agent-plan` and AI Agent `Claude Code`. For manual setup, merge the
following `env` object into `~/.claude/settings.json` (Windows:
`%USERPROFILE%\.claude\settings.json`):

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<YOUR_AGENT_PLAN_KEY>",
    "ANTHROPIC_BASE_URL": "https://ark.cn-beijing.volces.com/api/plan",
    "ANTHROPIC_MODEL": "ark-code-latest",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "ark-code-latest",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "ark-code-latest",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "ark-code-latest",
    "CLAUDE_CODE_SUBAGENT_MODEL": "ark-code-latest",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

Set `hasCompletedOnboarding` to `true` in `~/.claude.json`, restart Claude Code, then run `/status` to
confirm the selected model. The traffic-disable setting prevents Claude Code's nonessential background
traffic from consuming Agent Plan allowance. For models that support it, Ark's optional thinking-off body
is `{"thinking":{"type":"disabled"}}` via `CLAUDE_CODE_EXTRA_BODY`.

Official references:

- [Volcengine Agent Plan for Codex](https://docs.volcengine.com/docs/82379/2556054?lang=zh)
- [Volcengine Agent Plan for Claude Code](https://docs.volcengine.com/docs/82379/2373740?lang=zh)
- [Supported Agent Plan models and Harnesses](https://docs.volcengine.com/docs/82379/2366394?lang=zh#3d801f5f)
