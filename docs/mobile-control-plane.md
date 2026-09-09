# Hara Mobile control-plane contract

> Status: protocol v1 foundation, 2026-09-07. Hara CLI/Serve is the execution authority; Desktop and Mobile
> are clients of the same provider-neutral runtime.

## Product boundary

Hara Mobile is the remote surface for Hara. It must not become a second implementation of Codex Remote
Connections, Claude Code, or a terminal provider. Codex and Claude Code remain execution providers behind Hara;
their credentials, native session IDs, private reasoning, raw provider payloads, and local filesystem paths must
never be sent to the phone or relay.

```text
Hara Mobile
  <-> signed + end-to-end encrypted envelopes
Hara Relay (ciphertext transport only)
  <-> signed + end-to-end encrypted envelopes
`hara mobile connect` on the user's computer
  <-> authenticated loopback JSON-RPC
`hara serve`
  <-> Hara engine / Codex app-server / Claude Code / local PTY
```

Desktop and Mobile may both observe the same session. Exactly one current lease holder may send terminal input
or answer a control-gated approval. A UI label is never proof of ownership; every mutation is checked again by
the CLI against its publication, lease epoch, expiry, command ID, and active turn.

## Protocol v1 already implemented in CLI

- Nayi account SMS login and expiring Desktop-device registration.
- A user-visible, one-time pairing challenge. The Desktop approves the exact mobile public-key thumbprint.
- P-256 signatures plus peer encryption for every relay envelope; the relay handles ciphertext and routing.
- An explicit, bounded publication directory for Personal coding-agent sessions (`hara`, `codex`, and
  `claude-code`). Publications and capabilities expire with the Desktop credential.
- Bounded session transcript and terminal snapshot reads. The current v1 phone UX should poll these snapshots;
  it must not infer durable state from a dropped notification.
- Typed task progress snapshots expose round, tool-call, run-token, todo, checkpoint-age, and no-progress stop
  state without exposing prompts or tool output. Mobile should render these metrics when available and remain
  compatible with older Engines where `progress` is absent.
- Short terminal-control leases (10 seconds to 5 minutes), one lease per publication, and a new bridge-wide
  epoch after restart.
- Idempotent remote command receipts, payload collision rejection, expiry checks, `expectedTurnId` fencing for
  steer/interrupt, and monotonic payload-bound `inputSeq` values for PTY input.
- Private, bounded publication and command-outcome checkpoints survive bridge restart. Relay delivery has an
  independent per-device stream/cursor: reconnect re-acknowledges the local checkpoint and requests only the
  missing suffix, while gaps, changed streams, and conflicting replays fail closed.
- Approval, interrupt, submit/steer, terminal input, resize, and release are capability-gated separately.

The CLI entry points are:

```text
hara mobile login
hara mobile pair
hara mobile connect
hara mobile status
hara mobile logout
```

## Native mobile client requirements

The React Native client may reuse visual/component patterns from NayiApp, but it must implement this Hara
protocol rather than copy NayiApp account or networking assumptions.

1. Generate the mobile P-256 key inside Keychain/Keystore and never export the private key.
2. Claim a pairing challenge, show the Desktop identity and expiry, and finish only after Desktop approval.
3. Reject relay devices whose signed public-key identity differs from the paired thumbprint.
4. List only published sessions and render their explicit capabilities. Do not guess that a disabled button is
   authorized merely because another device could use it.
5. Read an authoritative snapshot when opening/resuming a session. Treat `accepted` submit as work admitted,
   not completed; refresh until a terminal state or committed/failed receipt is observed.
6. Create one stable command ID per logical action and reuse it only for the byte-equivalent uncertain retry.
   Never generate a new ID to make an ambiguous action “go through.”
7. Acquire an explicit lease before approvals or raw terminal input. On stale epoch/lease, discard queued keys,
   refresh, and ask the user to take control again.
8. Keep an emergency Interrupt action visible for a running turn, but fence it to the observed active turn.
9. Store no provider key, native session identifier, raw local path, unredacted terminal archive, or plaintext
   relay envelope in analytics/crash logs.
10. On background/suspend, stop accepting new input, flush an acknowledged command if possible, release the
    terminal lease, and show outcome-unknown actions as pending inspection rather than silently resending them.

## Delivery work still required

- Deploy and verify the account/device/pairing endpoints at `api.hara.nanhara.tech` and the WSS relay at
  `relay.hara.nanhara.tech`; add rate limits, abuse controls, encrypted backups, key rotation, and restore drills.
- Implement the React Native pairing, session list, conversation, approval, and terminal screens against the
  protocol above.
- Extend publication to ordinary Hara sessions only after their task/workforce/approval snapshot and controller
  lease are exposed through the same redacted contract. Do not tunnel the full local Serve API to Mobile.
- Add end-to-end tests for Desktop online/offline transitions, phone backgrounding, lease contention, lost ACKs,
  duplicated envelopes, clock skew, key replacement, relay restart, and abrupt local process loss.

## Acceptance gate

Mobile remote control is production-ready only when an uncertain network outcome cannot execute a user command
twice, a stale phone cannot control a newer turn, Desktop can take control back visibly, provider secrets remain
local, and session state recovers from authoritative snapshots after every tested disconnect boundary.
