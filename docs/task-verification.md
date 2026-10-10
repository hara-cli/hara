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

## Closeout recovery and safe retry

`test/serve-task-closeout.test.mjs` also exercises real loopback WebSockets and the production disk
session store under `test/setup-isolated-home.mjs`. Its fixture client deliberately discards closing
text, the terminal event and the RPC response. A replacement Serve instance must then restore exactly
one closing reply and the original task/turn identity from disk. The five outcomes are completed,
external-state waiting, manual-action waiting, unfinished todos and a terminal provider error.

Retrying the same command UUID returns its saved outcome without another provider round, tool execution
or streamed turn. A conflicting reuse is rejected. If only the terminal command receipt failed to save,
the closing reply remains in history, but resume marks the command outcome unavailable and refuses
automatic re-execution. Reading a saved history does not require a model request.

These are deterministic service-instance replacement checks in one test process, not an OS-crash,
power-loss, native Desktop, public Relay or real-upload acceptance test. The fixture writes only a local
synthetic receipt; it never uploads media or sends messages. The durable cases fail before touching the
store unless the repository's per-process isolated-home preload is active. Run them after a build with:

```sh
node --import ./test/setup-isolated-home.mjs --test test/serve-task-closeout.test.mjs
```

Build and run in a private clone when Hara is running from the shared checkout; do not overwrite its live
`dist/`. `HARA_SERVE_TASK_CLOSEOUT_TEST_BUILD_ROOT` can select an already compiled private build instead.
