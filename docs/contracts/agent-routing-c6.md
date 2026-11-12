# C6 Core-private owner routing (default closed)

C6 composes the existing C0 v1, actual C1 transport, C3 command/claim and C4 issuance/physical lifecycle. Production integration remains C12. Syntax and observed decisions never grant execution.

## Shared public duty source / onboarding G3

The sole duty field source is `AgentDutyProfile["publicProfile"]`: `title`, `description`, `owns`, `rejects`. `agent-duty-draft.ts` validates these with the unchanged C0 parser. `createAgentDutyDraft` returns only `kind=duty-draft/status=unconfirmed` public data; `agentDutyDraftProposal` builds a syntactic proposal against an explicit target/context/revision. Neither performs IO, confirms duty, issues a grant or enables automatic routing. C5 and onboarding step3 can import this same data helper. Batch creation/draft generation is not authority. Only a real C1/C3-confirmed duty can enter the directory; persona/instructions and imported roles cannot supply it.

## Private aggregate and migration

Explicit schema3->4 adds `routing` to the original authority aggregate. It retains all control/lifecycle/policy bytes, exact root/task/command/claim identities and UNKNOWN. Migration uses the original session admission lock and refuses physical leases/unsettled legacy effects. It never recreates a grant or proves an old run never executed. Without trusted C6 bootstrap, readers/writers fail closed; a schema downgrade remains fenced after restoration. Partial downgrades cannot re-enter legacy.

Routing records are bounded (128,512KiB), keyed to scope/generation/channel/work item. A classification submission identity and its UNKNOWN/final result are immutable. Claimed records cannot be reassigned or erased. Capacity refusal must remain scoped to the new request; true storage corruption remains fail-closed. C0 source/fixtures/lock and C4 history caps are unchanged.

## Selection and execution contract

Audience precedes public directory lookup and private context. Existing owner wins; otherwise actual structured human choice, exclusive human-confirmed business mapping, then unique public duty match. Ties/conflicts/no match return NEEDS_OWNER. Raw mentions/quotes/attachments never create human authority. Non-owners do not start a business model. Empty-recipient legacy notes stay notes.

An unclaimed nomination is private data. C0 reason values are not expanded or relabeled: classification/duty matching never pretends to be business_mapping. Only an actually accepted C3 claim can be projected as current_owner, retaining the original selection method privately. A multi-candidate/preclaim state without an honest C0 representation uses a private envelope with no synthetic C0 decision. It is not a second identity/receipt or execution contract.

The C3 aggregate CAS binds the single claim and original owner. Only original preparation/RunPermit/C4 issuance plus current C2 intersection can execute. Another message/command ID does not steal a work item; old UNKNOWN and in-flight effects retain original ownership. No C7 handoff, priority, autonomy or production admission is enabled.

## Restricted classification

A separately minted opaque RoutingPermit authorizes at most one no-tool provider invocation over the authorized human message and public candidate duties. It is not a C1 grant or execution permit. Durable submission_started precedes the provider boundary. Timeout/cancel/restart becomes UNKNOWN, never an automatic repurchase/fallback. Strict output is one whitelisted candidate or NEEDS_OWNER; no substring/first-role fallback. A late/stale result cannot take a claim.

## C12 prerequisites retained

Before opening production entries, separately review and implement C4 history capacity extension/compaction (64segments,512KiB each and4096commands/2048runs exact indexes) and manual recovery for issued crashes without positive quiescence. Do not erase taskId, release an unproven lease, evict UNKNOWN by age or replay business as a workaround.


### Narrow classifier adapter and its observation lifetime

C6 optionally accepts an explicit Host-only single-origin `AgentRoutingClassifierConfig`; the CLI/production bootstrap supplies none. It passes only a frozen public payload, stable original request/provider/budget refs, `tools=[]`, bounded input bytes/output tokens and an AbortSignal. The adapter must honor those limits and never replay accepted/unknown submissions; a real transport requires C12 review. No general provider/fallback factory is selected by the core. Current verification uses synthetic callbacks, not a paid provider claim.

Only the null-to-submission_started authority CAS mints the opaque RoutingPermit. Consumption and actual submission are separately one-shot; JSON, cold stored records, another authority or C1 grants cannot replace it. Physical adapter Promises remain observable after logical timeout. An original observed result can be stored after UI disconnection, but it cannot change an existing human-selected/claimed owner or promote a stale audience/catalog. UNKNOWN/final classification metadata is immutable. Routing state reserves1024bytes per submitted classification for bounded result publication, while preserving C4 active-run closure reserve. Counter exhaustion refuses the current request before invalid bytes can be written.


## E: trusted Host/WS entry, still closed in production

A trusted `AgentRoutingHostOptions` bootstrap requires C3+C4 and the independent C1 owner credential. CLI/native production composition does not supply it. Capability `workspace.agent-routing.v1` and the four private methods under `workspace.boundaries.routing.{initialize,directory,get,submit}` exist only for that bootstrap. Every call authenticates the actual C1 connection before Workspace/generation/audience lookups. Exact wire envelopes reject source, actor, proof, approved and enable overrides. `submit` takes the private routing input; it returns `NEEDS_OWNER` with no owner on uncertainty, or the original claim/receipt. There is no legacy broadcast fallback.

The opaque claim bridge pins both the logical channel/work body digest and `channelSessionId(channelId, owner)` plus the unchanged C3 message digest for that physical conversation. The original C3 accept atomically publishes one claim before creating the business provider or loading private start context. Dependency failures use C4 pre-issuance settlement. New work IDs are intentional new work; changing only request/command IDs never steals an existing work item. No serialized routing/projection object is executable.

The Host audience port reads channel metadata only (no activity/history/persona). A per-channel durable audience revision increments on membership changes, including remove+re-add; unrelated channel changes do not fence siblings. Every C2 effect checks the original audience digest. Public directory reads only confirmed C0 duties and current Agent metadata; actual resource/tool/home checks occur for the selected C1/C3 owner. Host-confirmed business bindings supply an explicit revision and unique owner IDs; that revision is part of the selection digest.

C6 creates only the owner's canonical channel conversation and governed reply. It does not populate the legacy fanout room queue/timeline or add a Desktop UI. C12 must review UI/result consumption, native bootstrap, actual single-origin classifier adapter and production enablement; the existing C4 capacity/manual recovery gates remain mandatory. Classifier pending physical calls count toward Host activity, and close aborts their signal without pretending unknown work was never submitted.
