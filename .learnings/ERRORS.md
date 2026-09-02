# Errors

## [ERR-20260830-NPM-PACK-CACHE-OWNERSHIP] Release pack checks must not depend on the shared npm cache

**Logged**: 2026-08-30T10:20:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release verification

### Summary

`npm pack --dry-run` completed its build but failed when npm tried to open a root-owned temporary entry in
the workstation's shared cache. The package was valid; cache ownership was unrelated user-machine state.

### Resolution

Do not use `sudo chown` as part of a release. Run packaging and registry verification with a task-private
cache under the system temporary directory. The same 0.156.1 package dry-run then completed successfully.

### Metadata

- Source: command_failure
- Reproducible: yes, with the affected shared cache
- Related Files: package.json, package-lock.json
- Tags: npm, cache, permissions, release
- Pattern-Key: release.npm_pack_uses_task_private_cache
- Recurrence-Count: 2
- Last-Seen: 2026-08-31T01:15:00+08:00

---

## [ERR-20260829-NPM-AUDIT-MIRROR] Default npm mirror does not implement the audit endpoint

**Logged**: 2026-08-29T04:14:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release verification

### Summary

The release dependency audit returned HTTP 404 because the workstation's configured
`registry.npmmirror.com` endpoint does not implement `/-/npm/v1/security/audits/quick`. This was an
unsupported mirror capability, not a vulnerability result.

### Resolution

Keep normal package installation settings unchanged, but run the release security gate with the explicit
official `https://registry.npmjs.org` audit endpoint and a task-private cache. The authoritative audit then
completed with zero vulnerabilities.

### Metadata

- Source: external_api_failure
- Reproducible: yes
- Related Files: package-lock.json
- Tags: npm, audit, registry, release
- Pattern-Key: release.npm_audit_requires_authoritative_registry
- Recurrence-Count: 1

---

## [ERR-20260829-POSIX-TRUE-VERSION] Cross-platform CLI probes need a controlled executable fixture

**Logged**: 2026-08-29T06:45:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: testing

### Summary

The release test used `/usr/bin/true` as an explicit CLI and expected `--version` to produce no output.
BSD `true` on macOS satisfied that assumption, while GNU coreutils `true` on the Linux release runner
printed a version string, so the package and binary workflows stopped before publishing.

### Resolution

Use a private executable fixture with deterministic `--version` behavior, while retaining the real spawn
and PATH-prepending assertions. The targeted test and the complete host-boundary suite now pass. A failed
public tag is never moved; the corrected release advances to the next patch version.

### Metadata

- Source: command_failure
- Reproducible: yes, on GNU coreutils runners
- Related Files: test/external-sessions.test.mjs
- Tags: ci, linux, macos, fixture, release
- Pattern-Key: tests.external_cli_probe_uses_controlled_cross_platform_fixture
- Recurrence-Count: 1

---

## [ERR-20260829-CODEX-SESSION-BOUNDED-READ] Large Codex history and stale PATH broke real session intake

**Logged**: 2026-08-29T00:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: external-sessions

### Summary

A real Codex transcript exceeded the adapter's 16 MiB output limit because `thread/read` loaded the entire
thread, including heavy tool payloads. Separately, automatic discovery found the verified NVM Codex CLI but
left its runtime directory later in `PATH`, allowing the workstation's legacy Node 11 to execute its modern
ES module shebang and making the source appear unhealthy.

### Resolution

Read the newest 50 turns through the official `thread/turns/list` summary view, keep provider cursors in
Core, show a neutral older-history notice, and fork with `excludeTurns: true` before fetching the same bounded
window. Always move the verified CLI sibling runtime directory to the front of the scrubbed child `PATH`,
even when that directory already appears later. Hermetic regression tests cover both boundaries, and
read-only real-device smoke tests verified Codex and Claude without logging transcript content.

### Metadata

- Source: test_failure
- Reproducible: yes
- Related Files: src/external-sessions/codex.ts, src/external-sessions/process.ts, test/external-sessions.test.mjs
- Tags: codex, app-server, pagination, bounded-output, nvm, path
- Pattern-Key: external_sessions.bound_transcripts_and_promote_verified_runtime
- Recurrence-Count: 1

---

## [ERR-20260829-RUNTIME-LOG-AND-EMPTY-MIGRATION-FIXTURES] Expanded lifecycle diagnostics changed bounded fixtures

**Logged**: 2026-08-29T03:55:00+08:00
**Priority**: low
**Status**: resolved
**Area**: serve diagnostics and session migration tests

### Summary

The release tests initially failed for fixture and lifecycle reasons after completing the feedback contract:
the 512-byte runtime-log budget reached `log.limit` before the newly asserted successful tool lifecycle,
and two metadata-order tests used empty interactive transcripts that the new compatibility migration now
correctly archives as abandoned drafts. The full suite then exposed the inverse lifecycle edge: an explicitly
resumed archived draft gained real content but remained hidden from `latestForCwd`.

### Resolution

Keep the production limits and abandoned-draft classification unchanged. Give the logger test a still-bounded
1 KiB budget, and give metadata-order fixtures a real user message so they represent healthy sessions rather
than abandoned drafts. Treat an explicit resume followed by a real submitted turn as the reversible restore
action, but leave failed or zero-turn opens archived. Focused and full-session coverage exercise both sides.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: src/index.ts, test/serve-runtime-log.test.mjs, test/session.test.mjs, test/session-profile-cli.test.mjs
- Tags: tests, runtime-log, session-migration, fixtures
- Pattern-Key: tests.fixtures_must_preserve_domain_classification
- Recurrence-Count: 2
- Last-Seen: 2026-08-29

---

## [ERR-20260829-MODEL-CAPABILITY-VERSION-SKEW] New model capability was hidden by an older running engine

**Logged**: 2026-08-29T23:35:00+08:00
**Priority**: high
**Status**: resolved
**Area**: model-routing

### Summary

The current source and Desktop catalog correctly described `qwen3.8-flash` as multimodal, but the installed
Desktop was still connected to Hara engine 0.154.0. That engine predated the Qwen 3.8 capability map, so the
composer presented the model as unable to read images even though Alibaba Token Plan supports them.

### Resolution

Treat model onboarding as one versioned end-to-end contract: static provider catalog, Serve capability
response, Desktop copy, provider transport, native image payload, bundled sidecar version, and running-engine
upgrade must all be verified together. Keep the Desktop capability badge authoritative to the running engine,
but surface and repair engine skew during release instead of interpreting an old engine's answer as a current
provider limitation. Regression coverage now verifies both Qwen 3.8 Flash classification and its Responses
`input_image` payload.

### Metadata

- Source: user_feedback
- Reproducible: yes with Hara engine 0.154.0
- Related Files: src/vision.ts, src/providers/responses.ts, test/vision.test.mjs, test/responses-provider.test.mjs
- Tags: qwen, token-plan, vision, desktop, sidecar, version-skew
- Pattern-Key: model.capabilities_require_runtime_and_transport_release_verification
- Recurrence-Count: 1

---

## [ERR-20260828-EXTERNAL-SESSION-SMOKE-SANDBOX] Local session and loopback smoke tests need the host boundary

**Logged**: 2026-08-28T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: development-workflow

### Summary

The first Codex App Server smoke test failed because the restricted coding sandbox could not initialize
Codex's SQLite state under `~/.codex`. A separate Serve protocol test failed with `listen EPERM` on an
ephemeral loopback port. Neither failure reflected a Hara product defect.

### Resolution

Keep unit tests hermetic with a fake JSONL App Server. Run the single real-provider metadata smoke and local
WebSocket isolation test at the approved host boundary. Never broaden production permissions or parse
provider transcript files to work around the development sandbox.

### Metadata

- Source: test_failure
- Reproducible: yes in the restricted coding sandbox
- Related Files: src/external-sessions/process.ts, test/external-sessions.test.mjs, test/serve-external-sessions.test.mjs
- Tags: codex, app-server, sqlite, websocket, sandbox
- Pattern-Key: tests.external_session_runtime_smoke_requires_host_boundary
- Recurrence-Count: 1

---

## 2026-08-28 — A void logger callback implicitly returned `stderr.write`'s boolean

- Command: `npm run build`
- Failure: TypeScript rejected a callback annotated `void` because the expression-bodied arrow returned
  the boolean from `process.stderr.write`.
- Correction: use a block-bodied callback when adapting Node stream writers to a `void` sink contract.


## [ERR-20260828-PRIVATE-HOME-SMOKE] Real adapter smoke needs access to protected Hara state

**Logged**: 2026-08-28T02:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: testing

### Summary

A real-device external-session smoke test failed with `EPERM` while tightening the mode of the existing
`~/.hara` private state directory. The restricted workspace sandbox permits repository writes but cannot
change metadata on the user's protected Hara state.

### Resolution

Keep the production permission checks strict. Run real-device adapter smoke tests in the approved local
release runner, while keeping hermetic adapter and Serve integration tests inside isolated temporary homes.

### Metadata

- Source: command_failure
- Reproducible: yes, only in the restricted workspace sandbox
- Related Files: src/external-sessions/identity.ts, src/security/private-state.ts
- Tags: external-sessions, smoke-test, sandbox, permissions
- Pattern-Key: tests.real_adapter_smoke_requires_private_home_access
- Recurrence-Count: 1

---

## [ERR-20260828-NPM-AUDIT-SANDBOX] Dependency audit requires the approved network runner

**Logged**: 2026-08-28T02:30:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-operations

### Summary

CLI and Desktop `npm audit` requests failed with `ENOTFOUND registry.npmmirror.com` in the restricted
workspace network. npm also could not write diagnostics to the shared home cache.

### Resolution

Rerun the unchanged audit in the approved network-capable release runner and set a task-specific cache
under `/private/tmp`. The configured npm mirror does not implement the audit endpoint, so direct only the
audit command to the official npm registry; do not change installation/lockfile registry settings or weaken
the audit level.

### Metadata

- Source: command_failure
- Reproducible: yes, only in the restricted network sandbox
- Related Files: package-lock.json, ../hara-desktop/package-lock.json
- Tags: npm, audit, network, sandbox, cache
- Pattern-Key: release.npm_audit_requires_network_runner_and_private_cache
- Recurrence-Count: 1

---

## [ERR-20260826-APPLY-PATCH-DUPLICATE-FILE-OPS] One patch declared the same file twice

**Logged**: 2026-08-26T14:22:00+08:00
**Priority**: low
**Status**: resolved
**Area**: development-workflow

### Summary

An atomic `apply_patch` was rejected because two separate `Update File` operations targeted
`src/session/task.ts` in one patch, even though the hunks were independent. No partial edit occurred.

### Resolution

Group all hunks for a file under one `Update File` block, or apply one file-scoped patch at a time. The
follow-up used file-scoped patches and preserved the original working tree.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: src/session/task.ts
- Tags: apply-patch, atomic-edit, workflow
- Pattern-Key: editing.apply_patch_one_operation_per_file
- Recurrence-Count: 1

---

## [ERR-20260826-NVM-NPM-SHEBANG-USES-PATH] Absolute npm path still used legacy Node

**Logged**: 2026-08-26T14:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: development-workflow

### Summary

Invoking the NVM 22.23.1 `npm` executable by absolute path was insufficient: npm's `#!/usr/bin/env node`
shebang still resolved the workstation's legacy Node 11 from `PATH`, which cannot import `node:path`.

### Resolution

For npm/pnpm commands, prepend the repository-approved Node 22.23.1 `bin` directory to `PATH` as well as
selecting the executable. For direct tests, invoking the Node 22.23.1 binary itself remains deterministic.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: package.json
- Tags: node, nvm, npm, shebang, path
- Pattern-Key: tests.nvm_npm_absolute_path_still_requires_path_prepend
- Recurrence-Count: 1

---

## [ERR-20260822-ZSH-EMPTY-GLOB-IN-SEARCH] A source search used an unmatched zsh glob

**Logged**: 2026-08-22T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: development-workflow

### Summary

An `rg` inspection included `src/constants*`; zsh expanded the unmatched glob before `rg` ran and rejected
the command with `no matches found`. No files were changed.

### Resolution

Pass a concrete directory to `rg` and filter matches inside the tool, or quote an intentional literal glob.

### Metadata

- Source: tool_failure
- Reproducible: yes
- Tags: zsh, glob, search
- Pattern-Key: shell.zsh_avoid_unmatched_search_globs
- Recurrence-Count: 2
- Last-Seen: 2026-08-26
- Recurrence-Note: An unquoted `test/task-lifecycle*` filter failed before `rg`; use the concrete `test` directory plus `--glob` inside `rg`.

---

## [ERR-20260824-GATEWAY-STATUS-SANDBOX] Gateway status can require the host permission boundary

**Logged**: 2026-08-24T19:20:00+08:00
**Priority**: low
**Status**: resolved
**Area**: operations

### Summary

Running `hara gateway status` inside the restricted coding sandbox failed with `EPERM: operation not
permitted, fchmod`, even though the live Feishu Gateway remained connected and healthy.

### Resolution

Treat this error as an execution-environment boundary, not a product outage. Rerun the same redacted status
command at the approved host boundary before diagnosing or restarting the Gateway. Never kill a process whose
credentials are reported as `process-only` merely to work around the sandbox.

### Metadata

- Source: command_failure
- Reproducible: yes in the outer restricted sandbox
- Related Files: src/gateway/serve.ts
- Tags: gateway, sandbox, permissions, operations
- Pattern-Key: gateway.status_fchmod_eperm_requires_host_boundary
- Recurrence-Count: 1

---

## [ERR-20260824-NPM-REGISTRY-TIMEOUT] Bound global upgrades and verify a mirrored fallback

**Logged**: 2026-08-24T19:29:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release-operations

### Summary

The official npm registry published Hara 0.152.2 correctly, but a transitive packument request timed out
during the workstation global install and left npm sleeping without useful progress.

### Resolution

Stop the stalled install, compare the exact package version and `dist.integrity` between npmjs and
npmmirror, and only then retry against the matching mirror with bounded fetch retries and timeouts. Audit
every visible Hara installation separately: the persistent Gateway may reinvoke a different NVM-global
entry than the interactive shell.

### Metadata

- Source: command_failure
- Reproducible: transient
- Related Files: package.json, src/cron/runner.ts, src/gateway/serve.ts
- Tags: npm, registry, timeout, gateway, nvm, release
- Pattern-Key: release.global_install_uses_verified_bounded_mirror_fallback
- Recurrence-Count: 1

---

## [ERR-20260823-NPM-AUDIT-MIRROR] Default npm mirror did not implement audit

**Logged**: 2026-08-23T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-workflow

### Summary

The workstation's configured `registry.npmmirror.com` returned 404/NOT_IMPLEMENTED for npm's security audit
endpoint, so the first production-dependency gate failed without evaluating dependencies.

### Resolution

Run release audits with an explicit `--registry=https://registry.npmjs.org/` and a task-private npm cache.
The official registry audit then completed with zero vulnerabilities.

### Metadata

- Source: external_api_failure
- Reproducible: yes
- Related Files: package-lock.json
- Tags: npm, audit, registry, release
- Pattern-Key: release.audit_against_official_npm_registry
- Recurrence-Count: 1

---

## [ERR-20260823-NODE-PATH-FOCUSED-TEST] Focused test used the legacy shell Node

**Logged**: 2026-08-23T00:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: development-workflow

### Summary

A focused `node --test` command ran with the workstation's default Node 22.22.3 even though the repository
requires 22.23.1. Child CLI checks then failed at the runtime floor instead of exercising the intended test.

### Resolution

For every npm, Node, and child-process test command in this repository, explicitly prepend the approved NVM
22.23.1 `bin` directory to `PATH`, including commands launched with `login: false`.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: package.json, test/config-live.test.mjs
- Tags: node, nvm, tests, workstation
- Pattern-Key: tests.pin_repository_node_for_every_command
- Recurrence-Count: 1

---

## [ERR-20260823-CONCURRENT-STRESS-OVERLOAD] Independent stress suites were over-parallelized

**Logged**: 2026-08-23T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: development-workflow

### Summary

Three independent 8-process lock pressure suites were launched simultaneously. All three exceeded their
30-second per-test wall-clock limit even though the same pressure case passed repeatedly when run serially.

### Resolution

Repeat multi-process contention tests serially. Their child processes already provide the desired
concurrency; parallelizing whole stress suites tests machine saturation rather than the lock invariant.

### Metadata

- Source: command_failure
- Reproducible: yes under load
- Related Files: test/config-live.test.mjs, src/security/private-state.ts
- Tags: tests, concurrency, stress, timeout
- Pattern-Key: tests.serialize_independent_multiprocess_stress_suites
- Recurrence-Count: 1

---

## [ERR-20260823-ATOMIC-BOUNDARY-CANONICAL-TARGET] Bound write reused a lexical macOS alias

**Logged**: 2026-08-23T17:05:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: filesystem-safety

### Summary

The personal-Agent hire path was bound through `bindAtomicWritePath`, but `atomicWriteText` was then called
with the original lexical path. Under macOS temporary homes, `/var/...` canonicalizes to `/private/var/...`,
so the safety check correctly rejected the two names as a changed target before creating the Agent file.

### Resolution

After binding a prospective path, use `boundary.target` consistently for the verified read and atomic write.
Keep the original path only for user-facing labels. A Serve regression test now hires and archives an Agent
from a macOS temporary home and proves the catalog refreshes without exposing the private prompt.

### Metadata

- Source: test_failure
- Reproducible: always under aliased parent paths
- Related Files: src/org/roles.ts, test/serve-agent-identity.test.mjs
- Tags: macos, realpath, atomic-write, agent-lifecycle
- Pattern-Key: filesystem.bound_write_uses_canonical_boundary_target
- Recurrence-Count: 1

---

## [ERR-20260822-SHARED-INTEL-RUNNER-TIMEOUT] Release test suite exceeded timing bounds under concurrent runner load

**Logged**: 2026-08-22T03:48:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release-workflow

### Summary

The first v0.150.0 Intel macOS release attempt ran the full test suite under transient runner contention.
Presentation export, process-spawn, and timer-yield tests became 10–60× slower and crossed their safety
bounds. The unchanged immutable-tag job passed on its focused rerun.

### Resolution

Rerun the failed immutable-tag job after contention clears. If the pattern recurs, split deterministic product
checks from renderer/process timing checks or bound test concurrency; do not simply remove the runtime safety
timeouts.

### Metadata

- Source: release_failure
- Reproducible: concurrency-dependent
- Related Files: .github/workflows/release.yml, test/presentations.test.mjs, test/search.test.mjs, test/session-profile-cli.test.mjs
- Tags: release, macos-intel, runner, contention, timeout
- Pattern-Key: release.serialize_heavy_native_jobs_per_host
- Recurrence-Count: 1

---

## [ERR-20260822-LEARNING-CLIENT-MULTIFILE-PATCH] Learning client patch used a duplicated display excerpt

**Logged**: 2026-08-22T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: development-workflow

### Summary

A cross-file `apply_patch` was rejected atomically because a prior combined command output displayed a
duplicated interface line that was not present in the source file.

### Resolution

Read the exact file excerpt separately and apply the organization client and store changes in independent
patches. No product file was partially changed by the rejected patch.

### Metadata

- Source: command_failure
- Reproducible: no
- Related Files: src/org-fleet/enroll.ts, src/learning/store.ts
- Tags: apply-patch, combined-output, workflow
- Pattern-Key: editing.read_exact_context_before_multifile_patch
- Recurrence-Count: 3

---

## [ERR-20260821-APPLY-PATCH-HUNK-BOUNDARY] A multi-file patch marker landed inside an unfinished hunk

**Logged**: 2026-08-21T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: development-workflow

### Summary

An `apply_patch` update for the website validator and its runbook placed the second file marker where the
first update hunk still expected prefixed context. The patch was rejected atomically before either file
changed.

### Resolution

Split behavior and documentation into separate patches after reading the exact target block. Verify the
first file independently before applying the second; do not append another file marker to a hunk that does
not end with valid context.

### Metadata

- Source: tool_failure
- Reproducible: yes
- Related Files: hara-web/scripts/validate-desktop-release.mjs, hara-web/DESKTOP_DOWNLOADS.md
- Tags: apply-patch, hunk, workflow
- Pattern-Key: editing.split_multifile_patch_after_hunk_boundary_failure
- Recurrence-Count: 1

---

## [ERR-20260817-PROTECTED-SIGNER-ACTION-ARCHIVES] Protected signer depended on external Action archives

**Logged**: 2026-08-17T23:10:00+08:00
**Priority**: high
**Status**: resolved
**Area**: release-workflow

### Summary

The Desktop release matrix produced valid native packages, but the protected self-hosted macOS signer could
not start reliably because job setup still downloaded pinned GitHub Action archives from
`codeload.github.com`. Removing those Actions exposed the same non-resumable failure in direct Git
smart-HTTP: repeated transfers reached the last 14 bytes to 5 KB and were reset or stalled. Re-running or
loosening the low-speed threshold discarded nearly complete packs and restarted them from byte zero.

### Resolution

Keep ordinary matrix jobs on pinned Actions, but make the protected signer actionless. Have the verified
cloud preparation job export compact object packs for the exact protected Desktop and CLI commit trees and
upload one immutable run artifact. The signer downloads that exact artifact with bounded HTTP range resume,
checks the GitHub artifact digest and internal SHA-256 manifest, reconstructs shallow checkouts with the
original commit/tree identities, selects the controlled host's pinned toolchains, and cleans only the unique
run/attempt-scoped source directory. Retry only transport and Apple timestamp transients, never certificate,
authorization, provenance, notarization, or signature failures.

### Metadata

- Source: command_failure
- Reproducible: network-dependent
- Related Files: hara-desktop/.github/workflows/build.yml, hara-desktop/scripts/build-mac-signed.sh
- Tags: github-actions, codeload, self-hosted-runner, signing, release
- Pattern-Key: release.use_resumable_digest_bound_source_handoff
- Recurrence-Count: 5

---

## [ERR-20260820-NPM-CACHE-OWNERSHIP] npm pack could not use the workstation's global cache

**Logged**: 2026-08-20T01:17:11+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary

`npm pack --dry-run` completed Hara's prepare/build step but npm could not create a temporary cache file
because the workstation's shared `~/.npm` cache contains root-owned entries.

### Error

```text
npm error code EPERM
npm error syscall open
npm error path /Users/zhujianbo/.npm/_cacache/tmp/...
```

### Context

- Command: Node 22 `npm pack --dry-run`
- Hara's TypeScript build completed successfully before npm attempted to write its cache.
- Changing ownership of the user's global npm cache is outside the package release task.

### Suggested Fix

Use a task-local temporary `npm_config_cache` for release preflight commands on this workstation. Do not
mutate global npm cache ownership as an incidental workaround.

### Metadata

- Reproducible: yes
- Related Files: package.json
- Tags: npm, cache, release-preflight

### Resolution

- **Resolved**: 2026-08-20T01:17:11+08:00
- **Notes**: Release preflight reruns with an isolated cache under `/private/tmp`; `.learnings` remains
  intentionally untracked and excluded from the product commit.

---

## [ERR-20260817-ZSH-NESTED-VERSION-ASSERTION] release_command

**Logged**: 2026-08-17T16:59:25+08:00
**Priority**: low
**Status**: resolved
**Area**: release-verification

### Summary

A nested `node -p` expression lost its intended quotes inside a zsh command string, so zsh interpreted the
parenthesized JavaScript as a filename-generation pattern. The release command stopped before tag creation
or push, leaving no partial deployment.

### Error

```text
zsh: bad pattern: "require(./package.json).version"
```

### Resolution

Use `jq -er '.version == "<expected>"' package.json` or another quote-simple file assertion in release
chains. Keep the assertion before tag creation so a shell parsing failure cannot produce a partial release.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: package.json
- Tags: zsh, quoting, release, version
- Pattern-Key: release.use_quote_simple_version_assertion
- Recurrence-Count: 1

---

## [ERR-20260817-RELEASE-VERIFY-ASSUMPTIONS] Release verification reused an incorrect repository and audit endpoint

**Logged**: 2026-08-17T19:55:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-workflow

### Summary

Two release checks relied on remembered defaults instead of repository-owned evidence: the first GitHub query
used `hara-cli/hara-cli` although `origin` is `hara-cli/hara`, and the first dependency audit used the configured
npmmirror endpoint, which does not implement npm's audit API. A speculative Desktop workflow patch also briefly
duplicated an environment key that an existing regression already covered.

### Resolution

Read `git remote -v` and existing release assertions before patching or querying. Run security audits against
`https://registry.npmjs.org` explicitly when the configured install mirror lacks the audit endpoint. Revert any
speculative edit immediately and rerun the focused test before release.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: hara-desktop/.github/workflows/build.yml, hara-desktop/test/release-pipeline.test.mjs
- Tags: github, npm-audit, release, verification
- Pattern-Key: release.derive_remote_and_audit_endpoint_from_evidence
- Recurrence-Count: 1

---

## [ERR-20260814-DEEPSEEK-HARNESS-NODE-METADATA] Package metadata probe used the legacy system Node and a non-relative require id

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: architecture-analysis

### Summary

A read-only package metadata loop in `deepseek-harness` invoked the workstation's legacy system Node and
passed `packages/.../package.json` to `require()` without a `./` prefix. Node treated the path as a package
identifier and every lookup failed. No target-repository file was changed.

### Resolution

For every Node or pnpm command in this analysis, prepend the repository-approved Node 22.23.1 runtime.
Use filesystem readers such as `sed`/`rg`, an absolute path, or a correctly prefixed relative path instead
of relying on the ambient Node resolver for metadata inspection.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: /Users/zhujianbo/work/projects/ai/deepseek-harness/AGENTS.md
- Tags: node, nvm, package-metadata, architecture-analysis
- Pattern-Key: node.pin_repo_runtime_and_use_explicit_paths
- Recurrence-Count: 1

---

## [ERR-20260814-PATH-ASSIGNMENT-SINGLE-COMMAND] Node PATH pin applied to only the first command in a chain

**Logged**: 2026-08-14T15:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-verification

### Summary

An inline `PATH=... node --version` assignment affected only that executable. Later commands in the same
shell line resolved the legacy system Node 11 through the global npm launcher, even though the version probe
had just printed Node 22.23.1.

### Error

```text
Error: Cannot find module 'node:path'
```

### Resolution

For a multi-command Node release gate, export the repository-approved NVM `bin` directory once at the start
of the shell or pass an explicit environment to every subprocess. Never infer later npm commands inherit an
assignment scoped to an earlier command.

### Follow-up 2026-08-21

Invoking the NVM installation's `npm` file by absolute path reproduced the same boundary: its
`#!/usr/bin/env node` shebang still selected ambient Node 11. Exporting the matching Node 22.23.1 `bin`
directory for the whole shell fixed npm and every lifecycle subprocess. An absolute launcher path is not
an interpreter pin.

### Follow-up 2026-08-22

A public `npm view` release check again omitted the repository-approved environment and selected system
Node 11 (`Cannot find module 'node:path'`). Keep the complete Node/Bun/Rust toolchain prefix attached to
each independently launched verification command; a pin used by earlier commands or other parallel calls
does not carry over.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: AGENTS.md
- Tags: node, nvm, path, release
- Pattern-Key: release.export_node_path_for_whole_shell
- Recurrence-Count: 3
- Last-Seen: 2026-08-22

---

## [ERR-20260814-DOCX-RENDER-DEPENDENCY] Packaged DOCX renderer lacked its Python image dependency

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: development-workflow

### Summary

The packaged `render_docx.py` could not start because the active Python environment did not contain
`pdf2image`; LibreOffice was also unavailable on this workstation.

### Error

```text
ModuleNotFoundError: No module named 'pdf2image'
```

### Resolution

For read-only intake, fall back to macOS Quick Look plus structural text extraction and disclose the missing
canonical render gate; do not install dependencies into the system Python as an incidental task side effect.

### Metadata

- Source: command_failure
- Reproducible: yes
- Tags: docx, rendering, dependency
- Pattern-Key: documents.renderer_dependency_missing
- Recurrence-Count: 1

---

## [ERR-20260814-DOCUMENTS-SKILL-CACHE-PATH] Documents skill catalog pointed to a stale cache version

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: development-workflow

### Summary

The catalog path ended in `26.805.11740`, while the installed documents package had already advanced to
`26.812.11052`.

### Error

```text
sed: .../documents/26.805.11740/skills/documents/SKILL.md: No such file or directory
```

### Resolution

Resolve the installed version with `rg --files` when an immutable plugin-cache locator has expired, then read
the discovered `SKILL.md` fully before continuing.

### Metadata

- Source: command_failure
- Reproducible: yes
- Tags: skills, plugin-cache, documents
- Pattern-Key: skills.resolve_stale_plugin_cache_locator
- Recurrence-Count: 1

---

## [ERR-20260814-FEISHU-PREVIEW-LIMIT] Feishu message preview exceeded the client safety bound

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: development-workflow

### Summary

The feedback refresh requested `--preview-limit 1200`, but the reusable Feishu client intentionally accepts
only values from 1 through 100.

### Error

```text
error: days/limit/preview-limit out of range
```

### Resolution

Use `--preview-limit 100` for message listing, then fetch the individual message or attachment when the full
body is needed.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py
- Tags: feishu, feedback-intake, parameter-bounds
- Pattern-Key: feishu.messages_preview_limit_max_100
- Recurrence-Count: 1

---

## [ERR-20260814-STREAM-IMAGE-WITHOUT-NUL] Text streaming did not classify a minimal image header as binary

**Logged**: 2026-08-14T14:20:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend

### Summary

The first `inspect_image` regression expected `read_file` to reject every image as binary, but the bounded
streaming decoder historically used NUL-byte detection. A minimal valid PNG signature with no NUL in the
fixture was rendered with replacement/control characters instead of producing the binary guidance.

