# C13: first-batch Core boundary acceptance

This slice closes the Core follow-ups from C0–C6. It keeps C0 v1, the private state schema, default bootstrap gates and supported runtime set unchanged. Its implementation does not enable production transports or add Desktop commands.

## Retained intent and lifecycle rules

- A retained routing work item has one original message digest. Reusing it with changed text returns `COMMAND_ID_CONFLICT` before any retained-owner return, including selected and claimed work. An original retransmission retains the original identity and cannot reassign an owner.
- A dispatch failure can be read back after a competing admission only when a genuine original claim exists. A rejected command receipt alone preserves the original error; it is not acceptance.
- An issued run cannot become a never-executed recovery target because usage is zero or physical closure is proven. Manual recovery must satisfy the original phase, terminal proof, released lease, effect and latest-claim checks.
- A positive closure fact does not permit releasing another live process's exact lease. Reconciliation checks the actual owner and original persisted evidence before release; it does not create execution authority.
- Refusing an invalid abort on an issued run preserves that run's healthy execution. The abandoning marker is set only after prepared-state and original-owner checks, before durable terminal publication.
- A later audience change fences every subsequent actual effect. The original owner and any UNKNOWN outcome survive late results and retransmission. UNKNOWN is reported ahead of an audience-change hint when both apply.

## Core acceptance matrix

Each execution receipt binds its exact source, toolchain, private guard, source invariance, test log and checksums. The table maps real entry points and observations, rather than treating a projection or a JSON permit as execution proof.

| ID | Boundary | Executable evidence |
| --- | --- | --- |
| L00 | Frozen C0 parser/fixture/lock and absent bootstrap | `check-agent-boundaries-contract.mjs`; contract tests and disabled Host/RPC cases |
| L01 | Host-owned provenance and passive external source | `agent-boundary-host.test.mjs` real WS/HTTP negatives; `agent-hub*` passive save tests |
| L02 | Human/Agent/resource/local-node intersection and actual scoped IO | `agent-boundary-execution.test.mjs`: actual IO, inode, links, scope adapter and unsupported native/child/exec/MCP paths |
| L03 | Durable C3 CAS/epoch, task stop and Agent pause domains | `agent-command-control`, `agent-command-host`, `agent-lifecycle-drain`, `agent-lifecycle-rpc` tests |
| L04 | Pre-issuance N5, manual recovery and original physical owner | `agent-lifecycle-recovery`, `agent-lifecycle-host-recovery`, `agent-boundaries-c13-lifecycle` tests |
| L05 | One owner from the audience and confirmed public duties | `agent-routing-owner`, `agent-routing-host`, public duty draft and tie/no-match cases |
| L06 | Original body, rejection diagnostics, two genuine Hosts | `agent-boundaries-c13-routing` F1/F2; joint selected barrier requires two Hosts but one claim/provider |
| L07 | One tool-free RoutingPermit and no resubmission of UNKNOWN | `agent-routing-classification`, `agent-routing-rpc`, `agent-routing-process` tests |
| L08 | Audience revalidation at the actual effect | Joint real WS test observes the first file, revokes membership during a real in-flight turn, and verifies no second file, original owner and retained UNKNOWN |
| L09 | Crash cuts and cold read-only effect observation | Existing independent routing/lifecycle process tests and original run-bound C2 journal checks |
| L12 | Ordinary rejection isolation, corruption and bounded history | C3 capacity/lease/expiry/CAS tests; lifecycle contract/history tests; original evidence is preserved |
| L13 | Deferred entry points stay closed | Existing bootstrap/provenance/legacy-entry negatives; additional humans, cloud/mobile and C7–C12 activation remain separate work |

L10/L11 require the actual frozen Desktop C5 consumer and are a separate joint signoff. A Core receipt does not certify its UI, capability negotiation, screenshots or command consumption.

The two new joint scenarios emit `C13_JOINT_CASE` with synthetic scope, original work/command/task/run/claim references, provider counts and physical closure. The IO case additionally records the actual first-file digest and absence of the revoked effect. No credential or private production content is emitted.

## Test and mutation entry points

Normal verification uses `npm test` (including build and feedback evaluation) under the established private HOME/TMP guard with credentials removed. Dependencies and compiled output are reused from the compatible locked checkout. Expected mutation failures are not part of the ordinary test glob.

Explicit mutation verification, after build and inside the same private guard:

```sh
node test/helpers/agent-boundaries-c13-mutations.mjs --verify
```

The verifier requires a green canonical baseline, then runs the existing C2/C3 loader targets, C4/C6 verifier suites and C13 regressions. A kill requires the exact applied marker, the named failing test and an assertion failure. Loader errors, skipped cases or fixture failures are not coverage. Substitutions happen only in per-process module loading; canonical compiled files are hashed before and after. Existing UNKNOWN checks shared by historical suites are repeat invocations, not additional independent defenses.

The C13 recovery mutations distinguish the phase/terminal pair from the independently necessary lease-release check. The latter uses a genuine never-issued terminal with the original physical release interrupted. The foreign-owner negative uses real continuing child processes, followed by genuine owner exit and evidence-based reconciliation.

## Remaining activation gates

Core acceptance is separate from Desktop joint signoff and production activation. Bounded archive/index capacity, reviewed recovery for issued crashes without positive closure evidence, the real single-origin classification adapter, and native/CLI/Desktop/legacy timeline wiring remain later prerequisites. Retained IDs, UNKNOWN and lease ownership are not cleared to bypass those gates.
