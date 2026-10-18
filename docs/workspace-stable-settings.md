# Local Workspace settings contract

This source-only fix keeps `~/.hara/workspaces-v1`. Bundle identifiers are not part of the settings
namespace. Host Home for discovery/import is separate from the private runtime/SDK credential Home.

## Connections and appearance

- Resource-bound `workspace-connections-v2.json` retains its filename, now schema 3. Sequential migration
  backs up recoverable keyRef metadata before atomic replacement. Future schemas/recovered backups are
  read-only. No empty overwrite or plaintext fallback is permitted.
- Credential migration denial/timeout/unsupported vault access is `migrationPending`, not damaged JSON.
  Validate all source rows before vault writes; preserve the original and return read-only, empty
  connections. A repeated snapshot does not retry the same blocked source. Scoped, confirmed
  `workspace.connection.migration.retry` may try once again; backup-only recovery cannot use this route.
- Missing primary plus any existing backup is not a new store: recover a valid backup read-only,
  projecting pure older schemas in memory only. A sole old credential backup cannot write the vault.
  Unavailable connection settings do not prevent the Workspace roster/history from opening; no model
  or cross-scope connection is selected as fallback. Storage authority checks remain fail-closed.
- Keychain service `tech.nanhara.hara.workspace.credentials.v1` is fixed; accounts bind scope, connection
  and credential generation. Never put real Keys in JSON, browser storage, logs, snapshots or argv.
- `activeConnectionId` (RPC alias `defaultConnectionId`) selects new runs only. Editing rotates the
  generation, blank Key preserves the credential. Deletion invalidates the old run and chooses the
  oldest remaining active connection, then ID, or none. Never fall back to another scope.
- Known legacy files offer metadata previews. Confirmed import copies one credential into the selected
  space with a deduplicated source revision; unsafe/unsupported sources remain untouched.
- Persist retired keyRefs before cleanup. Denial/crash leaves explicit retryable cleanup via
  `workspace.connection.cleanup`; listing never automatically removes Keychain data.
- Stable `home/.hara/ui-preferences-v1.json` schema 2 owns appearance. Bounded known WebKit locations
  are queried read-only for exactly `hara.theme`; absence means system. localStorage is only a cache.

## Runtime and skills

- Bounded discovery searches login shell, numeric descending nvm, Homebrew/local, npm/Volta/Bun and
  validates `--version`. No install/download/package execution. Registration and use recheck fingerprint;
  registration is not permission to use a general-Agent driver.
- The fixed npm-prefix probe explicitly sets `npm_config_update_notifier=false`,
  `NO_UPDATE_NOTIFIER=1` and `npm_config_offline=true`. Label previews obey the same 80-character
  limit as confirmed import; model IDs retain their separate 256-character bound.
- Global `~/.hara/skills` remains untouched. Enabling preserves a verified bounded UTF-8 bundle as an
  immutable `.hara/skill-library/v1/ID/SHA256.json` version and a separate Workspace snapshot. Version
  changes and private edits are explicit; no automatic upgrade of another space's pinned instructions.
- Pi receives only the enabled-skill index and `workspace_skill`, reading captured scoped copies in
  pages below 8k result characters. Declared allowed-tools narrows the original whitelist, including
  same-round batches. Skills grant no shell, fork execution, binary assets, global paths or credentials.

## Schedules and verification limits

The visible scoped schedules panel manages plan data, not a second scheduler. Real old schedules remain
untouched. The fixture-only offline migration backs up bytes, preserves schedule/enablement and existing
workspace, maps unscoped rows to an explicitly supplied personal Workspace, deduplicates and receipts.
Real cutover and Jeff's actual personal-space mapping require separate approval.

Synthetic Provider/fake Keychain tests do not prove native Keychain authorization, vendor login, paid
model compatibility, a refreshed sidecar, a newly signed package or release. Record these states separately.