### Error

```text
Expected /call inspect_image/; received numbered replacement/control characters from read_file.
```

### Resolution

Route supported image extensions to `inspect_image` before text decoding, then independently require
PNG/JPEG/GIF/WebP magic bytes inside the image tool. Do not assume that every binary input contains a NUL
byte in the sampled window, and do not trust an extension as the final media-type proof.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: src/tools/builtin.ts, src/tools/inspect-image.ts, test/inspect-image.test.mjs
- Tags: image, binary-detection, utf8, tool-routing
- Pattern-Key: harden.binary_routing_needs_hint_and_magic_boundary
- Recurrence-Count: 1

---

## [ERR-20260813-FEISHU-CAPABILITY-DISCOVERY] Assumed a skill script was a callable nested tool

**Logged**: 2026-08-13T21:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: issue-intake

### Summary

After successfully pulling feedback with the `feishu-communicate` skill's maintained CLI, a follow-up
attempt guessed a `tools.feishu_chat__send` nested-tool name that was not exposed in this session. The
call failed before sending anything; no credential or message content was transmitted.

### Resolution

Use the same verified skill-owned `scripts/feishu_chat.py send` command for outbound messages unless an
actual Feishu MCP tool is discovered in the enabled tool catalog. Do not infer nested tool names from a
skill's purpose.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py
- Tags: feishu, skills, tool-discovery, issue-intake
- Pattern-Key: feishu.do_not_infer_nested_tool_from_skill_name
- Recurrence-Count: 1

---

## [ERR-20260812-CHROMIUM-PDF-PROCESS-STAYS-OPEN] Headless Chromium wrote a complete PDF but did not exit

**Logged**: 2026-08-12T12:03:00+08:00
**Priority**: high
**Status**: resolved
**Area**: presentation-export

### Summary

The first real direct-PDF regression timed out after 60 seconds even though Chromium had already written
an 85 KiB, two-page PDF with a valid `%%EOF` marker. The browser and helper processes kept the owned
process group alive, so treating child exit as the only success boundary produced a false failure and left
an orphaned temporary browser process.

### Resolution

Treat a stable, bounded regular output file with a complete PDF end marker as the renderer completion
boundary. Once that boundary is reached, terminate the isolated browser process group and then perform the
independent PDF header/EOF/page-count checks before returning bytes. Child exit remains a valid completion
signal only when the verified output already exists.

### Metadata

- Source: command_failure
- Reproducible: yes on Chrome 151 for macOS
- Related Files: src/presentations/pdf.ts, test/presentations.test.mjs
- Tags: chromium, pdf, process-lifecycle, timeout, presentation
- Pattern-Key: browser.pdf_completion_is_verified_file_not_child_exit
- Recurrence-Count: 1

---

## [ERR-20260813-REDACTION-PLACEHOLDER-ASSERTION] Final regression expected the wrong safe placeholder

**Logged**: 2026-08-13T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The final full CLI suite failed only because a new credential-redaction test expected `Bearer ***`, while
the established redactor correctly applies its more specific API-key replacement first and emits
`Bearer sk-***`. No credential was exposed and the production behavior was correct.

### Resolution

Keep the established, informative redaction marker and assert its exact safe output plus absence of the
original secret. Rerun the complete release suite after correcting the fixture.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: test/provider-bounded-turn.test.mjs, src/security/secrets.ts
- Tags: tests, redaction, release-gate
- Pattern-Key: test.assert_safe_redaction_semantics_not_invented_placeholder
- Recurrence-Count: 1

---

## [ERR-20260812-FULL-SUITE-LOOPBACK-SANDBOX] full-suite

**Logged**: 2026-08-12T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The managed sandbox rejected loopback listeners used by existing CLI integration tests, producing
many `listen EPERM` failures and one cancellation-path false negative after the PPT-focused tests had
already passed.

### Resolution

Reran the unchanged full suite at the approved system boundary with Node 22.23.1. All tests passed;
the sandbox failures were not product regressions.

---

## [ERR-20260812-NPM-NEW-PACKAGE-STALE-CACHE] Newly published prerelease was hidden by the default npm cache

**Logged**: 2026-08-12T02:28:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release

### Summary

Immediately after `@nanhara/hara-presentation@0.1.0-alpha.8` became visible through a fresh npm
cache, `npm install` with the workstation's default cache still returned `ETARGET`.

### Error

```text
npm error code ETARGET
npm error notarget No matching version found for @nanhara/hara-presentation@0.1.0-alpha.8.
```

### Resolution

Use a fresh task-specific npm cache for the first install of a just-published package, matching the
release verification scripts. Do not treat the stale-cache response as evidence that publication failed.

### Metadata

- Reproducible: timing-dependent
- Related Files: package.json, package-lock.json
- Tags: npm, prerelease, cache, release

---

## [ERR-20260810-GITHUB-ACTIONS-QUERY-TLS-TIMEOUT] GitHub Actions status query timed out during TLS handshake

**Logged**: 2026-08-10T23:21:57+08:00
**Priority**: low
**Status**: resolved
**Area**: release-verification

### Summary

The first `gh run list` query after pushing CLI tag `v0.145.0` timed out during the GitHub API TLS
handshake. The tag push had already succeeded, so retrying the tag would risk duplicate release work.

### Resolution

Keep the immutable tag unchanged and retry only the read-only Actions query after a short bounded wait.
Confirm the run head SHA before using any workflow result as release evidence.

### Metadata

- Source: command_failure
- Reproducible: network-dependent
- Related Files: .github/workflows/publish-npm.yml, .github/workflows/release.yml
- Tags: github, actions, tls, release-verification
- Pattern-Key: release.retry_read_only_github_status_not_tag_push
- Recurrence-Count: 1

---

## [ERR-20260807-BARE-WAIT-MASKED-PARTIAL-ASSET-DOWNLOADS] Bare Bash wait returned success while three parallel downloads stayed partial

**Logged**: 2026-08-07T22:14:00+08:00
**Priority**: high
**Status**: resolved
**Area**: release-validation

### Summary

Four resumable public-asset downloads ran in parallel and emitted repeated transport failures. A bare
`wait` returned zero because the status it surfaced was not an all-child success aggregate; size and
SHA-256 verification correctly showed that only the macOS arm64 asset was complete.

### Resolution

Never treat bare `wait` as aggregate evidence for parallel release downloads. Track every child PID and
require each wait to succeed, then independently compare every file with authoritative API size and
SHA-256. Also do not assume `curl --continue-at -` preserves a partial file when a redirect endpoint
ignores ranges; final byte validation remains mandatory.

### Metadata
- Source: command_failure
- Reproducible: yes
- Related Files: .github/workflows/release.yml
- Tags: release, download, bash, wait, checksum, github
- Pattern-Key: release.parallel_downloads_require_per_pid_status_and_final_digest
- Recurrence-Count: 1

---

## [ERR-20260810-FEISHU-SCRIPT-LOCATION] Assumed the Feishu helper lived in the repository

**Logged**: 2026-08-10T18:45:58+08:00
**Priority**: low
**Status**: resolved
**Area**: issue-intake

### Summary

The first latest-feedback pull invoked `scripts/pull_feishu_chat.py`, but this checkout does not contain
that helper. The maintained client belongs to the installed `feishu-communicate` skill.

### Resolution

Use the skill-owned `scripts/feishu_chat.py messages` command after reading the skill instructions, and
respect its bounded `preview-limit` range. The corrected pull returned the current 22-message window and
confirmed that there were no messages newer than 17:19.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py
- Tags: feishu, issue-intake, skills
- Pattern-Key: feishu.use_skill_owned_client_not_repo_guess
- Recurrence-Count: 1

---

## [ERR-20260810-HARA-STATE-CHMOD-SANDBOX] Project-approval test hit the managed Home permission boundary

**Logged**: 2026-08-10T18:45:58+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The focused project-approval test failed before its product assertion because the managed sandbox rejected
`chmod` on `~/.hara`; the child-process cancellation test separately returned the sandbox launcher status 71.

### Resolution

Rerun the unchanged suites in the approved host test boundary. Project approvals passed 5/5 and Agent
lifecycle limits passed 36/36; the later full isolated-Home CLI suite also exited successfully.

### Metadata

- Source: command_failure
- Reproducible: sandbox-dependent
- Related Files: test/project-approvals.test.mjs, test/agent-limits.test.mjs
- Tags: tests, sandbox, permissions, subprocess
- Pattern-Key: test.managed_sandbox_blocks_private_state_and_process_lifecycle
- Recurrence-Count: 1

---

## [ERR-20260810-SERVE-BUDGET-FIXTURE-MODEL] Serve round-budget fixture used a mismatched pinned model

**Logged**: 2026-08-10T18:45:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The first cumulative-round Serve test stored model `fake-1` but returned a provider named
`task-round-budget`. Serve correctly rejected the pinned-model mismatch and detached the session, so the
following send reported “no live session”.

### Resolution

Keep the fixture provider on the stored `fake-1` identity and assert that `session.resume` succeeds before
sending. This preserves the production pinned-model guard while testing only the round-budget behavior.

### Metadata

- Source: test_failure
- Reproducible: yes
- Related Files: test/serve-e2e.test.mjs
- Tags: serve, fixture, model-pinning
- Pattern-Key: test.serve_fixture_must_match_persisted_model
- Recurrence-Count: 1

---

## [ERR-20260810-RUN-OUTCOME-ROUNDS-CONTRACT] Internal task accounting changed the public run result shape

**Logged**: 2026-08-10T18:30:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: agent-lifecycle

### Summary

The first cumulative task-round implementation added a `rounds` property to every `runAgent` outcome.
Existing cancellation tests correctly rejected this because callers rely on the stable, minimal outcome shape.

### Resolution

Keep provider-round accounting inside the lifecycle and persist it through `taskIntake.onRoundUsage`; do not
expose it on `RunOutcome`. Regression tests verify both the unchanged return contract and durable 50/100-round
task behavior.

### Metadata

- Source: test_failure
- Reproducible: yes
- Related Files: src/agent/loop.ts, test/agent-limits.test.mjs
- Tags: compatibility, task-budget, run-outcome
- Pattern-Key: api.keep_internal_accounting_out_of_public_result_shape
- Recurrence-Count: 1

---

## [ERR-20260807-NPM-PACK-SANDBOX-CACHE-EPERM] npm pack dry-run could not access the user cache inside the workspace sandbox

**Logged**: 2026-08-07T21:22:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-validation

### Summary

The first `npm pack --dry-run` for CLI 0.142.2 failed with `EPERM` while opening a temporary file under
the user's npm cache. npm described this as possibly root-owned cache content, but the same command
succeeded unchanged with system access; no ownership repair was required.

### Resolution

Treat an npm-cache EPERM from the restricted workspace as sandbox evidence first. Re-run the exact
read/package gate with the pinned Node runtime and system access before considering permission changes;
never follow npm's generic `sudo chown` suggestion without independent filesystem evidence.

### 2026-08-10 Follow-up

The CLI 0.145.0 pack gate hit the same default-cache `EPERM`. Keep the build result, avoid changing
global cache ownership, and rerun with a release-specific cache under `/private/tmp`.

### Metadata
- Source: tool_failure
- Reproducible: sandbox-dependent
- Related Files: package.json, package-lock.json
- Tags: npm, pack, cache, sandbox, eperm
- Pattern-Key: tooling.npm_cache_eperm_in_workspace_requires_system_gate_not_chown
- Recurrence-Count: 2

---

## [ERR-20260806-TRUNCATED-TEST-EXIT] Long TAP output hid a failed assertion and process status

**Logged**: 2026-08-06T12:05:00+08:00
**Priority**: high
**Status**: resolved
**Area**: release-validation

### Summary

The first full CLI gate produced more output than the tool result could retain. Its middle section,
including one failed capability-list assertion, was truncated; a deferred process result also returned
without an exit code. Reading the visible first/last tests was not sufficient release evidence.

### Resolution

Rerun the exact Node test set with `--test-reporter=dot`, poll the returned process session until it exits,
and require an explicit exit code. This exposed the stale expected feature list; after updating it, all 956
tests exited 0.

### Metadata
- Source: command_failure
- Reproducible: yes for high-volume TAP output
- Related Files: test/serve-e2e.test.mjs
- Tags: test, output-truncation, exit-code, release-gate
- Pattern-Key: tests.require_explicit_exit_after_truncated_output
- Recurrence-Count: 1

---

## [ERR-20260806-PUBLIC-ASSET-DOWNLOAD-TRUNCATED] Public release download ended with partial native binaries

**Logged**: 2026-08-06T14:25:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release-validation

### Summary

The long-running `gh release download` yielded an execution session, but the orchestration wrapper
emitted only its empty output and lost the returned session ID instead of polling it to an exit code.
All four v0.141.0 asset names were left as small prefixes of the GitHub-declared sizes. The files still
had valid Mach-O/ELF headers, so a shallow `file` check could have mistaken them for complete artifacts.
Subsequent direct downloads also hit low-speed timeout and broken-pipe retries.

### Resolution

For every yielded command, serialize the complete execution result, retain its session ID, and poll it
to a real exit code. Never accept a release download based on file names or type alone: compare exact
byte size and SHA-256 with the public Release API. Resume the immutable URL with bounded retries when
incomplete; v0.141.0's arm64 macOS asset eventually matched 68,167,904 bytes and its published SHA-256,
then passed codesign, version, and help execution checks.

### Follow-up 2026-08-21

A same-day `gh release download` of the large Desktop 0.1.96 asset set again made only partial progress.
The release-channel audit instead used GitHub's digest-bearing asset metadata as the immutable expectation
and streamed the public first-party CDN bytes directly into size/SHA-256 verification. This avoided keeping
partial binaries while still proving all 15 mirrored objects and six updater Range responses.

### Metadata

- Source: external_api_failure
- Reproducible: intermittent
- Related Files: .github/workflows/release.yml
- Tags: github-release, download, resume, sha256, release
- Pattern-Key: release.public_asset_requires_size_and_digest_not_header
- Recurrence-Count: 2
- Last-Seen: 2026-08-21

---

## [ERR-20260806-GIT-FOR-EACH-REF-PEELED] Local Git did not support the requested `%(peeled)` atom

**Logged**: 2026-08-06T14:05:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-validation

### Summary

A tag verification command assumed this workstation's Git supported the `%(peeled)`
`for-each-ref` atom. It did not, so the formatting command failed before producing evidence.

### Resolution

Verify annotated tags portably with `git cat-file -t <tag>` and
`git rev-parse '<tag>^{}'`, then dereference the remote annotated-tag object through the GitHub API.

### Metadata

- Source: tool_failure
- Reproducible: yes
- Tags: git, annotated-tag, compatibility, release
- Pattern-Key: release.portable_annotated_tag_dereference
- Recurrence-Count: 1

---

## [ERR-20260806-NPM-GATE-ENV] Release commands fell back to legacy Node and an unusable npm cache

**Logged**: 2026-08-06T11:55:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release-validation

### Summary

`npm pack --dry-run` tried to write the workstation's root-owned npm cache, while a chained Bun/version
probe applied its temporary PATH only to the first command and let the following `npm` resolve through
legacy system Node 11.

### Resolution

Run each modern Node command separately with the repository-approved Node bin first on PATH. Point the
non-publishing pack check at a dedicated cache under `/private/tmp`; do not change ownership or mutate the
user's global npm cache.

### Metadata
- Source: command_failure
- Reproducible: yes on this workstation
- Tags: npm, node, nvm, cache, shell-environment
- Pattern-Key: tooling.pin_node_per_command_and_isolate_npm_cache
- Recurrence-Count: 1

---

## [ERR-20260805-PROJECT-APPROVAL-TMP-ALIAS] Scratch grants compared lexical and canonical macOS paths

**Logged**: 2026-08-05T20:25:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: security

### Summary

The first project-approval test showed `.tmp/a.txt` and `.tmp/b.txt` receiving exact-file grants instead
of one shared scratch-directory grant. The project root was canonicalized from `/var/...` to
`/private/var/...`, while relative target paths still used the lexical cwd.

### Resolution

Resolve relative targets from the real cwd and map absolute targets inside the lexical project tree onto
the same canonical root before scope comparison. On 2026-08-07 the same alias appeared in a new
`open_directory` test; expected paths now use `realpathSync.native()` instead of lexical `resolve()`.

### Metadata
- Reproducible: yes on macOS temporary directories
- Related Files: src/security/project-approvals.ts, test/project-approvals.test.mjs, test/open-directory.test.mjs
- Tags: path-alias, macos, approval-scope
- Pattern-Key: security.compare_canonical_paths
- Recurrence-Count: 2
- Last-Seen: 2026-08-07

---

## [ERR-20260805-SERVE-E2E-SANDBOX-LISTEN] WebSocket end-to-end test cannot bind inside the workspace sandbox

**Logged**: 2026-08-05T22:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: test

### Summary

The focused `serve-e2e` test reached the WebSocket server setup, but the workspace sandbox denied a
loopback listener before application code ran.

### Error

```text
listen EPERM: operation not permitted 127.0.0.1
```

### Suggested Fix

Run WebSocket end-to-end tests with the already reviewed host-network permission. Keep pure trigger tests
inside the sandbox so policy logic still has a fast hermetic check.

The 2026-08-10 CLI 0.145.0 standalone Serve release smoke reached the same pre-application
`listen EPERM` boundary; rerun that exact smoke with narrowly scoped host loopback access.

### Metadata
- Reproducible: yes
- Related Files: test/serve-e2e.test.mjs
- Tags: test, websocket, sandbox, loopback
- Pattern-Key: tests.serve_e2e_requires_host_loopback
- Recurrence-Count: 4
- Last-Seen: 2026-08-10

### Resolution
- **Resolved**: 2026-08-05T22:00:00+08:00
- **Notes**: Classified as an execution-environment restriction; rerun the identical focused test with
  host-network permission.

---

## [ERR-20260805-APPROVAL-COPY-PATCH] Approval copy patch assumed the wrong Chinese source text

**Logged**: 2026-08-05T20:18:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

A multi-file patch expected `始终允许`, while the existing Desktop translation was `总是允许`. Patch
verification rejected the whole change before writing anything.

### Resolution

Read the exact source line and apply a narrow patch against the existing text.

### Metadata
- Reproducible: yes
- Tags: apply-patch, i18n
- Pattern-Key: tooling.patch_exact_source_first
- Recurrence-Count: 1

---

## [ERR-20260801-PNPM-COREPACK-VERSION-DRIFT]

**Logged**: 2026-08-01T23:52:00+08:00
**Priority**: low
**Status**: in_progress
**Area**: release-validation

### Summary

Website builds resolved Corepack's ambient pnpm 11.13.0 even though the repositories require pnpm 11.5.0,
so all three builds stopped at the package-manager version gate before compiling.

### Resolution

Keep the repository constraint unchanged and invoke the exact cached toolchain with
`corepack pnpm@11.5.0 ...` for every build/deploy command.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: hara-web/site/package.json, hara-web/cn-site/package.json, hara-web/docs/package.json
- Tags: pnpm, corepack, toolchain, website
- Pattern-Key: tooling.invoke_repository_pinned_pnpm_version

---

## [ERR-20260805-ZSH-EMPTY-GLOB] A read-only audit used an unmatched zsh glob

**Logged**: 2026-08-05T20:10:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

A repository search included `test/*approval*` directly in a zsh command. No matching path existed,
so zsh rejected the command before `rg` ran.

### Error

```text
zsh:1: no matches found: test/*approval*
```

### Resolution

Use explicit directories plus `rg --glob`, or quote optional patterns, for searches that may match no
files.

### Metadata
- Reproducible: yes
- Tags: zsh, glob, audit
- Pattern-Key: tooling.zsh_unmatched_glob
- Recurrence-Count: 1

---

## [ERR-20260805-REASONING-TEST-NO-STREAM] terminal privacy test expected an unstreamed result

**Logged**: 2026-08-05T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The first reasoning-privacy regression expected the fake provider's returned
text to appear in captured streaming output even though the fixture never
called `onText`.

### Error

```text
AssertionError: the verified assistant result remains visible
```

### Context

- Command: focused Node tests for terminal and TUI reasoning privacy
- Product behavior was correct; the test fixture did not model streaming.

### Suggested Fix

Have the fake provider stream the visible answer through `onText` before
returning the same canonical answer.

### Metadata

- Reproducible: yes
- Related Files: test/loop-reasoning-render.test.mjs
- Pattern-Key: test.fake_provider_must_stream_visible_delta

### Resolution

- **Resolved**: 2026-08-05T00:00:00+08:00
- **Notes**: Added the missing `onText("done")` fixture callback.

---

## [ERR-20260805-TEST-PATCH-CONTEXT] reasoning regression-test patch context drifted

**Logged**: 2026-08-05T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

An `apply_patch` for the reasoning-privacy regression test did not match because
the expected comment used different quote characters from the file.

### Error

```text
apply_patch verification failed: Failed to find expected lines
```

### Context

- Operation: update `test/loop-reasoning-render.test.mjs`
- Product source edits were unaffected.

### Suggested Fix

Read the narrow test region and patch against its exact current text.

### Metadata

- Reproducible: no
- Related Files: test/loop-reasoning-render.test.mjs
- Pattern-Key: patch.test_comment_context_drift

### Resolution

- **Resolved**: 2026-08-05T00:00:00+08:00
- **Notes**: Rebased the minimal test patch on the actual file contents.

---

## [ERR-20260805-SERVE-E2E-SANDBOX-HOME] Focused Serve tests needed loopback permission and an isolated HOME

**Logged**: 2026-08-05T17:05:00+08:00
**Priority**: medium
**Status**: resolved by isolated host-context rerun
**Area**: tests

### Summary

Running `test/serve-e2e.test.mjs` in the restricted sandbox denied every loopback listener and also
revealed that two legacy automation cases would otherwise resolve the workstation's real `~/.hara`
cron directory.

### Resolution

Run the focused suite in the approved loopback context with HOME and USERPROFILE set to a dedicated
temporary directory. Never grant a test access to the user's live Hara state merely to bypass the
sandbox.

### Metadata

- Source: test_environment_failure
- Reproducible: sandbox-dependent
- Related Files: test/serve-e2e.test.mjs
- Tags: websocket, loopback, home-isolation, sandbox
- Pattern-Key: tests.serve_e2e_requires_loopback_and_isolated_home
- Recurrence-Count: 1

---

## [ERR-20260805-NVM-GLOBAL-INSTALL-RACE] Parallel npm upgrades resolved to one NVM prefix

**Logged**: 2026-08-05T03:13:00+08:00
**Priority**: high
**Status**: resolved
**Area**: infra

### Summary

Two global Hara upgrades were launched concurrently by invoking different absolute `npm` scripts,
but neither command pinned its matching Node `bin` directory on `PATH`. Both `#!/usr/bin/env node`
launchers therefore resolved to Node 22.22.3 and wrote into the same global prefix, producing a
partially installed dependency tree.

### Error

```text
TAR_ENTRY_ERROR ENOENT
ENOTEMPTY: directory not empty
Cannot find module .../protobufjs/scripts/postinstall
```

### Suggested Fix

Treat each NVM global installation as a serialized operation. Put that runtime's `bin` directory
first on `PATH`, invoke its matching npm executable, verify `npm prefix -g`, then install and execute
`hara --version` before moving to the next runtime. Never parallelize global npm mutations when their
effective prefixes have not been proven distinct.

### Metadata
- Reproducible: yes
- Related Files: AGENTS.md
- Tags: npm, nvm, global-install, path, race, release
- Pattern-Key: npm.nvm_global_install_requires_pinned_path_and_serialization
- Recurrence-Count: 1

### Resolution
- **Resolved**: 2026-08-05T03:18:00+08:00
- **Notes**: Reinstalled 0.138.2 sequentially under explicit per-runtime `PATH`, then verified the
  independent global package tree and `hara --version` under Node 22.22.3 and Node 24.15.0.

---

## [ERR-20260804-INTEL-PROCESS-TREE-FLAKE] Intel CI missed the quiet-grandchild PID deadline

**Logged**: 2026-08-04T17:27:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The release commit's first `macos-15-intel` full-suite run passed 1256 of 1257 tests but the quiet
process-tree fixture did not publish its grandchild PID before the test deadline. The release change
only touched model-fetch diagnostics, and all other platforms, package publishing, and standalone
release workflows passed.

### Error

```text
TERM escalation still kills a quiet grandchild after the direct shell has closed
expected .../grandchild.pid to publish a positive PID
```

### Context

- The fixture uses a one-second shell timeout and then waits 1.5 seconds for a PID file.
- The same Intel job passed in full when GitHub Actions reran the failed job without code changes.
- This is runner scheduling/timing sensitivity, not evidence of a model-connection regression.

### Suggested Fix

If this recurs, decouple fixture startup readiness from the termination timeout or increase only the
Intel CI fixture startup allowance. Do not weaken the production process-tree termination assertion.

### Metadata
- Reproducible: no
- Related Files: test/jobs.test.mjs
- Tags: ci, macos, intel, timing, process-tree, flaky-test

### Resolution
- **Resolved**: 2026-08-04T17:27:00+08:00
- **Notes**: Reran the failed GitHub Actions job; the full suite and native x64 standalone smoke both
  completed successfully.

---

## [ERR-20260804-NPM-VIEW-APPROVAL-TIMEOUT] Public npm verification approval review timed out

**Logged**: 2026-08-04T17:05:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-verification

### Summary

A read-only `npm view` request was rejected because automatic permission review did not finish before
its deadline. The failure did not indicate an unsafe command or a package problem.

### Resolution

Retried the same narrowly scoped official-registry read once, as instructed; it succeeded and returned
the expected `0.138.0` version and integrity.

### Metadata
- Reproducible: no
- Related Files: package.json
- Tags: approval, timeout, npm, public-verification

---

## [ERR-20260804-NPM-CI-INCOMPLETE-EXTRACTION] Yielded npm install session was not polled before validation

**Logged**: 2026-08-04T16:39:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release-validation

### Summary

The nested execution helper yielded a still-running `npm ci` session after its initial wait. The
orchestration printed only the partial output and discarded the returned session ID, then started
`npm ls`, tests, and audit while npm was still replacing `node_modules`. That race temporarily exposed
empty package directories and a missing `tsc` link; the installer itself had not completed yet.

### Suggested Fix

Whenever `exec_command` returns a session ID, poll that exact session with `write_stdin` until an exit
code is returned before running any command that reads or writes the same tree. Then validate the
installed tree with `npm ls` and an executable-link check before starting tests or audit.

### Metadata
- Reproducible: yes
- Related Files: package.json, package-lock.json
- Tags: npm-ci, orchestration, session-polling, race, release-gate
- Pattern-Key: release.serialize_dependency_mutation_and_tests
- Recurrence-Count: 2
- Last-Seen: 2026-09-02

### Resolution
- **Resolved**: 2026-08-04T16:46:00+08:00
- **Notes**: Waited until no npm install/test/audit process remained, then verified `tsc` and the full
  dependency tree. Future long commands retain and poll their returned unified-exec session IDs. Recurred
  on 2026-09-02 when a security-driven `npm install` overlapped an already-running full suite; the release
  workflow now keeps dependency mutation and every consumer gate strictly serial.

---

## [ERR-20260804-RELEASE-AUDIT-NEW-ADVISORIES] Official production audit found newly disclosed dependency vulnerabilities

**Logged**: 2026-08-04T16:35:00+08:00
**Priority**: high
**Status**: resolved
**Area**: release-validation

### Summary

The `0.138.0` pre-release audit stopped on one moderate and three high-severity advisories affecting
the locked `fast-uri`, `hono`, `ip-address`, and `undici` versions. npm reports compatible fixes for
all four through `npm audit fix`; no release tag was created.

### Suggested Fix

Apply the official-registry compatible lockfile updates, review the exact dependency diff, then rerun
the complete tests, production audit, pack dry run, and standalone binary smoke before tagging.

### Metadata
- Reproducible: yes
- Related Files: package.json, package-lock.json
- Tags: npm-audit, release-gate, dependencies, security

### Resolution
- **Resolved**: 2026-08-04T16:41:00+08:00
- **Notes**: Locked fast-uri 3.1.5, hono 4.12.34, ip-address 10.3.1, and undici 7.29.0 from the
  official registry; the package-lock update and install audit both reported zero vulnerabilities.

---

## [ERR-20260804-NPM-PACK-GLOBAL-CACHE-PERMISSION] Pack dry run inherited an unwritable global npm cache

**Logged**: 2026-08-04T16:35:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release-validation

### Summary

`npm pack --dry-run` completed its prepare build but failed while opening a temporary path under the
workstation's global npm cache because that cache contains historical root-owned files. This is an
environment failure, not a package-content failure.

### Error

```text
npm error code EPERM
npm error syscall open
npm error path /Users/zhujianbo/.npm/_cacache/tmp/...
```

### Suggested Fix

Use a private release-validation cache under `/private/tmp` for pack/audit commands. Do not change
ownership of the user's entire global npm directory as part of a product release.

### Metadata
- Reproducible: yes
- Related Files: package.json, package-lock.json
- Tags: npm, cache, permissions, pack, release-gate

### Resolution
- **Resolved**: 2026-08-04T16:36:00+08:00
- **Notes**: The retry path uses an isolated writable cache and leaves the global npm directory intact.

### Follow-up

- **Seen again**: 2026-08-05T12:09:00+08:00
- **Context**: The 0.139.1 pack dry run again reached the same default-cache `EPERM` after its prepare
  build. The unchanged command passed when granted access to the user cache; no package bytes changed.
- **Prevention**: Prefer `NPM_CONFIG_CACHE=/private/tmp/<release-specific-directory>` for local pack
  validation so the release gate never depends on the historical global cache ownership.
