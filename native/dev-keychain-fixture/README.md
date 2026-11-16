# K1 slice 1 — offline contract fixtures

This directory is test-only. It is not imported by `src/`, the formal CLI, the
Dev launcher or release/build scripts. It does not make Dev credentials usable.
The formal vault/default Host expressions and installed Dev entry are unchanged.

- `protocol.mjs`: bounded HDQ1/HDR1 binary codec, EOF gating, nonce and UTF-16
  validation. Frame caps include the four-byte length prefix (8,500,000 and
  65,600 bytes); the encoded length excludes it. Status order is `ok`,
  `invalid_request`, `unavailable`, `access_denied`, `credential_unreadable`,
  `write_unconfirmed`, `cleanup_unconfirmed`. A found reply is valid only for GET.
- `fake-vault.mjs`: memory-only Security model, fixed Dev namespace, group and
  legacy semantics, synthetic identity/directory provider, NO_UI save/restore,
  failures and shared asynchronous group locks. Operation records omit values.
  A bare ref starting with `vault.` overlaps another scope's group account; the
  fake rejects it as `credential_unreadable` before any item operation. Qualified
  refs such as `vault.scope:connection:g1` remain usable. This is a fail-closed
  clarification of the group/legacy ambiguity; it does not alter the wire ref
  grammar or the production vault. Review this rule before real helper wiring.
- `k1_codec.{h,m}` / `codec-probe.m`: Foundation-only, fake-build-only native
  codec probe. It validates and canonically re-encodes one frame after stdin EOF.
  It is not a helper; it has no storage backend, Security imports, credentials,
  signing operation or GUI. Reply round-trip validates structure; the JS consumer
  additionally binds the reply nonce and operation to its outstanding request.
- `guards.mjs`: injected fake compile/sign/publish pipeline, helper-only cache
  inputs and binding records, effective build-spec checks, and a bounded scanner
  for actual files. It checks ASCII/UTF-16LE markers and file identity/digest.
  Format recognition is only a prerequisite for this namespace scan; existing
  architecture, provenance and signing checks remain separate requirements.

Run the four `test/dev-keychain-k1-*.test.mjs` files using the repository's
isolated-home setup. Native codec tests need macOS/Xcode Command Line Tools;
run `native/dev-keychain-fixture/canary.test.mjs` explicitly with Node and the
approved Bun on PATH. The canary is outside the normal npm test glob so Node-only
CI does not acquire a new Bun dependency. It compiles tiny synthetic binaries, never runs
or signs them. On macOS the native tests also check that the probe has no Security
imports/dependency, and that compilation without `K1_FAKE_ONLY` fails. No npm
packages or external frameworks are added.

This slice proves the offline contracts, not OS integration. There is no real
`getpwuid_r`, filesystem lock, Keychain API, helper dispatch/signature admission,
Dev adapter/Host injection, config-generation transaction, launcher change or
mandatory production release gate here. Fake UI state is per synthetic helper
session; it does not establish the scope of Apple's process interaction state.
Real cross-process locking, Security backend, default/login Keychain membership,
private HOME metadata, actual UI-state isolation, transport/termination behavior
and GUI require separately approved follow-up work. The build-spec/artifact
checks remain fixtures until their production callers are separately wired and
reviewed. No fake result authorizes real Keychain or GUI use.

The design prevents accidental cross-profile use, not hostile code running as
the same user. No real key or item is used, imported, enumerated or migrated.
