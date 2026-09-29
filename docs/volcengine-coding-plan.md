# Volcengine Ark Coding Plan

Coding Plan is a separate subscription route from Agent Plan and ordinary pay-as-you-go Ark access:

| client/protocol | base URL |
|---|---|
| Hara, Codex, OpenCode and other OpenAI-compatible tools | `https://ark.cn-beijing.volces.com/api/coding/v3` |
| Claude Code and other Anthropic-compatible tools | `https://ark.cn-beijing.volces.com/api/coding` |

Hara uses the OpenAI-compatible Responses route. Do not replace it with `/api/v3`: that is the ordinary
pay-as-you-go Ark route and does not consume Coding Plan allowance. Do not replace it with `/api/plan/v3`
either; that belongs to Agent Plan.

## Hara setup

```bash
hara profile add ark-coding-plan --byok \
  --provider volcengine-coding-plan \
  --model ark-code-latest
hara profile use ark-coding-plan
hara doctor
```

The masked setup prompt stores the selected connection's API key. A trusted launcher may instead export
`ARK_API_KEY` and pass `--no-key-prompt`.

Use `ark-code-latest` when Ark Console should control the concrete model, including its Auto mode. `auto`
itself is not a valid Coding Plan wire model ID. A console switch can take several minutes to become active.
To pin one model, select one of the current Model Names below.

### Choosing a model

The Desktop picker keeps the wire ID visible but describes the intended workload so people do not have to
guess from model names alone:

| need | suggested starting point | notes |
|---|---|---|
| default / unsure | `ark-code-latest` | Ark Console manages Auto or the pinned concrete model; best default for most people |
| routine coding with balanced latency | `doubao-seed-2.1-lite` | 1M context and up to 256K output |
| small edits and completion | `doubao-seed-2.0-mini` | speed-first 256K-context option |
| long-running coding or Agent orchestration | `doubao-seed-evolving` | stable ID with frequently evolving Coding/Agent capability |
| difficult production coding | `doubao-seed-2.1-pro`, `glm-5.3`, or `deepseek-v4-pro` | reserve higher-allowance models for work that needs them |
| image-aware routine development | `glm-5.3-flash`, `deepseek-v4.1-flash`, or `minimax-m3` | multimodal options with 1M context |
| focused code work with image/video input | `kimi-k2.7-code` | 256K context; output including reasoning is more constrained |
| software engineering and deep reasoning | `kimi-k3` | always-thinking, high-allowance option for complex work |

These are workload suggestions, not a universal quality ranking. Live key-scoped availability and the Ark
Console remain authoritative.

## Current conversation-model catalog

Hara's built-in fallback catalog, verified against the Coding Plan documentation on 2026-09-29, is:

- `ark-code-latest`
- `doubao-seed-evolving`
- `doubao-seed-2.1-pro`
- `doubao-seed-2.1-lite`
- `doubao-seed-2.0-mini`
- `minimax-m3`
- `glm-5.3` (`glm-latest`)
- `glm-5.3-flash`
- `deepseek-v4.1-flash`
- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `kimi-k2.7-code`
- `kimi-k2.8-preview`
- `kimi-k3`

`doubao-seed-2.0-lite` and `doubao-seed-2.1-turbo` are sunset entries, so Hara hides them from new
selections while preserving an already configured value long enough to migrate it. `doubao-embedding-vision`
is a vector model, not a conversation model, and therefore belongs in an embedding configuration rather than
the Hara chat/Agent model picker.

A successful key-scoped live catalog remains authoritative for entitlement. Unknown future conversation
models may be selected explicitly, but they do not inherit unverified vision, tool, context, or failover
capabilities. Volcengine remains authoritative for subscription usage; Hara does not manufacture a billing
formula from transport token counts.

Official references:

- [Coding Plan core configuration and supported tools](https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-other-tools?lang=zh)
- [Coding Plan for Codex](https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-codex?lang=zh)
- [Coding Plan quick start](https://docs.volcengine.com/docs/ark/coding-plan-personal-get-started?lang=zh)