- **Recurrence-Count**: 2
- **Last-Seen**: 2026-08-05

---

## [ERR-20260804-MODEL-PROXY-LOCAL-LISTEN-SANDBOX] Focused proxy test could not bind loopback in the sandbox

**Logged**: 2026-08-04T16:20:00+08:00
**Priority**: low
**Status**: resolved
**Area**: test-environment

### Summary

The focused model-proxy suite initially reported one failure because its authenticated CONNECT fixture
must listen on a temporary `127.0.0.1` port, which the managed sandbox rejected with `EPERM`. The six
non-listening tests, including both new loopback diagnostics, passed.

### Error

```text
listen EPERM: operation not permitted 127.0.0.1
```

### Suggested Fix

When this existing transport integration test is part of a required verification, rerun the exact
pinned-Node test command with narrowly scoped permission to bind a local test port. Do not interpret
the sandbox error as a product or network-logic regression.

### Metadata
- Reproducible: yes
- Related Files: test/model-proxy.test.mjs
- Tags: test, sandbox, loopback, listen, proxy

### Resolution
- **Resolved**: 2026-08-04T16:21:00+08:00
- **Notes**: Reran the identical Node 22.22.3 command outside the bind-restricted sandbox; all 7 tests
  passed.

---

## [ERR-20260804-MODEL-LOOPBACK-PATCH-CONTEXT] Combined model-network patch used stale test context

**Logged**: 2026-08-04T16:16:00+08:00
**Priority**: low
**Status**: resolved
**Area**: code-editing

### Summary

A combined source-and-test `apply_patch` for the stale loopback gateway diagnosis failed atomically
because the expected final test block did not match the current file exactly. No product file was
partially changed.

### Error

```text
apply_patch verification failed: Failed to find expected lines in test/model-proxy.test.mjs
```

### Suggested Fix

Read the exact numbered source and test ranges, then apply small independent patches for the runtime
logic and each regression test. Verify `git diff` after every patch group.

### Metadata
- Reproducible: yes
- Related Files: src/network/model-fetch.ts, test/model-proxy.test.mjs
- Tags: apply-patch, test-context, model-network, loopback

### Resolution
- **Resolved**: 2026-08-04T16:17:00+08:00
- **Notes**: Confirmed the failed patch left no diff, re-read the exact ranges, and split the edit into
  source and test patches.

---

## [ERR-20260801-CMP-N-EXACT-EOF]

**Logged**: 2026-08-01T23:46:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release-validation

### Summary

The macOS `cmp -n 1024` command returned an EOF failure when the downloaded Range fixture was exactly
1024 bytes and the source artifact was longer, even though both 1024-byte prefixes had the same SHA-256.
This falsely suggested a CDN byte-range mismatch.

### Resolution

Validate Range delivery with three independent checks: HTTP 206, exact response byte count, and SHA-256
of `head -c <range-size>` from the source versus the downloaded part. Do not use `cmp -n` for this gate.

### Metadata

- Source: release_validation_failure
- Reproducible: yes
- Related Files: DESKTOP_DOWNLOADS.md
- Tags: macos, cmp, cdn, range, sha256
- Pattern-Key: release.range_prefixes_use_hash_not_cmp_n

---

## [ERR-20260731-REGEX-LITERAL-DOUBLE-ESCAPE] Proxy diagnostic test over-escaped a regex literal

**Logged**: 2026-07-31T18:35:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

A new assertion copied string-style double escaping into a JavaScript regex literal. The product
returned the intended `HTTP(S)` diagnostic, but the test looked for literal backslashes.

### Resolution

Use one escape level for parentheses in regex literals and reserve doubled backslashes for string
representations of a regular expression.

### Metadata

- Source: test_failure
- Reproducible: yes
- Related Files: test/model-proxy.test.mjs
- Tags: regex, javascript, diagnostics
- Pattern-Key: tests.regex_literals_do_not_use_string_double_escaping

---

## [ERR-20260801-ZSH-MIXED-QUOTE-RG]

**Logged**: 2026-08-01T23:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

A read-only `rg` command embedded a character class containing backticks, single quotes, and double
quotes inside one zsh double-quoted command string. zsh rejected the command before `rg` ran.

### Error

```text
zsh:1: unmatched "
```

### Resolution

Avoid mixed shell quoting for source discovery. Use a simpler literal search first, or split extraction
and normalization into separate commands whose patterns do not cross shell quote boundaries.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: src/tools
- Tags: zsh, quoting, ripgrep, diagnostics
- Pattern-Key: tooling.zsh_search_patterns_avoid_mixed_quote_classes

---

## [ERR-20260731-INTEL-AUTOMATION-PREVIEW-BUDGET] Intel CI treated a valid deferred preview as a failure

**Logged**: 2026-07-31T18:27:59+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

The release-class Intel Mac runner failed twice because the Serve end-to-end test required at least
one cron preview inside a shared 40 ms renderer budget. Under runner contention the production code
correctly returned an empty preview with `nextRunDeferred: true`, but the test rejected that documented
deferred state.

### Error

```text
not ok - serve e2e: auth gate → create → send streams text events and returns the reply
AssertionError: validation returns the bounded preview that fits its latency budget
```

### Context

- Windows, Linux, Apple Silicon, Node 22, and Node 24 lanes passed.
- A failed-only rerun reproduced the same assertion on Intel.
- `nextRun` already has deterministic deadline coverage; an exhausted renderer budget is allowed to
  return no preview rather than monopolize Serve's event loop.

### Suggested Fix

Assert the response contract instead of host scheduling luck: accept zero to three finite preview
timestamps, require `nextRunDeferred: true` whenever fewer than three are returned, and retain the
separate deterministic exhausted-deadline test.

### Resolution

The Serve assertion now accepts the documented deferred-empty response and still requires the
deferred marker whenever the shared renderer budget cannot produce all three previews.

### Metadata

- Reproducible: environment-dependent
- Related Files: test/serve-e2e.test.mjs, test/cron.test.mjs, src/serve/server.ts
- Tags: intel, ci, automation, deadline, deferred-preview
- See Also: ERR-20260726-INTEL-SESSION-PROFILE-TEST-TIMEOUT
- Pattern-Key: tests.renderer_deadline_contract_must_allow_deferred_empty_results

---

## [ERR-20260731-INTEL-CRON-WALL-CLOCK-FIXTURE] Cron recovery tests depended on a contended runner's short wall-clock schedule

**Logged**: 2026-07-31T18:45:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

After the renderer assertion was corrected, the release-class Intel runner exposed two more
host-scheduling assumptions: a helper Node process had to start and exit inside a 10-second test
budget, and a job-timeout test also imposed an unrelated 2-second whole-tick watchdog.

### Resolution

Replace the helper process with a same-process, token-checked transient lock that is released
deterministically. Let the terminal-state retry retain its production 35-second bound, give that test
a 45-second outer timeout, and use a 30-second tick watchdog in the separate 100-millisecond
job-timeout test. The focused tests and the full 1,252-test local suite then passed.

### Metadata

- Source: ci_failure
- Reproducible: environment-dependent
- Related Files: test/cron-v2.test.mjs
- Tags: intel, ci, cron, lock, watchdog, timing
- Pattern-Key: tests.isolate_the_deadline_under_test_from_host_scheduler_contention

---

## [ERR-20260731-NPM-PACK-HOME-CACHE] Package dry-run inherited an unwritable global npm cache

**Logged**: 2026-07-31T18:10:00+08:00
**Priority**: low
**Status**: resolved by isolated cache
**Area**: release-validation

### Summary

`npm pack --dry-run` completed its build but failed while opening a temporary file under the user's
global npm cache, which contains historical root-owned entries.

### Resolution

Do not change ownership of the user's global cache during a release. Set `npm_config_cache` to a
dedicated temporary directory for package dry-runs; the same 0.137.0 package then packed successfully.

### Metadata

- Source: tool_failure
- Reproducible: yes
- Related Files: package.json, package-lock.json
- Tags: npm, cache, permissions, release
- Pattern-Key: release.npm_pack_use_isolated_cache_when_home_cache_is_unwritable

---

## [ERR-20260726-PUBLIC-SMOKE-MISSING-WS] Public asset verification imported an uninstalled test dependency

**Logged**: 2026-07-26T19:28:00+08:00
**Priority**: high
**Status**: resolved
**Area**: release-validation

### Summary

The new native Serve smoke correctly caught the released Bun session path, but it imported the `ws`
package. Binary build jobs had already run `npm ci`, while the final public Darwin verification jobs
intentionally checked out source and downloaded the immutable assets without installing dependencies.
Both public Mac verification jobs therefore stopped with `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`;
the already-published binary bytes were valid, but the container job was skipped.

### Resolution

Use Node 22's built-in WebSocket client and EventTarget API so the final verification remains
self-contained. Add a policy assertion forbidding an import from `ws` in the standalone Serve smoke.
Publish a new immutable patch tag instead of moving or replacing the 0.135.1 tag or release.

### Metadata

- Source: release_failure
- Reproducible: yes
- Related Files: scripts/standalone-serve-smoke.mjs, test/standalone-build-policy.test.mjs
- Tags: github-actions, release, public-verification, websocket, dependencies
- Pattern-Key: release.final_asset_smokes_must_be_self_contained
- Recurrence-Count: 1

---

## [ERR-20260731-DESK-TEST-SANDBOX-LOOPBACK] Desk integration tests were first run without loopback access

**Logged**: 2026-07-31T15:20:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The first focused Serve and hara-desk test runs were executed in the filesystem sandbox. Their local
HTTP fixtures, PostgreSQL test connection, and loopback listeners failed with `EPERM`, even though the
pure Desk profile tests and TypeScript builds were valid.

### Resolution

Keep pure profile/decoder tests isolated in a temporary Desk home and run them in the sandbox. Run
integration suites that explicitly bind `127.0.0.1` or connect to the local test database with the
approved loopback-capable test permission. Both full CLI and hara-desk suites then passed.

### Metadata

- Source: tool_failure
- Reproducible: yes
- Related Files: test/desk-profile.test.mjs, test/serve-e2e.test.mjs, hara-desk/test
- Tags: sandbox, loopback, postgres, tests
- Pattern-Key: tests.local_network_fixtures_require_loopback_permission
- Recurrence-Count: 1

---

## [ERR-20260731-ZSH-UNMATCHED-TEST-GLOB] A scoped search used an unmatched zsh glob

**Logged**: 2026-07-31T15:20:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

A repository search passed `test/*organization*` directly to zsh. With no matching path, zsh rejected
the command before `rg` ran.

### Resolution

Use `rg --glob '*organization*'` or search the directory and filter inside `rg`; do not rely on shell
glob expansion for optional matches.

### Metadata

- Source: tool_failure
- Reproducible: yes
- Related Files: test
- Tags: zsh, rg, glob, search
- Pattern-Key: tooling.optional_patterns_belong_in_rg_glob
- Recurrence-Count: 1

---

## [ERR-20260731-MODEL-PROXY-FOCUSED-TEST] Proxy regression test mixed sandbox limits with two compatibility regressions

**Logged**: 2026-07-31T10:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

The first model-proxy focused run was executed in a filesystem sandbox that rejects loopback listeners,
and it also exposed two real compatibility regressions: `ProviderTarget` returned an enumerable
`proxy: undefined`, while direct embedding requests bypassed the suite's injected global `fetch`.

### Error

```text
listen EPERM: operation not permitted 127.0.0.1
Expected values to be strictly deep-equal: + proxy: undefined
model network request failed (ENOTFOUND)
```

### Context

- Local HTTP/CONNECT fixtures require an escalated loopback-capable test run in this environment.
- Existing target resolvers intentionally omit absent optional properties because callers compare exact
  serialized shapes.
- Existing embedding tests inject `globalThis.fetch`; a proxy adapter should use it for direct requests
  and use Undici only when a per-request dispatcher is required.

### Suggested Fix

Omit `proxy` when unset, delegate direct traffic to `globalThis.fetch`, retain Undici only for selected
proxy routes, then rerun focused and full suites with the approved Node runtime and loopback permission.

### Metadata
- Reproducible: yes
- Related Files: src/network/model-fetch.ts, src/providers/target.ts, test/model-proxy.test.mjs
- Tags: proxy, tests, sandbox, compatibility, fetch-injection

### Resolution
- **Resolved**: 2026-07-31T10:15:00+08:00
- **Notes**: Absent proxy fields are omitted, direct requests retain the injectable global fetch, proxy
  requests use a scoped Undici dispatcher, and the focused suite passed 53/53 before the full suite passed
  1,234 tests with one intentional skip.

---

## [ERR-20260727-OSASCRIPT-PERMISSION-PROBE] System Events probe was not a reliable capability check

**Logged**: 2026-07-27T03:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: architecture

### Summary

Read-only `osascript` probes for the frontmost application's accessibility tree failed in the
current restricted process with `-10827` / `Application can't be found`. The result does not
distinguish a missing app, an Automation denial, Accessibility denial, or execution-environment
restriction, so it must not be exposed as a user-facing capability state.

### Resolution

Do not build Calendar or semantic computer-use status on AppleScript probes. Query EventKit,
AXUIElement, and ScreenCaptureKit from the signed Desktop native boundary, return the framework's
typed authorization/error state, and validate it in an installed signed app. AppleScript remains a
diagnostic or application-specific fallback only.

### Metadata
- Source: tool_failure
- Related Files: src/tools/computer.ts, docs/local-agent-capabilities.md
- Tags: macos, accessibility, applescript, permissions, native-bridge
- Pattern-Key: macos.use_native_framework_authorization_state
- Recurrence-Count: 1

---

## [ERR-20260726-BUN-DIR-CLOSE-VOID] Released Bun sidecar could not initialize the session index

**Logged**: 2026-07-26T19:10:00+08:00
**Priority**: critical
**Status**: resolved
**Area**: runtime

### Summary

CLI 0.135.0 used `await dir.close().catch(...)` after asynchronous directory iteration in the legacy
session-index migration. Node 22 returns a Promise from `fs.Dir.close()`, but Bun 1.3.9 closes
synchronously and returns `undefined`. The released standalone therefore crashed with
`undefined is not an object (evaluating 'dir.close().catch')`. Desktop 0.1.39 encountered the same
failure during its initial `session.list`, so “Start conversation” and project opening could not connect.

### Resolution

Wrap `await dir.close()` in `try/catch` at both migration close sites so both Promise- and void-returning
runtime contracts are safe. Extend the native standalone Serve smoke to call `session.list`, run it across
all native CI/release targets, and extend Desktop's final sidecar/package smoke to execute `hara sessions`
under an isolated HOME.

### Metadata

- Source: released_regression
- Reproducible: yes
- Introduced: 0.134.7
- Affected: CLI 0.135.0, Desktop 0.1.39
- Related Files: src/session/store.ts, scripts/standalone-serve-smoke.mjs, .github/workflows/ci.yml, .github/workflows/release.yml
- Tags: bun, standalone, fs-dir, desktop, session-index, release-gate
- Pattern-Key: runtime.never_chain_promise_methods_on_cross_runtime_close
- Recurrence-Count: 1

---

## [ERR-20260726-INTEL-SESSION-PROFILE-TEST-TIMEOUT] Intel CI exhausted an undersized integration-test budget

**Logged**: 2026-07-26T16:12:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

The `real headless resume keeps its saved organization profile after the active profile changes`
integration test launched seven complete CLI processes but allowed only 20 seconds. Under the parallel
Intel CI load, all assertions passed and the test was then canceled exactly at its deadline.

### Resolution

Raised only this bounded integration test's timeout to 60 seconds and documented why it is materially
heavier than an ordinary unit test. The full local suite then completed with 1,229 passes, zero failures
or cancellations, and one intentional skip. The immutable `v0.135.0` release workflow independently
passed the same Intel suite.

### Metadata

- Reproducible: environment-dependent
- Related Files: test/session-profile-cli.test.mjs
- Tags: intel, ci, integration-test, timeout
- Pattern-Key: tests.full_process_integration_requires_runner_budget
- Recurrence-Count: 1

---

## [ERR-20260726-PREPUSH-REVIEW-NO-RESPONSE] External Codex review did not return within 15 minutes

**Logged**: 2026-07-26T14:55:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release-validation

### Summary

`git prepush-check` correctly selected `codex review --base origin/main` for the new `0.135.0` commit,
but the external review process remained asleep with no output for more than 15 minutes. It was stopped
without writing a cache marker for the new HEAD.

### Context

- The exact committed diff had already passed the full 1,230-test suite, production dependency audit,
  package manifest check, standalone build/smoke, diff check, and explicit credential scan.
- The global `pre-push` hook is intentionally a no-op; `git prepush-check` is a separate advisory review.
- The previous cache still points to an older commit, so this timeout cannot be mistaken for a completed review.

### Suggested Fix

Add a bounded timeout and a distinct `REVIEW_UNAVAILABLE` result to the shared review hook. Never cache an
empty or timed-out review as successful; retry the external review independently when the service recovers.

### Metadata

- Reproducible: unknown
- Related Files: /Users/zhujianbo/.githooks/codex_prepush_check.sh
- Tags: codex-review, timeout, release-gate
- See Also: ERR-20260724-PREPUSH-CACHED-FAILED-EXTERNAL-REVIEW

---

## [ERR-20260726-HEAD-ARCHIVE-WRONG-CWD] Ran git archive outside the repository

**Logged**: 2026-07-26T14:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

A clean-review setup invoked `git archive HEAD` with `/tmp` as the command working directory, so Git could
not find the repository and the chained npm command then ran without a package directory.

### Resolution

Run `git archive` from the repository, create the temporary checkout there, and explicitly `cd` into the
result before invoking build or test commands.

### Metadata

- Reproducible: yes
- Related Files: .git
- Tags: git, review, temporary-checkout, cwd
- Pattern-Key: tooling.git_archive_requires_repository_cwd
- Recurrence-Count: 1

---

## [ERR-20260726-FEISHU-HELPER-PULL-SUBCOMMAND] Assumed a nonexistent pull subcommand

**Logged**: 2026-07-26T11:27:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

The Feishu helper was invoked with `pull`, but its history command is
`messages`. Check the helper's command list or use `messages --help` before
constructing a refresh call.

### Resolution

Used `messages --chat <chat-id> --days 1 --limit 10 --latest` and confirmed the
original-thread reply and group release notice are visible.

### Metadata

- Reproducible: yes
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py
- Tags: feishu, cli, command-discovery
- Pattern-Key: feishu.helper_history_command_is_messages
- Recurrence-Count: 1

---

## [ERR-20260726-INTEL-CRON-LOCK-TEST-TIMEOUT] Intel release retry test exceeded its local deadline

**Logged**: 2026-07-26T10:40:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

The tagged 0.134.9 Intel Mac release lane timed out after 10 seconds in
`manual run retries a transient terminal-state store lock instead of leaving
running behind`. The following cron assertion then missed its second job.

### Context

- The same commit's release-class Intel CI full suite had just passed.
- Linux, Apple Silicon, Windows, Node 22/24, Docker, and local full tests passed.
- The failure occurred before Intel binary build; no GitHub Release or container was published.

### Suggested Fix

Rerun the failed idempotent release job once. If it recurs, harden the fixture
readiness/deadline instead of weakening terminal-state persistence semantics.

### Resolution

The failed Intel job was rerun once and the full test suite, signed Intel
binary build, public release verification, and final multi-architecture image
publication all passed. Treat the original result as a transient runner timing
failure; harden the fixture only if the same pattern recurs.

### Recurrence

- **Seen again**: 2026-07-31T02:32:46+08:00
- **Context**: The exact same `cron-v2` fixture exceeded its 10-second test deadline in the
  `v0.135.4` Apple Silicon release lane. Linux, Intel Darwin, both main CI Node lanes, Windows, local
  focused/full suites, and the new proxy transport checks passed.
- **Action**: Rerun the failed idempotent tag workflow once. Because this is now the second
  architecture-independent occurrence, harden the fixture's readiness/deadline in the next patch even
  if the rerun succeeds; do not relax the production lock semantics.

### Metadata

- Reproducible: unknown
- Related Files: test/cron-v2.test.mjs
- Tags: release, intel-mac, cron, timing
- Pattern-Key: release.retry_intel_cron_lock_fixture_timeout
- Recurrence-Count: 2

---

## [ERR-20260725-DIRECTORY-CTIME-IS-NOT-ENTRY-CHANGE] Session marker treated directory ctime as an entry-change signal

**Logged**: 2026-07-25T06:05:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend

### Summary

The mixed-version session audit compared both directory mtime and ctime. On macOS/APFS, metadata changes to
a child file advanced the directory ctime without adding, removing, or renaming a directory entry, so an
unchanged fresh process repeated the complete compatibility audit.

### Resolution

Use directory mtime as the entry-set/rename change signal and retain ctime only in the diagnostic marker.
Keep the daily audit as a backstop for filesystems with coarse directory timestamps.

### Metadata
- Source: test_failure
- Related Files: src/session/store.ts, test/session.test.mjs
- Tags: macos, apfs, ctime, migration, performance
- Pattern-Key: filesystem.directory_entry_changes_use_mtime
- Recurrence-Count: 1

---

## [ERR-20260725-FEISHU-SEND-DNS] Feishu send hit a transient DNS failure after a successful read

**Logged**: 2026-07-25T05:45:00+08:00
**Priority**: low
**Status**: pending
**Area**: tooling

### Summary

The canonical feedback chat was fetched successfully, but the immediately following `feishu_chat.py send`
failed before HTTP connection setup because the Feishu host could not be resolved.

### Error

```
Feishu network error: nodename nor servname provided, or not known
```

### Suggested Action

Retry the idempotent text send after a short delay, then record only the confirmed message ID. For future
automation, consider bounded DNS/network retries around sends while keeping message deduplication explicit.

### Metadata
- Source: external_api_failure
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py
- Tags: feishu, dns, transient, reporting
- Pattern-Key: integrations.retry_transient_dns_before_reporting_failure
- Recurrence-Count: 2
- Last-Seen: 2026-07-25

---

## [ERR-20260725-FULL-TEST-LOOPBACK-SANDBOX] Full suite needs loopback-listen permission

**Logged**: 2026-07-25T05:35:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

Running `npm test` inside the workspace sandbox produced dozens of `listen EPERM 127.0.0.1` failures in
HTTP, WebSocket, Serve, and gateway tests. One process-cancellation assertion also observed the sandbox
launcher exit instead of Hara's cancellation message.

### Resolution

Rerun the unchanged full suite with the repository-approved `npm test` escalation. The authoritative run
completed again on 2026-07-27 with 1230 passed, 0 failed, and 1 skipped. Treat the restricted run's
loopback `EPERM` and sandbox-launcher exit code as environment failures, not product regressions.
The same restricted-run signature recurred on 2026-08-05: loopback-backed tests returned `EPERM` and
one cancellation test observed sandbox exit code 71. The unchanged suite was queued for the approved
outside-sandbox verification path. That authoritative rerun completed with 1,257 passed, 0 failed,
and 1 skipped.

### Follow-up 2026-08-06T13:55:00+08:00

The 0.141.0 release preflight again ran once in the restricted sandbox: the cancellation fixture
returned exit code 71 and loopback-backed tests returned `listen EPERM`. The unchanged commit was
immediately rerun with the pinned Node 22 toolchain through the approved loopback-capable boundary;
only that outside-sandbox result is authoritative. The final clean rerun passed all 1,279 tests with
zero failures.

### Follow-up 2026-08-07T17:00:00+08:00

The 0.142.1 release preflight reproduced the same managed-sandbox signature: loopback-backed tests
returned `listen EPERM`, and the nested Seatbelt cancellation fixture returned exit code 71. The exact
unchanged `npm test` command must be rerun through the approved loopback-capable boundary before tagging.

### Follow-up 2026-08-21

The 0.148.4 optimization gate again produced the established restricted-run signature: 94 loopback
listeners returned `EPERM`, and the cancellation fixture observed sandbox exit code 71. Focused checks and
the unchanged full suite were immediately rerun with Node 22.23.1 at the approved host boundary; all 1,397
tests passed with zero failures and zero skips. Do not report this exact paired signature as a Hara bug.

### Follow-up 2026-08-29

The current release preflight reproduced the identical restricted-run signature: loopback fixtures were
denied with `listen EPERM`, the cancellation fixture received sandbox exit code 71, and the browser PDF
fixture could not launch. Rerun the unchanged suite through the approved host boundary before judging code.

### Metadata
- Source: test_environment_failure
- Related Files: test/web.test.mjs, test/wecom-gateway.test.mjs, test/serve-e2e.test.mjs
- Tags: tests, sandbox, loopback
- Pattern-Key: tests.full_suite_requires_loopback_permission
- Recurrence-Count: 11
- Last-Seen: 2026-09-01

---

## [ERR-20260806-EXTERNAL-AGENT-PROBE-TIMEOUT] Full-suite load exhausted a tight external-agent probe margin

**Logged**: 2026-08-06T14:02:00+08:00
**Priority**: low
**Status**: resolved by focused and full rerun
**Area**: tests

### Summary

One approved Node 22 full-suite run passed 1,278 tests but the external-agent reinstall probe reached
its five-second deadline at 5,032 ms. The same file passed 11/11 in isolation, then the unchanged full
suite passed 1,279/1,279 without concurrent build load.

### Suggested Action

Keep the release blocked until a complete rerun is green, as done here. Separately review whether the
fixture should avoid stacking multiple process-tree cleanup waits against the production availability
timeout so ordinary host load cannot consume the entire assertion margin.

### Metadata

- Source: test_failure
- Reproducible: intermittent under host load
- Related Files: test/external-agent.test.mjs, src/tools/external_agent.ts
- Tags: external-agent, timeout, process-tree, test-flake, release
- Pattern-Key: tests.external_agent_probe_fixture_needs_timeout_margin
- Recurrence-Count: 1

---

## [ERR-20260725-SESSION-ROUTE-CANONICAL-PATH] Reproduction hashed a non-canonical macOS temp path

**Logged**: 2026-07-25T05:35:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

A session-index reproduction looked for a source/cwd route using the lexical `/var/...` temp path, while
production canonicalized that macOS alias to `/private/var/...` before hashing, causing an `ENOENT`.

### Error

```
ENOENT: no such file or directory, scandir '.../source-cwd-interactive-87c0...'
```

### Resolution

Hash `realpathSync(project)` (the same canonical path production stores) when constructing white-box route
fixtures on macOS.

### Metadata
- Source: tool_failure
- Related Files: src/session/store.ts
- Tags: tests, macos, realpath, session-index
- Pattern-Key: tests.hash_canonical_paths_for_route_fixtures
- Recurrence-Count: 1

---

## [ERR-20260725-TOOL-REGISTRY-SIDE-EFFECT] Isolated tool test omitted its registration import

**Logged**: 2026-07-25T05:20:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

An isolated `session_search` first-use fixture imported only the generic registry, so `getTool()` returned
undefined even though the production startup imports the tool modules that register themselves.

### Resolution

Import the tested tool module explicitly before querying the registry in standalone child-process fixtures.
Treat a registry lookup in isolation as a side-effect dependency and assert the tool exists before invoking it.

### Metadata
- Source: tool_failure
- Related Files: test/session-search.test.mjs
- Tags: tests, registry, side-effects, child-process
- Pattern-Key: tests.import_tool_registration_before_registry_lookup
- Recurrence-Count: 1

---

## [ERR-20260725-SESSION-SHARD-SENTINEL] Page cleanup skipped the reserved continuation shard

**Logged**: 2026-07-25T04:50:00+08:00
**Priority**: low
**Status**: resolved
**Area**: backend

### Summary

The first stateful shard-iterator refactor advanced past its reserved 257th continuation shard after the
256-shard request budget had already advanced the cursor to that sentinel. The existing empty-shard
regression correctly observed `hasMore: false`.

### Resolution

Advance exhausted shards only inside the traversal loop. Its final state already points at either a
partially read shard or the one extra unvisited continuation shard, so no post-loop advance is needed.

### Metadata
- Source: focused_test_failure
- Related Files: src/session/store.ts, test/session.test.mjs
- Tags: sessions, pagination, cursor, regression
- Pattern-Key: pagination.preserve_reserved_continuation_sentinel
- Recurrence-Count: 1

---

## [ERR-20260725-FEISHU-REVIEW-REPORT-DNS] Feishu bug report send failed on DNS resolution

**Logged**: 2026-07-25T04:02:17+08:00
**Priority**: medium
**Status**: resolved
**Area**: infra

### Summary

The required Hara review report could not be sent to the canonical Feishu group because the Open
Platform request failed before connection with a hostname resolution error.

### Error

`Feishu network error: <urlopen error [Errno 8] nodename nor servname provided, or not known>`

### Context

- Operation: `feishu_chat.py send` to the configured Hara feedback group
- The same credential/configuration passed `doctor`, and reading recent group messages succeeded earlier
  in this review.
- The prepared redacted report remains at `/tmp/hara-review-report.txt` for an explicit later retry.

### Suggested Fix

Retry after DNS/network connectivity is restored; do not regenerate or expose Feishu credentials.

### Resolution

A single retry succeeded without changing credentials or report content; Feishu returned message ID
`om_x100b69080014b0a0c3227140f55480e`.

### Metadata
- Reproducible: unknown
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py
- Tags: feishu, dns, reporting

---

## [ERR-20260725-CODEX-REVIEW-BASE-PROMPT-CONFLICT] Codex review rejected a prompt with --base

**Logged**: 2026-07-25T03:42:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

The CLI help renders an optional review prompt beside `--base`, but this installed Codex version rejects
using both in one invocation.

### Resolution

Run the branch-diff review with `--base origin/main` and no positional prompt; use repository AGENTS.md and
the ordinary review rubric for scope.

