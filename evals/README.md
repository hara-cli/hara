# Hara feedback evaluations

This is Hara's controlled counterpart to Codex's scored iteration loop: establish a reproducible baseline,
make one focused change, rerun the same evaluation, inspect its evidence, and promote the change only when
the explicit threshold passes. The method follows OpenAI's official
[Iterate on difficult problems](https://learn.chatgpt.com/use-cases/iterate-on-difficult-problems)
workflow; it does not let a model rewrite product code, policies, or prompts autonomously.

`feedback/*.json` are sanitized, deterministic execution receipts derived from real reports in the
canonical `hara 反馈群`. They contain no prompts, user names, message IDs, credentials, or local user
paths. They are regression baselines, not claims that a live model was called during CI.

Run the gate with the repository-pinned Node runtime:

```bash
npm run eval:feedback
```

Each trace fixes an expected outcome and budgets for rounds, tool calls, approvals, user interventions,
and repeated no-progress failures. It can also require a strategy transition within a bounded number of
tool calls, forbid sending to a retired model, and require engine-readable completion evidence or the
exact typed/evidenced human dependency. Action-ownership receipts also enforce zero wrongful delegation:
an authorized action with an available tool must remain owned by the Agent. The command exits non-zero on
any regression and prints aggregate completion success rate, wrong-handoff count, and cost-shaped metrics.

To add a trace, redact it first and use `traceKind: "sanitized-feedback"` plus a `redacted-...` source
reference. The evaluator rejects common secret shapes and macOS, Linux, or Windows user-home paths. A
recorded live run should be transformed into this bounded receipt rather than checking a raw Hara session
into Git: session transcripts can contain private work, tool arguments, paths, and credentials.
