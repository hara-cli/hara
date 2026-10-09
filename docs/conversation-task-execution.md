# Conversation and task execution

Hara treats “receiving a message” and “executing a task” as two related state machines. A busy input box is not
proof that an agent task exists, and a plausible interpretation is not permission to change the workspace.

## 1. Conversation controller

The conversation controller owns input delivery and ordering:

```text
submitted input
      |
      +-- local control (/model, /skills, ...) --> serialize UI work
      |                                           queue later input as next
      |
      +-- executable slash skill (/design, ...) -> live task; accept steering
      |
      +-- explicit /next -----------------------> next-task queue barrier
      |
      +-- live executable turn -----------------> steer that exact turn id
      |
      `-- no live executable turn --------------> start a new task
```

Only an executable model turn publishes a steer target. Local controls can keep the UI busy but cannot receive
steering. User-invocable slash Skills are not controls: they launch an Agent task and publish its turn ID.
If a turn finishes after an input was marked as a steer but before delivery, the session router
promotes that input to a normal turn. A steer aimed at the wrong still-existing turn remains an error, because
silently attaching it to another task would corrupt intent.

The queue therefore has explicit semantics:

- **steer**: refine the exact live task;
- **next**: wait for the current operation, then create a new task;
- **control**: change local UI/configuration state without pretending an agent task exists.

## 2. Understanding and execution

Every main task preserves two different records:

- `objective`: the bounded raw user request, kept as the authoritative source;
- `brief`: the agent's explicit interpretation of intent, goal, constraints, acceptance checks, and steps.

Before a brief exists, Hara permits conversation, file reads, search, questions, and todo planning. The runtime
blocks edits, unsafe or unknown shell commands, computer actions, external agents, and MCP connections. The
agent must first call the engine-owned `task_intake` tool. This is a separate persisted protocol round,
not necessarily a separate model request:

```text
raw request
    |
    v
read / inspect / clarify
    |
    v
task_intake checkpoint
  intent + goal + constraints + acceptance + steps
    |
    v
authorized execution
    |
    v
verification against acceptance checks
```

Separating the checkpoint from the first mutation is deliberate. If a model places `task_intake` and an edit
in one response, Hara splits the response, closes and persists the checkpoint's tool-use/result pair, then
revalidates the carried edit against the accepted state and permission gates. That edit does not require an
extra model request, but cannot bypass the boundary—even when an older `change` brief already existed. New
user steering discards carried actions so the model must reconsider them. Resume never starts from a
half-written state.

An `answer` or `investigate` brief does not authorize mutation. A mutating operation requires `intent: change`;
opaque external tools retain their own per-action confirmation in addition to the understanding gate. The
runtime classifies mixed action tools by operation: `task list` and `cronjob list` are reads, while their
write/run actions are changes. Invalid truthy substitutes for Bash's boolean `background` flag are rejected.

## 3. Context ownership

The transcript is evidence, not the task state. Hara persists a compact execution object alongside it:

```text
TaskExecution
  identity: task id + turn id + status
  objective: original request
  brief: accepted interpretation
  steering: bounded audit of later refinements
  checkpoint: todos/outcome used for resume
```

On every model round, the runtime reconstructs the authoritative context from the current execution object. The
stable task identity snapshot deliberately does not embed a frozen brief; exactly one current brief is added
dynamically, so a revision cannot leave the model seeing both the old and new goals. Providers that support
trailing turn context receive changing clock/brief/checkpoint data after durable history, preserving the
stable system prefix rather than invalidating its cache. Steering
that arrives while the model is running updates the authoritative owner first; a later brief checkpoint
refreshes from that owner before writing, preventing a stale snapshot from deleting the new steering.

This division keeps compaction and resume predictable: a shorter transcript may lose conversational detail,
but it does not silently replace task identity, accepted constraints, or completion criteria.

## 4. Design influences and boundaries

- Codex demonstrates turn-id-aware steering and recovery when a turn ends during delivery.
- cc-haha keeps message queue priority separate from the model query loop.
- Claude Code documents isolated subagents, deterministic hooks, and plugin packaging.

Hara uses those ideas selectively. Specialist agents are appropriate for bounded independent research; they
are not an automatic substitute for understanding the main task. Hooks enforce deterministic policy; prompts
guide judgment. The engine remains responsible for delivery identity, permissions, checkpoints, deadlines,
and loop guards.

“Self-improvement” should likewise be evidence-driven: record recurring failures, add a regression, change a
policy/prompt/runtime component, and measure it. Hara must not silently rewrite its own core prompt or grant
itself broader permissions.

## 5. Engine-owned progress and bounded pauses

A successful tool receipt is not automatically progress. Hara maintains a run-local watchdog that stores only
digests and bounded text shingles—never raw prompts, arguments, results, paths, or credentials—and compares both
observable evidence and durable task state:

```text
tool round
  -> compare successful evidence fingerprints
  -> compare task facts/artifacts/capabilities/completion
  -> compare newly completed todos
  -> publish credential-free progress counters
  -> continue | warn | pause