### Metadata
- Source: tool_failure
- Related Files: .learnings/ERRORS.md
- Tags: codex, review, cli
- Pattern-Key: tooling.codex_review_base_excludes_prompt
- Recurrence-Count: 1

---

## [ERR-20260725-SOURCE-AWARE-LATEST-CALLER-SEMANTICS] One source-aware latest helper changed a transfer guard

**Logged**: 2026-07-25T03:35:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend

### Summary

Changing `latestForCwd` to select only interactive sessions correctly protected implicit `--continue`, but
workspace-transfer detection had a different contract: any newer automated activity must suppress its
“carry the session” prompt. Reusing the narrowed helper made that guard incorrectly resurrect an older manual
session. A separate spawned legacy-recall test also showed that explicit manual resume must finish the
compatibility index sweep before automatic transcript recall runs.

### Resolution

Keep `latestForCwd` interactive-only for implicit human resume, add the explicitly named `latestAnyForCwd`
for activity-sensitive transfer detection, and run the yielding legacy index sweep for manual
`--resume`/`--continue` launches while excluding cron and gateway subprocesses.

### Metadata
- Source: full_test_failure
- Related Files: src/session/store.ts, src/session/transfer.ts, src/index.ts
- Tags: sessions, source-boundary, migration, recall, regression
- Pattern-Key: sessions.name_latest_helpers_by_source_contract
- Recurrence-Count: 1

---

## [ERR-20260725-CODEX-PATH-RUNTIME-MISMATCH] Review PATH selected Node 22.23 but omitted the Codex binary

**Logged**: 2026-07-25T04:05:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

The release review command explicitly selected the repository Node 22.23 runtime but replaced `PATH`
without carrying forward the installed Codex location under the neighboring Node 22.22.3 NVM bin.
The shell therefore returned `codex: command not found` before review started.

### Resolution

Invoke Codex by its discovered absolute path while keeping Node 22.23 first in `PATH`. For repository
Node commands continue using the approved 22.23 runtime; do not assume adjacent NVM installations expose
the same global CLI set.

### Metadata
- Source: tool_failure
- Related Files: .learnings/ERRORS.md
- Tags: codex, nvm, path, release-review
- Pattern-Key: tooling.discover_global_cli_before_replacing_path
- Recurrence-Count: 2
- Last-Seen: 2026-07-25

---

## [ERR-20260725-OBSERVER-EXIT-RACE] Reproduction attached an exit waiter after the child had exited

**Logged**: 2026-07-25T03:15:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

A one-off cron shutdown reproduction awaited `once(observer, "exit")` only after the main run had
settled. The observer had already exited, so Node reported an unsettled top-level await and exited 13.

### Resolution

Capture the observer's exit promise immediately after `spawn`, before awaiting unrelated work. The
corrected reproduction confirmed the persisted state was still `running` after 2.5 seconds.

### Metadata
- Reproducible: yes
- Related Files: src/serve/server.ts, src/cron/runner.ts
- Tags: tests, child-process, event-ordering

---

## [ERR-20260725-RANDOMUUID-PARAM-INFERENCE] Optional UUID parameter inferred too narrowly

**Logged**: 2026-07-25T02:18:00+08:00
**Priority**: low
**Status**: resolved
**Area**: backend

### Summary

A helper defaulting an unannotated parameter to `randomUUID()` inferred Node's UUID template-literal type,
then rejected a persisted session ID carried as an ordinary `string`.

### Resolution

Annotate public/defaulted UUID parameters as `string` when callers pass validated persisted identifiers;
the runtime value remains a UUID while the API does not inherit an accidental template-literal restriction.

### Metadata
- Source: tool_failure
- Related Files: src/cron/runner.ts
- Tags: typescript, node-types, randomUUID, inference
- Pattern-Key: typescript.annotate_default_uuid_public_parameters
- Recurrence-Count: 1

---

## [ERR-20260724-FEISHU-REVIEW-REPORT-DNS] Feishu bug report hit a transient DNS failure

**Logged**: 2026-07-24T22:12:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: integration

### Summary

The required read-only feedback pull succeeded earlier, but sending the final 0.134.7 code-review
findings to `hara 反馈群` failed before any message was created with
`urlopen error [Errno 8] nodename nor servname provided, or not known`.

### Suggested Fix

Retry the canonical `feishu_chat.py send` command once DNS/network access is available, then retain the
returned message ID as confirmation. Do not assume the report was delivered.

### Resolution

A retry two seconds later succeeded and returned message ID
`om_x100b690cd40ccca0c493582fe68e1ac`. The 2026-07-25 recurrences also succeeded on one bounded
two-second retry and returned `om_x100b690dae0cc4a4de7145ccf000753` and
`om_x100b690f344b64a4deb59c5771ec98e`; the latest retry returned
`om_x100b69084ce34ca0c45b7faeb93410a`.

### Metadata
- Reproducible: unknown
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py
- Tags: feishu, dns, bug-report, code-review
- Recurrence-Count: 5
- Last-Seen: 2026-07-25

---

## [ERR-20260725-CRON-TERMINAL-RETRY-FIXTURE] Terminal retry fixture never reached its store-lock race

**Logged**: 2026-07-25T00:38:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The first terminal-state retry regression returned before reaching its intended store-lock race: first
because the command job used the temporary HOME itself as `cwd`, then because the managed test sandbox
rejected a nested macOS `sandbox-exec` with exit 71.

### Resolution

Create a real project child under the isolated HOME and use the established test-only
`HARA_ALLOW_SENSITIVE_FILES=1` waiver for the harmless sleep command. Protected-path behavior remains
covered separately, while this fixture now exercises only the terminal persistence path.

### Metadata
- Source: tool_failure
- Related Files: test/cron-v2.test.mjs
- Tags: cron, tests, home-boundary
- Pattern-Key: tests.use_project_child_for_command_fixtures
- Recurrence-Count: 1

---

## [ERR-20260725-FEISHU-DNS] Feishu bug-report send failed after a successful read

**Logged**: 2026-07-25T00:25:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: infra

### Summary

The canonical Hara feedback chat was readable at task start, but the required review-finding report later
failed before reaching Feishu because DNS resolution became unavailable.

### Error

`Feishu network error: <urlopen error [Errno 8] nodename nor servname provided, or not known>`

### Context

- Operation: `feishu_chat.py send --chat oc_17590648f393135cde6a6b9cd6f1c710 --text-file ...`
- The same credential/configuration passed `doctor` and fetched the latest 200 messages earlier in the task.
- No credentials or private delivery values were placed in the command or error log.

### Suggested Fix

Retry only after connectivity/DNS is available; keep the prepared redacted report text and avoid changing
credential stores for a transport-level failure.

### Metadata
- Reproducible: unknown
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py

### Resolution

- **Resolved**: 2026-07-25T00:26:00+08:00
- **Notes**: One bounded retry succeeded and returned message ID
  `om_x100b690d50e9a534c3ae52b25f96fe2`; no credential changes were needed.

---

## [ERR-20260724-CROSS-REPO-READ-PATH] Read-only verification used the sibling repository as its working directory

**Logged**: 2026-07-24T22:25:00+08:00
**Priority**: low
**Status**: resolved
**Area**: verification

### Summary

A combined read-only check tried to inspect `src/serve/server.ts` while its working directory was
`hara-desktop`, so `sed` failed before the following Desktop diff check could run.

### Resolution

Run CLI source inspection and Desktop diff verification as separate commands with an explicit workdir
for each repository. No tracked files were changed by the failed command.

### Metadata
- Source: tool_failure
- Related Files: hara-cli/src/serve/server.ts, hara-desktop
- Tags: workdir, multi-repo, verification
- Pattern-Key: verification.split_cross_repository_checks_by_workdir
- Recurrence-Count: 2
- Last-Seen: 2026-08-26
- Recurrence-Note: A root-workspace command addressed `src/serve/server.ts` without binding the CLI child workdir; the corrected verification split CLI and Desktop reads.

---

## [ERR-20260724-APPLY-PATCH-TEMP-OUTSIDE-WORKSPACE] apply_patch rejected a writable temp path

**Logged**: 2026-07-24T22:10:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

`apply_patch` rejected `/private/tmp/hara-cli-01347-review-findings.txt` as outside the project even
though the managed filesystem profile lists `/private/tmp` as writable. No file was created.

### Resolution

Use a restricted shell heredoc for ephemeral tool input outside the repository; keep `apply_patch` for
workspace source and learning edits.

### Metadata
- Reproducible: yes
- Related Files: .learnings/ERRORS.md
- Tags: apply-patch, temp-file, managed-sandbox

---

## [ERR-20260724-REVIEW-SANDBOX-BLOCKED-LOOPBACK] Focused Serve review could not bind loopback

**Logged**: 2026-07-24T22:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: tests

### Summary

The focused review command preserved the repository's isolated-home preload, but the managed
`workspace-write` sandbox rejected every Serve test listener with `listen EPERM` on `127.0.0.1`.
The non-network cron, session-source, and external-agent tests passed; the Serve failures are an
environment restriction rather than patch evidence.

### Suggested Fix

Run the exact focused command in an environment whose policy permits local loopback listeners. Do not
drop `--import ./test/setup-isolated-home.mjs`, and do not interpret sandbox `EPERM` results as code failures.

### Metadata
- Reproducible: yes
- Related Files: test/serve-e2e.test.mjs, test/setup-isolated-home.mjs
- Tags: tests, sandbox, loopback, code-review
- See Also: ERR-20260724-FOCUSED-TEST-MISSED-HOME-PRELOAD
- Recurrence-Count: 3
- Last-Seen: 2026-07-25

---

## [ERR-20260725-CRON-LEGACY-TEST-IMPORT] New migration assertion omitted readFileSync import

**Logged**: 2026-07-25T00:08:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The first focused run reached the new legacy-date persistence assertion but failed because the test's
existing `node:fs` import list did not include `readFileSync`.

### Resolution

Added the missing named import and reran the focused test independently before the full gate.

### Metadata
- Source: tool_failure
- Related Files: test/cron.test.mjs
- Tags: tests, imports, migration
- Pattern-Key: tests.verify_named_imports_for_new_assertions
- Recurrence-Count: 1

---

## [ERR-20260724-DUPLICATE-RPC-PATCH-CONTEXT] Automation update patch landed in the validate case

**Logged**: 2026-07-24T21:25:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: editing

### Summary

A patch anchored only on the repeated schedule/timezone parsing block matched `automation.validate` instead
of `automation.update`, introducing references to the update-only `existing` job.

### Resolution

The TypeScript build caught the invalid scope before commit. Restored validation, moved the logic under the
explicit `case "automation.update"` block, and reran the complete suite. For repeated switch branches, anchor
patches on the case label or a unique nearby identifier and inspect both the intended and earlier matching
blocks before testing.

### Metadata
- Source: tool_failure
- Related Files: src/serve/server.ts
- Tags: apply-patch, duplicate-context, rpc
- Pattern-Key: editing.anchor_repeated_switch_blocks_by_case
- Recurrence-Count: 1

---

## [ERR-20260724-FOCUSED-TEST-MISSED-HOME-PRELOAD] Direct Serve test skipped the isolated-home preload

**Logged**: 2026-07-24T21:27:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

A focused `node --test` invocation omitted `--import ./test/setup-isolated-home.mjs`. The managed sandbox
blocked loopback listeners and a later fixture attempted to open the real `~/.hara` store before failing.

### Resolution

Reran through the repository's exact preload and approved loopback boundary; all focused and full tests
passed. Every direct Hara test invocation must preserve the `npm test` preload and timeout contract, even
when selecting only one test file.

### Metadata
- Source: tool_failure
- Related Files: package.json, test/setup-isolated-home.mjs
- Tags: tests, home-isolation, serve, loopback
- Pattern-Key: tests.preserve_repository_preload_for_focused_runs
- Recurrence-Count: 1

---

## [ERR-20260724-TEST-PATCH-REPLACED-TRACKED-FILE] A new regression patch replaced an existing test file

**Logged**: 2026-07-24T20:45:00+08:00
**Priority**: high
**Status**: resolved
**Area**: tests

### Summary

An `Add File` patch was used for `test/external-agent.test.mjs` without first confirming whether the path
already existed in `HEAD`. It replaced the repository's full external-agent security suite with one new
test, which the subsequent diff-stat review exposed as a large deletion.

### Resolution

Restored every original test through `apply_patch`, retained only the intended hot-install regression, and
verified that the file diff is now one import addition plus one test. Before any add-file patch, check both
`rg --files` and `git ls-files`; after every edit, inspect per-file diff stats before running or staging.

### Metadata
- Source: tool_failure
- Related Files: test/external-agent.test.mjs
- Tags: apply-patch, tests, preserve-existing-work
- Pattern-Key: editing.confirm_path_absence_before_add_file
- Recurrence-Count: 1

---

## [ERR-20260724-PREPUSH-CACHED-FAILED-EXTERNAL-REVIEW] Pre-push gate cached an unusable review

**Logged**: 2026-07-24T01:40:00+08:00
**Priority**: high
**Status**: resolved
**Area**: release-validation

### Summary

The pre-push hook invoked external `codex review` inside a restricted sandbox. The review client failed
before inspecting the diff, but the hook wrote `last_head` and `last_summary.txt` before validating that
output or running its severity scan. A subsequent invocation would therefore report the commit as already
reviewed even though the cached summary only contained an initialization error.

### Resolution boundary

Never treat the presence of `last_head` alone as review evidence. Require a non-error review result and run
the severity scan before committing the cache marker. The invalid marker was moved aside, but rerunning the
external review requires the user's explicit authorization to send repository code/diff content to Codex;
do not bypass that consent boundary.

---

## [ERR-20260724-CRON-EDIT-STALE-SNAPSHOT] A due scheduler snapshot could outlive a definition edit

**Logged**: 2026-07-24T20:20:00+08:00
**Priority**: high
**Status**: resolved
**Area**: cron

### Summary

The first automation-edit implementation atomically updated the cron store and rejected edits once a job
was visibly running, but a tick could already hold an older due-job snapshot. If the edit committed before
`recordRunStart`, the tick marked the new stored definition as running and then launched the stale task
content from its snapshot. Deletion had a similar check-then-act window that could remove a newly running
owner record.

### Resolution

Persist a monotonic `definitionRevision`, increment it for every edit, and require the selected revision in
the same store transaction that records a run start. An edit that wins the race makes the old snapshot
ineligible to launch; a start that wins makes the edit return busy. Refuse removal of a running job inside
the store mutex as well as at the RPC boundary.

### Metadata
- Source: code_review
- Related Files: src/cron/store.ts, src/cron/runner.ts, src/serve/server.ts, test/cron.test.mjs
- Tags: cron, automation, race, stale-snapshot, deletion
- Pattern-Key: scheduler.fence_selected_definition_at_run_start
- Recurrence-Count: 1

---

## [ERR-20260724-CODEX-REVIEW-LEGACY-NODE] Codex review inherited the workstation's Node 11

**Logged**: 2026-07-24T20:10:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release-validation

### Summary

Running `codex review --uncommitted` from a non-interactive shell resolved the Codex launcher through
the correct NVM installation but executed it with the workstation's legacy system Node 11. The ESM
entrypoint then failed on a named import before review began.

### Resolution

Prepend the repository-approved Node 22 `bin` directory to `PATH` for Codex review commands, just as
for npm, pnpm, and other modern Node tooling. A bare global `codex` path does not prove that the
interpreter selected by its shebang is modern enough.

### Metadata
- Source: tool_failure
- Related Files: AGENTS.md
- Tags: codex, node, nvm, review, release
- Pattern-Key: toolchain.bind_codex_review_to_approved_node
- Recurrence-Count: 1

---

## [ERR-20260724-RELEASE-VERSION-CHECK-USED-NODE11] Release shell resolved legacy system Node

**Logged**: 2026-07-24T01:15:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

A read-only package-version check invoked ambient `node` and hit the workstation's Node 11, which cannot
parse optional chaining. No file or release state changed.

### Resolution

Prepend `/Users/zhujianbo/.nvm/versions/node/v22.22.3/bin` for every Node/npm release command, including
small `node -e` verification snippets. The Node 22 rerun confirmed package and lock versions are all 0.134.2.

### Follow-up

- **Seen again**: 2026-07-26T14:10:00+08:00
- **Context**: A read-only `npm view @nanhara/hara version` inherited Node 11 before the pinned PATH was applied.
- **Resolution**: The Node 22 rerun confirmed the public version was `0.134.9`; no release state changed.
- **Seen again**: 2026-07-31T01:36:00+08:00
- **Context**: The `0.135.3` public-package verification again invoked ambient `npm`, which failed while
  loading `node:path` under the workstation's Node 11.
- **Resolution**: Re-run the query with the repository-pinned Node 22.23.1 `bin` directory first on
  `PATH`; the GitHub release had already completed and no release state was changed by this failed probe.
- **Seen again**: 2026-08-05T12:22:00+08:00
- **Context**: The `0.139.1` public npm verification omitted the pinned `PATH` and failed on
  `node:path` under Node 11. The release workflow itself had already succeeded.
- **Resolution**: Re-ran the read with Node 22.23.1 first on `PATH`; npm returned `0.139.1`.
- **Seen again**: 2026-08-10T19:00:00+08:00
- **Context**: The pre-release `npm view @nanhara/hara version` probe again used ambient npm/Node and
  failed while loading `node:path`; all three Git fetches had already succeeded and no release state changed.
- **Resolution**: Re-run every remaining npm/Node release command with the exact Node 22.23.1 path and
  pinned PATH prefix, including read-only registry checks.
- **Recurrence-Count**: 5
- **Last-Seen**: 2026-08-10

---

## [ERR-20260724-NPM-DEFAULT-CACHE-AND-AUDIT-SANDBOX] Release checks need isolated cache and approved network

**Logged**: 2026-07-24T01:05:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release

### Summary

The release candidate itself built and tested successfully, but `npm pack --dry-run` could not write the
workstation's root-owned default npm cache and a concurrent audit call could not resolve the npm registry
inside the managed network sandbox.

### Error

```text
EPERM ... /Users/zhujianbo/.npm/_cacache/tmp/...
getaddrinfo ENOTFOUND registry.npmjs.org
```

### Resolution

Use `--cache /private/tmp/hara-npm-cache` for non-mutating package inspection instead of changing ownership
of the user's global cache. Treat registry audit as an explicit outbound metadata disclosure; rely on the
already completed zero-vulnerability audit while `package-lock.json` is unchanged if a redundant audit is
denied by the approval boundary. On 2026-07-26, the same sandbox DNS boundary recurred; the exact
official-registry audit was rerun with approved network access and found 0 vulnerabilities.

### Metadata

- Pattern-Key: release.npm_audit_requires_approved_network
- Recurrence-Count: 2
- Last-Seen: 2026-07-26

---

## [ERR-20260722-INK-INPUT-RESUBSCRIBE-GAP] Slow Intel runner lost a key between paint and passive-effect resubscription

**Logged**: 2026-07-22T12:10:00+08:00
**Priority**: high
**Status**: resolved
**Area**: tui

### Summary

The release-class Intel CI restored a command with Up, rendered it, then lost the immediately following Down
key. The test timed out restoring the unsent draft. Ink's `useInput` effect depends on callback identity, while
InputBox supplied a new inline callback on every render, creating a real listener teardown/resubscribe gap.

### Error

```text
InputBox: Up/Down recalls submissions and restores the unsent draft
Down past newest did not restore the draft
```

### Resolution

InputBox now supplies a React 19 Effect Event to `useInput`. Its identity remains stable so Ink retains one
stdin subscription, while the event reads the latest render state. Six concurrent focused interaction runs
passed locally; the main Intel release gate remains the authoritative verification before tagging.

### Metadata
- Reproducible: CI-only timing window
- Related Files: src/tui/InputBox.tsx, test/tui-inputbox.test.mjs

---

## [ERR-20260722-HEADLESS-PROXY-CANCEL-AND-DOM-BOUNDARY] Real Chromium cancelled tunnels and outlived complete DOM output

**Logged**: 2026-07-22T11:25:00+08:00
**Priority**: high
**Status**: resolved
**Area**: web

### Summary

The first real Chromium smoke exposed two behaviors not represented by the fake-browser unit test: Chrome
cancels speculative and subresource CONNECT tunnels, which can raise EPIPE on the peer, and its utility
processes may remain alive after `--dump-dom` has emitted a complete HTML document.

### Error

```text
Error: write EPIPE
Headless render unavailable: The isolated browser did not finish within 25 seconds.
```

### Resolution

The validating proxy now treats either tunnel endpoint closing as ordinary paired cleanup and installs error
handlers before asynchronous routing. The renderer treats a serialized closing `</html>` tag as the output
boundary, immediately terminates the isolated process tree, closes the proxy, and removes the temporary
profile. A real installed-Chrome smoke now returns rendered content without crashing or false timeout.

### Metadata
- Reproducible: yes
- Related Files: src/tools/headless-web.ts, test/web.test.mjs

---

## [ERR-20260721-NESTED-SEATBELT-TEST] Managed sandbox rejects Hara's nested sandbox-exec

**Logged**: 2026-07-21T17:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The focused `runShell` cancellation regression failed before the cancellation path because Hara correctly
wrapped even `sandbox=off` commands in its protected-file Seatbelt profile, while the outer managed Codex
sandbox prohibited applying another macOS sandbox.

### Error

```text
sandbox-exec: sandbox_apply: Operation not permitted
Error: exit code 71
```

### Resolution

Re-ran only the affected Node test outside the outer sandbox; it passed. Treat exit 71 plus the exact
`sandbox_apply` diagnostic as an execution-environment limitation, not a product cancellation regression.

---

## [ERR-20260721-RUSTUP-CARGO-RUSTC-PATH] rustup-selected Cargo still resolved an obsolete rustc

**Logged**: 2026-07-21T16:40:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tooling

### Summary

Desktop Rust tests initially failed because invoking Cargo through the Rust 1.97 toolchain did not prevent
the automation shell from resolving `/usr/local/bin/rustc` 1.84.1.

### Resolution

For Desktop gates in this environment, invoke the 1.97 Cargo binary and set both `RUSTC` and `RUSTDOC` to
the matching toolchain binaries. Pinning Cargo alone is insufficient when an older compiler precedes rustup
on `PATH`.

---

## [ERR-20260720-MANAGED-SANDBOX-LOOPBACK-LISTEN] Network-style tests cannot bind local ports

**Logged**: 2026-07-20T11:19:41+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

A focused CLI regression run compiled successfully and passed pure profile/token tests, but every test
that created a local HTTP or Serve listener failed before exercising product code because the managed
workspace sandbox denied `listen()` on both `0.0.0.0` and `127.0.0.1`.

### Error

```text
listen EPERM: operation not permitted 127.0.0.1
listen EPERM: operation not permitted 0.0.0.0
```

### Suggested Fix

Keep build and pure logic tests inside the restricted sandbox. Re-run loopback integration tests with
the narrowly scoped Node test command outside that network restriction, and classify `listen EPERM`
as an environment limitation rather than a product regression.

### Resolution

- **Resolved**: 2026-07-20T11:19:41+08:00
- **Notes**: The build and all non-listening tests in the same run passed; the integration gate is
  scheduled for a permitted loopback environment.

### Metadata

- Reproducible: yes
- Tags: tests, sandbox, loopback
- Pattern-Key: test.managed_sandbox_blocks_loopback_listen
- Recurrence-Count: 2
- First-Seen: 2026-07-20
- Last-Seen: 2026-08-06

---

## [ERR-20260720-AMBIENT-TOOL-EVENT-ASSERTION] Tool-state regression selected the first intake tool

**Logged**: 2026-07-20T00:50:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The new privacy regression selected the first `phase=tool` lifecycle event, but the understanding gate
correctly runs `task_intake` before `write_file`.

### Resolution

Assert that the complete tool-state sequence contains `write_file` and that every ambient lifecycle
detail excludes the workspace path. Do not assume a particular tool is first when the harness has a
mandatory intake phase.

---

## [ERR-20260719-PROMPT-ASSEMBLER-TEST-HOME] prompt assembler focused test touched the real private Hara home

**Logged**: 2026-07-19T23:05:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
The first focused PromptAssembler test called the real `skillsDigest`, which tightens the user's private
Hara directory and was correctly denied by the managed sandbox.

### Error
```text
EPERM: operation not permitted, chmod '/Users/zhujianbo/.hara'
```

### Suggested Fix
Tests that compose the complete runtime system prompt must isolate `HOME`, even when the assertion only
targets prompt boundaries, because skill/plugin discovery intentionally passes through private-state setup.

### Metadata
- Reproducible: yes
- Related Files: test/prompt-assembler.test.mjs, src/agent/loop.ts

### Resolution
- **Resolved**: 2026-07-19T23:05:00+08:00
- **Notes**: The test now uses a temporary HOME and restores it in `finally`.

---

## [ERR-20260718-SERVE-PHYSICAL-LEASE-TESTS] node-test

**Logged**: 2026-07-18T23:10:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
Strengthening Serve so a timed-out or interrupted physical provider retains its session lease invalidated
three tests that still expected the session to become writable at the earlier logical-return boundary.

### Error
```text
TypeError: Cannot read properties of undefined (reading 'reply')
TypeError: Cannot read properties of undefined (reading 'title')
```

### Context
- Command: Node 22 focused Serve end-to-end and shutdown-safety tests.
- The RPCs correctly returned BUSY under the new physical-serialization contract; the tests incorrectly
  dereferenced a success result before settling the deliberately non-cooperative provider.

### Suggested Fix
Model logical completion and physical settlement as separate test checkpoints. Assert BUSY between them,
settle the ignored provider Promise, then assert that the next session mutation succeeds.

### Metadata
- Reproducible: yes
- Related Files: src/serve/server.ts, test/serve-e2e.test.mjs,
  test/serve-shutdown-safety.test.mjs

### Resolution
- **Resolved**: 2026-07-18T23:13:00+08:00
- **Notes**: Updated the contract tests and added a dedicated timed-out provider lease regression; all
  27 focused Serve tests pass.

---

## [ERR-20260717-NVM-BUILD-PATH] Project build resolved npm through an obsolete system Node

**Logged**: 2026-07-17T22:39:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tooling

### Summary
An unpinned `npm run build` resolved `/usr/local` npm under an obsolete system Node instead of the project's
NVM runtime. The process failed before loading project code because that Node did not support `node:path`.

### Error
```text
Error: Cannot find module 'node:path'
```

### Suggested Fix
For Hara repository gates, prepend the selected Node 22+ NVM `bin` directory (or enter it through `nvm use`)
before invoking npm. Do not assume a non-login automation shell inherits the interactive terminal's NVM
selection.

### Metadata
- Reproducible: yes
- Recurrence-Count: 4
- First-Seen: 2026-07-17
- Last-Seen: 2026-07-22
- Related Files: package.json, AGENTS.md

### Resolution
- **Resolved**: 2026-07-17T22:39:00+08:00
- **Notes**: Re-ran the build with Node 22.22.3 and its paired npm on one explicit PATH. The same non-login
  PATH mismatch recurred through 2026-07-22; the documented pinned-runtime workaround remains correct.

---

## [ERR-20260717-MACOS-TMP-REALPATH] Session cwd tests compared a macOS temp-directory alias

**Logged**: 2026-07-17T22:41:00+08:00
**Priority**: low
**Status**: resolved
**Area**: testing

### Summary
New session relaunch tests expected the lexical `/var/folders/...` path returned by `tmpdir()`, while the
production resolver and spawned child correctly reported its canonical `/private/var/folders/...` identity.

### Suggested Fix
Compare canonical real paths when a test asserts execution-root identity. Preserve lexical paths only in
tests whose behavior explicitly concerns user-entered spelling.

### Resolution
- **Resolved**: 2026-07-17T22:41:00+08:00
- **Notes**: Both resolver and attached-child assertions now use `realpathSync.native`.

---

## [ERR-20260716-DOCKER-DAEMON] Public-image runtime probe had no local Docker daemon

**Logged**: 2026-07-16T02:28:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release

### Summary
A post-publish `docker run` probe could not start because Docker Desktop was not running locally. The release
CI had already executed its Docker runtime smoke, and the public GHCR index exposed both amd64 and arm64
manifests, so this was an unavailable local verifier rather than an image failure.

### Error
```text
Cannot connect to the Docker daemon at unix:///Users/zhujianbo/.docker/run/docker.sock
```

### Suggested Fix
Check Docker daemon availability before scheduling local runtime probes. When it is unavailable, distinguish
that condition from registry/image failure and retain CI runtime plus public manifest verification evidence.

### Resolution
- **Resolved**: 2026-07-16T02:28:00+08:00
- **Notes**: Verified the public OCI index and both target manifests; did not start Docker Desktop implicitly.

---

## [ERR-20260717-DESKTOP-BASH32-FALSE-SUCCESS] macOS Bash 3.2 reported a fatal nounset exit as success

**Logged**: 2026-07-17T01:12:19+08:00
**Priority**: critical
**Status**: resolved
**Area**: release

### Summary
The protected Desktop signer expanded an empty array inside a function under `set -u`. macOS Bash 3.2
printed `unbound variable`, but the EXIT cleanup trap received status zero, so both signed-build steps were
reported successful and the failure surfaced later only as a missing provenance marker.

### Error
```text
./scripts/build-mac-signed.sh: line 159: ORIGINAL_KEYCHAINS[@]: unbound variable
```

### Suggested Fix
Never iterate a possibly empty Bash array directly on the macOS 3.2 release host. Track its populated count
and use indexed access. Protect release scripts with an explicit completion sentinel in addition to preserving
`$?`, so every exit before the verified final point is nonzero even when Bash supplies a false zero status.

