# Workspace credential storage v1

The local Workspace Host advertises `workspace.credential-storage.v1`. Its authenticated
`initialize` result includes `credentialStorage`. The authenticated read-only method
`workspace.credentialStorage.get({})` returns the same Host-wide snapshot at the time of
the request. The getter accepts no workspace, generation, backend, file or identity parameter.

| Field | Values |
| --- | --- |
| `schemaVersion` | `1` |
| `hostPlatform` | `darwin`, `win32`, `linux`, `other` |
| `arch` | The Host process architecture |
| `backend` | `macos-keychain`, `windows-dpapi`, `none` |
| `supported` | Whether Hara has a secure backend for this platform and architecture |
| `state` | `not_checked`, `ready`, `unavailable`, `unsupported` |
| `reason` | `null` for `not_checked` or `ready`. Otherwise `platform_unsupported`, `architecture_unsupported`, `host_binding_unavailable`, `helper_missing`, `helper_invalid`, `access_denied` or `backend_unavailable` |

Windows x64 uses the packaged CurrentUser DPAPI worker. macOS uses the existing Keychain
records. Linux, other platforms and unsupported Windows architectures return `unsupported`.
A missing Windows helper leaves the backend supported and the state unavailable. A descriptor
read does not launch a worker, unlock a Keychain or probe a model endpoint. A successful vault
operation updates the snapshot to ready. The connection view's `keySaved` is a metadata fact.

Credential failures keep the numeric JSON-RPC error. Its `data` has `domain: "credential-vault"`
and the following code and retry values. Credential errors contain no raw worker output, keys,
references or paths. Permission, generation and revision errors keep their existing domain.

| code | retry |
| --- | --- |
| `unsupported`, `invalid_request` | `none` |
| `unavailable`, `access_denied`, `credential_unreadable`, `cleanup_unconfirmed` | `explicit_user_only` |
| `write_unconfirmed` | `readback_only` |

## Saving and recovery

All provider vault operations share a serialized lane for the Host's namespace. The caller
has a 30 second credential budget. Each native operation has a separate 15 second limit.
The v2 private worker message can report that opening the exclusive store lock failed before
any credential entry was accessed. The adapter retries only this result, up to three attempts
within the shorter backoff window. It preserves all other failed or unknown outcomes. Requests
and replies use bounded private pipes. Every launch checks the packaged executable against its digest.

The store records an intent for each new generation before sending any write. The intent
contains only resource-bound references and process state. The Host records the worker PID before
giving the worker its frame. Publication checks the captured resource, permission, connection and
settings revision again. List and model binding resolution never adopt an unconfirmed generation.
Revocation and a confirmed replacement remain committed if physical cleanup is pending.

On reopen, a dead writer's intent becomes cleanup pending. Live or uncertain worker ownership
holds recovery. The existing explicitly approved `workspace.connection.cleanup` can retry a
connection's retired generations by `connectionId`. When `connectionId` is omitted it addresses
only the workspace's recorded, unpublished intents. Both forms require the current workspace
generation and revision. The Host checks the original resource and its published and recoverable
references before removal. A DPAPI or Keychain operation whose outcome cannot be proven keeps its
record. A damaged source or a credential already referenced by metadata is preserved.

The schema 2 credential migration waits for an explicit approval. It validates the whole input,
writes fresh references and publishes metadata only after the batch is confirmed and the primary
still matches. The new backup contains only the secured schema. Unbound native temporary
ciphertexts remain on disk under the namespace quotas. When quota is exceeded a new write
fails with `unavailable`. Reads do not sweep or infer ownership of temporary files by age.
