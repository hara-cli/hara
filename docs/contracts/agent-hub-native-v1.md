# Agent Hub Native v1

Core uses this contract between an authenticated Native broker and the trusted Host. C-B.1 provides the wire validators, C1-backed attachment, selection and confirmation guards, and the journal. The Host composes it with W0 and the launcher in C-B.2. Deployment of the Native bootstrap and original system confirmation is gated on C-B.3 platform acceptance.

## Transport

Native and Core bind each handshake to the same installation UUID, Host instance UUID, loopback port and ordinary workspace transport token. The owner credential is independent. Proofs are lower-case HMAC-SHA256 hex, with the 32-byte key decoded from hex. The input is the UTF-8 encoding of this JSON array in this order.

```text
["hara.agent-hub-native.v1","attach.server" | "attach.client",
 installId,hostInstanceId,port,clientNonce,serverNonce,sha256(workspaceToken)]
```

The workspace token hash is SHA-256 over the ASCII lower-case hex string. Proof comparison uses fixed-length constant-time equality. Each server nonce expires at 30,000 ms and is consumed on a finish attempt. A successful attach retires the prior C1 handle and obtains a fresh five-minute Native capability. Detach, Host close and a later attachment retire it sooner. Session identity is local to the issuing Auth object.

The Host adapter must check the exact loopback peer, Host and port, reject browser Origin and Sec-Fetch, use explicit body ceilings and authenticate the two envelopes before reading private request bodies. The adopted Native broker owns the private requests and confirms only through its native callback. Pending intent and its challenge remain in trusted Core and Native memory. Ordinary workspace WS, the renderer and managed agents receive only their existing contracts.

## Shapes

The [JSON Schema](agent-hub-native-v1.schema.json) describes the shape of the private request, attach replies, frozen intent, result and handoff. The codec additionally checks current selection and authority, canonical ID encodings, cross-field equality, byte ceilings and digest equality. The in-process entry points trust Host callers. Native wire inputs start as bounded, valid UTF-8 JSON. Synthetic interoperable keys, proofs, requests and positive and negative examples are in the [fixtures](agent-hub-native-v1.fixtures.json). The [lock](agent-hub-native-v1.lock.json) binds the codec, schema and fixtures.

| Method | Parameters |
| --- | --- |
| `attach.hello` | `installId, hostInstanceId, port, clientNonce` |
| `attach.finish` | Same tuple plus `serverNonce, clientProof` |
| `detach` | Empty record |
| `describe`, `registry.list` | `workspaceId, viewEpoch` |
| `messages.list` | Selection plus `connectionId, afterSeq, limit` (1–50) |
| `message.read`, `attachment.read` | Selection plus `connectionId, messageId` and `attachmentId` for an attachment |
| `read.mark` | Selection plus `connectionId, throughSeq` |
| `control.prepare` | Selection plus a structured `target` |
| `control.cancel`, `control.status` | `operationId, intentDigest` in the current controlled scope |
| `control.commit` | Operation reference plus its single-use `challenge` |

Request envelopes are exact `{schemaVersion:1, method, params}`. The view comes from the trusted Host, and the request's workspace and epoch must match it. Only the current authenticated view can query a scope's operation history. The attached-read schemas consume R1 projection and W0 payloads at their existing versions. Read execution and result envelopes for those payloads belong to the Host composition.

## Operation

Core collects current witnesses, performs the injected preflight and checks the witnesses again. It freezes the intent. In the digest, the message is the UTF-8 bytes of compact `JSON.stringify(["hara.agent-hub-native.v1","control.intent",intent])`. The object keys follow `$defs.intent.properties` recursively in declared order. Optional launch label omission and explicit null both select automatic naming and remain distinct inputs. IDs, epochs, catalog and policy digests, launch witness and cleanup plan bind the confirmation to the exact prepared selection.

The 30,000 ms timer starts after preflight and freezing. At expiry, the broker must prepare again, show the new intent and get another confirmation. A trustworthy commit contains only the operation ref and challenge. Show the same intent when a pending selection is coalesced. Final claim rechecks the current scope/generation, selection epoch, Host identity, admission and effect witnesses at its synchronous CAS fence. The injected effect ports check their specific current row and physical witness when publishing. Prepare is memory-only. Cancellation can remove a pending intent up to claim.

A claim is durable before any asynchronous effect. Each scope and generation has an independent private journal. Up to 16 unfinished ordinary claims and a total of 256 ordinary records are supported in this slice. Each accepted grant also pays for its own fixed-size revocation slot at claim. Revocation uses an equal-size replacement lane. The policy accounts for the normal atomic replacement peak and uses the reserved control lane for revocation. Status costs no write. Established capacity refuses new claims while retaining existing results. The persistent records contain digests, safe references and outcomes. There is no automatic eviction in this slice.

| Phase | Durable fact |
| --- | --- |
| `claimed` | Original ref, host/target and exact claim stored |
| `staged` | Grant token digest recorded before the private stage port |
| `previous_revoked` | Rotation disabled the previous grant and must verify removal before staging a replacement |
| `catalog_committed` | Adapter verified the grant catalog publication |
| `handoff_committed` | Adapter verified the intended handoff; the journal records the non-secret result |
| `revoked` | Access is disabled; handoff removal is pending or uncertain |
| `settled` | Final launch, cleanup or revoke outcome recorded |

Matching ref and digest read the existing result. A digest conflict is explicit. An in-flight operation can read as pending. After a restart an incomplete publication reads unknown. A known committed result is historical after restart. Retrying a query never issues a new token or restarts a launch. Recovering or retiring physical artifacts requires the verified Host adapter. Missing state with a retained replacement witness fails closed. An unresolved revoke slot also fences a competing grant or rotation publication.

## Handoff v2

The exact handoff shape binds the localhost origin, C0 scope/generation, Host, R1 agent and instance, launch reference, policy, connection and grant epoch. The alias is `agent-` followed by the agent ID. Material and recovery roots use normalized absolute paths and the same platform identity format. Handoff JSON fits 16 KiB. The authority that publishes and consumes it must separately verify the physical file and directory identities, owner, private mode, single link and exact allowed launch. A parsed descriptor is only data.

Core stores only the hash of the 32-byte token's lower-case hex string in the transaction journal. Raw token delivery is confined to the trusted stage and the one bound runtime handoff. Publication remains ineligible until the current scope, launch, profile, committed grant and final handoff all match. Actual W0 fencing, physical launch teardown, policy-root migration and platform bootstrap are covered by the subsequent integration slices.