### Metadata
- Reproducible: yes on macOS Bash 3.2
- Related Files: ../hara-desktop/scripts/build-mac-signed.sh,
  ../hara-desktop/scripts/release-shell-safety.sh, ../hara-desktop/test/release-pipeline.test.mjs

### Resolution
- **Resolved**: 2026-07-17T01:10:00+08:00
- **Notes**: Replaced empty-array iteration with counted indexing, added a verified-completion sentinel and an
  executable Bash 3.2 regression that fails if an early nounset exit is ever reported as success again.

---

## [ERR-20260717-DESKTOP-DOUBLE-CODESIGN] Tauri replaced an already Developer-ID-signed sidecar

**Logged**: 2026-07-17T01:57:10+08:00
**Priority**: critical
**Status**: resolved
**Area**: release

### Summary
The Desktop release script removed Bun's ad-hoc Mach-O signature, applied a timestamped Developer ID
signature to the source sidecar, and then handed it to Tauri. Tauri always signs nested binaries while
assembling Hara.app, so it replaced the Developer ID signature a second time and codesign rejected the
result because the trusted timestamp was missing.

### Error
```text
Hara.app/Contents/MacOS/hara: A timestamp was expected but was not found.
failed to bundle project: failed codesign application
```

### Suggested Fix
Execute all source-side boundary smoke while Bun's valid ad-hoc signature remains, remove that signature,
and never execute or pre-sign the now-unsigned source binary. Let Tauri perform the sole Developer ID
signing pass on the copy inside Hara.app, then verify the nested authority, timestamp, app signature,
notarization, archive, and DMG before promotion.

### Metadata
- Reproducible: yes in protected run 29519212427
- Related Files: ../hara-desktop/scripts/build-mac-signed.sh,
  ../hara-desktop/test/release-pipeline.test.mjs
- See Also: ERR-20260717-DESKTOP-BASH32-FALSE-SUCCESS

### Resolution
- **Resolved**: 2026-07-17T01:55:00+08:00
- **Notes**: Removed the source-side Developer ID signing/execution pass and added regression assertions plus
  explicit packaged-sidecar Developer ID authority and trusted-timestamp gates.

---

## [ERR-20260717-DESKTOP-STAPLER-CLOUDKIT-TIMEOUT] Apple ticket lookup timed out after accepted notarization

**Logged**: 2026-07-17T02:28:00+08:00
**Priority**: high
**Status**: resolved
**Area**: release

### Summary
Desktop 0.1.21 completed its sole nested sidecar signature, Apple accepted Hara.app notarization, and
Tauri stapled the app. A later `stapler validate` against the app mounted from the DMG made a CloudKit
ticket-delivery request that timed out once; the updater archive's validation succeeded later in the
same job, proving that the ticket was present and the failure was transient.

### Error
```text
NSURLErrorDomain Code=-1001 "The request timed out."
CloudKit ticket-delivery records/lookup
The validate action failed
```

### Suggested Fix
Use one bounded validator for every app/archive/DMG promotion check. Retry at most three times only
when the failure explicitly identifies Apple network or CloudKit service transport; fail immediately
for a missing/invalid ticket and fail after the final transient attempt.

### Metadata
- Reproducible: transient in protected run 29522254908 attempt 1
- Related Files: ../hara-desktop/scripts/stapler-validate.mjs,
  ../hara-desktop/scripts/mac-dmg-smoke.mjs, ../hara-desktop/scripts/mac-updater-smoke.mjs,
  ../hara-desktop/scripts/release-mac-assets.sh
- See Also: ERR-20260717-DESKTOP-DOUBLE-CODESIGN

### Resolution
- **Resolved**: 2026-07-17T02:30:00+08:00
- **Notes**: Added one three-attempt, timeout-bounded validator; all smoke and promotion paths use it,
  non-transient ticket failures remain immediate, and classification/regression tests pass.

---

## [ERR-20260717-DESKTOP-SPCTL-PATH] Protected non-login shell could not resolve spctl

**Logged**: 2026-07-17T02:38:00+08:00
**Priority**: critical
**Status**: resolved
**Area**: release

### Summary
Desktop 0.1.21 attempt 2 completed app and DMG signing, Apple accepted both notarization submissions,
and stapling/validation passed. The next Gatekeeper command used bare `spctl`; GitHub Actions' non-login
shell PATH did not include `/usr/sbin`, so an otherwise verified ARM release stopped with exit 127.

### Error
```text
./scripts/build-mac-signed.sh: line 296: spctl: command not found
```

### Suggested Fix
Release scripts must not inherit interactive-shell PATH assumptions. Invoke Gatekeeper explicitly as
`/usr/sbin/spctl` in signed build, local promotion, remote-draft verification, and public verification,
and retain a regression that rejects any line beginning with a bare `spctl` command.

### Metadata
- Reproducible: yes in protected run 29522254908 attempt 2
- Related Files: ../hara-desktop/scripts/build-mac-signed.sh,
  ../hara-desktop/scripts/release-mac-assets.sh, ../hara-desktop/test/release-pipeline.test.mjs
- See Also: ERR-20260717-DESKTOP-STAPLER-CLOUDKIT-TIMEOUT

### Resolution
- **Resolved**: 2026-07-17T02:39:00+08:00
- **Notes**: All protected Gatekeeper invocations use `/usr/sbin/spctl`; regression and workflow guidance
  now make the non-login-shell boundary explicit.

---

## [ERR-20260717-GH-RUN-WATCH-TIMEOUT] GitHub run watch lost its network connection

**Logged**: 2026-07-17T01:12:19+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
`gh run watch` timed out while the remote Desktop workflow continued normally, so the local watcher result
was not reliable evidence of the workflow conclusion.

### Suggested Fix
After any watcher transport error, query the immutable run and job state again with `gh run view --json` and
inspect the failed job log by database ID. Do not infer a release failure or success from the watcher process.

### Resolution
- **Resolved**: 2026-07-17T01:02:00+08:00
- **Notes**: Re-read run 29516580474 and the protected signing job through the Actions API, then diagnosed the
  exact Bash 3.2 failure from the complete job log.

---

## [ERR-20260716-GATEWAY-RECOVERY-TIMEOUT] Fault-injection timeout leaked into recovery assertion

**Logged**: 2026-07-16T02:23:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tooling

### Summary
The 0.124.0 Release workflow failed one otherwise-green full suite because a gateway test reused its
deliberately tiny 50ms fault-injection deadline for the later normal multi-chunk recovery assertion.
Runner contention delayed the recovery queue long enough to produce a false Telegram transport timeout.

### Error
```text
not ok - credential-scoped outbound lanes quarantine a timed-out transport and recover without late interleaving
Error: Telegram send timed out after 50ms
```

### Suggested Fix
Keep deliberate timeout tests short, but restore a realistic bounded deadline before asserting normal recovery.
Stress the focused test repeatedly and retain the global test timeout as the deadlock guard.

### Resolution
- **Resolved**: 2026-07-16T02:23:00+08:00
- **Notes**: Recovery now uses a 1000ms bounded budget; the focused regression passed 25/25 repetitions.

---

## [ERR-20260715-DESKTOP-GUARD-FIXTURE] Negative release test missed a new prerequisite

**Logged**: 2026-07-15T03:10:13+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
After promotion began requiring the protected signing-job marker, the wrong-workflow regression
fixture omitted that marker and failed at the earlier generic guard instead of reaching the intended
workflow-identity assertion.

### Error
```text
Expected /unexpected promotion workflow identity/ but received the protected signing-job guard error.
```

### Context
- Operation: Desktop release-pipeline regression tests after closing the Rosetta promotion gap.
- The implementation failed closed correctly; only the negative fixture's setup was stale.

### Suggested Fix
Whenever a guard gains a prerequisite, update deeper negative fixtures with all valid preceding
conditions so each test still exercises the boundary named by its assertion.

### Metadata
- Reproducible: yes
- Related Files: hara-desktop/test/release-pipeline.test.mjs, hara-desktop/scripts/release-mac-assets.sh

### Resolution
- **Resolved**: 2026-07-15T03:10:13+08:00
- **Notes**: Added the matching protected-job marker to the wrong-workflow fixture; all 18 tests pass.

---

## [ERR-20260715-COMPOSITE-RELEASE-GATE] Later command masked an npm audit failure

**Logged**: 2026-07-15T19:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: release

### Summary
An initial release-gate shell invocation ran `npm audit` followed by `npm pack`; the shell continued after the audit network failure, so the later successful pack made the overall command exit successfully.

### Context
- Operation: Hara CLI 0.123.0 pre-tag validation.
- The audit result could not be inferred from the composite command's final exit code.
- Recurrence during 0.124.1 validation: a stale 0.123.1 native binary failed the version smoke, but later
  read-only diff commands still ran because the composite command again omitted `set -e`.

### Suggested Fix
Run independent release gates as separate commands, or begin composite invocations with `set -e` and inspect each result explicitly.

### Resolution
- **Resolved**: 2026-07-15T19:00:00+08:00
- **Recurrence-Count**: 3
- **Last-Seen**: 2026-08-07T17:20:00+08:00
- **Notes**: Rebuilt the native 0.124.1 binary, then ran its version probe and hostile-cwd/doctor smoke as
  independent fail-fast gates. Future composite release commands must start with `set -euo pipefail`.
  During 0.142.1 preflight, an initial `codesign --verify` failure was likewise masked by later successful
  standalone smokes; the corrected gate reapplied the CI ad-hoc signature and reran every check fail-fast.

---

## [ERR-20260715-RELEASE-PATH] Bare shell selected an obsolete system Node/npm

**Logged**: 2026-07-15T19:01:00+08:00
**Priority**: high
**Status**: resolved
**Area**: release

### Summary
A retry omitted the repository's pinned toolchain PATH and selected an obsolete system npm/Node, which failed while importing `node:path`.

### Error
```text
Cannot find module 'node:path'
```

### Suggested Fix
Prepend the Node 22 nvm, Cargo, and Bun directories on every independent release command, then run `rehash` and verify both `command -v node` and `command -v npm` before the gate. Do not rely on shell initialization or an existing zsh command hash.

### Metadata
- Reproducible: yes
- Recurrence-Count: 7
- Last-Seen: 2026-07-26T00:00:00+08:00
- See Also: ERR-20260715-NPM-PATH, ERR-20260715-LOGIN-PATH

### Resolution
- **Resolved**: 2026-07-15T19:01:00+08:00
- **Notes**: Re-ran with Node 22.23.1 and npm 10.9.8; the Desktop release preflight again proved that even
  read-only probes must set the pinned PATH before invoking Node/npm. Require an explicit Node 22 PATH, zsh
  `rehash`, and executable-version verification before every Node-based command. A later read-only
  `npm view @wecom/aibot-node-sdk` probe repeated the same failure when it omitted that prefix. On
  2026-07-26, an over-narrow Node-only PATH omitted `~/.bun/bin` from `npm run build:binary`; the retry
  used the complete Node-and-Bun toolchain PATH.

---

## [ERR-20260715-RELEASE-NETWORK] Registry and Docker Hub TLS failures interrupted gates

**Logged**: 2026-07-15T19:02:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release

### Summary
Transient TLS/auth timeouts prevented the first npm audit and `node:22-slim` image fetch, even though local compilation and tests were healthy.

### Suggested Fix
Treat registry availability as a distinct release dependency, retry boundedly, and require a real successful registry audit and container build before tagging.

### Metadata
- Reproducible: transient
- Recurrence-Count: 2
- Last-Seen: 2026-08-31T01:10:00+08:00
- See Also: ERR-20260716-NPM-AUDIT-QUICK-410

### Resolution
- **Resolved**: 2026-07-15T19:02:00+08:00
- **Notes**: Both networks recovered; npm reported zero vulnerabilities and the real Docker image built and returned version 0.123.0. The same official audit endpoint reset one Hara CLI 0.157.0 release-gate connection on 2026-08-31; the release remained blocked until a bounded retry returned an authoritative result.

---

## [ERR-20260715-PROCESS-READINESS] Process fixtures signaled before the observer's condition was true

**Logged**: 2026-07-15T19:35:00+08:00
**Priority**: high
**Status**: resolved
**Area**: tests

### Summary
GitHub's Node 24 matrix exposed two process-test races hidden by local timing: a child-side stdout callback did not prove the parent had consumed that output, and a parent publishing its spawned child's PID did not prove that child had initialized or retained inherited pipes.

### Error
```text
approved org subprocesses have a hard ceiling ... expected /pid:\d+/, received ''
runShell hard fallback ... expected >=1000ms, received 405ms
```

### Suggested Fix
Synchronize on the exact property under test. Separate normal-output capture from shutdown behavior; require the escaped process itself to publish a valid positive PID before asserting hard-fallback timing.

### Resolution
- **Resolved**: 2026-07-15T19:35:00+08:00
- **Notes**: Split the gateway assertions, made PID readers reject empty/zero files, made the escaped child self-publish readiness, and passed both Node 22 and Node 24 full 958-test matrices.

---

## [ERR-20260715-TUI-PAUSED-STDIN] Paste proxy tests missed the real paused-stdin hand-off

**Logged**: 2026-07-15T20:15:00+08:00
**Priority**: critical
**Status**: resolved
**Area**: runtime

### Summary
Hara 0.123.0's bracketed-paste proxy rendered the TUI but accepted no keyboard input because `readline.close()` pauses the real stdin before Ink mounts and the proxy never resumed its wrapped stream.

### Context
- Unit tests used a naturally flowing `PassThrough`, so decoder, paste framing, and InputBox tests all passed while the production stream lifecycle was absent.
- The default interactive command was unusable; `HARA_TUI=0 hara` remained a temporary fallback.

### Suggested Fix
Every stream proxy must test the producer's real precondition and mirror lifecycle methods across the boundary. For terminal input, cover an explicitly paused source plus raw-mode enable/disable, and perform a real PTY smoke before release.

### Resolution
- **Resolved**: 2026-07-15T20:15:00+08:00
- **Notes**: The proxy now resumes the source on Ink demand/raw enable and pauses it on cleanup; a paused-source regression, 68 focused tests, real PTY typing/paste, and both 959-test Node matrices pass.

---

## [ERR-20260715-PATCH-CONTEXT] Batched security patch used an incomplete test anchor

**Logged**: 2026-07-15T18:50:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
A multi-file `apply_patch` was rejected because the Guardian test anchor omitted two assertions between the matched lines.

### Error
```text
apply_patch verification failed: Failed to find expected lines in test/guardian.test.mjs
```

### Context
- Operation: add three independently reported security/path regressions and tests.
- `apply_patch` rejected the complete batch, so no partial source edits landed.

### Suggested Fix
Inspect the exact local test block first, then split broad changes into source and test patches with short, exact anchors.

### Metadata
- Reproducible: yes
- Related Files: test/guardian.test.mjs

### Resolution
- **Resolved**: 2026-07-15T18:51:00+08:00
- **Notes**: Re-read the exact block and applied smaller source/test patches successfully.

---

## [ERR-20260715-CANONICAL-TMPDIR] Literal realpath equality rejected macOS /var temp homes

**Logged**: 2026-07-15T18:58:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: security

### Summary
The first global-config hard-link guard required the lexical parent path to equal its realpath, which rejected macOS temporary homes below the stable `/var` → `/private/var` system alias.

### Error
```text
refusing global config write: '.../home/.hara' is not a canonical directory
```

### Context
- Operation: focused regression tests for global config hard-link refusal.
- The security goal is stable directory identity, not banning an unchanged ancestor alias.

### Suggested Fix
Capture the parent's canonical path and inode, then require both to remain unchanged immediately before commit.

### Metadata
- Reproducible: yes
- Related Files: src/config.ts, test/config-live.test.mjs

### Resolution
- **Resolved**: 2026-07-15T18:59:00+08:00
- **Notes**: Replaced literal equality with stable canonical-path and inode verification.

---

## [ERR-20260715-SHELL-QUOTE] Backtick in a double-quoted zsh search command broke parsing

**Logged**: 2026-07-15T19:05:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
A read-only `rg` command embedded a Markdown backtick inside a double-quoted zsh argument, causing an unmatched-quote parse failure.

### Error
```text
zsh: unmatched "
```

### Context
- Operation: inspect Home-workspace guidance before adding `--cwd`.

### Suggested Fix
Use a single-quoted regex argument and avoid shell-interpreted Markdown punctuation in command strings.

### Metadata
- Reproducible: yes
- Related Files: src/context/workspace-scope.ts

### Resolution
- **Resolved**: 2026-07-15T19:06:00+08:00
- **Notes**: Reissued the search with a single-quoted expression.

---

## [ERR-20260715-PID-FIXTURE-RACE] Cancellation fixtures read PID files before content publication

**Logged**: 2026-07-15T19:15:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
Two full-suite cancellation tests waited only for a PID file name to exist. Under contention they could read the file between creation and content write, parse the empty string as PID 0, and then probe Hara's own process group forever.

### Error
```text
computer child 0 survived cancellation
cron child 0 survived cancellation
```

### Context
- Operation: full pre-release Hara CLI matrix.
- The focused computer test passed five consecutive runs because its fixture usually completed the tiny write before the first poll.
- `process.kill(0, 0)` targets the current process group, explaining why the false "survivor" never disappeared.

### Suggested Fix
Poll until the file contains a safe positive integer PID, then retain the original strict cancellation and disappearance deadlines.

### Metadata
- Reproducible: under full-suite contention
- Related Files: test/computer.test.mjs, test/cron-v2.test.mjs

### Resolution
- **Resolved**: 2026-07-15T19:17:00+08:00
- **Notes**: Both fixtures now wait for a published positive PID; the one-second ESRCH window and 1.5-second settlement bound remain unchanged.

---

## [ERR-20260715-FEISHU-MESSAGES-COMMAND] Feishu helper no longer accepts the pull alias

**Logged**: 2026-07-15T17:35:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
The local Feishu helper rejected the remembered `pull` command; the supported read command is `messages`.

### Error
```text
argument command: invalid choice: 'pull'
```

### Context
- Operation: refresh the canonical `hara 反馈群` before Hara issue work.
- The current helper exposes `messages --chat ... --days ... --output ...`.

### Suggested Fix
Use `messages` in future intake and monitoring calls, and check subcommand help before reusing an older alias.

### Metadata
- Reproducible: yes
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py

### Resolution
- **Resolved**: 2026-07-15T17:36:00+08:00
- **Notes**: Re-ran with `messages` and pulled 41 current messages from the exact canonical chat ID.

---

## [ERR-20260715-INK-PACKAGE-EXPORT] Ink package metadata is not exported through require

**Logged**: 2026-07-15T17:37:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
Reading `ink/package.json` through Node module resolution failed because Ink's exports map does not expose package metadata.

### Error
```text
ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './package.json' is not defined by "exports"
```

### Context
- Operation: verify the installed Ink version while diagnosing TUI input parsing.

### Suggested Fix
Resolve Ink's installed directory and read package.json through the filesystem, or use the lockfile/package manifest.

### Metadata
- Reproducible: yes
- Related Files: package.json, package-lock.json

### Resolution
- **Resolved**: 2026-07-15T17:38:00+08:00
- **Notes**: Confirmed Ink 6.8 from the filesystem and inspected its input parser directly.

---

## [ERR-20260715-PASTE-OVERFLOW-ORDER] Same-chunk paste end bypassed the overflow gate

**Logged**: 2026-07-15T17:52:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
The first bracketed-paste decoder implementation checked for an end marker before validating the completed payload size, so an oversized paste contained in one chunk bypassed the bound.

### Error
```text
Expected rejection marker, received the full oversized payload.
```

### Context
- Operation: focused bracketed-paste regression suite.
- Split-chunk framing passed; start, payload, and end in one chunk exposed the ordering bug.

### Suggested Fix
Validate the content length at the completed-frame boundary as well as while buffering incomplete frames.

### Metadata
- Reproducible: yes
- Related Files: src/tui/bracketed-paste.ts, test/tui-bracketed-paste.test.mjs

### Resolution
- **Resolved**: 2026-07-15T17:53:00+08:00
- **Notes**: Added completed-frame size validation; all focused paste/input tests pass.

---

## [ERR-20260715-PASTE-ENTER-BATCH] Immediate Enter observed the pre-paste React draft

**Logged**: 2026-07-15T17:56:00+08:00
**Priority**: high
**Status**: resolved
**Area**: tests

### Summary
Even after paste framing produced separate logical events, a paste followed immediately by Enter could run inside one React batch and submit the previous empty draft.

### Error
```text
Expected "alpha\nbeta", received null.
```

### Context
- Operation: no-wait InputBox regression for paste followed by Enter.
- Render state was incorrectly serving as event-time input state.

### Suggested Fix
Keep a synchronous authoritative draft ref for input callbacks and use React state only as the render copy.

### Metadata
- Reproducible: yes
- Related Files: src/tui/InputBox.tsx, test/tui-inputbox.test.mjs

### Resolution
- **Resolved**: 2026-07-15T17:58:00+08:00
- **Notes**: Draft, attachment, and paste refs now update synchronously; the no-wait regression and all focused TUI tests pass.

---

## [ERR-20260715-SECRET-SCAN-QUOTE] Mixed quote classes broke a zsh secret-scan command

**Logged**: 2026-07-15T04:04:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
A defensive pre-read secret scan embedded both quote characters inside a single shell regex and produced an unmatched-quote parse error.

### Error
```text
zsh: unmatched "
```

### Context
- Operation: scan the local `video-publish` skill before displaying its contents.
- The shell rejected the command before reading or printing skill file contents.

### Suggested Fix
Pass several simple `rg -e` patterns and avoid interpolating quote characters into a nested command string.

### Metadata
- Reproducible: yes
- Related Files: none

### Resolution
- **Resolved**: 2026-07-15T04:04:00+08:00
- **Notes**: Replaced the combined expression with separately quoted patterns.

---

## [ERR-20260715-RPM2CPIO-PAYLOAD] Ubuntu rpm2cpio rejected the generated Desktop RPM

**Logged**: 2026-07-15T03:57:00+08:00
**Priority**: high
**Status**: pending
**Area**: release-ci

### Summary
The Desktop 0.1.12 Linux lane built and signed both packages, then Ubuntu 22.04's `rpm2cpio` silently rejected the generated RPM while the deb package fully passed extraction and sidecar execution.

### Error
```text
RPM package smoke failed: RPM conversion: rpm2cpio failed: exit status 1
```

### Context
- The RPM existed and its updater signature verified against the configured public key.
- The Debian package extracted and ran Hara 0.122.5 natively with hostile-cwd, SAB-disabled, help, and serve-help probes.
- The release stayed a hidden draft; aggregation and publication were skipped.

### Suggested Fix
Install `libarchive-tools` and use `bsdtar` to extract the RPM directly to disk. This avoids older rpm2cpio payload/compression limitations and avoids buffering the full cpio stream in Node memory.

### Metadata
- Reproducible: yes on GitHub Ubuntu 22.04 runner
- Related Files: hara-desktop/.github/workflows/build.yml, hara-desktop/scripts/package-smoke.mjs

---

## [ERR-20260715-WEB-ROOT-MANIFEST] Hara Web is not a root-package workspace

**Logged**: 2026-07-15T03:51:00+08:00
**Priority**: low
**Status**: resolved
**Area**: repository-discovery

### Summary
A read-only Hara Web inspection assumed a root `package.json`, but the repository keeps independent manifests under `site/` and `docs/`.

### Error
```text
cat: package.json: No such file or directory
```

### Context
- Operation: inspect deployment and build scripts while Desktop CI was running.
- `deploy.sh` already correctly builds each child with `pnpm -C`.

### Suggested Fix
Discover manifests with `rg --files -g package.json` before reading package metadata in a multi-product repository.

### Metadata
- Reproducible: yes
- Related Files: hara-web/deploy.sh, hara-web/site/package.json, hara-web/docs/package.json

### Resolution
- **Resolved**: 2026-07-15T03:51:00+08:00
- **Notes**: Continue using the two child manifests; no repository change was required.

---

## [ERR-20260715-BUN-WINDOWS-TARGET-DOWNLOAD] Bun Windows baseline runtime download was incomplete

**Logged**: 2026-07-15T03:48:00+08:00
**Priority**: medium
**Status**: pending
**Area**: release-ci

### Summary
The Hara Desktop 0.1.12 Windows matrix lane failed while Bun extracted its exact Windows baseline compiler runtime.

### Error
```text
error: Failed to extract executable for 'bun-windows-x64-baseline-v1.3.9'. The download may be incomplete.
```

### Context
- Operation: build the pinned Hara CLI 0.122.5 sidecar on `windows-latest`.
- Toolchain validation, npm installation, and npm audit had already passed; no Hara source or smoke test executed after the failed download.
- The release remained a hidden draft and no public artifact was exposed.

### Suggested Fix
Treat the first occurrence as a transient runner/download failure and rerun only failed jobs after the matrix settles. If it repeats, add a bounded retry that removes only Bun's incomplete target cache before recompiling.

### Metadata
- Reproducible: not yet
- Related Files: .github/workflows/build.yml

---

## [ERR-20260715-GIT-SSH-HANG] GitHub SSH read can hang without a connection deadline

**Logged**: 2026-07-15T03:45:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release-validation

### Summary
A pre-tag `git ls-remote` over SSH remained blocked without output, so the release command never reached local tag creation or push.

### Error
```text
ssh ... git-upload-pack 'hara-cli/hara-desktop.git'
# no output until interrupted
```

### Context
- Operation: verify remote Desktop main immediately before creating `v0.1.12`.
- A separate GitHub API/SSH probe confirmed that the tag had not been created remotely.

### Suggested Fix
Use the GitHub API for read-only ref verification and configure `ConnectTimeout`, `ServerAliveInterval`, and `ServerAliveCountMax` on release Git pushes.

### Metadata
- Reproducible: intermittent
- Related Files: none

### Resolution
- **Resolved**: 2026-07-15T03:45:00+08:00
- **Notes**: Interrupted the stale read, verified no remote tag existed, and resumed with bounded SSH settings.

### Follow-up 2026-08-06T14:10:00+08:00

After the successful CLI 0.141.0 `main` push, an unbounded SSH `ls-remote` verification again produced
no output for over one minute. It was interrupted without changing release state; use GitHub's
read-only ref API for the post-push equality check and keep the actual configured Git push transport
unchanged.

- **Recurrence-Count**: 2
- **Last-Seen**: 2026-08-06

---

## [ERR-20260715-ZSH-STATUS-READONLY] zsh reserves the `status` variable

**Logged**: 2026-07-15T03:34:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
A pre-commit secret-scan wrapper tried to assign the previous exit code to `status`, which is a read-only special parameter in zsh.

### Error
```text
zsh:1: read-only variable: status
```

### Context
- Operation: distinguish ripgrep's no-match exit code from a scan failure.
- The scanner emitted no matched file or credential content before the wrapper failed.

### Suggested Fix
Use a non-reserved variable such as `rc` for exit-code handling in cross-shell command wrappers.

### Metadata
- Reproducible: yes
- Related Files: none

### Resolution
- **Resolved**: 2026-07-15T03:34:00+08:00
- **Notes**: Re-ran the same scan with `rc`.

---

## [ERR-20260715-NPM-AUDIT-MIRROR] npm mirror lacks the security audit endpoint

**Logged**: 2026-07-15T03:31:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-validation

### Summary
The Desktop dependency audit failed because the user-level npm registry was set to npmmirror, which does not implement npm's security audit endpoint.

### Error
```text
npm warn audit 404 Not Found - POST https://registry.npmmirror.com/-/npm/v1/security/audits/quick
[NOT_IMPLEMENTED] /-/npm/v1/security/* not implemented yet
```

### Context
- Operation: `npm audit --audit-level=moderate` for Hara Desktop 0.1.12.
- All build and test gates passed; the error occurred before any advisory response was returned.

### Suggested Fix
Pin the official registry for audit-only validation: `npm audit --registry=https://registry.npmjs.org`.

### Metadata
- Reproducible: yes
- Related Files: package-lock.json

### Resolution
- **Resolved**: 2026-07-15T03:31:00+08:00
- **Notes**: Re-ran the audit against the official npm registry; keep this local learning file uncommitted.

### Follow-up
- **Seen again**: 2026-07-21T10:45:00+08:00
- **Resolution**: Keep release audits pinned to `https://registry.npmjs.org`; the configured mirror still
  does not implement the audit endpoint.
- **Seen again**: 2026-08-05T02:47:00+08:00 for both CLI and Desktop pre-release audits; retry the
  unchanged commands against the official registry.
- **Recurrence-Count**: 3

---

## [ERR-20260714-BUN] Bun self-invocation integration test

**Logged**: 2026-07-14T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
An exact path assertion failed because Bun canonicalized macOS's `/var` alias to `/private/var`.

### Error
```text
Expected /var/folders/.../bun-entry.mjs but received /private/var/folders/.../bun-entry.mjs.
```

### Context
- Operation: plain-Bun `selfInvocation` integration test
- Environment: macOS temporary directory returned through the `/var` filesystem alias

### Suggested Fix
Compare both script-entry paths after `realpathSync.native()` canonicalization.

### Metadata
- Reproducible: yes
- Related Files: test/self-invoke.test.mjs

### Resolution
- **Resolved**: 2026-07-14T00:00:00+08:00
- **Notes**: The assertion now compares canonical paths while preserving the argument-order check.

---

## [ERR-20260715-DESKTOP-TIMEOUT-PATCH] Timeout regression test and option placement were incorrect

**Logged**: 2026-07-15T03:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
The first Desktop timeout-hardening patch sliced YAML jobs at any line beginning with two spaces and inserted a
second timeout into the updater verifier's cargo-build options instead of the artifact-verification options.

### Error
```text
prepare_release must have a timeout
```