```

The fourth substantially unchanged repeat of the same successful call pauses the run. Six consecutive rounds
of more than 80% similar successful evidence also pause it. For Serve/Desktop/Mobile, headless print, gateway,
cron, and native subagent work, five rounds without a genuinely new checkpoint, completed todo or verified
file change raise one warning; eight pause the run. Attached runs with unfinished todos use the same warning
decision, but do not acquire that unattended eight-round stop. The 200,000 input/output token boundary applies
to all runs and uses cumulative usage since run start (minus its initial stats baseline), with at least two
consecutive stale rounds. It is not a sliding “tokens since last progress” counter. A live user steer refreshes
the unattended/warning window, not consumed tokens or the evidence ledger.

One continuous warning episode produces one reminder and one notice. Real durable progress can re-arm it.
There is no second todo timer and no Gateway heuristic that treats five uses of the same tool as a stall.
The specific Gateway missing-native-image-input correction remains separate, internally wrapped and issued
once; quiet children never inject or consume the main conversation's reminder stream.

Only new observed evidence counts: a new fact value/evidence receipt, artifact, capability state, completion
receipt, or newly completed todo. Rewriting `current_step`, resaving an identical fact, or changing command
offsets/temp names does not reset the gate. Conversely, a genuine checkpoint clears evidence-similarity streaks,
so long healthy work is not killed because `task_checkpoint` returned the same boilerplate receipt. Explicit
status progress such as a changed percentage, completed/processed count, or `done/total` ratio remains new
evidence even when the surrounding status prose is unchanged; bare offsets and line numbers do not.

Authentication and authorization boundaries are state, not search problems. After the first 401/403 the Agent
gets one bounded chance to use a supported sign-in/capability route. An unrelated successful read does not erase
that boundary; a second access-boundary attempt pauses the task with the reason preserved.

`no_progress` and repeated-loop outcomes are resumable `paused` task states. Serve emits the stop reason plus
round, tool-call, token, todo, similarity, and checkpoint-age counters through `event.task_state.progress`.
Desktop and Mobile should render this typed object and the persisted blocker/next step; they must not infer
progress by parsing terminal prose.

Failure warning and hard-stop counting share one module's identity, reset and eviction rules. Their lifetimes
remain intentionally distinct: warnings retain their existing session scope, while each run starts a fresh
hard-stop ledger. Successful unrelated reads cannot erase access or policy boundaries.

## 6. Human closeout and errors

An accepted fresh completion receipt closes the model turn without another model request just to produce
prose. Missing prose receives a bounded, redacted ordinary assistant reply from durable state. Awaiting-user
dependencies and unfinished todos override contradictory success claims. Copy-only manual instructions,
verification commands and resume phrases remain available to plain-text clients; they are never executed
by rendering the reply. Long or multiline commands are not presented as executable truncated prefixes.

The shared `isRecoverableRunPause` classification drives persisted status, closeout wording and Serve's pause
response. Provider/empty/unclassified safety failures stay blocked errors, not a generic `/continue` pause.
Their terminal event retains this turn's already streamed/persisted handoff, while the RPC still reports an
error. Explicit cancellation and task/turn ownership fences remain authoritative.

Neither a normal model turn nor a model-authored receipt independently proves every external business
effect. Uploads, publications and other consequential operations still need their own authoritative evidence;
an unknown result must not be blindly replayed.
