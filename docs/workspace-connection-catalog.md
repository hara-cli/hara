# Workspace Connection Catalog (`workspace.connection-catalog.v1`)

`workspace.connection-catalog.v1` provides a read-only, offline model reference catalog for Workspace mode.

## Purpose and Boundaries

- **Offline only**: Reads only the bundled `@earendil-works/pi-ai@1.5.0` static provider `.models` data modules (42 provider groups, `type === "chat"`) and Hara's built-in documented fallback model lists (`hara-documented`).
- **Zero secrets & zero side effects**: Never reads the credential vault, Keychain, `~/.hara`, user `models.json`, environment API keys, or network endpoints, and never saves or migrates connections.
- **No implicit Workspace initialization**: The Workspace must already be opened in the Host (`workspace.create`, `workspace.select`, or `workspace.snapshot`) before calling `workspace.connection.catalog`. Calling it on an unopened Workspace fails without creating scope/project state or staging legacy imports.
- **Reference metadata is not runtime authority**: Fields such as `referenceContextWindow`, `referenceMaxOutputTokens`, `inputModalities`, and `reasoning` reflect bundled vendor reference metadata only. Actual execution limits, routing, and enabled capabilities remain controlled by the Host (`hara/coding` proxy boundary). Catalog entries never prove account entitlement or connection readiness.
- **Legacy Core fallback**: When `initialize` does not advertise `workspace.connection-catalog.v1`, clients must fall back to manual model ID entry without blocking connection creation or editing.
- **Existing live listing unchanged**: `workspace.connection.listModels` (`workspace.connection-models.v1`) continues to return `source: "live" | "documented"` unchanged.

## Capability & RPC Contract

- Capability (advertised only when `mode === "workspace"`): `workspace.connection-catalog.v1`
- Method: `workspace.connection.catalog`
- Required params:
  - `workspaceId`: non-empty Workspace ID
  - `expectedGeneration`: current resource generation of the already-opened Workspace
- Optional params (strict whitelist; unknown or credential fields are rejected):
  - `providerId`: one of the 42 bundled Pi provider IDs
  - `documentedRef`: one of `alibaba-coding-plan`, `deepseek-responses`, `minimax-token-plan`, `volcengine-agent-plan`, `volcengine-coding-plan` (mutually exclusive with `providerId`)
  - `query`: case-insensitive substring filter (`<= 200` chars, no control characters)
  - `cursor`: non-negative integer offset string (only valid when `providerId` or `documentedRef` is set)
  - `limit`: integer in `1..200` (default `100`)

### Responses

1. **Group summary** (neither `providerId` nor `documentedRef` set):
   - `schemaVersion`: `1`
   - `catalog`: `{ package: "@earendil-works/pi-ai", version: "1.5.0", generatedAt, digest }` (`digest` is `sha256:<hex>` of the canonical projected catalog payload)
   - `groups`: array of `{ source: "pi-catalog", providerId, modelCount } | { source: "hara-documented", documentedRef, modelCount }`
2. **Group models** (`providerId` or `documentedRef` set):
   - `schemaVersion`: `1`
   - `source`: `"pi-catalog" | "hara-documented"`
   - `providerId` or `documentedRef`
   - `catalog`
   - `total`: total matching models in the group
   - `nextCursor`: next offset string or `null`
   - `models`:
     - For `pi-catalog`: whitelisted projection `{ id, name, api, referenceContextWindow?, referenceMaxOutputTokens?, inputModalities?, reasoning? }`
     - For `hara-documented`: `{ id }` (no inferred capability metadata)