### Context
- Operation: `npm test` after adding finite release/extraction timeouts.
- The workflow already contained the timeout; the new policy test parsed its indentation incorrectly.

### Suggested Fix
Split YAML into lines and stop only at the next exact two-space job header. Place one distinct timeout on each
`execFileSync` call and inspect the resulting object before rerunning tests.

### Metadata
- Reproducible: yes
- Related Files: hara-desktop/test/release-pipeline.test.mjs, hara-desktop/scripts/updater-signature.mjs

### Resolution
- **Resolved**: 2026-07-15T03:00:00+08:00
- **Notes**: Corrected the job-boundary parser and moved the verification timeout to the intended call.

---

## [ERR-20260715-FEISHU-CHAT-ARG] Used stale Feishu messages flag

**Logged**: 2026-07-15T02:35:00+08:00
**Priority**: low
**Status**: resolved
**Area**: integrations

### Summary
The first refresh of the canonical Hara feedback group used `--chat-id`, while the current bundled Feishu client
requires `--chat` for the `messages` command.

### Error
```text
feishu_chat.py messages: error: the following arguments are required: --chat
```

### Context
- Operation: refresh `hara 反馈群` before continuing Desktop issue work.
- No remote state was changed.

### Suggested Fix
Follow the command's current help/skill examples and use `messages --chat <chat-id>`.

### Metadata
- Reproducible: yes
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py

### Resolution
- **Resolved**: 2026-07-15T02:35:00+08:00
- **Notes**: Retried immediately with `--chat`.

---

## [ERR-20260715-ZVEC-DARWIN-X64] Optional zvec removal broke TypeScript build

**Logged**: 2026-07-15T02:30:00+08:00
**Priority**: high
**Status**: resolved
**Area**: ci

### Summary
The new macOS Intel standalone CI lane failed during `npm ci` because npm correctly removed the optional
`@zvec/zvec` package when no Darwin x64 binding was available, while TypeScript still tried to resolve its
literal dynamic import at build time.

### Error
```text
src/search/zvec-store.ts(22,26): error TS2307: Cannot find module '@zvec/zvec' or its corresponding type declarations.
```

### Context
- Operation: Hara CLI 0.122.5 main-branch release gate on `macos-15-intel`.
- All other CI lanes passed; the unsupported native accelerator already had a runtime JSON fallback.

### Suggested Fix
Give optional native modules an ambient compile-time declaration while keeping the runtime import failure guarded,
then retain a native Intel CI lane so unsupported-package removal remains exercised.

### Metadata
- Reproducible: yes
- Related Files: src/search/zvec-store.ts, src/types/optional-native-modules.d.ts, package.json

### Resolution
- **Resolved**: 2026-07-15T02:30:00+08:00
- **Notes**: Added the ambient optional-module contract and a policy regression test; the runtime fallback is unchanged.

---

## [ERR-20260715-RUBY-YAML-ALIASES] System Ruby rejected modern Psych keyword

**Logged**: 2026-07-15T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
The macOS system Ruby/Psych version does not accept the modern `aliases:` keyword on `YAML.load_file`.

### Error
```text
unknown keyword: aliases (ArgumentError)
```

### Context
- Operation: syntax-only parsing of GitHub Actions YAML.
- Environment: macOS system Ruby 2.6.

### Suggested Fix
For syntax-only checks on this host, call `YAML.load_file(path)` without the newer keyword.

### Metadata
- Reproducible: yes
- Related Files: .github/workflows/ci.yml, .github/workflows/release.yml

### Resolution
- **Resolved**: 2026-07-15T00:00:00+08:00
- **Notes**: Re-ran without the unsupported keyword; both workflow files parsed successfully.

---

## [ERR-20260715-CODEX-REVIEW-PROMPT] Codex review rejected prompt with uncommitted scope

**Logged**: 2026-07-15T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
The installed Codex CLI help advertises `codex review --uncommitted [PROMPT]`, but this version rejects a custom prompt when `--uncommitted` is present.

### Error
```text
error: the argument '--uncommitted' cannot be used with '[PROMPT]'
```

### Context
- Operation: independent review of the Hara 0.122.5 standalone boundary patch.
- The review scope itself remained available without the custom prompt.

### Suggested Fix
Use `codex review --uncommitted` without a positional prompt for this installed CLI version, and inspect unrelated untracked output separately.

### Metadata
- Reproducible: yes
- Related Files: scripts/build-binary.ts, scripts/standalone-boundary-smoke.mjs

### Resolution
- **Resolved**: 2026-07-15T00:00:00+08:00
- **Notes**: Re-launched the review with `--uncommitted` only.

---

## [ERR-20260715-NPM-PATH] Absolute Node did not select the matching npm

**Logged**: 2026-07-15T00:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release-validation

### Summary
Invoking the pinned Node executable before a separate bare `npm` command still let the shell resolve the obsolete system npm and Node runtime.

### Error
```text
Error: Cannot find module 'node:path'
at /usr/local/lib/node_modules/npm/lib/cli.js
```

### Context
- Operation: Hara CLI targeted build and regression verification.
- Node 22.23.1 itself was installed and worked, but the following bare `npm` came from `/usr/local/bin`.

### Suggested Fix
For every release gate, prepend the pinned Node installation's `bin` directory to `PATH` for the whole command, then run both npm and node inside that environment.

### Metadata
- Reproducible: yes
- Related Files: package.json, hara-desktop/.node-version
- See Also: ERR-20260715-PNPM-NODE

### Resolution
- **Resolved**: 2026-07-15T00:00:00+08:00
- **Notes**: Re-ran with the complete Node 22.23.1/Bun/Rust PATH; build and 28 focused tests passed.

---

## [ERR-20260715-CRON-LOCK-EXPECTATIONS] Cron lock regression test expectations

**Logged**: 2026-07-15T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
The first focused Cron run failed because one assertion overfit diagnostic wording and one legacy fixture still expected an aged live lock to be reclaimed.

### Error
```text
45 focused tests passed; the manual-run message regex and malformed-lock fixture expectations failed.
```

### Context
- Operation: Node 22 focused `cron`, `cron-v2`, and self-invocation tests after changing tick locks to proof-based PID recovery.
- The implementation correctly kept an aged identity-less live owner; the old fixture encoded the unsafe age-only behavior being removed.

### Suggested Fix
Assert the durable safety outcome rather than exact prose, and use a proven-dead PID when a malformed-guard test needs the primary lock to be reclaimable.

### Metadata
- Reproducible: yes
- Related Files: test/cron-v2.test.mjs, src/cron/runner.ts

### Resolution
- **Resolved**: 2026-07-15T00:00:00+08:00
- **Notes**: Updated the focused assertions and fixtures to match the fail-closed identity semantics.

---

## [ERR-20260714-NPM-CACHE] npm pack blocked by global cache ownership

**Logged**: 2026-07-14T22:32:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-validation

### Summary
`npm pack --dry-run` compiled successfully but could not write a temporary file under the user npm cache because that cache contains root-owned entries.

### Error
```text
npm error code EPERM
npm error path /Users/zhujianbo/.npm/_cacache/tmp/...
```

### Context
- Operation: release package-content validation
- Environment: existing user-level npm cache with mixed ownership

### Suggested Fix
Use an isolated writable cache for deterministic release validation instead of changing global cache ownership.

### Resolution
- **Resolved**: 2026-07-14T22:32:00+08:00
- **Notes**: Re-run with `npm_config_cache=/private/tmp/hara-npm-cache`.

### Follow-up
- **Seen again**: 2026-07-21T10:45:00+08:00
- **Context**: The `0.126.1` and `0.130.2` dry-run package checks selected the same mixed-ownership global cache.
- **Resolution**: Re-ran with a unique cache under `/private/tmp`; the package build and manifest inspection passed.
- **Seen again**: 2026-07-22T11:35:00+08:00
- **Context**: The `0.133.0` dry-run again selected the global cache before the task-owned cache was applied.
- **Resolution**: Re-ran unchanged with an isolated `/private/tmp` cache; all 168 package entries were produced.
- **Seen again**: 2026-07-26T14:25:00+08:00
- **Context**: The `0.135.0` dry-run selected the same mixed-ownership cache after a clean build.
- **Resolution**: Re-ran unchanged with `NPM_CONFIG_CACHE=/private/tmp/hara-npm-cache`; the 170-entry package
  manifest included `dist/serve/attachments.js` and reported version `0.135.0`.
- **Seen again**: 2026-07-31T10:20:00+08:00
- **Context**: The model-proxy release candidate again selected the unwritable default cache after its
  prepare/build step passed.
- **Resolution**: Re-run the unchanged dry-run with a task-owned cache under `/private/tmp`; never follow
  npm's generic ownership-changing advice during release validation.
- **Recurrence-Count**: 6

---

## [ERR-20260715-PNPM-NODE] pnpm build verification selected legacy npm runtime

**Logged**: 2026-07-15T00:18:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
Running the build through pnpm invoked a dependency-state install hook; its nested bare `npm` resolved through the system PATH and ran under an obsolete Node that cannot load `node:` modules.

### Error
```text
Error: Cannot find module 'node:path'
at /usr/local/lib/node_modules/npm/lib/cli.js
```

### Context
- Operation: Hara CLI release build verification
- The project had previously been verified with the absolute Node 22 executable.
- pnpm also generated an unintended `pnpm-lock.yaml` and converted the local dependency layout before the build began.

### Suggested Fix
Use the Node 22 executable directly for `node_modules/typescript/bin/tsc` and each post-build script. An absolute npm CLI alone is insufficient because package-script shebangs can still resolve bare `node` from the legacy system PATH. Do not switch package managers during release validation.

### Metadata
- Reproducible: yes
- Related Files: package.json, package-lock.json

### Resolution
- **Resolved**: 2026-07-15T00:18:00+08:00
- **Notes**: Removed the unintended pnpm lockfile, restored dependencies offline, and resumed validation by invoking the compiler and post-build scripts directly through Node 22.

---

## [ERR-20260715-SMOKE-QUOTE] Standalone smoke version lookup quoting

**Logged**: 2026-07-15T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
An over-escaped `node -p` expression prevented the standalone boundary smoke from receiving its expected version.

### Error
```text
Expected unicode escape
SyntaxError: Invalid or unexpected token
```

### Context
- Operation: local standalone build and boundary-smoke verification.
- The nested command string passed literal backslashes to `node -p`; the standalone build itself succeeded.

### Suggested Fix
Use a shell-safe expression such as `node -p 'require("./package.json").version'` without preserving escape backslashes.

### Metadata
- Reproducible: yes
- Related Files: package.json, scripts/standalone-boundary-smoke.mjs

### Resolution
- **Resolved**: 2026-07-15T00:00:00+08:00
- **Notes**: Re-ran the smoke with corrected shell quoting.

---

## [ERR-20260715-BUN-CROSS-TARGET] Bun cross-target download blocked

**Logged**: 2026-07-15T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-validation

### Summary
Local all-target standalone validation stopped when Bun could not download an uncached cross-compilation runtime in the restricted environment.

### Error
```text
error: Failed to download 'bun-darwin-x64-baseline-v1.3.9': ConnectionRefused
```

### Context
- Operation: `npm run build:binaries` during review.
- The native/currently cached target built successfully; network access was unavailable for the next target.

### Suggested Fix
Run the cross-target gate in CI or another environment with Bun's target artifacts cached or downloadable.

### Metadata
- Reproducible: yes
- Related Files: package.json, scripts/build-binary.ts

### Resolution
- **Resolved**: 2026-07-15T00:00:00+08:00
- **Notes**: Treated as an environment limitation; native build, runtime smoke, and the full test suite passed locally.

---

## [ERR-20260715-LOGIN-PATH] Login shell selected obsolete Node and Rust toolchains

**Logged**: 2026-07-15T10:45:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release-validation

### Summary
The login shell placed `/usr/local/bin` before the pinned user toolchains, so bare `npm`, `cargo`, and `rustc` invoked Node 11 / Rust 1.84 during Desktop 0.1.14 validation.

### Error
```text
Error: Cannot find module 'node:path'
feature `edition2024` is required
rustc 1.84.1 is not supported by the following packages
```

### Context
- Operation: inspect Bun packages and run the locked Desktop Cargo checks.
- The required Node 22 and Rust 1.97 binaries were installed under the user's nvm/cargo directories, but were later on PATH.

### Suggested Fix
Prepend the pinned toolchain directories for release validation instead of relying on the login shell's bare command resolution.

### Metadata
- Reproducible: yes
- Related Files: hara-desktop/.node-version, hara-desktop/.rust-version
- See Also: ERR-20260715-PNPM-NODE

### Resolution
- **Resolved**: 2026-07-15T10:47:00+08:00
- **Notes**: Re-ran Node checks with the Node 22 nvm directory first and Cargo checks with `~/.cargo/bin` first; all relevant gates passed.

---

## [ERR-20260715-SHELLCHECK-SOURCE] ShellCheck source-following flag omitted

**Logged**: 2026-07-15T10:43:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
The first static-check command failed only because ShellCheck was not allowed to follow the repository-local sourced build-toolchain script.

### Error
```text
SC1091: Not following: scripts/check-build-toolchain.sh was not specified as input
```

### Context
- Operation: Desktop 0.1.14 release-gate verification.
- The source path is fixed and repository-local.

### Suggested Fix
Use `shellcheck -x` and name both shell scripts explicitly.

### Metadata
- Reproducible: yes
- Related Files: hara-desktop/scripts/refresh-sidecar.sh, hara-desktop/scripts/check-build-toolchain.sh

### Resolution
- **Resolved**: 2026-07-15T10:44:00+08:00
- **Notes**: The corrected static check passed.

---

## [ERR-20260715-SKILL-COMPATIBILITY] Skill validator lags the published Agent Skills optional fields

**Logged**: 2026-07-15T11:03:00+08:00
**Priority**: low
**Status**: resolved
**Area**: docs

### Summary
The current `skill-creator` validator rejects the optional `compatibility` frontmatter field even though the current Agent Skills specification documents it.

### Error
```text
Unexpected key(s) in SKILL.md frontmatter: compatibility
```

### Context
- Operation: validate the public `hara-video/skills/video-publish` skill.
- The validator accepts only `name`, `description`, `license`, `metadata`, and `allowed-tools`.

### Suggested Fix
Keep compatibility requirements in the body until the local validator supports the newer optional field, or update the validator and its schema tests.

### Metadata
- Reproducible: yes
- Related Files: hara-video/skills/video-publish/SKILL.md

### Resolution
- **Resolved**: 2026-07-15T11:04:00+08:00
- **Notes**: Moved the client/network/adapter requirements into the skill body and revalidated the frontmatter subset.

---

## [ERR-20260715-CODEX-REVIEW-HANG] Uncommitted review exceeded its useful execution bound

**Logged**: 2026-07-15T11:15:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
`codex review --uncommitted` kept recursively inspecting toolchains and caches for more than 26 minutes, including a single 163-second search, then stopped emitting output instead of returning review findings.

### Error
```text
Review process remained alive for 26+ minutes with no final result and long periods without output.
```

### Context
- Operation: read-only review of the eight-file Hara Desktop 0.1.14 release patch.
- Unit, metadata, actionlint, ShellCheck, Node build, and pinned Rust checks had already passed.
- Two interactive interrupts and SIGTERM did not stop the process; SIGKILL was required for this spawned review only.

### Suggested Fix
Wrap autonomous review runs in a finite external timeout and constrain them to the changed files. Fall back to targeted local gates and manual diff review when the reviewer starts broad cache/system discovery.

### Metadata
- Reproducible: unknown
- Related Files: hara-desktop/.github/workflows/build.yml

### Resolution
- **Resolved**: 2026-07-15T11:16:00+08:00
- **Notes**: Terminated the stuck spawned review and retained the passing targeted release gates as the decision evidence.

---

## [ERR-20260715-WEB-SAFE-URL] Web reader rejected Hara-owned HTTPS domains

**Logged**: 2026-07-15T21:25:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
The web reader rejected `https://desk.nanhara.tech/health` (and earlier Hara public domains) as an unsafe URL, so it could not perform the requested public reverse verification.

### Error
```text
URL https://desk.nanhara.tech/health is not safe to open (non-retryable error)
```

### Context
- Operation: read-only production health verification during the Hara Desk/CLI gap audit.
- The domain is a Hara-owned HTTPS endpoint already documented in the workspace.

### Suggested Fix
Use bounded read-only HTTPS requests as the fallback and verify status/body/headers without printing credentials; retry the web reader only after its safe-URL classification changes.

### Metadata
- Reproducible: yes
- Related Files: HARA_PRODUCTS.md, hara-desk/deploy/DEPLOY.md
- See Also: Hara Web 0.123.1 public verification in the current task

### Resolution
- **Resolved**: 2026-07-15T21:25:00+08:00
- **Notes**: Switched to bounded `curl` checks against the public endpoint.

---

## [ERR-20260715-ZSH-OPTIONAL-GLOB] Optional test glob aborted a read-only audit command

**Logged**: 2026-07-15T23:20:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
A read-only TUI audit command passed `test/pty*.mjs` directly to zsh. No file matched, so zsh emitted
`no matches found` before `rg` could run that portion of the query.

### Error
```text
zsh: no matches found: test/pty*.mjs
```

### Context
- Operation: inspect Hara CLI TUI/PTY input coverage after the 0.123.1 paused-stdin hotfix.
- Other independent reads in the same shell invocation still ran, but the glob-dependent search did not.
- Recurrence: an unquoted GitHub API URL containing `?per_page=100` was likewise expanded by zsh before
  `curl` ran during Windows release-CI monitoring.

### Suggested Fix
Discover optional files with `rg --files | rg 'pattern'`, quote patterns passed to tools that interpret them,
or use an explicitly null-tolerant zsh glob only when shell expansion is actually required.

### Metadata
- Reproducible: yes
- Related Files: hara-cli/test, hara-cli/src/tui
- Recurrence-Count: 3
- Last-Seen: 2026-07-26T00:00:00+08:00

### Resolution
- **Resolved**: 2026-07-15T23:21:00+08:00
- **Notes**: Re-ran the inspection with explicit existing files and `rg --files`; on 2026-07-26,
  replaced an optional `.github/workflows/*.yaml` glob with explicit existing workflow files. Focused TUI/file/session
  regression later passed 77/77. Quoted the complete GitHub API URL on recurrence and retrieved the CI state.

---

## [ERR-20260716-MISSING-LEARNINGS-FILE] Optional learning log aborted a chained read

**Logged**: 2026-07-16T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: docs

### Summary
A review command assumed `.learnings/LEARNINGS.md` existed and chained later reads with `&&`, so the missing optional file prevented existing feature and error logs from being read.

### Error
```text
sed: .learnings/LEARNINGS.md: No such file or directory
```

### Context
- Operation: review project learnings before the Hara agent/context architecture audit.
- `.learnings/FEATURE_REQUESTS.md` and `.learnings/ERRORS.md` existed; only the optional learning log was absent.

### Suggested Fix
Discover learning files first with `rg --files .learnings`, then read each existing file independently instead of chaining optional paths.

### Metadata
- Reproducible: yes
- Related Files: .learnings/FEATURE_REQUESTS.md, .learnings/ERRORS.md

### Resolution
- **Resolved**: 2026-07-16T00:01:00+08:00
- **Notes**: Re-ran the review against the discovered files independently.

---

## [ERR-20260716-CODEX-CONTEXT-PATH] Codex context manager moved from a single legacy file

**Logged**: 2026-07-16T00:15:00+08:00
**Priority**: low
**Status**: resolved
**Area**: architecture-review

### Summary
A Codex comparison command assumed `core/src/context_manager.rs`, but the current source splits the implementation under `core/src/context_manager/`.

### Error
```text
wc: codex-rs/core/src/context_manager.rs: open: No such file or directory
sed: codex-rs/core/src/context_manager.rs: No such file or directory
```

### Context
- Operation: compare Hara conversation/context handling with the current local Codex source.
- Codex had recently evolved and the path assumption came from an older layout.

### Suggested Fix
Discover architecture files with `rg --files` before reading named upstream modules, especially in fast-moving comparison repositories.

### Metadata
- Reproducible: yes
- Related Files: /Users/zhujianbo/work/projects/ai/codex/codex-rs/core/src/context_manager

### Resolution
- **Resolved**: 2026-07-16T00:16:00+08:00
- **Notes**: Located the split `mod.rs`, `history.rs`, `normalize.rs`, and `updates.rs` modules through the repository index.

---
# ERR-20260716-SERVE-PATCH-CONTEXT

- Date: 2026-07-16
- Context: Applying the durable steering + explicit continuation change to `src/serve/server.ts`.
- Error: A multi-hunk `apply_patch` failed because one large context block did not match the current file exactly.
- Recovery: Inspect exact numbered lines and apply smaller independent hunks; verify the diff after each group.
- Prevention: For large orchestration files with frequent nearby edits, anchor patches on the smallest unique import/function lines instead of a combined broad patch.

# ERR-20260716-NODE22-PATH-STALE

- Date: 2026-07-16
- Context: First build/test after task and steering changes.
- Error: `$HOME/.nvm/versions/node/v22.22.0/bin` was absent, so PATH fell through to an obsolete system Node; npm failed on `node:path` and Node did not support `--test`.
- Recovery: Discover installed runtimes before retrying and invoke the matching npm through that runtime's bin directory.
- Prevention: Do not carry a concrete NVM patch-version path across sessions without verifying it exists (`ls ~/.nvm/versions/node`, `node -v`, `command -v node`).

# ERR-20260716-COMPACTION-FIXED-LENGTH-ASSERTION

- Date: 2026-07-16
- Context: Focused tests after changing compaction from summary-only to checkpoint + recent-turn anchor.
- Error: One fork-isolation assertion still assumed compacted history had at most two entries.
- Recovery: Compare the original session to the actual post-compaction baseline instead of a legacy fixed length.
- Prevention: Tests for intentionally variable retained context should assert invariants/content and captured baselines, not implementation-specific message counts.

---

## [ERR-20260716-INJECTED-AGENTS-PATH] Injected root instructions were mistaken for a workspace file

**Logged**: 2026-07-16T23:07:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
A chained repository-inspection command tried to read a physical root `AGENTS.md`, although the root Hara
rules for this turn were injected in the prompt and only the subprojects contain actual `AGENTS.md` files.

### Error
```text
sed: AGENTS.md: No such file or directory
```

### Context
- Operation: review release conventions before preparing Hara CLI 0.124.1.
- The leading failed read stopped later `&&`-chained, otherwise independent status reads.

### Suggested Fix
Treat prompt-injected instructions as authoritative without assuming a matching disk file. Discover physical
instruction files first with `rg --files -g 'AGENTS.md'`, and do not chain optional reads ahead of required ones.

### Metadata
- Reproducible: yes
- Related Files: AGENTS.md, hara-cli/AGENTS.md

### Resolution
- **Resolved**: 2026-07-16T23:08:00+08:00
- **Notes**: Discovered the actual per-product instruction files and read `hara-cli/AGENTS.md` independently.

---

## [ERR-20260716-GITHUB-JOB-LOG-AUTH] Public Actions API withheld raw job logs

**Logged**: 2026-07-16T23:12:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release

### Summary
GitHub exposed the public run, job, steps, and annotations but returned HTTP 403 for the raw job-log archive;
the available browser plugin also had no active browser to supply a signed-in session.

### Error
```text
curl: (56) The requested URL returned error: 403
No browser is available
```

### Context
- Operation: diagnose the Windows native runtime lane without relying on an invalid local `gh` login.
- Existing annotations only contained the generic failing step and exit code.

### Suggested Fix
Make platform-only CI failures self-describing through redacted GitHub workflow annotations and continue the
native smoke after a contract-test failure when the build prerequisite succeeded.

### Metadata
- Reproducible: yes
- Related Files: .github/workflows/ci.yml

### Resolution
- **Resolved**: 2026-07-16T23:16:00+08:00
- **Notes**: Added bounded 80-line failure annotations and independent native Windows execution-smoke coverage.

---

## [ERR-20260716-NPM-AUDIT-QUICK-410] npm audit fallback endpoint was retired

**Logged**: 2026-07-16T23:53:00+08:00
**Priority**: high
**Status**: resolved
**Area**: release

### Summary
The official npm 10.9.8 audit client experienced a transient bulk-advisory request failure, then fell back to
the retired `audits/quick` endpoint and received HTTP 410. That result was neither a clean audit nor evidence
of a dependency vulnerability.

### Error
```text
npm warn audit 410 Gone - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick
```

### Context
- Operation: independent production-dependency gate for Hara CLI 0.124.1.
- A later retry with the same pinned Node 22.23.1 and npm 10.9.8 received HTTP 200 from the bulk endpoint and
  reported zero vulnerabilities.

### Suggested Fix
Retry the complete official-registry audit a small fixed number of times. Never convert an endpoint error to
success, and keep the final nonzero status when every attempt fails.

### Metadata
- Reproducible: transient
- Related Files: .github/scripts/audit-production.sh, .github/workflows/release.yml,
  .github/workflows/publish-npm.yml
- See Also: ERR-20260715-NPM-AUDIT-MIRROR

### Resolution
- **Resolved**: 2026-07-16T23:54:00+08:00
- **Notes**: Both tag workflows now use a shared three-attempt audit gate; a real retry completed with zero
  vulnerabilities and the gate still exits nonzero after the final failed attempt.

---

## [ERR-20260717-DESKTOP-TOOLCHAIN-SOURCE] Sourced bash toolchain helper assumed Bash and caller fail-fast

**Logged**: 2026-07-17T00:34:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release

### Summary
Sourcing Desktop's build-toolchain helper from the default zsh under `set -u` referenced undefined
`BASH_SOURCE`; without caller `set -e`, a failed Node check also continued to later checks and could return
success from the final Rust check.

### Error
```text
scripts/check-build-toolchain.sh:110: BASH_SOURCE[0]: parameter not set
error: Node.js 22.23.1 is pinned for release builds (detected 22.22.3)
```

### Suggested Fix
Guard direct-execution logic behind `BASH_VERSION`, and make the aggregate checker return immediately after
any failed component independent of the caller's shell options.

### Metadata
- Reproducible: yes
- Related Files: ../hara-desktop/scripts/check-build-toolchain.sh,
  ../hara-desktop/test/release-pipeline.test.mjs

### Resolution
- **Resolved**: 2026-07-17T00:36:00+08:00
- **Notes**: Added shell-safe direct-execution detection, explicit `|| return 1` checks, regression assertions,
  and verified both zsh sourcing and the complete pinned Desktop gate.

---

## [ERR-20260717-EXEC-TEMPLATE-EXPANSION] JavaScript tool template collided with shell parameter expansion

**Logged**: 2026-07-17T00:20:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
A JavaScript template containing shell `${TMPDIR:-/tmp}` was parsed as JavaScript interpolation. Escaping it
inside `String.raw` then preserved a literal backslash, so `mktemp` received the unexpanded expression.

### Suggested Fix
For composed tool commands, avoid nested interpolation syntax or use a concrete trusted temporary root such
as `/private/tmp`; keep each public-artifact verification fail-fast and independently observable.

### Resolution
- **Resolved**: 2026-07-17T00:23:00+08:00
- **Notes**: Re-ran npm and GitHub public-artifact verification independently with concrete temporary paths;
  both completed successfully and cleaned their directories.

---

## [ERR-20260717-FEISHU-MESSAGE-RANGES] Feishu intake rejected oversized fetch parameters without exposing bounds

**Logged**: 2026-07-17T03:17:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
The reusable Feishu client rejected a canonical Hara intake fetch using `--days 2 --limit 100
--preview-limit 500` with a generic range error, while its help text did not state the accepted bounds.

### Error
```text
error: days/limit/preview-limit out of range
```

### Suggested Fix
Use conservative fetch values for release-time polling and inspect the client validation before increasing
them. The client should eventually show the accepted range in `--help` and in the validation error.

### Resolution
- **Resolved**: 2026-07-17T03:17:00+08:00
- **Notes**: Retried with conservative supported values; no credentials or message contents were exposed by
  the failed call.

---

## [ERR-20260717-GIT-PUSH-SSH-STALL] Git SSH push stayed silent without completing

**Logged**: 2026-07-17T11:43:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
After committing the standalone WeCom smoke entry, `git push origin main` remained silent for more than
80 seconds. The remote ref still pointed to the prior commit, so the push had not completed.

### Suggested Fix
Interrupt a silent push after a bounded wait, verify the remote ref with `git ls-remote`, then retry the same
non-interactive push. Never infer success from the local commit or create a tag while the branch ref is stale.

### Resolution
- **Resolved**: 2026-07-17T11:43:00+08:00
- **Notes**: The stalled process was interrupted safely; local and remote refs were checked, then the same
  push succeeded with bounded SSH connect/keepalive settings.

---

## [ERR-20260717-PATCH-NONUNIQUE-STATUS] A broad patch changed the wrong repeated status field

**Logged**: 2026-07-17T11:58:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
An `apply_patch` hunk targeting only `**Status**: in_progress` matched the first feature-request entry instead
of the intended WeCom entry because the field text was repeated.

### Suggested Fix
Include the entry heading or another unique neighboring line in every patch hunk that changes repeated
metadata fields, then inspect the exact affected section immediately.

### Resolution
- **Resolved**: 2026-07-17T11:58:00+08:00
- **Notes**: Restored the unrelated interaction feature status and updated only the WeCom entry.

---

## [ERR-20260717-RG-PATTERN-OPTION] ripgrep pattern was parsed as an option

**Logged**: 2026-07-17T12:15:05Z
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
A mechanism-audit search pattern began with `--cwd`, so ripgrep parsed the alternation as an unsupported
command-line flag instead of a pattern.

