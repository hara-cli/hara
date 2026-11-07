# Workspace extension catalog (P0.5)

This slice discovers metadata and stores two levels of permissions. It never starts an MCP server,
installs or activates a plugin, resolves credentials, registers a runtime tool, or calls an upstream.
The existing governor, run permits, native runtime launch paths and global MCP registry are unchanged.

## Candidates and identity

The trusted Host reads its own bounded global Hara MCP configuration and verified installed plugin
manifests. The global JSON projection scans past secret-bearing values without decoding/materializing
`env`, `args`, headers, URLs, profiles or other configuration domains. It projects only server keys,
command identity, transport and redacted description. Source discovery does not create config/plugin
folders. Malformed/aliased host config fails with a fixed error; invalid plugin manifests contribute nothing.

Renderer DTOs contain a source ID, kind, display name, transport, redacted executable summary,
description, opaque source revision and reviewed tool metadata. They contain no executable path,
argv, environment, credential reference or endpoint. The source namespaces are:

- `global:<registered Host ID>:<server key>`
- `plugin:<verified manifest digest>:<declared server key>`
- `workspace:<id>` (available to a future trusted workspace-specific source provider)

The plugin digest currently identifies the verified manifest, **not an audited binary/package**.
Global config file identity/timestamps invalidate metadata even when only skipped values change.
Same display names never merge or overwrite another source's grant. No plugin hooks, skills, bins or
panels are enabled by an MCP switch. Discovered sources have no reviewed tools in this slice; they
show as awaiting review and can grant no tool. The trusted Host provider seam can supply reviewed
synthetic metadata for tests and the future manager; the renderer cannot supply tool metadata.

## Storage and effective permissions

`workspace-extensions-v1.json` is a separate private `VersionedSettings` domain inside the existing
Workspace resource generation. Existing feature documents are not rewritten. Missing data is revision
zero with all switches off. CAS, resource binding, private writer fences and backup recovery are reused.
Recovered/newer-schema state is read-only and grants no tools. Corrupt state without a usable backup
is preserved and refused. Storage/catalog sizes, tool sets and pending proposals are bounded.

Each source stores an explicit workspace tool allowlist. Each colleague, including main Hara, needs
its own enabled assignment and explicit subset of that allowlist. Empty arrays grant nothing; null and
wildcards are rejected. Turning a connection off preserves its selections but removes effective access.
A changed descriptor/catalog invalidates old locks; new tools cannot be inherited. Agent epoch changes
also invalidate assignments. Host management is restricted to its authenticated local owner; account
scopes need a separate trusted owner/admin admission adapter before management is enabled.

## RPC

Capability: `workspace.extensions.v1`. All methods require `workspaceId` and `expectedGeneration`.
An older Core has no fallback to global plugin management.

| Method | Additional input | Result |
| --- | --- | --- |
| `workspace.extensions.list` | none | safe workspace view |
| `workspace.extensions.describe` | `sourceId` | view restricted to that source |
| `workspace.agents.extensions.list` | `agentId`, `agentEpoch` | colleague assignment/effective tools |
| `workspace.extensions.propose` | `change`, `expectedRevision` | one-use, client/view/generation-bound proposal |
| `workspace.extensions.approve` | `proposalId`, `approved`, `expectedRevision` | current safe view; only explicit true writes |

A change has `target: workspace|agent`, source ID/revision, enabled flag and `allowedTools`; agent
changes also carry agent ID/epoch. Unknown fields are refused. Proposals expire after two minutes,
are bounded to 64, are consumed once, and are dismissed on client selection change/disconnect.
Approval rechecks current source metadata, permission revision and colleague epoch. Rejection does
not advance the revision. Mutations are not retried after a lost response; clients read back first.

## Future execution seam

`LocalWorkspaceHost.extensionToolSnapshot` refreshes the Host catalog once per attempt, then returns
frozen metadata for that exact Workspace, generation, colleague and epoch. `assertExtensionTool`
rechecks the current persisted authorization before every future dispatch. Forged/cross-store snapshots
fail; removal/narrowing/revision changes reject old snapshots immediately. Expansion requires a new
attempt snapshot. Catalog invalidation and refresh failure fail closed.

These are metadata/authorization seams for `registered-cli-mcp` and Pi. They do not replace the future
manager's binary/schema/credential/network checks, external action confirmation, trusted binding,
role/tool policy intersection, run permit, lease, budget or cancellation checks. There is deliberately no
upstream executor or `Tool.run` in this slice. No real MCP/native integration or OS isolation is claimed.

## Focused checks

Use pinned Node 22.23.1+, an isolated task HOME/TMPDIR, and one runner at a time:

```sh
npm run build
node --import ./test/setup-isolated-home.mjs --test --test-concurrency=1 test/workspace-extensions.test.mjs test/workspace-local-server.test.mjs
```

The fixtures use synthetic config/manifests and loopback RPC only. No real user config, keychain,
provider, native runtime, paid call or upstream MCP is required.
