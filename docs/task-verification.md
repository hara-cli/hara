# Source-linked task verification

Hara retains the accepted task brief, checkpoints and completion receipt separately from chat history.
`task_checkpoint.completion.checks` optionally links each acceptance criterion to successful working
tool calls actually observed by the current run. It is a provenance check, not an independent judge
of business success. The model still needs to interpret the result correctly, and consequential work
still needs the appropriate external receipt or read-only reconciliation.

```json
{
  "completion": {
    "state": "verified",
    "evidence": ["The receipt confirms the requested delivery."],
    "checks": [
      {
        "acceptance_index": 0,
        "evidence": "The platform receipt confirms one delivery.",
        "tool_call_ids": ["the_actual_tool_call_id"]
      }
    ]
  }
}
```

- Cover every current acceptance index exactly once. Each check permits 1–4 distinct tool calls and
  a credential-free interpretation of at most 400 characters.
- Failed, denied, unexecuted, duplicate-ID, bookkeeping, memory-recall or stale calls cannot be cited.
  A different task, turn, accepted brief or user steering invalidates earlier references. Routine
  checkpoint and usage updates do not.
- The run-local ledger retains only hashes, not tool arguments or raw results. It is capped at 512
  entries and fails closed on overflow. No history or model-authored “receipt” populates the ledger.
- Accepted checks are converted to bounded, source-digested evidence in the existing task schema.
  The text interpretation remains model-authored; the digest attests only to an observed source.
- Legacy receipts remain compatible and do **not** acquire source-linked verification retroactively.
  Resumed runs must reconcile existing receipts safely rather than replay an upload, message or paid
  request to obtain a new citation. `awaiting_user` retains its existing typed-dependency protocol.

This adds no provider request, automatic retry, permission grant or paid operation. Regression tests
use in-memory tools and deterministic providers: valid baseline, malformed/stale/failed reference
boundaries, human-dependency isolation and no-replay closeout. These tests verify engine behavior;
they are not a live-model comparison or proof of improved end-to-end task success.