### Error
```text
rg: unrecognized flag --cwd|cwdOption|workspace|...
```

### Context
- Operation: read-only Hara CLI source and test discovery.
- No source file or runtime state was changed by the failed command.
- The first retry placed `--glob` after the `--` terminator, so ripgrep treated the glob flags as file paths
  even though it still returned source matches.

### Suggested Fix
Terminate ripgrep option parsing with `--` before any pattern that may begin with a dash.

### Metadata
- Reproducible: yes
- Related Files: none
- Recurrence-Count: 2

### Resolution
- **Resolved**: 2026-07-17T12:15:05Z
- **Notes**: Re-ran the audit with all option flags before `--`, followed by the dash-prefixed pattern.

---

## [ERR-20260717-ZSH-UNMATCHED-TEST-GLOB] zsh expanded an optional test glob before ripgrep

**Logged**: 2026-07-17T12:21:16Z
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
A read-only audit passed `test/evolve*.test.mjs` as an unquoted path argument; zsh rejected the command
because no file matched that optional glob.

### Error
```text
zsh:1: no matches found: test/evolve*.test.mjs
```

### Context
- Operation: discover remaining Hara CLI session/compaction/evolution mechanisms.
- No repository source or runtime state was changed.

### Suggested Fix
Use ripgrep `-g` filters or quote optional globs instead of relying on shell expansion.

### Metadata
- Reproducible: yes
- Related Files: none

### Resolution
- **Resolved**: 2026-07-17T12:21:16Z
- **Notes**: Re-ran against explicit source/test directories with ripgrep-managed glob filters.

---

## [ERR-20260717-TUI-RUN-EXTENSION] Assumed the TUI entry used a `.ts` source file

**Logged**: 2026-07-17T12:35:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
A read-only inspection targeted `src/tui/run.ts`, but the React/Ink TUI entry is `src/tui/run.tsx`.

### Error
```text
sed: src/tui/run.ts: No such file or directory
```

### Context
- Operation: inspect the local interactive lifecycle before designing a safe workspace switch.
- No source file or runtime state was changed.

### Suggested Fix
Resolve the exact source name with `rg --files src/tui` before opening files whose extension is uncertain.

### Resolution
- **Resolved**: 2026-07-17T12:35:00+08:00
- **Notes**: Located and inspected `src/tui/run.tsx`.

---

## [ERR-20260717-ZSH-OPTIONAL-SOURCE-GLOBS] Optional audit globs were expanded by zsh

**Logged**: 2026-07-17T13:02:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
Two read-only searches included optional `src/**/*.test.*` and `test/security*.test.mjs` arguments.
zsh rejected each command before ripgrep ran because no path matched the corresponding glob.

### Error
```text
zsh:1: no matches found: src/**/*.test.*
zsh:1: no matches found: test/security*.test.mjs
```

### Suggested Fix
Discover files with `rg --files` and filter them, or express optional patterns through ripgrep `--glob`
arguments instead of unquoted shell globs.

### Resolution
- **Resolved**: 2026-07-17T13:02:00+08:00
- **Notes**: Subsequent inspections used explicit files or ripgrep-managed filters.

---

## [ERR-20260717-HARA-CLI-NODE11] Default shell selected an unsupported Node 11

**Logged**: 2026-07-17T13:20:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tooling

### Summary
The default shell resolved `/usr/local/bin/node` v11.4.0, so a Hara CLI build/test command failed before
the repository's Node 22 code could run.

### Suggested Fix
Prefix every independent Hara CLI command with the pinned Node 22 nvm directory and verify the selected
runtime rather than assuming an interactive shell has activated nvm.

### Resolution
- **Resolved**: 2026-07-17T13:20:00+08:00
- **Notes**: Re-ran all builds and tests with Node v22.22.3.

---

## [ERR-20260717-MACOS-REALPATH-TMP] Workspace test assumed /var rather than canonical /private/var

**Logged**: 2026-07-17T13:23:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
A new workspace-switch test compared the user-facing `/var/...` temporary path with the canonical path
returned by `realpathSync`, which is `/private/var/...` on macOS.

### Suggested Fix
Canonicalize both expected and actual filesystem paths when testing security boundaries or workspace
switches; never compare a symlinked macOS temporary prefix literally.

### Resolution
- **Resolved**: 2026-07-17T13:23:00+08:00
- **Notes**: Updated the assertion to compare real paths; focused workspace tests passed.

---

## [ERR-20260718-STALE-VERSIONED-SKILL-PATH] Skill catalog referenced a stale plugin cache version

**Logged**: 2026-07-18T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
The advertised Browser skill path contained an older versioned plugin-cache directory, so the first
read failed even though a newer installed copy of the same skill was available locally.

### Error
```text
No such file or directory:
/Users/zhujianbo/.codex/plugins/cache/openai-bundled/browser/26.707.91948/skills/control-in-app-browser/SKILL.md
```

### Suggested Fix
When a versioned plugin-cache path is missing, rediscover the installed `SKILL.md` with `rg --files`
under the plugin cache and select the matching skill identity. Do not hard-code or infer another cache
version.

### Resolution
- **Resolved**: 2026-07-18T00:00:00+08:00
- **Notes**: Located and read the installed Browser skill at version `26.715.31925`; no Hara source or
  runtime state was changed.

---

## [ERR-20260718-FEISHU-SCRIPT-WORKSPACE-PATH] Feishu helper was invoked from a nonexistent workspace path

**Logged**: 2026-07-18T16:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
The first Feishu send attempt assumed `scripts/feishu_chat.py` existed at the Hara workspace root. The
helper is owned by the installed `feishu-communicate` skill, so the command failed before contacting Feishu.
After finding it, a second attempt assumed an obsolete `send-text` subcommand; the installed helper uses
`send --chat ... --text ...`.

### Error
```text
python: can't open file '/Users/zhujianbo/work/projects/hara/scripts/feishu_chat.py': No such file or directory
feishu_chat.py: error: argument command: invalid choice: 'send-text'
```

### Suggested Fix
Use the helper path and command syntax declared by the currently installed Feishu skill. Run the concrete
subcommand's `--help` before sending when the local helper version may have changed.

### Resolution
- **Resolved**: 2026-07-18T16:00:00+08:00
- **Notes**: Rediscovered `/Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py` and
  continued with that helper.

### Metadata
- Reproducible: yes when invoked from the Hara workspace root
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py
- Pattern-Key: tooling.use_canonical_feishu_skill_script
- Recurrence-Count: 2
- Last-Seen: 2026-08-07

---

## [ERR-20260718-BROWSER-RUNTIME-CACHE-SKEW] Browser runtime loaded a newer plugin but looked up old troubleshooting docs

**Logged**: 2026-07-18T17:00:00+08:00
**Priority**: low
**Status**: open
**Area**: tooling

### Summary
The installed Browser skill was rediscovered at cache version `26.715.31925`, but browser selection returned
`No browser is available` and the runtime then looked for bootstrap troubleshooting documentation under the
stale `26.707.91948` cache directory.

### Suggested Fix
Ensure browser-client resolves documentation relative to the same plugin root from which it was imported,
or invalidate stale runtime metadata when the plugin cache version changes. Until fixed, treat browser-based
visual QA as unavailable rather than silently switching to an unapproved automation surface.

---

## [ERR-20260718-NPM-CHILD-NODE-PATH] Absolute npm launcher did not pin Node for child scripts

**Logged**: 2026-07-18T18:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
Launching `npm-cli.js` with an absolute Node 22 binary did not update `PATH`. Package scripts then resolved
the host's older `node`, which rejected `node --test` and modern TypeScript syntax before tests/builds ran.

### Error
```text
node: bad option: --test
SyntaxError: Unexpected token ?
```

### Suggested Fix
For pinned-Node validation, set `PATH` so the selected Node's `bin` directory is first for the entire npm
process tree; selecting only the interpreter for `npm-cli.js` is insufficient.

### Resolution
- **Resolved**: 2026-07-18T18:00:00+08:00
- **Notes**: Re-ran Desktop tests and the CLI build with Node 22 first in `PATH`; both passed.

---

## [ERR-20260718-SKILL-INSTALL-ZIP-STALL] GitHub archive download stalled during official WeCom Skill install

**Logged**: 2026-07-18T23:15:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
The Skill installer's default direct-download mode remained blocked while reading the GitHub repository
archive and produced no progress or terminal error. A normal shallow clone of the same public repository
had already completed successfully.

### Suggested Fix
When the installer archive request makes no progress, stop that bounded attempt and rerun the same helper
with `--method git`. Preserve the helper's destination collision checks instead of copying directories
manually.

### Resolution
- **Resolved**: 2026-07-18T23:18:00+08:00
- **Notes**: Git mode installed all nine official WeCom Skills into `~/.hara/skills`, and Hara subsequently
  indexed each one as a global Skill.

---

## [ERR-20260718-WECOM-SEVEN-DAY-BOUNDARY] WeCom message query exceeded the rolling seven-day window

**Logged**: 2026-07-18T23:21:00+08:00
**Priority**: low
**Status**: resolved
**Area**: integration

### Summary
The first read-only `get_msg_chat_list` request used midnight seven calendar dates ago. At query time that
was older than the API's precise rolling 168-hour limit, so WeCom rejected it even though the dates appeared
to span seven days.

### Error
```text
errcode 850016: begin_time cannot be more than 7 days ago
```

### Suggested Fix
For default history discovery, calculate the start relative to the current timestamp or use a conservative
six-day window. Use the current Beijing time as `end_time` rather than the end of the calendar day.

### Resolution
- **Resolved**: 2026-07-18T23:21:00+08:00
- **Notes**: Retried with a six-day range; the official CLI returned the internal group conversation and
  `get_message` retrieved its latest text message successfully.

---

## [ERR-20260719-PLUGIN-SECURITY-VALIDATION] Plugin security validation initially hit host and type-check boundaries

**Logged**: 2026-07-19T19:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The first compile found one nullable staging-manifest reference in rollback code. After that was corrected,
the default workspace sandbox denied the focused tests before product assertions because the suite must
tighten the real `~/.hara` directory and open a loopback provider fixture.

### Resolution

Captured the verified manifest in a non-null rollback binding, rebuilt successfully, and reran the unchanged
Plugin/BYOK suite in the approved host test boundary. All 15 focused tests passed. Do not weaken private-state
permission checks or loopback provider coverage to make the restricted sandbox pass.

---

## [ERR-20260719-PLUGIN-HOTPATH-SCAN] Full plugin-tree validation consumed an agent deadline

**Logged**: 2026-07-19T19:12:00+08:00
**Priority**: high
**Status**: resolved
**Area**: runtime

### Summary

The first Plugin hardening implementation rescanned every file in every installed package each time
`listInstalled()` contributed Skills, roles, MCP servers, or panels. Four real local plugins delayed the
next agent round enough to consume a one-second lifecycle budget; the Serve guardian lease regression
timed out before its guardian provider started.

### Resolution

Keep full package scans at install, update, and ownership-sensitive uninstall boundaries. Runtime discovery
still reparses the manifest and revalidates every declared skill/agent/bin/MCP path, but does not walk
unrelated package files on every turn. The previously failing guardian test now completes in about one
second, and all Plugin/BYOK focused tests remain green.

---

## [ERR-20260719-TSC-PATH] Pinned Node command pointed at a nonexistent global TypeScript

**Logged**: 2026-07-19T19:48:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The release recheck pinned Node 22 correctly but constructed the TypeScript entry path under Node's global
modules. TypeScript is a project dependency here, so that file does not exist.

### Resolution

Run the pinned Node executable against `node_modules/typescript/bin/tsc`, then run the two local build
normalizers with the same pinned runtime. The build and all 1084 test cases then completed successfully.

---

## [ERR-20260719-NPM-CHILD-PATH] Pinned npm launcher still spawned the obsolete system Node

**Logged**: 2026-07-19T22:30:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

Invoking npm's CLI module with Node 22 pinned the parent process, but the `npm test` script invoked another
`npm run build` through the inherited PATH. That resolved to the obsolete system Node/npm installation and
failed before compilation with `Cannot find module 'node:path'`.

### Resolution

Pin both the Node executable and the child-process PATH to the repository's required Node installation.
This keeps nested npm and `node` commands on the same toolchain. Treat this as an environment failure, not
a product regression, and keep `.learnings/` out of commits. The same obsolete-system-Node failure recurred
while verifying `npm view` for 0.128.0 on 2026-07-20; sourcing NVM and selecting Node 22 before invoking npm
resolved it again.

---

## [ERR-20260720-RELEASE-TEST-SANDBOX] Release suite needs the approved host test boundary

**Logged**: 2026-07-20T02:31:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The 0.127.0 release run inside the restricted workspace produced `EPERM` failures when tests tightened the
real private `~/.hara` directory, bound loopback WebSocket fixtures, or exercised owned process
cancellation. Those failures occurred before or outside the product assertions.

### Resolution

Reran the unchanged exact-Node suite in the approved host boundary. All 1,092 tests passed. Do not weaken
private-state permissions, loopback gateway coverage, or process ownership checks to accommodate a
filesystem/network sandbox. Artifact/Serve focused tests reproduced the same loopback `listen EPERM` on
2026-07-20; the unchanged approved-host run passed 26/26, followed by the 0.128.0 full suite at 1,098/1,098.

---

## [ERR-20260720-CRON-CI-WALLCLOCK] Shared-runner latency made a lock semantics test fail

**Logged**: 2026-07-20T16:20:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

The first main CI after Artifact revision transactions failed only on Node 24. A cron recovery test used
`<400ms` wall-clock assertions to stand in for the actual lock state transition. The stale malformed lock
was safely recovered and the job was written, but a loaded GitHub runner crossed the timing threshold.
On a local macOS host where the process-birth probe was unavailable, the PID-reuse case also waited for the
fail-closed guard instead of skipping an unsupported probe.

### Resolution

Assert the durable state instead: the expected job exists, the mismatched guard is gone, and a live legacy
identity-less guard remains protected. Run the PID-reuse assertion only when the OS can provide a birth
identity. Keep the production lock algorithm and fail-closed behavior unchanged; do not encode shared-runner
scheduling latency as a correctness property.

---

## [ERR-20260721-FEISHU-SEND-CHAT-FLAG] Feishu send used the wrong destination flag

**Logged**: 2026-07-21T16:05:00+08:00
**Priority**: low
**Status**: resolved
**Area**: config

### Summary

The reusable Feishu client rejected a group send because `send` expects `--chat`, while the attempted
command used `--chat-id`. No message was sent.

### Error

```text
feishu_chat.py send: error: one of the arguments --chat --open-id is required
```

### Context

- Operation: register a confirmed Hara upgrade-path bug in the canonical feedback group.
- The reply subcommand correctly uses `--message-id`; the send subcommand deliberately uses `--chat`.

### Suggested Fix

Check the subcommand-specific `--help` before composing a write command and use the exact canonical chat
ID as the value of `--chat`. Preserve idempotency by retrying only after confirming the failed invocation
did not send a message.

### Metadata

- Reproducible: yes
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py

### Resolution

- **Resolved**: 2026-07-21T16:05:00+08:00
- **Notes**: Corrected the argument locally; `.learnings/` remains uncommitted.

---

## [ERR-20260721-NPM-DUPLICATE-EMPTY-CONFIG] npm rejects one path used as both user and global config

**Logged**: 2026-07-21T16:18:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: config

### Summary

A hardening probe for the source-aware updater set both `NPM_CONFIG_USERCONFIG` and
`NPM_CONFIG_GLOBALCONFIG` to `/dev/null`. npm fails closed before parsing its command when the two resolved
configuration paths are identical.

### Error

```text
Exit prior to config file resolving
cause
double-loading config "/dev/null" as "global", previously loaded as "user"
```

### Context

- Operation: execute the matching Node installation's npm CLI with credential-free fixed config paths.
- No package installation or filesystem mutation was attempted by the failing `npm --version` probe.

### Suggested Fix

Use distinct inert paths: the platform null device for user config and a separate nonexistent path for
global config. Keep the fixed registry/prefix CLI arguments and ignored lifecycle scripts.

### Metadata

- Reproducible: yes
- Related Files: src/update-install.ts, test/update-install.test.mjs

### Resolution

- **Resolved**: 2026-07-21T16:18:00+08:00
- **Notes**: Verified npm 10.9.8 succeeds when global config uses a distinct nonexistent path.

---

## [ERR-20260721-FEISHU-PREVIEW-LIMIT] Feishu preview limit was mistaken for a character budget

**Logged**: 2026-07-21T16:22:00+08:00
**Priority**: low
**Status**: resolved
**Area**: config

### Summary

Two read-only message pulls were rejected because `--preview-limit` is a message count constrained to
1–100, not a text-character budget. Values 4000 and 2000 were invalid.

### Error

```text
error: days/limit/preview-limit out of range
```

### Context

- Operation: immediately refresh the canonical Hara feedback group after the user reported a new message.
- No write or partial output occurred.

### Suggested Fix

Use the script's validation contract (`days <= 90`, `limit <= 500`, `preview-limit <= 100`) and default to
20 preview messages. The successful retry used one day, 100 fetched messages, and 20 previews.

### Metadata

- Reproducible: yes
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py

### Resolution

- **Resolved**: 2026-07-21T16:23:00+08:00
- **Notes**: Latest 39 messages were pulled successfully; the new 16:12 report had no attachment.

---

## [ERR-20260721-NPM-PACK-CACHE-SANDBOX] npm pack dry-run could not write the user cache in the sandbox

**Logged**: 2026-07-21T16:34:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The 0.130.3 package dry-run compiled successfully, then npm failed opening a temporary cache entry under
`~/.npm`. Its generic diagnostic called the cache root-owned, but the active workspace sandbox simply did
not grant writes to that user directory.

### Error

```text
npm error code EPERM
npm error syscall open
npm error path ~/.npm/_cacache/tmp/...
```

### Context

- Operation: `npm pack --dry-run --json` with the exact Node 22 toolchain.
- Do not follow npm's generic `sudo chown` suggestion without independently proving ownership is wrong.

### Suggested Fix

Rerun the unchanged pack dry-run in the approved host boundary or point npm at a task-owned temporary cache.

### Metadata

- Reproducible: yes
- Related Files: package.json, package-lock.json
- See Also: ERR-20260720-RELEASE-TEST-SANDBOX

### Resolution

- **Resolved**: 2026-07-21T16:34:00+08:00
- **Notes**: Classified as environment-only; `.learnings/` remains uncommitted.

---

## [ERR-20260722-WEB-PROXY-TEST-JS-ANNOTATION] Node test fixture accidentally used TypeScript syntax

**Logged**: 2026-07-22T03:45:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

A new `.mjs` proxy regression included a TypeScript-only parameter annotation. Node rejected the test at
parse time before it could exercise the authenticated CONNECT path.

### Resolution

Keep `test/*.mjs` fixtures plain JavaScript even when the source under test is TypeScript. Remove annotations
from inline server callbacks and let the compiled `dist/` surface carry the type checks.

---

## [ERR-20260722-UNDICI-REQUEST-OPTION-DRIFT] Proxy implementation used an unsupported request option

**Logged**: 2026-07-22T03:46:00+08:00
**Priority**: low
**Status**: resolved
**Area**: dependencies

### Summary

The first Undici 7 implementation passed `maxRedirections` to a request options type that does not accept it
at that call site. TypeScript correctly stopped the build.

### Resolution

Handle the already-bounded redirect loop in Hara and omit the unsupported transport option. Check the exact
installed major's official API/type surface before copying options across Undici entry points.

---

## [ERR-20260722-NPM-PACK-CACHE-RECURRED] Release dry-run selected the unwritable user npm cache again

**Logged**: 2026-07-22T04:10:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-validation

### Resolution

The unchanged 0.132.0 pack check passed with `--cache /private/tmp/hara-npm-cache`. Continue using a
task-owned cache for release validation; do not apply npm's generic ownership-changing suggestion.

---

## [ERR-20260722-RELEASE-TEST-FIXED-WAIT-RACE] Native release tests assumed process and Ink startup latency

**Logged**: 2026-07-22T04:20:00+08:00
**Priority**: high
**Status**: resolved
**Area**: release-validation

### Summary

The 0.132.0 Intel macOS asset job reached the real test suite but three fixtures relied on fixed 150–500ms
startup/render delays. Under release-runner contention, PID files or committed Ink state were not observable
yet, so the tests failed before exercising their intended timeout, cleanup, and history assertions.

### Resolution

Start asynchronous work first, wait for a concrete bounded handshake (valid PID content, rendered composer
text, or submission callback), and retain a separate generous total deadline so a real hang still fails.
File existence alone is not a valid PID handshake because another process may observe the created file before
its synchronous write becomes readable. The focused suites and pinned-PATH full suite must both pass before
publishing each follow-up patch.

### 0.132.3 follow-up

The release-class Intel lane later exposed three more instances of the same underlying mistake: a non-Git
completion fixture let a slow Git probe consume the filesystem budget, a TUI streaming assertion sampled a
fixed 80 ms window, and a semantic-cancellation fixture aborted before its provider registered the listener.
Use explicit marker detection or lifecycle handshakes, and run the complete suite on the release-class Intel
runner on `main` before creating an immutable npm tag.

### 0.135.2 follow-up

The main-branch Intel lane again exposed fixed-delay assumptions in two newer TUI tests. The first failed
before mounting an `ask_user` prompt and skipped `unmount()`, which polluted a later status-slot test and kept
the file alive until its 120-second deadline. Replace fixed render sleeps with bounded observable-state
handshakes and always clean up interactive fixtures in `finally`. The same run also showed that a
latency-budgeted cron preview can correctly return fewer than three entries with `nextRunDeferred: true`;
tests must assert that documented partial-result contract instead of assuming an unloaded host.

Metadata: recurrence 2, last seen 2026-07-27, Intel CI.

---

## [ERR-20260723-SANDBOX-LOOPBACK-EPERM] Local network tests cannot bind inside the workspace sandbox

**Logged**: 2026-07-23T20:10:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-validation

### Summary

The focused enrollment, provider-wire, and Serve suites failed with `listen EPERM` on loopback because the
workspace sandbox blocks even ephemeral localhost listeners. Source compilation and non-network tests were
unaffected.

### Resolution

Rerun the exact test command through the approved elevated `node --test` boundary. All 77 focused tests then
passed, including the managed DeepSeek gateway request-body and scoped model/effort checks. Treat a uniform
loopback `EPERM` as an execution-boundary failure, not a product regression.

---

## [ERR-20260724-NPM-VIEW-RESTRICTED-NETWORK-HANG] npm view stalled during public-release verification

**Logged**: 2026-07-24T18:45:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-validation

### Summary

`npm view` against the explicit npmjs registry produced no response and did
not terminate inside the restricted network boundary, even though the publish
workflow had succeeded.

### Resolution

Terminate the stalled client and verify the immutable public package metadata
directly from the official npm registry outside the restricted network
boundary. Confirm the requested version, tarball, integrity, and pinned
`gitHead`; never treat a silent `npm view` timeout as proof that a package is
absent.

### Follow-up

- **Seen again**: 2026-08-10T19:02:00+08:00
- **Context**: The correctly pinned Node 22 `npm view` pre-release probe remained silent for more than
  one minute. The exact read-only process was identified and terminated before any release mutation.
- **Resolution**: Use the official registry JSON endpoint with `curl --max-time 20` for the bounded
  preflight, then repeat the package verification after CI publication with the same hard deadline.

### Metadata

- Source: command_failure
- Reproducible: network-dependent
- Tags: npm, registry, timeout, release-verification
- Pattern-Key: release.bound_npm_registry_reads
- Recurrence-Count: 2
- Last-Seen: 2026-08-10

---

## [ERR-20260724-CRON-PREVIEW-REPARSE-TIMEOUT] Zoned cron preview repeatedly reparsed the expression

**Logged**: 2026-07-24T19:35:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary

The new `automation.validate` regression used a weekday schedule in `Asia/Shanghai` and exceeded the
20-second Serve test deadline. `nextRun` parsed the cron expression once, but then called
`cronMatches` for every scanned minute; `cronMatches` parsed the same expression again each time.

### Resolution

Split matching into a pre-parsed `cronFieldsMatch` helper. `nextRun` now parses once and reuses the
same field sets across the bounded scan. The unchanged real weekday/timezone RPC case dropped below
one second in the focused WebSocket test.

### Metadata
- Source: tool_failure
- Related Files: src/cron/schedule.ts, test/serve-e2e.test.mjs
- Tags: cron, timezone, performance, rpc, timeout
- Pattern-Key: scheduler.parse_once_for_bounded_scan
- Recurrence-Count: 1

---

## [ERR-20260724-WRONG-REPOSITORY-PATH] A cross-repository inspection used the CLI working directory

**Logged**: 2026-07-24T19:35:00+08:00
**Priority**: low
**Status**: resolved
**Area**: diagnostics

### Summary

A source inspection attempted to read Desktop's `src/client.ts` while the command working directory
was still `hara-cli`, producing a misleading missing-file failure.

### Resolution

For commands that cross Hara repositories, set the exact child-repository `workdir` explicitly before
reading paths, even when the repositories are siblings in one workspace.

### Metadata
- Source: tool_failure
- Related Files: ../hara-desktop/src/client.ts
- Tags: shell, workdir, monorepo, diagnostics
- Pattern-Key: diagnostics.bind_command_to_repository
- Recurrence-Count: 1

---

## [ERR-20260724-EXTERNAL-AGENT-PATH-CACHE] External-agent availability cache ignored PATH changes

**Logged**: 2026-07-24T19:50:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend

### Summary

The full suite exposed an order-dependent external-agent test: an earlier `claude` probe cached
`false`, then a later test added a valid temporary `claude` executable to PATH, but the bin-only cache
continued reporting it missing. The same stale result could affect a long-running Serve process after
a user installs an external agent CLI.

### Resolution

Key availability results by both backend name and the current PATH. Re-probe when the launch
environment changes; retain caching only for an identical resolution environment.

### Metadata
- Source: tool_failure
- Related Files: src/tools/external_agent.ts, test/external-agent.test.mjs
- Tags: cache, path, external-agent, serve, tests
- Pattern-Key: runtime.cache_environment_dependent_probe_by_environment
- Recurrence-Count: 1

---

## [ERR-20260724-FEISHU-REVIEW-REPORT-DNS] Feishu review report failed after a successful read

**Logged**: 2026-07-24T21:20:55+08:00
**Priority**: medium
**Status**: resolved
**Area**: infra

### Summary

The Feishu skill successfully ran `doctor` and fetched the latest Hara feedback-group messages, but the
subsequent reply that reported newly discovered 0.134.7 review findings failed during DNS resolution.

### Error

```text
error: Feishu network error: <urlopen error [Errno 8] nodename nor servname provided, or not known>
```

### Context

- Operation: reply to the existing Hara CLI 0.134.7 candidate-review message.
- Destination and message were resolved exactly; no credentials or sensitive task data were placed on the
  command line or in the report.
- The read call immediately beforehand succeeded, so this appears to be a transient/restricted network
  failure rather than missing Feishu configuration.

### Suggested Fix

Retry through the same canonical `feishu_chat.py reply` command when Feishu DNS/network access is available;
do not recreate a client or switch credential stores.

### Metadata
- Reproducible: unknown
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py
- Tags: feishu, network, dns, issue-reporting

### Resolution
- **Resolved**: 2026-07-24T21:21:30+08:00
- **Notes**: A single retry through the same canonical reply command succeeded and returned Feishu message
  `om_x100b690223b0d8a0ddb6d38ce9577c8`.

---

## [ERR-20260724-HOSTILE-CWD-SMOKE-RELATIVE-BINARY] Hostile-cwd smoke used a repository-relative binary path

**Logged**: 2026-07-24T22:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: verification

### Summary

A standalone-binary smoke intentionally changed the working directory to `/private/tmp`, but invoked
`./dist/bin/hara`. The shell correctly reported that the relative path did not exist; the built Hara
binary had not failed.

### Resolution

When a smoke test deliberately changes away from the repository, resolve the binary to an absolute path
before launching it. The absolute-path `--help` and `--version` probes both passed from `/private/tmp`.

### Metadata
- Source: tool_failure
- Related Files: dist/bin/hara
- Tags: smoke-test, hostile-cwd, path, verification
- Pattern-Key: verification.absolute_artifact_path_outside_repo
- Recurrence-Count: 1

---

## [ERR-20260724-PREPush-CODEX-PATH] Repository Node bin did not contain the Codex review command

**Logged**: 2026-07-24T22:05:00+08:00
**Priority**: low
**Status**: resolved
**Area**: verification

### Summary

The release check correctly pinned project execution to Node 22.23.1, but replacing PATH entirely with
that runtime removed the separately installed `codex` executable, so `git prepush-check` exited before
reviewing code.

### Resolution

Keep the repository-approved Node 22.23.1 bin first, then append the narrow NVM bin that contains the
Codex launcher. This preserves the project runtime while making the review command discoverable.
On 2026-08-05 the same over-narrow PATH also omitted Codex's bundled `rg`, while the review report
destination was outside the workspace-write sandbox. The retry must retain the project Node first,
append both the Codex launcher and bundled tool directory, and use the approved pre-push review path.

### Metadata
- Source: tool_failure
- Related Files: /Users/zhujianbo/.githooks/codex_prepush_check.sh
- Tags: node, nvm, codex, path, prepush
- Pattern-Key: verification.preserve_auxiliary_tool_bin_after_runtime_pin
- Recurrence-Count: 2
- Last-Seen: 2026-08-05

---

## [ERR-20260724-MULTI-FILE-PATCH-CONTEXT] One large review-fix patch used a mismatched hunk anchor

**Logged**: 2026-07-24T23:10:00+08:00
**Priority**: low
**Status**: resolved
**Area**: backend

