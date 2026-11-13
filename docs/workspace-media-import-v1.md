# workspace.media.import (v1)

Capability: `workspace.media.import.v1`. This call lets a client paste an image from the clipboard into a workspace conversation. The image is stored in the managed project and goes back through the same path-based attachment flow as `workspace.media.register` and `workspace.media.describe`.

## Request (one call per chunk)

```
workspace.media.import {
  workspaceId, expectedGeneration,
  importId,      // UUID chosen by the client for this image
  mime,          // image/png | image/jpeg | image/gif | image/webp
  index,         // 0-based; chunks must arrive in order, each exactly once
  total,         // = ceil(bytes / 65536)
  bytes,         // total image size, declared on every chunk
  chunkBase64    // canonical padded base64; every chunk except the last is exactly 65536 bytes
}
```

The Workspace RPC socket accepts at most 128 KiB per message, so images are sent in 64 KiB chunks.

## Replies

- A chunk before the last: `{ received: index + 1 }`.
- The last chunk: `{ path, media: { id, mime, bytes } }`.
  - `path` is absolute, of the form `<managed project>/attachments/<sha256>.<ext>`. Clients put it in the message like any other attachment path.
  - `media` is the same registration that `workspace.media.register` returns.

## Errors

All errors are thrown as RPC errors.

| Message starts with | Meaning |
|---|---|
| `image_too_large` | The declared `bytes` is over 3.6 MB (`MAX_NATIVE_IMAGE_BYTES`, the existing image attachment limit). Sent on the first chunk; nothing is staged. |
| `import_aborted` | A chunk was out of order or duplicated, didn't match the import, or had the wrong size; or the staged import is gone (timed out, disconnected or generation changed). The whole import is discarded; start again with a new `importId`. |
| `import_busy` | This connection already has an import in progress. That import is not affected. |
| `Workspace resource generation changed` | The workspace generation is stale. Anything staged on this connection is discarded. |
| `Workspace media unavailable` | The final bytes don't match `mime` (checked by magic bytes), or a link or hard link sits at the destination. |
| `Invalid Workspace media import` / `unsupported Workspace RPC fields` | The request is malformed. |

## Guarantees

- **Staging:** only in memory, one import per connection.
  - It is discarded after 60 s without a chunk, on disconnect, on a generation change, or on any refusal.
  - Discarded bytes are zeroed.
- **File name:** the content hash. Callers cannot name or place the file, and the same image twice reuses one file.
- **Write:** the bytes go to a private temp file (`O_EXCL|O_NOFOLLOW`, mode 0600) in `attachments/` (0700), are fsynced, then renamed into place.
  - A link or hard link at the destination is refused, never replaced or followed.
  - `attachments/` itself must be a real directory owned by the user.
- **Retention:** no automatic cleanup. Conversation history keeps referring to these files, so pasted images accumulate in `attachments/`. A future attachment-cleanup feature (1.3.x backlog) will handle them.
