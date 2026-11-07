# Workspace operation cards

Hara ships eight original help cards in the built-in `hara-operations` skill. The system prompt includes one short skill description and its content digest. The existing read-only `workspace_skill` tool serves `SKILL.md` (the routing index) or one `cards/<id>.md` resource; it retains the existing pagination, output bounds, content guard and current-run permit check. No manual body is placed in the system prompt.

The built-in is application help, available without importing or enabling user skill files. Its reserved ID cannot be replaced by global/project content. It is delivered with the running Core source, without writes to a user's skill library or changes to stored feature schemas. User-enabled skills retain their own version locks, disable/fork revocation and tool restrictions. Reading either kind of skill grants no additional tools or authorization.

| Card | Contract checked against running code |
| --- | --- |
| `runtime-login` | Local registration approval and login-source validation; scoped runtime login and agent revision/epoch RPCs |
| `model-effort` | Runtime inventory and revisioned model/effort selection RPCs; inventory capabilities remain authoritative |
| `create-colleague` | Main-only roster/create tool schemas; pending is not created; original controller, human approval and consumed card |
| `channel-mentions` | Local member mention parser; group-only sync/wake tools and scoped send RPC |
| `failure-recovery` | Request receipt and resume RPC fields, generation fence, refusal when there is no resumable task; confirmed request deduplication and unknown-outcome refusal |
| `proxy-boundary` | Baseline has no `workspace.runtime-proxy.v1` or runtime proxy getter/setter; no invented settings instructions |
| `scope-permissions` | Actual file tool schemas/kinds; protected/absolute/escaping paths and revoked permit refusal |
| `verification-handoff` | Verify/receipt tool schemas; paged receipt data is run-local and reference-only |

Each card's RPC methods/fields and tool schemas are rendered from the same Hara-authored declaration as its prose. `test/workspace-operation-cards.test.mjs` compares those facts with tools captured from an actual formal Host and sends requests through the actual local JSON-RPC server. It checks unknown/missing fields and stale generations, plus the permission behaviors listed above. Deliberately renamed tools/RPCs and changed required fields must fail these checks. A fake provider also loads a single card through the governed tool boundary; no external model is called.

Human RPC names are explanatory contracts, not model tools. Cards instruct Hara to use only supplied tools and observed client capabilities, avoid invented UI labels, distinguish proposal/acceptance/completion, and continue within existing authorization without adding a new confirmation layer.

When a covered contract changes, update the affected card and behavior check together. In particular, integrating the independent proxy branch must update the proxy card: its current absence check intentionally rejects a stale guide. Group queue/interjection/ambient controls and rich failure UI also need matching card updates when admitted. These cards do not certify Desktop UI, real accounts, billing, or release status.

Focused validation (use Node 22.23.1+, and an owned task directory for `HOME`/`TMPDIR`):

```sh
npm run build
node --import ./test/setup-isolated-home.mjs --test --test-concurrency=1 --test-timeout=120000 test/workspace-operation-cards.test.mjs test/workspace-skills.test.mjs
```

Implementation: `src/workspace/operation-cards.ts`; existing reader: `src/workspace/skills.ts`; Host composition: `src/workspace/local-host.ts`. Mechanisms were informed by the fixed Raft study; the instructions and implementation are original Hara work and contain no Raft code, schema or prompt copies.
