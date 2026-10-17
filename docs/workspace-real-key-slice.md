# Local Workspace real-key acceptance slice

This is an explicit opt-in acceptance route, not a release or general automatic BYOK migration.
The default `workspace-dev` remains synthetic. Pass `--ark-key-file /absolute/private/source.key`
to init/status/serve/run to select this lane. Desktop's isolated `dev:workspace` harness forwards
the same option. It never accepts a Key value in an argument or inherits a model/proxy environment.

The approved route is fixed to Ark Coding Plan `/api/coding/v3`, model
`deepseek-v4-1-flash-260910`. Each Workspace starts empty and needs its own explicit connection action;
the action stores only a canonical owner-only file reference with a frozen SHA256 generation. The
source is read-only (unsafe modes/links fail, no chmod repair), validated at every governed effect,
and never exposed in renderer DTOs. Changing the file requires a new explicit configuration/approval;
there is no fallback to another key, endpoint, model or Runtime.

The fixture-wide `.hara/real-key-budget-v1.json` survives restarts and includes all Workspaces and
colleagues. Limits: 300,000 input+output transport tokens, 24 wire requests, 4,096 output tokens per
request. Before IO, reserve UTF-8 request-body bytes + 8,192 protocol margin + max output. Only a
complete valid provider usage receipt settles the reservation. Crash, interruption, missing usage,
unsafe output, HTTP failure or an unknown outcome remains charged at the reservation and blocks all
new requests. No automatic replay or downgrade is possible. This is transport telemetry, not an
estimate of subscription credits or a provider invoice. Credentials/request/response bodies are not
stored in the budget ledger. The host's per-run/tree limits remain an additional independent bound.

Execution still uses the existing Hara-governed Pi model-step driver. Pi cannot directly run tools or
import native auth/plugins. Main Hara proposes a colleague, a fresh scoped human card is required,
then it may delegate one same-Workspace hop and only close with an observed verified result. The UI
calls them 同事; Pi is an internal runtime label, not a type of employee.

`test/workspace-real-key.test.mjs` uses fake key files and an injected in-memory SSE transport only.
It does not call a model. Real acceptance results, exact SHAs, timings, usage and leak scans are in
the workspace inbox report, not in this generic source document. Existing fixture-marker v1's
historical `synthetic-workspace-dev` kind remains a private fixture identity, not a provider claim;
discovery + negotiated capability explicitly identify the actual model mode.