### Summary

A multi-file patch failed atomically because one `store.ts` insertion expected a nearby declaration in
the wrong hunk position. No partial changes were applied.

### Resolution

Split the four independent review fixes into small file-scoped patches and verify each before testing.

### Metadata
- Source: tool_failure
- Related Files: src/cron/store.ts
- Tags: apply-patch, context, multi-file
- Pattern-Key: editing.split_independent_cross_file_hunks
- Recurrence-Count: 1

---

## [ERR-20260724-EXTERNAL-AGENT-PROBE-LOAD-FLAKE] Probe fixture timed out under parallel test load

**Logged**: 2026-07-24T23:32:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

A combined focused test run made the temporary `claude --version` fixture hit the five-second
availability timeout before writing its probe marker. It recurred in the 0.134.7 full release suite as
an erroneous “CLI not found” result in the output-limit process-tree test, so isolated reruns alone are
not a sufficient release gate.

### Resolution

The output-limit fixture now answers `--version` through a cheap shell builtin and starts its Node process
only for the actual external-agent run. The isolated file passed 11/11 and the complete pinned Node
22.23.1 suite then passed under parallel load.

### Metadata
- Source: tool_failure
- Related Files: test/external-agent.test.mjs, src/tools/external_agent.ts
- Tags: tests, concurrency, process-start, timeout
- Pattern-Key: tests.recheck_process_start_timeout_under_isolated_load
- Recurrence-Count: 2

---

## [ERR-20260724-CHANGELOG-PATCH-CONTEXT] Changelog review-fix patch used a wrapped-line anchor

**Logged**: 2026-07-25T00:05:00+08:00
**Priority**: low
**Status**: resolved
**Area**: docs

### Summary

The first changelog patch expected two wrapped lines as one context block and failed atomically.

### Resolution

Read the exact wrapped paragraph and apply a smaller context-specific patch; no partial edit occurred.
The same mistake recurred on 2026-08-05 when a version-bump patch omitted the blockquote marker on a
wrapped changelog line. The atomic failure left package metadata unchanged; a file-local exact-context
patch then succeeded.

### Metadata
- Source: tool_failure
- Related Files: CHANGELOG.md
- Tags: apply-patch, markdown, context
- Pattern-Key: editing.inspect_wrapped_markdown_before_patch
- Recurrence-Count: 2
- Last-Seen: 2026-08-05

---

## [ERR-20260725-NPM-PUBLIC-VERIFY-NODE11] Public npm smoke inherited the workstation's Node 11

**Logged**: 2026-07-25T09:53:24+08:00
**Priority**: medium
**Status**: resolved
**Area**: infra

### Summary

The isolated npm installation of `@nanhara/hara@0.134.8` succeeded, but the first execution of its
generated `.bin/hara` shim inherited the workstation's system Node 11 and correctly stopped at Hara's
Node 22.12 runtime floor. This was a verification-environment error, not a published-package failure.

### Error

```text
Hara requires Node.js 22.12.0 or newer (detected 11.4.0).
```

### Context

- The install command explicitly selected the repository Node runtime.
- The subsequent direct `.bin/hara --version` command omitted the pinned `PATH`.
- Non-interactive public-artifact smoke commands are subject to the same legacy-Node resolution as
  npm, pnpm, and small Node verification snippets.

### Suggested Fix

Treat installation and execution as one toolchain-bound verification unit: prepend the
repository-approved Node 22 `bin` directory to every command that executes an npm-installed shim,
including a shim reached by an absolute path.

### Metadata
- Reproducible: yes
- Related Files: package.json, runtime-bootstrap.cjs, AGENTS.md
- Tags: npm, public-artifact, smoke-test, node, nvm, path
- See Also: ERR-20260724-RELEASE-VERSION-CHECK-USED-NODE11, ERR-20260724-CODEX-REVIEW-LEGACY-NODE

### Resolution
- **Resolved**: 2026-07-25T09:53:24+08:00
- **Notes**: Re-execute the public package shim with Node 22.23.1 first on `PATH`; retain the initial
  failure as positive evidence that the published runtime guard works.
- **Seen again**: 2026-08-24T17:47:00+08:00 while verifying public npm metadata for CLI 0.152.1. A
  standalone `npm view` omitted the pinned PATH and failed on Node 11 before making a registry claim.
  Re-running with Node 22.23.1 first returned version 0.152.1 and the expected package integrity.
- **Recurrence-Count**: 2

---

## [ERR-20260725-FEISHU-PREVIEW-LIMIT] Feishu message preview exceeded the helper's protected range

**Logged**: 2026-07-25T09:56:07+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary

The pre-release Feishu intake refresh requested `--preview-limit 800`; the shared helper rejects values
above 100 before making an API request.

### Error

```text
error: days/limit/preview-limit out of range
```

### Suggested Fix

Use `--preview-limit 100` or less. The independent message-fetch `--limit` may be as high as 500, while
the rendered preview limit is intentionally capped at 100.

### Metadata
- Reproducible: yes
- Related Files: /Users/zhujianbo/.codex/skills/feishu-communicate/scripts/feishu_chat.py
- Tags: feishu, api, message-intake, parameter-validation

### Resolution
- **Resolved**: 2026-07-25T09:56:07+08:00
- **Notes**: Retried the read-only group refresh with the documented 100-message preview cap.

---

## [ERR-20260805-GHCR-SECONDARY-RATE-LIMIT] GHCR rejected a completed multi-architecture push

**Logged**: 2026-08-05T01:00:00+08:00
**Priority**: medium
**Status**: in_progress
**Area**: infra

### Summary

The Hara CLI 0.138.1 release built both OCI architectures successfully, but GHCR rejected the final
manifest push with GitHub's transient secondary-rate-limit HTTP 403. npm, CI, the immutable GitHub
release, and both public Darwin execution checks had already passed.

### Error

```text
failed to push ghcr.io/hara-cli/hara:0.138.1: 403 Forbidden
You have exceeded a secondary rate limit. Please wait a few minutes before you try again.
```

### Suggested Fix

Rerun only the failed release job after a bounded delay and verify the public multi-architecture
manifest before considering the release train complete. If this recurs, add a bounded registry-push
retry that never rebuilds or changes the tagged source identity.

### Metadata
- Reproducible: intermittent
- Related Files: .github/workflows/release.yml
- Tags: release, ghcr, docker, rate-limit, retry
- Pattern-Key: release.ghcr_push_retry_secondary_rate_limit
- Recurrence-Count: 1

### Resolution
- **Resolved**: 2026-08-05T01:04:00+08:00
- **Notes**: Waited for the bounded GitHub secondary limit to clear, reran only the failed image job,
  and required the complete release workflow to finish successfully before advancing Desktop.

---

## [ERR-20260806-FEISHU-CACHE-SHAPE] Feedback cache top level was mistaken for the message array

**Logged**: 2026-08-06T18:11:59+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

A read-only `jq` audit indexed the Feishu sync cache as an array, but the cache is an object whose
`messages` field contains the array. The query failed before returning message details; the fetched cache
itself was intact.

### Error

```text
jq: error: Cannot index object with object
```

### Resolution

Inspect `type` and `keys` before querying a generated integration artifact, then select `.messages[]` for
this cache schema.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: /private/tmp/hara-feedback-latest-inspect-20260806.json
- Tags: feishu, jq, cache-schema, message-intake
- Pattern-Key: tooling.inspect_generated_json_shape_before_query
- Recurrence-Count: 1

---

## [ERR-20260806-CLI-PIN-FILE-ASSUMPTION] CLI toolchain probe assumed Desktop pin files

**Logged**: 2026-08-06T20:03:47+08:00
**Priority**: low
**Status**: resolved
**Area**: release-validation

### Summary

A read-only baseline command tried to read `.node-version` and `.bun-version` from `hara-cli` because
Desktop uses those pin files. The CLI repository has no matching files, so `sed` exited non-zero after the
package metadata was printed.

### Error

```text
sed: .node-version: No such file or directory
```

### Resolution

Discover repository-specific pin files with `rg --files` before reading them. For this release train, use
Desktop's exact Node/Bun pins where the coupled workflow requires them and CLI's declared Node engine plus
the already verified release toolchain elsewhere.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: package.json, ../hara-desktop/.node-version, ../hara-desktop/.bun-version
- Tags: release, toolchain, node, bun, discovery
- Pattern-Key: tooling.discover_repo_pin_files_before_reading
- Recurrence-Count: 1

---

## [ERR-20260806-TASK-INTAKE-SOURCE-PATH] Task-intake implementation path was guessed from its test name

**Logged**: 2026-08-06T20:10:42+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

A read-only source inspection assumed the `task_intake` implementation lived in
`src/tools/task-intake.ts`. The tool is defined inside `src/agent/loop.ts`, so the final `sed` operand did
not exist even though the preceding test ranges were read successfully.

### Error

```text
sed: src/tools/task-intake.ts: No such file or directory
```

### Resolution

Locate symbol definitions with `rg -n 'name: "task_intake"|applyTaskBrief' src` before selecting source
ranges; do not infer implementation layout from test filenames.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: src/agent/loop.ts, test/task-intake.test.mjs
- Tags: source-discovery, task-intake, rg, tooling
- Pattern-Key: tooling.locate_symbol_before_assuming_test_mirrors_source_path
- Recurrence-Count: 1

---

## [ERR-20260806-DESKTOP-REPEATED-DIRECTORY-PATCH] Link hardening patch matched the earlier directory helper

**Logged**: 2026-08-06T20:17:43+08:00
**Priority**: medium
**Status**: resolved
**Area**: editing

### Summary

A patch intended to add Windows reparse-point handling inside `ensure_desktop_media_directory` anchored on
a repeated `match fs::symlink_metadata(directory)` block and landed in the earlier
`ensure_managed_cli_directory` helper. Rust compiled but warned that the inserted mutable variable was not
needed on macOS; the intended helper remained unchanged.

### Resolution

Restore the earlier helper and replace the full, function-named `ensure_desktop_media_directory` block instead
of relying on an inner branch that is textually identical elsewhere. A later attempt that included both function
names but still used a shared hunk body matched the earlier helper again; only full-function context prevented
the recurrence. Formatting and focused Rust tests verify both helpers.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: ../hara-desktop/src-tauri/src/lib.rs
- Tags: apply-patch, duplicate-context, rust, security
- Pattern-Key: editing.anchor_repeated_blocks_by_function_name
- Recurrence-Count: 2
- See Also: ERR-20260724-DUPLICATE-RPC-PATCH-CONTEXT

---

## [ERR-20260806-DESKTOP-TEST-ROOT-COLLISION] Consecutive native fixture roots were not guaranteed distinct

**Logged**: 2026-08-06T20:19:15+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The pasted-image symlink test called the timestamp-based `test_root()` helper twice consecutively. On this
filesystem both calls could observe the same clock value, so the supposed outside directory equaled the test
root and cleanup failed with `File exists`.

### Resolution

Derive the outside directory from the first root with an explicit `-outside` suffix and unlink the fixture
symlink before recursive cleanup. The five focused native attachment tests then passed.

### Metadata

- Source: command_failure
- Reproducible: timing-dependent
- Related Files: ../hara-desktop/src-tauri/src/lib.rs
- Tags: rust, test-fixture, temp-directory, collision
- Pattern-Key: tests.derive_distinct_fixture_paths_without_clock_only_identity
- Recurrence-Count: 1

---

## [ERR-20260806-SERVE-STORE-FIXTURE] New task-state assertion referenced an unnamed memory store

**Logged**: 2026-08-06T20:19:15+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The Serve failure/empty-response regression still passed `memStore()` inline to `baseDeps`, while a new
assertion tried to inspect `store.saved`. The host-network E2E reached the assertion and failed with
`ReferenceError: store is not defined` after the other 36 cases passed.

### Resolution

Assign `const store = memStore()` before starting Serve, pass that exact instance to `baseDeps`, and rerun
the focused failure/empty test before the full matrix.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: test/serve-e2e.test.mjs
- Tags: test, serve, fixture, task-state
- Pattern-Key: tests.name_fixture_before_asserting_persisted_state
- Recurrence-Count: 1

---

## [ERR-20260806-DESKTOP-CSS-PATH-GUESS] Source inspection included nonexistent paths

**Logged**: 2026-08-06T20:24:00+08:00
**Priority**: low
**Status**: resolved
**Area**: repository-navigation

### Summary

A read-only `rg` command included `src/WorkStarter.css` by assumption, but the component styles live in
`src/App.css`. The same mistake recurred while looking for CLI release guidance by including a nonexistent
`WORKFLOW.md` beside an existing `AGENTS.md`. Ripgrep returned exit code 2 even though useful matches were
otherwise available.

### Resolution

Resolve candidate files with `rg --files` before passing explicit paths, or search the existing `src`
directory and narrow the matches afterward. Continue using `src/App.css` for the composer drop-state styles.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: AGENTS.md, ../hara-desktop/src/App.css, ../hara-desktop/src/WorkStarter.tsx
- Tags: rg, repository-navigation, css
- Pattern-Key: navigation.resolve_paths_before_explicit_rg_targets
- Recurrence-Count: 2

---

## [ERR-20260806-SANDBOX-PROCESS-LIST] Push diagnosis attempted process listing inside the sandbox

**Logged**: 2026-08-06T20:45:00+08:00
**Priority**: low
**Status**: resolved
**Area**: diagnostics

### Summary

While a network push produced no output, a default-sandbox `ps aux` diagnostic failed with
`operation not permitted`. This workstation intentionally blocks process enumeration in the workspace
sandbox, which was also part of the tester's feedback.

### Resolution

Rerun only the necessary read-only diagnostic with approval and a narrowly filtered
`ps -axo pid,ppid,etime,state,command` query. It confirmed that `git push` was waiting in its GitHub SSH
transport, not in a repository pre-push test. Do not weaken Hara's model-facing sandbox or expose a broad
process list merely to make release diagnostics more convenient.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: AGENTS.md
- Tags: sandbox, ps, git-push, diagnostics
- Pattern-Key: sandbox.process_listing_requires_narrow_approved_diagnostic
- Recurrence-Count: 1

---

## [ERR-20260806-GIT-PUSH-SSH-HANG] Unbounded SSH push stalled before updating the remote

**Logged**: 2026-08-06T20:47:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: release

### Summary

`git push origin main` remained in `ssh git@github.com git-receive-pack` for more than four minutes with
no output, and a separate GitHub API read confirmed that `main` still pointed to the old commit. The first
bounded Desktop push later timed out while connecting to GitHub's port 22; its remote also remained unchanged.

### Resolution

Reconfirm the exact process IDs, terminate only the stalled push, and retry with an ephemeral
`GIT_SSH_COMMAND` using a 20-second connect timeout plus bounded server-alive probes. The retry pushed
`main` successfully, and the GitHub API verified the exact release SHA before the annotated tag was created.
For the later connection timeout, reconfirm the Desktop remote SHA and retry the same bounded command once;
that retry succeeded. Use these bounded settings and remote-SHA checks for subsequent release pushes.

### Metadata

- Source: command_failure
- Reproducible: network-dependent
- Related Files: .git/config
- Tags: git, ssh, github, release, timeout
- Pattern-Key: release.bound_git_ssh_push_transport
- Recurrence-Count: 3
- Last-Seen: 2026-08-27

---

## [ERR-20260806-GHCR-PULL-TLS-TIMEOUT] First public container pull timed out during TLS handshake

**Logged**: 2026-08-06T21:24:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-verification

### Summary

The first `docker pull ghcr.io/hara-cli/hara:0.141.1` attempt failed with a transient TLS handshake
timeout before the public-image smoke test could run.

### Resolution

Retry the exact immutable release tag once outside the restricted network sandbox, then verify the
reported registry digest and execute the image with `--version`. The retry completed with digest
`sha256:22ca7421eb76fc929697b099c698599cb1ebcfd018a774f4cff2753895dda3ad`, and the container reported
Hara CLI `0.141.1`.

### Metadata

- Source: command_failure
- Reproducible: network-dependent
- Related Files: .github/workflows/release.yml
- Tags: docker, ghcr, tls, release-verification
- Pattern-Key: release.retry_public_registry_tls_once_then_verify_digest
- Recurrence-Count: 1

---
## [ERR-20260808-ARTIFACT-FCHMOD-SANDBOX] Artifact focused test cannot tighten temporary file mode in managed sandbox

**Logged**: 2026-08-08T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The focused presentation suite built successfully, but its Artifact create path failed before the product
assertion when the managed workspace sandbox rejected `fchmod` on an isolated temporary private-state file.

### Resolution

Keep the private-state permission hardening intact and rerun the unchanged focused suite in the approved
host test boundary. Treat this exact pre-assertion `EPERM: operation not permitted, fchmod` signature as an
execution-boundary failure, not a presentation regression.

The same boundary recurred on 2026-08-29 while a read-only real-device External Session probe initialized
its device-stable identity under `~/.hara`: the sandbox rejected `fchmod` before Codex or Claude discovery.
The unchanged probe passed at the approved host boundary with both sources ready. Keep the private directory
mode checks strict and move real-Home probes to that boundary.

### Metadata

- Source: command_failure
- Reproducible: sandbox-dependent
- Related Files: test/presentations.test.mjs, src/security/private-state.ts, src/external-sessions/identity.ts
- Tags: tests, sandbox, artifact, permissions, fchmod
- Pattern-Key: test.managed_sandbox_blocks_artifact_fchmod
- Recurrence-Count: 2
- Last-Seen: 2026-08-29

---
## [ERR-20260810-CROSS-SHELL-WARNING-ASSERTION] Warning copy assertion used the wrong phrase order

**Logged**: 2026-08-10T18:15:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The focused cross-shell warning test expected “inside the script” before “UTF-8”, while the actual
copy correctly says to set UTF-8 inside the script.

### Error

```text
AssertionError: powershell -Command "上传 文件.pdf"
```

### Context

- Command: Node 22 focused `test/tools.test.mjs test/analysis-sop.test.mjs`
- Production detection and copy were correct; only the new assertion order was inverted.

### Suggested Fix

Match the semantic phrase in its real order without weakening the required content checks.

### Metadata

- Reproducible: yes
- Related Files: test/tools.test.mjs, src/tools/builtin.ts

### Resolution

- **Resolved**: 2026-08-10T18:15:00+08:00
- **Notes**: Corrected the assertion to require `ASCII-only`, `-File`, `UTF-8`, and `inside the script`
  in the emitted order.

---
## [ERR-20260814-MULTIFILE-PATCH-STALE-CONTEXT] Multi-file patch assumed an outdated helper body

**Logged**: 2026-08-14T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: development-workflow

### Summary

A multi-file `apply_patch` was rejected atomically because one hunk assumed a return expression included
`model.trim()`, while the current helper passed `model` directly to the regular expression.

### Resolution

Read the exact target excerpts immediately before cross-file mechanical edits, and split behavioral and
fixture patches when one stale context hunk would reject an otherwise valid group.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: src/org-fleet/enroll.ts, test/deepseek-factory.test.mjs
- Tags: apply-patch, context, workflow
- Pattern-Key: editing.read_exact_context_before_multifile_patch
- Recurrence-Count: 2

---

## [ERR-20260814-PARALLEL-HARA-PROFILE-DIAGNOSTIC] Parallel Hara CLI probes produced conflicting profile resolution

**Logged**: 2026-08-14T04:15:00+08:00
**Priority**: low
**Status**: resolved
**Area**: development-workflow

### Summary

Two concurrent image-routing probes shared Hara's persisted identity/runtime state. One correctly used the
configured Qwen connection while the other unexpectedly resolved the personal profile as an unauthenticated
Anthropic provider, so the parallel comparison could not be treated as product evidence.

### Error

```text
Not authenticated for profile 'personal' (provider 'anthropic').
```

### Resolution

Run Hara CLI integration probes serially and explicitly pin the provider/model inputs. Parallelize only
stateless source inspection or isolated provider calls, never commands that may refresh or persist the same
profile/runtime state.

### Metadata

- Source: command_failure
- Reproducible: concurrency-dependent
- Related Files: src/index.ts, src/profile/profile.ts
- Tags: diagnostics, profile, concurrency, qwen
- Pattern-Key: diagnostics.serialize_shared_hara_profile_probes
- Recurrence-Count: 1

---

## [ERR-20260822-PARALLEL-BUILD-DIST-TEST] Dist-consuming test raced the build that produces dist

**Logged**: 2026-08-22T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: development-workflow

### Summary

The TypeScript build and a focused test importing `dist/agent/loop.js` were started in parallel. The test
read the previous dist output before the build replaced it, so a new progress-acknowledgement assertion
failed even though the source build succeeded.

### Resolution

Build before running any test that imports generated `dist` files. Parallelize only test groups that consume
the same already-complete build, never a producer and its consumer.

### Metadata

- Source: command_failure
- Reproducible: concurrency-dependent
- Related Files: src/agent/loop.ts, test/task-intake.test.mjs
- Tags: tests, build, concurrency, dist
- Pattern-Key: tests.serialize_generated_artifact_producer_consumer
- Recurrence-Count: 1

---

## [ERR-20260823-NPM-PACK-GLOBAL-CACHE] Release pack probe inherited an unusable shared npm cache

**Logged**: 2026-08-23T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-workflow

### Summary

`npm pack --dry-run` completed its prepare/build step but failed when npm tried to create a temporary cache
file under a global cache containing root-owned entries. The package source and build were not the cause.

### Error

```text
npm error code EPERM
npm error syscall open
npm error path ~/.npm/_cacache/tmp/...
```

### Resolution

Use a task-private cache such as `/private/tmp/hara-npm-cache` for read-only packaging and registry probes on
this workstation. Do not change ownership of the user's whole npm cache or require sudo for a release gate.

### Metadata

- Source: command_failure
- Reproducible: yes
- Related Files: package.json, package-lock.json
- Tags: npm, cache, packaging, permissions
- Pattern-Key: release.use_task_private_npm_cache
- Recurrence-Count: 1

---

## [ERR-20260824-EDIT-FILE-SYNTAX-RECOVERY] Invalid generated Python was followed by an identical failed repair

**Logged**: 2026-08-24T17:12:01+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary

Hara Desktop 0.1.104 / CLI 0.152.0 generated a Python helper with invalid quote syntax, then the Agent
submitted the same failing `edit_file` repair twice instead of reading the exact current line and changing
strategy. The repeated-failure guard correctly stopped the run, but the task remained incomplete.

### Error

```text
SyntaxError: invalid syntax
agent run stopped: the same failing edit_file call repeated 2 times. Change the approach or fix the
reported cause before retrying.
```

### Context

- Source report: Feishu `hara 反馈群`, message `om_x100b67f4d71a588cb25fe948907f54c`, Windows Desktop
  0.1.104 with engine 0.152.0 and `qwen3.7-plus`.
- The screenshot shows a newly generated `.py` file containing typographic quote characters in Python
  syntax and a malformed nested-quote URL assignment at the reported line. Folder/chat identifiers are
  intentionally omitted here.
- Python parses the whole file before executing it, so the failing invocation did not reach the rename or
  upload operations.
- `REPEATED_FAILURE_LIMIT=2` behaved as designed. The defect is the missing syntax-aware validation and
  ineffective repair path, not the circuit breaker itself.

### Suggested Fix

Keep the repeated-failure stop, but add a sanitized regression that writes invalid Python with typographic
syntax quotes, returns the exact parser line/column, and requires the next repair to re-read the current
line and use materially different edit arguments. Add a language-aware syntax check before executing a
newly written Python helper. Do not blindly normalize every curly quote because typographic quotes may be
intentional string data. Surface the failed `edit_file` reason next to the final stop so Desktop users can
distinguish “old string not found” from the original program syntax error.

### Resolution

Implemented for CLI 0.152.1. The runtime now recognizes Python parse-time diagnostics from shell and direct
Python tool results, emits a basename/line-scoped recovery instruction, and blocks `edit_file`/`write_file`
on that source until `read_file` has observed the exact current file. The model prompt also distinguishes
the normal no-reread optimization from mandatory post-failure inspection. A sanitized Feishu feedback trace
and deterministic agent-loop regression cover the recovery path; the final CLI suite passed 1439 tests with
0 failures and 1 platform skip, and native boundary/Serve smokes passed.

### Metadata

- Source: user_feedback
- Reproducible: unknown (screenshot evidence is deterministic; original session is remote)
- Related Files: src/agent/loop.ts, src/agent/repeat-guard.ts, src/tools/edit.ts, test/agent-limits.test.mjs
- Tags: desktop, windows, qwen, python, edit-file, recovery, repeated-failure
- Pattern-Key: agent.syntax_failure_requires_materially_different_repair
- Recurrence-Count: 1

---

## [ERR-20260824-NESTED-SEATBELT-TEST] Nested macOS sandbox made a cancellation test report exit 71

**Logged**: 2026-08-24T18:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: testing

### Summary

The focused `runShell` cancellation test failed inside the coding workspace because Hara's child
`sandbox-exec` could not apply a second Seatbelt profile. The product process never reached its intended
cancellation path.

### Error

```text
sandbox-exec: sandbox_apply: Operation not permitted
Error: exit code 71
```

### Resolution

Re-run tests that intentionally exercise Hara's own macOS Seatbelt boundary outside the outer workspace
sandbox. The same focused test passed there; do not weaken Hara's sandbox or broaden the assertion to accept
exit 71.

### Metadata

- Source: command_failure
- Reproducible: yes, only under nested Seatbelt
- Related Files: src/sandbox.ts, test/agent-limits.test.mjs
- Tags: tests, macos, sandbox, seatbelt
- Pattern-Key: tests.nested_seatbelt_requires_unsandboxed_runner
- Recurrence-Count: 3
- Last-Seen: 2026-09-01

---

## [ERR-20260824-GITHUB-RUN-WATCH-TLS] GitHub Actions watcher hit a transient TLS timeout

**Logged**: 2026-08-24T17:50:00+08:00
**Priority**: low
**Status**: resolved
**Area**: release-workflow

### Summary

`gh run watch` stopped while the release continued remotely because one GitHub API request timed out during
the TLS handshake. Completed jobs and the workflow itself were unaffected.

### Error

```text
failed to get run: TLS handshake timeout
```

### Resolution

Re-query the run by immutable database ID with `gh run view`; do not rerun or retag based on a watcher
transport error. The authoritative run remained in progress with every completed job successful.

### Metadata

- Source: external_api_failure
- Reproducible: no
- Related Files: .github/workflows/release.yml
- Tags: github-actions, tls, release, monitoring
- Pattern-Key: release.requery_authoritative_run_after_watcher_timeout
- Recurrence-Count: 1

---

## [ERR-20260824-POST-ACTION-OWNERSHIP] Completed tool work was mislabeled as advice-only delegation

**Logged**: 2026-08-24T18:10:00+08:00
**Priority**: high
**Status**: resolved
**Area**: agent-runtime

### Summary

After a successful change tool had already saved the requested records, a model omitted the formal
`task_checkpoint` completion receipt twice. The action-ownership guard considered only each later
prose-only response and reported that the model had never acted.

### Resolution

Track successful edit/exec/computer effects across the run. Ask once for the missing verification receipt;
if it is still omitted, preserve the real tool result and final summary as a resumable checkpoint rather
than emitting the advice-only failure. Read-only investigation remains insufficient, and the engine never
fabricates verified completion evidence. Deterministic tests cover both branches and the sanitized feedback
suite now includes the post-action receipt transition.

### Metadata

- Source: user_feedback
- Reproducible: yes
- Related Files: src/agent/loop.ts, test/task-intake.test.mjs, evals/feedback/post-action-completion-receipt.json
- Tags: desktop, agent, execution-ownership, completion-receipt, false-positive
- Pattern-Key: agent.ownership_guard_distinguishes_missing_receipt_after_action
- Recurrence-Count: 1

---

## [ERR-20260824-LOOPBACK-SANDBOX] Full network tests need a loopback-capable release runner

**Logged**: 2026-08-24T18:12:00+08:00
**Priority**: low
**Status**: resolved
**Area**: testing

### Summary

The outer coding sandbox rejected local HTTP and WebSocket fixtures with `listen EPERM: operation not
permitted 127.0.0.1`, causing many unrelated tests to fail with one environmental error class.

### Resolution

Keep the tests strict and rerun the identical full suite in the approved loopback-capable release runner.
That run passed all 1441 tests. Do not weaken localhost integration coverage to accommodate the outer
sandbox.

### Metadata

- Source: command_failure
- Reproducible: yes, only in the outer restricted sandbox
- Related Files: test/deepseek-factory.test.mjs, test/web.test.mjs, test/wecom-gateway.test.mjs, test/serve-agent-identity.test.mjs
- Tags: tests, sandbox, loopback, websocket, http
- Pattern-Key: tests.loopback_fixtures_require_release_runner
- Recurrence-Count: 3
- Last-Seen: 2026-09-02

---

## [ERR-20260824-NPM-CACHE-OWNERSHIP] npm pack could not use the shared cache

**Logged**: 2026-08-24T18:13:00+08:00
**Priority**: low
**Status**: resolved
**Area**: packaging

### Summary

`npm pack --dry-run` failed because a pre-existing shared npm cache entry was owned by root. Changing the
ownership of the whole workstation cache would have been unnecessarily broad.

### Resolution

Use a task-specific private `NPM_CONFIG_CACHE` created under `/private/tmp` for packaging. The dry run then
completed with the expected 0.152.2 manifest and integrity receipt.

### Metadata

- Source: command_failure
- Reproducible: yes with the shared cache
- Related Files: package.json, package-lock.json
- Tags: npm, packaging, cache, permissions
- Pattern-Key: release.use_private_npm_cache_when_shared_cache_is_unsafe
- Recurrence-Count: 3
- Last-Seen: 2026-08-29

---
