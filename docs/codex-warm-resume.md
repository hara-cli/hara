# Codex resident launcher lifetime

Some Codex installations launch the native app-server as a child of an npm Node shim. The owned
Host spawn handle belongs to that shim. Treating every descendant of the first attempt as a tool
kills the app-server during an otherwise successful resident drain, causing the next message to
start another process even though the conversation and thread binding are unchanged.

After initialize and a validated idle thread/start or thread/resume response, S3 calls the
Host-only `policy.prepareResidentRoot()` once, before the first turn/start. It snapshots only
already-owned process identities using the existing birth/group/observed-ancestry supervisor;
there is no PID, command or path parameter. This does not reset workspace diff/evidence. A second
promotion on that root or a promotion by an attempt-lifetime policy is rejected.

During an attempt drain, the launcher and initialized resident children are stopped together,
then this attempt's later descendants are removed. Those verified resident processes resume only
once cleanup is certified. Whole-policy close still drains every owned process, including the
initial native child. Tier/protection/proxy changes and native failure continue to recycle the
process and resume the original thread, with the existing no-replay rules and bearer rotation.

The five-minute idle expiry, protected paths, permissions, model/effort, task/round/token budgets,
context construction, MCP admission and confirmation cards are unchanged. The existing supervisor
limit remains: an unobserved daemon that instantly detaches/reparents between samples is outside
its proven coverage.

Tests use a launcher/native-child pair as well as direct process fixtures. They assert stable
native PID and thread across fresh attempts with no additional cold_start, removal of later tool
children, final whole-tree close, and tier/failure recovery without prompt replay. Local receipts
separately record actual CLI version, zero-model before/after probes and the authorized real-turn
ledger; synthetic passes do not substitute for native acceptance.
