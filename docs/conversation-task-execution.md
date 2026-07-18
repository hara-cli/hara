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
agent must first call the engine-owned `task_intake` tool in a separate round:

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

Separating the checkpoint from the first mutation is deliberate. A model cannot place `task_intake` and an
edit in one response to bypass the boundary—even when an older `change` brief already existed. The checkpoint
is published and persisted only after its tool-use/result pair is protocol-complete, so resume never starts
from a half-written state.

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

On every model round, the runtime reconstructs the system context from the current execution object. The
stable task identity snapshot deliberately does not embed a frozen brief; exactly one current brief is added
dynamically, so a revision cannot leave the model seeing both the old and new goals. Steering
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
