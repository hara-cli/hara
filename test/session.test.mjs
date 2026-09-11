import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync, readFileSync, mkdirSync, mkdtempSync, statSync, readdirSync, truncateSync, utimesSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSessionLock,
  releaseSessionLock,
  isGeneratedSessionId,
  newSessionId,
  shortId,
  resolveSessionId,
  saveSession,
  loadSession,
  deleteSession,
  ensureSessionMetadataIndex,
  findSessionMetadataByFragment,
  listSessionMetadataPage,
  listSessions,
  latestForCwd,
  titleFrom,
  deriveTitle,
  sanitizeSessionTitle,
  validSessionId,
  sessionFileExists,
  MAX_SESSION_FILE_BYTES,
  MAX_SESSION_JSON_DEPTH,
  readSessionJournal,
  recordSessionApprovalState,
  recordSessionCompactionState,
  recordSessionProviderRetry,
  recordSessionRuntimeItem,
  recordSessionTaskState,
  replaySessionJournal,
} from "../dist/session/store.js";
import { SessionHub } from "../dist/serve/sessions.js";
import { createTaskExecution } from "../dist/session/task.js";

test("session id is a full UUID", () => {
  const id = newSessionId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(isGeneratedSessionId(id), true);
  assert.equal(isGeneratedSessionId("short-prefix"), false);
});

test("session ids cannot escape the private session directory", () => {
  for (const id of ["../outside", "a/b", "a\\b", "", ".", "..", `x${"y".repeat(221)}`]) {
    assert.equal(validSessionId(id), false, id);
    assert.equal(loadSession(id), null, id);
    assert.equal(acquireSessionLock(id).ok, false, id);
  }
  assert.equal(validSessionId("feishu-oc_123-uabc123-deadbe"), true);
  assert.equal(resolveSessionId("../../outside"), null);
});

test("deriveTitle: auto-summarizes the first message, keeps CJK, drops slash-commands, caps length", () => {
  assert.equal(deriveTitle("能识别图片吗"), "能识别图片吗"); // CJK preserved (not slugified to a random word)
  assert.equal(deriveTitle("/model glm-5"), "glm-5"); // leading slash-command dropped
  assert.equal(deriveTitle("  fix   the  null  check  "), "fix the null check"); // whitespace collapsed
  assert.equal(deriveTitle(""), ""); // blank → empty (caller falls back to short id)
  assert.ok(deriveTitle("x".repeat(80)).endsWith("…")); // long input capped
  const fakeSecret = "sk-sessiontitle1234567890";
  assert.equal(deriveTitle(`排查登录 ${fakeSecret}`), "排查登录 credential");
  assert.equal(sanitizeSessionTitle(`API_KEY=${fakeSecret}`), "credential");
});

test("session persistence validates and retains stable compaction window identity", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-compaction-window-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const id = "compaction-window-fixture";
    const at = "2026-09-06T00:00:00.000Z";
    saveSession({
      id,
      cwd: project,
      provider: "fixture",
      model: "fixture-model",
      title: "window fixture",
      createdAt: at,
      updatedAt: at,
      compaction: {
        windowId: "11111111-1111-4111-8111-111111111111",
        attemptId: "22222222-2222-4222-8222-222222222222",
        installedAt: at,
        sourceMessages: 8,
        replacementMessages: 3,
        sourceInputTokens: 1_234,
        inputAccounting: "provider",
      },
    }, [{ role: "user", content: "checkpoint" }]);
    assert.deepEqual(loadSession(id)?.meta.compaction, {
      windowId: "11111111-1111-4111-8111-111111111111",
      attemptId: "22222222-2222-4222-8222-222222222222",
      installedAt: at,
      sourceMessages: 8,
      replacementMessages: 3,
      sourceInputTokens: 1_234,
      inputAccounting: "provider",
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session persistence retains only a bounded Serve migration verifier", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-serve-migration-home-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  const id = newSessionId();
  const pausedAt = "2026-09-10T00:00:00.000Z";
  const suspensionId = "11111111-1111-4111-8111-111111111111";
  const verifier = "a".repeat(64);
  try {
    saveSession({
      id,
      cwd: project,
      provider: "fixture",
      model: "fixture-model",
      title: "migration fixture",
      createdAt: pausedAt,
      updatedAt: pausedAt,
      serveSuspension: {
        v: 1,
        state: "migrating",
        suspensionId,
        itemId: `serve-migrating:${suspensionId}`,
        pausedAt,
        sourceInstanceId: "22222222-2222-4222-8222-222222222222",
        taskId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        migrationTokenSha256: verifier,
        expiresAt: "2026-09-10T00:02:00.000Z",
      },
    }, [{ role: "user", content: "private migration history" }]);
    assert.deepEqual(loadSession(id)?.meta.serveSuspension, {
      v: 1,
      state: "migrating",
      suspensionId,
      itemId: `serve-migrating:${suspensionId}`,
      pausedAt,
      sourceInstanceId: "22222222-2222-4222-8222-222222222222",
      taskId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      migrationTokenSha256: verifier,
      expiresAt: "2026-09-10T00:02:00.000Z",
    });
    const transcript = readFileSync(join(home, ".hara", "sessions", `${id}.json`), "utf8");
    assert.match(transcript, new RegExp(verifier));
    assert.doesNotMatch(transcript, /migrationToken"|raw-migration-token/);
  } finally {
    deleteSession(id);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session persistence retains a write-ahead command receipt without prompt content", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-command-started-home-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  const id = newSessionId();
  const at = "2026-09-07T00:00:00.000Z";
  try {
    saveSession({
      id,
      cwd: project,
      provider: "fixture",
      model: "fixture-model",
      title: "",
      createdAt: at,
      updatedAt: at,
      commandReceipts: [{
        v: 1,
        commandId: "11111111-1111-4111-8111-111111111111",
        method: "session.submit",
        requestHash: "a".repeat(64),
        startedAt: at,
      }],
    }, []);
    const loaded = loadSession(id);
    assert.deepEqual(loaded?.meta.commandReceipts, [{
      v: 1,
      commandId: "11111111-1111-4111-8111-111111111111",
      method: "session.submit",
      requestHash: "a".repeat(64),
      startedAt: at,
    }]);
    assert.doesNotMatch(readFileSync(join(homedir(), ".hara", "sessions", `${id}.json`), "utf8"), /possibly executed|run once/);
  } finally {
    deleteSession(id);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session command receipts round-trip redacted and stay out of metadata sidecars", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-command-receipt-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const id = "command-receipt-fixture";
    const at = "2026-09-06T01:00:00.000Z";
    const commandId = "11111111-1111-4111-8111-111111111111";
    const fakeSecret = "sk-commandreceipt1234567890";
    saveSession({
      id,
      cwd: project,
      provider: "fixture",
      model: "fixture-model",
      title: "receipt fixture",
      createdAt: at,
      updatedAt: at,
      commandReceipts: [{
        v: 1,
        commandId,
        method: "session.submit",
        requestHash: "a".repeat(64),
        completedAt: at,
        outcome: { kind: "result", json: JSON.stringify({ reply: `done ${fakeSecret}` }) },
      }],
    }, [{ role: "user", content: "run once" }]);

    const loaded = loadSession(id);
    assert.equal(loaded.meta.commandReceipts[0].commandId, commandId);
    assert.equal(loaded.meta.commandReceipts[0].requestHash, "a".repeat(64));
    assert.doesNotMatch(loaded.meta.commandReceipts[0].outcome.json, new RegExp(fakeSecret));
    const sidecar = readFileSync(join(home, ".hara", "sessions", `${id}.metadata`), "utf8");
    assert.doesNotMatch(sidecar, /commandReceipts|sk-commandreceipt/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session projection journal is append-only, chained, and ignores a torn final record", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-journal-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const id = "projection-journal-fixture";
    const meta = {
      id,
      cwd: project,
      provider: "fixture",
      model: "fixture-model",
      title: "journal",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    };
    saveSession(meta, [{ role: "user", content: "first" }]);
    saveSession(meta, [
      { role: "user", content: "first" },
      { role: "assistant", text: "second", toolUses: [] },
    ]);
    const complete = readSessionJournal(id);
    assert.deepEqual(complete.events.map((event) => event.sequence), [1, 2]);
    assert.equal(complete.events[1].previousGeneration, complete.events[0].storageGeneration);
    assert.equal(complete.events[1].historyLength, 2);
    assert.equal(replaySessionJournal(complete.events).gaps.length, 0);
    assert.equal(replaySessionJournal(complete.events).last.storageGeneration, loadSession(id).storageGeneration);
    const skippedSequence = structuredClone(complete.events);
    skippedSequence[1].sequence += 1;
    assert.deepEqual(replaySessionJournal(skippedSequence).gaps.map((gap) => ({
      sequence: gap.sequence,
      expectedSequence: gap.expectedSequence,
    })), [{ sequence: 3, expectedSequence: 2 }]);

    const journalPath = join(home, ".hara", "sessions", `${id}.journal`);
    writeFileSync(journalPath, '{"v":1,"type":"projection.committed"', { flag: "a" });
    const torn = readSessionJournal(id);
    assert.equal(torn.truncatedTail, true);
    assert.equal(torn.events.length, 2, "the complete prefix remains replayable");

    saveSession(meta, [{ role: "user", content: "third" }]);
    const repaired = readSessionJournal(id);
    assert.deepEqual(repaired.events.map((event) => event.sequence), [1, 2, 3]);
    assert.equal(repaired.invalidRecords, 1, "the preserved torn bytes are isolated from later records");
    assert.equal(repaired.truncatedTail, false);
    assert.equal(replaySessionJournal(repaired.events).gaps.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session journal replays typed task state and provider retries without persisting private payloads", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-runtime-journal-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const id = "runtime-journal-fixture";
    const meta = {
      id,
      cwd: project,
      provider: "fixture",
      model: "fixture-model",
      title: "runtime journal",
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    };
    saveSession(meta, [{ role: "user", content: "private task text stays in the transcript" }]);
    assert.equal(recordSessionTaskState({
      sessionId: id,
      taskId: "task-runtime-1",
      turnId: "turn-runtime-1",
      state: "waiting",
      taskStatus: "running",
      phase: "approval",
      at: "2026-09-09T00:00:01.000Z",
      updatedAt: "2026-09-09T00:00:00.500Z",
      progress: {
        state: "stopped",
        trigger: "unattended_without_checkpoint",
        rounds: 8,
        maxRounds: 64,
        cumulativeTaskRounds: 18,
        taskRoundLimit: 100,
        toolCalls: 12,
        noProgressRounds: 8,
        checkpointStaleRounds: 8,
        tokens: { input: 12_000, output: 3_000, total: 15_000 },
        todo: { done: 1, total: 3 },
      },
    }), true);
    const fakeSecret = "sk-runtimejournal1234567890";
    assert.equal(recordSessionProviderRetry({
      sessionId: id,
      taskId: "task-runtime-1",
      turnId: "turn-runtime-1",
      at: "2026-09-09T00:00:02.000Z",
      retry: {
        provider: "openai",
        model: `model-${fakeSecret}`,
        attempt: 1,
        nextAttempt: 2,
        kind: "rate_limit",
        delayMs: 1_500,
        elapsedMs: 250,
        status: 429,
      },
    }), true);
    saveSession(meta, [
      { role: "user", content: "private task text stays in the transcript" },
      { role: "assistant", text: "done", toolUses: [] },
    ]);

    const journal = readSessionJournal(id);
    assert.deepEqual(journal.events.map((event) => event.type), [
      "projection.committed",
      "task.state",
      "provider.retry_scheduled",
      "projection.committed",
    ]);
    assert.deepEqual(journal.events.map((event) => event.sequence), [1, 2, 3, 4]);
    const replay = replaySessionJournal(journal.events);
    assert.equal(replay.gaps.length, 0);
    assert.equal(replay.last.storageGeneration, loadSession(id).storageGeneration);
    assert.equal(replay.lastEvent.type, "projection.committed");
    assert.deepEqual(replay.latestTaskState.progress, {
      state: "stopped",
      trigger: "unattended_without_checkpoint",
      rounds: 8,
      maxRounds: 64,
      cumulativeTaskRounds: 18,
      taskRoundLimit: 100,
      toolCalls: 12,
      noProgressRounds: 8,
      checkpointStaleRounds: 8,
      inputTokens: 12_000,
      outputTokens: 3_000,
      totalTokens: 15_000,
      todosDone: 1,
      todosTotal: 3,
    });
    assert.deepEqual(replay.providerRetries.map((event) => ({
      taskId: event.taskId,
      turnId: event.turnId,
      attempt: event.attempt,
      nextAttempt: event.nextAttempt,
      kind: event.kind,
      status: event.status,
    })), [{
      taskId: "task-runtime-1",
      turnId: "turn-runtime-1",
      attempt: 1,
      nextAttempt: 2,
      kind: "rate_limit",
      status: 429,
    }]);
    const rawJournal = readFileSync(join(home, ".hara", "sessions", `${id}.journal`), "utf8");
    assert.equal(rawJournal.includes(fakeSecret), false, "model labels are redacted before append");
    assert.equal(rawJournal.includes("private task text"), false, "task and transcript prose stay out of the journal");

    const impossibleProgress = structuredClone(journal.events);
    impossibleProgress[1].progress.todosDone = impossibleProgress[1].progress.todosTotal + 1;
    const isolatedCorruption = replaySessionJournal(impossibleProgress);
    assert.equal(isolatedCorruption.latestTaskState, undefined, "impossible progress is isolated from replay");
    assert.equal(isolatedCorruption.providerRetries.length, 1, "a later valid typed item remains inspectable");
    assert.ok(isolatedCorruption.gaps.length > 0, "skipping an invalid item leaves an explicit sequence gap");

    const skippedTypedEvent = structuredClone(journal.events);
    skippedTypedEvent[2].sequence += 1;
    assert.deepEqual(replaySessionJournal(skippedTypedEvent).gaps.map((gap) => ({
      sequence: gap.sequence,
      expectedSequence: gap.expectedSequence,
    })), [
      { sequence: 4, expectedSequence: 3 },
      { sequence: 4, expectedSequence: 5 },
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session journal deterministically replays provider, message, tool, diff, and Agent item lifecycles", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-item-journal-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const sessionId = "item-journal-fixture";
    const taskId = "task-item-1";
    const turnId = "turn-item-1";
    saveSession({
      id: sessionId,
      cwd: project,
      provider: "fixture",
      model: "fixture-model",
      title: "item journal",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    }, [{ role: "user", content: "private prompt must stay out of the journal" }]);

    const providerId = "provider-attempt-1";
    const messageId = "assistant-message-1";
    const toolId = "tool-call-1";
    const diffId = "diff-tool-call-1";
    const agentId = "agent-child-1";
    const common = { sessionId, taskId, turnId };
    const transitions = [
      { ...common, itemId: providerId, kind: "provider", state: "started", provider: "volcengine-agent-plan", model: "glm-5.3-flash" },
      { ...common, itemId: messageId, kind: "message", state: "started", parentItemId: providerId, role: "assistant" },
      { ...common, itemId: providerId, kind: "provider", state: "streaming", provider: "volcengine-agent-plan", model: "glm-5.3-flash" },
      { ...common, itemId: messageId, kind: "message", state: "streaming", parentItemId: providerId, role: "assistant" },
      { ...common, itemId: messageId, kind: "message", state: "completed", parentItemId: providerId, role: "assistant" },
      { ...common, itemId: providerId, kind: "provider", state: "completed", provider: "volcengine-agent-plan", model: "glm-5.3-flash", inputTokens: 120, outputTokens: 30 },
      { ...common, itemId: toolId, kind: "tool", state: "queued", parentItemId: messageId, role: "tool", name: "edit_file", effect: "edit" },
      { ...common, itemId: diffId, kind: "diff", state: "queued", parentItemId: toolId, effect: "edit" },
      { ...common, itemId: toolId, kind: "tool", state: "started", parentItemId: messageId, role: "tool", name: "edit_file", effect: "edit" },
      { ...common, itemId: toolId, kind: "tool", state: "completed", parentItemId: messageId, role: "tool", name: "edit_file", effect: "edit" },
      { ...common, itemId: diffId, kind: "diff", state: "completed", parentItemId: toolId, effect: "edit" },
      { ...common, itemId: agentId, kind: "agent", state: "queued", parentItemId: toolId, role: "agent", generation: 1 },
      { ...common, itemId: agentId, kind: "agent", state: "started", parentItemId: toolId, role: "agent", generation: 1 },
      { ...common, itemId: agentId, kind: "agent", state: "completed", parentItemId: toolId, role: "agent", generation: 1 },
    ];
    for (const [index, transition] of transitions.entries()) {
      assert.equal(recordSessionRuntimeItem({
        ...transition,
        at: new Date(Date.parse("2026-09-10T00:00:01.000Z") + index * 1_000).toISOString(),
      }), true);
    }

    const journal = readSessionJournal(sessionId);
    const replay = replaySessionJournal(journal.events);
    assert.equal(replay.gaps.length, 0);
    assert.equal(replay.runtimeItemIssues.length, 0);
    assert.deepEqual(replay.runtimeItems.map((item) => ({
      id: item.itemId,
      kind: item.kind,
      state: item.state,
      parent: item.parentItemId,
    })), [
      { id: providerId, kind: "provider", state: "completed", parent: undefined },
      { id: messageId, kind: "message", state: "completed", parent: providerId },
      { id: toolId, kind: "tool", state: "completed", parent: messageId },
      { id: diffId, kind: "diff", state: "completed", parent: toolId },
      { id: agentId, kind: "agent", state: "completed", parent: toolId },
    ]);
    const provider = replay.runtimeItems[0];
    assert.deepEqual({ input: provider.inputTokens, output: provider.outputTokens }, { input: 120, output: 30 });
    assert.deepEqual(replaySessionJournal(journal.events).runtimeItems, replay.runtimeItems,
      "the same ordered journal always reduces to the same lifecycle projection");

    const raw = readFileSync(join(home, ".hara", "sessions", `${sessionId}.journal`), "utf8");
    assert.equal(raw.includes("private prompt"), false);
    assert.equal(raw.includes("sk-itemjournal1234567890"), false);

    const last = journal.events.at(-1);
    const duplicateTerminal = { ...structuredClone(last), eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sequence: last.sequence + 1 };
    const mismatch = {
      ...structuredClone(last),
      eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      sequence: last.sequence + 2,
      kind: "tool",
    };
    const anomalous = replaySessionJournal([...journal.events, duplicateTerminal, mismatch]);
    assert.deepEqual(anomalous.runtimeItemIssues.map((issue) => issue.kind), ["duplicate_terminal", "identity_mismatch"]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session journal reconstructs compaction start, commit, install, failure, and crash-window recovery", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-compaction-journal-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const id = "compaction-journal-fixture";
    const createdAt = "2026-09-09T01:00:00.000Z";
    const baseMeta = {
      id,
      cwd: project,
      provider: "fixture",
      model: "fixture-model",
      title: "compaction journal",
      createdAt,
      updatedAt: createdAt,
    };
    const privateSource = "private checkpoint content sk-compactionjournal1234567890";
    saveSession(baseMeta, [
      { role: "user", content: privateSource },
      { role: "assistant", text: "private response", toolUses: [] },
    ]);

    const first = {
      sessionId: id,
      attemptId: "11111111-1111-4111-8111-111111111111",
      windowId: "22222222-2222-4222-8222-222222222222",
      sourceMessages: 2,
    };
    assert.equal(recordSessionCompactionState({
      ...first,
      state: "started",
      at: "2026-09-09T01:00:01.000Z",
    }), true);
    const firstWindow = {
      windowId: first.windowId,
      attemptId: first.attemptId,
      installedAt: "2026-09-09T01:00:02.000Z",
      sourceMessages: 2,
      replacementMessages: 1,
      sourceInputTokens: 123,
      inputAccounting: "provider",
    };
    saveSession({ ...baseMeta, compaction: firstWindow }, [{ role: "user", content: "private compacted checkpoint" }]);
    assert.equal(recordSessionCompactionState({
      ...first,
      state: "installed",
      installedAt: firstWindow.installedAt,
      replacementMessages: 1,
      sourceInputTokens: 123,
      inputAccounting: "provider",
      at: "2026-09-09T01:00:03.000Z",
    }), true);

    const failed = {
      sessionId: id,
      attemptId: "33333333-3333-4333-8333-333333333333",
      windowId: "44444444-4444-4444-8444-444444444444",
      previousWindowId: first.windowId,
      sourceMessages: 2,
    };
    assert.equal(recordSessionCompactionState({ ...failed, state: "started", at: "2026-09-09T01:00:04.000Z" }), true);
    assert.equal(recordSessionCompactionState({
      ...failed,
      state: "failed",
      reason: "provider_error",
      at: "2026-09-09T01:00:05.000Z",
    }), true);

    const completed = replaySessionJournal(readSessionJournal(id).events);
    assert.equal(completed.gaps.length, 0);
    assert.equal(completed.compactionIssues.length, 0);
    assert.deepEqual(completed.compactionAttempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      state: attempt.state,
      commitSequence: attempt.commitSequence,
      terminalSequence: attempt.terminalSequence,
      failureReason: attempt.failureReason,
      inferredInstalled: attempt.inferredInstalled,
    })), [
      {
        attemptId: first.attemptId,
        state: "installed",
        commitSequence: 3,
        terminalSequence: 4,
        failureReason: undefined,
        inferredInstalled: undefined,
      },
      {
        attemptId: failed.attemptId,
        state: "failed",
        commitSequence: undefined,
        terminalSequence: 6,
        failureReason: "provider_error",
        inferredInstalled: undefined,
      },
    ]);
    assert.equal(completed.latestCompaction.attemptId, failed.attemptId);

    // Simulate process loss after the replacement snapshot commit but before the explicit terminal item.
    const recovered = {
      sessionId: id,
      attemptId: "55555555-5555-4555-8555-555555555555",
      windowId: "66666666-6666-4666-8666-666666666666",
      previousWindowId: first.windowId,
      sourceMessages: 2,
    };
    assert.equal(recordSessionCompactionState({ ...recovered, state: "started", at: "2026-09-09T01:00:06.000Z" }), true);
    saveSession({
      ...baseMeta,
      compaction: {
        windowId: recovered.windowId,
        previousWindowId: recovered.previousWindowId,
        attemptId: recovered.attemptId,
        installedAt: "2026-09-09T01:00:07.000Z",
        sourceMessages: 2,
        replacementMessages: 1,
        sourceInputTokens: 200,
        inputAccounting: "estimated",
      },
    }, [{ role: "user", content: "second private checkpoint" }]);
    const crashRecovered = replaySessionJournal(readSessionJournal(id).events);
    assert.deepEqual({
      attemptId: crashRecovered.latestCompaction.attemptId,
      state: crashRecovered.latestCompaction.state,
      commitSequence: crashRecovered.latestCompaction.commitSequence,
      terminalSequence: crashRecovered.latestCompaction.terminalSequence,
      inferredInstalled: crashRecovered.latestCompaction.inferredInstalled,
    }, {
      attemptId: recovered.attemptId,
      state: "installed",
      commitSequence: 8,
      terminalSequence: undefined,
      inferredInstalled: true,
    });
    assert.equal(crashRecovered.compactionIssues.length, 0);
    const withoutStart = readSessionJournal(id).events.filter((event) => !(
      event.type === "compaction.state"
      && event.attemptId === recovered.attemptId
      && event.state === "started"
    ));
    const projectionOnly = replaySessionJournal(withoutStart);
    assert.equal(projectionOnly.latestCompaction.attemptId, recovered.attemptId);
    assert.equal(projectionOnly.latestCompaction.state, "installed");
    assert.equal(projectionOnly.latestCompaction.inferredInstalled, true);
    assert.equal(projectionOnly.latestCompaction.sourceMessages, undefined);
    assert.ok(projectionOnly.compactionIssues.some((issue) => (
      issue.attemptId === recovered.attemptId && issue.kind === "missing_start"
    )), "a missed start append stays visible while the committed installation remains recoverable");
    const rawJournal = readFileSync(join(home, ".hara", "sessions", `${id}.journal`), "utf8");
    assert.equal(rawJournal.includes(privateSource), false);
    assert.equal(rawJournal.includes("private checkpoint"), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session journal replays approval outcomes without retaining questions or tool payloads", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-approval-journal-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const id = "approval-journal-fixture";
    const at = "2026-09-09T02:00:00.000Z";
    saveSession({
      id,
      cwd: project,
      provider: "fixture",
      model: "fixture-model",
      title: "approval journal",
      createdAt: at,
      updatedAt: at,
    }, [{ role: "user", content: "private approval question and tool arguments" }]);
    const first = {
      sessionId: id,
      approvalId: "aaaaaaaa-1111-4111-8111-111111111111",
      taskId: "task-approval-1",
      turnId: "turn-approval-1",
      allowAlways: true,
    };
    assert.equal(recordSessionApprovalState({ ...first, state: "requested", at: "2026-09-09T02:00:01.000Z" }), true);
    assert.equal(recordSessionApprovalState({
      ...first,
      state: "resolved",
      outcome: "allowed_always",
      at: "2026-09-09T02:00:02.000Z",
    }), true);
    const second = {
      sessionId: id,
      approvalId: "bbbbbbbb-2222-4222-8222-222222222222",
      taskId: "task-approval-1",
      turnId: "turn-approval-1",
      allowAlways: false,
    };
    assert.equal(recordSessionApprovalState({
      ...second,
      state: "resolved",
      outcome: "allowed_always",
      at: "2026-09-09T02:00:02.500Z",
    }), false, "an approval cannot remember a broader scope that was never offered");
    assert.equal(recordSessionApprovalState({ ...second, state: "requested", at: "2026-09-09T02:00:03.000Z" }), true);
    assert.equal(recordSessionApprovalState({
      ...second,
      state: "resolved",
      outcome: "interrupted",
      at: "2026-09-09T02:00:04.000Z",
    }), true);

    const journal = readSessionJournal(id);
    assert.deepEqual(journal.events.map((event) => event.type), [
      "projection.committed",
      "approval.state",
      "approval.state",
      "approval.state",
      "approval.state",
    ]);
    const replay = replaySessionJournal(journal.events);
    assert.equal(replay.gaps.length, 0);
    assert.equal(replay.approvalIssues.length, 0);
    assert.deepEqual(replay.approvals.map((approval) => ({
      approvalId: approval.approvalId,
      state: approval.state,
      outcome: approval.outcome,
      resolutionSequence: approval.resolutionSequence,
    })), [
      { approvalId: first.approvalId, state: "resolved", outcome: "allowed_always", resolutionSequence: 3 },
      { approvalId: second.approvalId, state: "resolved", outcome: "interrupted", resolutionSequence: 5 },
    ]);
    assert.equal(replay.latestApproval.approvalId, second.approvalId);
    const rawJournal = readFileSync(join(home, ".hara", "sessions", `${id}.journal`), "utf8");
    assert.equal(rawJournal.includes("private approval question"), false);
    assert.equal(rawJournal.includes("tool arguments"), false);

    const mismatched = structuredClone(journal.events);
    mismatched[2].turnId = "another-turn";
    const isolated = replaySessionJournal(mismatched);
    assert.equal(isolated.approvals[0].state, "requested");
    assert.ok(isolated.approvalIssues.some((issue) => issue.kind === "identity_mismatch"));

    const orphanedResolution = {
      ...structuredClone(journal.events[4]),
      eventId: "dddddddd-4444-4444-8444-444444444444",
      approvalId: "eeeeeeee-5555-4555-8555-555555555555",
      sequence: 6,
      at: "2026-09-09T02:00:05.000Z",
      outcome: "timed_out",
    };
    const duplicateResolution = {
      ...structuredClone(orphanedResolution),
      eventId: "ffffffff-6666-4666-8666-666666666666",
      sequence: 7,
      at: "2026-09-09T02:00:06.000Z",
    };
    const anomalies = replaySessionJournal([...journal.events, orphanedResolution, duplicateResolution]);
    assert.equal(anomalies.gaps.length, 0);
    assert.equal(anomalies.latestApproval.approvalId, orphanedResolution.approvalId);
    assert.equal(anomalies.latestApproval.outcome, "timed_out");
    assert.deepEqual(anomalies.approvalIssues.map((issue) => issue.kind), [
      "missing_request",
      "duplicate_resolution",
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session persistence and the v3 compatibility pass remove legacy credentials from titles and sidecars", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-title-redaction-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const fakeSecret = "sk-legacytitle1234567890";
  try {
    const sessions = join(home, ".hara", "sessions");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    const generation = "11111111-1111-4111-8111-111111111111";
    const id = "legacy-sensitive-title";
    const emptyId = "legacy-empty-draft";
    const meta = {
      id,
      cwd: project,
      provider: "test",
      model: "test",
      title: `debug ${fakeSecret}`,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      source: "interactive",
    };
    writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
      storageGeneration: generation,
      meta,
      history: [{ role: "user", content: `please use ${fakeSecret}` }],
    }));
    writeFileSync(join(sessions, `${id}.metadata`), JSON.stringify({
      v: 1,
      generation,
      routes: 2,
      meta,
    }));
    writeFileSync(join(sessions, `${emptyId}.json`), JSON.stringify({
      meta: {
        ...meta,
        id: emptyId,
        title: "",
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
      history: [],
    }));

    assert.equal(listSessions()[0]?.title, "debug credential", "legacy sidecars are safe even before migration");
    await ensureSessionMetadataIndex({ force: true });

    const transcript = readFileSync(join(sessions, `${id}.json`), "utf8");
    const sidecar = readFileSync(join(sessions, `${id}.metadata`), "utf8");
    assert.equal(transcript.includes(fakeSecret), false);
    assert.equal(sidecar.includes(fakeSecret), false);
    assert.equal(JSON.parse(sidecar).routes, 3);
    assert.equal(loadSession(id)?.meta.title, "debug credential");
    const migratedEmpty = loadSession(emptyId);
    assert.equal(migratedEmpty?.meta.archived, true, "legacy empty interactive drafts are reversibly archived");
    assert.equal(migratedEmpty?.history.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("automation metadata history is cursor-paged without returning every transcript", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-page-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const dir = join(home, ".hara", "sessions");
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const created = [];
    for (let index = 0; index < 8; index++) {
      const id = `paged-cron-${index}`;
      saveSession({
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: `run ${index}`,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "",
        source: index < 6 ? "cron" : "interactive",
        ...(index < 6 ? { sourceName: "paged job", jobId: "paged-job" } : {}),
      }, [
        { role: "user", content: `full transcript ${index}` },
      ]);
      const stamp = new Date(Date.UTC(2026, 6, 24, 0, 0, index));
      utimesSync(join(dir, `${id}.json`), stamp, stamp);
      if (index < 6) created.push(id);
    }

    const seen = [];
    let cursor;
    do {
      const page = listSessionMetadataPage({
        sources: ["cron"],
        cursor,
        limit: 2,
      });
      assert.ok(page.sessions.length <= 2, "one response is server-bounded");
      seen.push(...page.sessions.map((session) => session.id));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
      assert.ok(cursor, "a non-terminal page has an opaque continuation cursor");
    } while (seen.length < 20);
    assert.deepEqual(new Set(seen), new Set(created));
    assert.equal(seen.length, created.length, "pagination never duplicates a transcript");
    assert.throws(
      () => listSessionMetadataPage({ cursor: "not-a-valid-cursor" }),
      /invalid session metadata cursor/i,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session metadata sidecars cannot overwrite or delete a legal transcript id", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-sidecar-namespace-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const meta = (id, title) => ({
      id,
      cwd: project,
      provider: "test",
      model: "test",
      title,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "",
    });

    saveSession(meta("foo.meta", "authoritative transcript"), [
      { role: "user", content: "history that must survive" },
    ]);
    saveSession(meta("foo", "neighbor session"), [
      { role: "user", content: "neighbor history" },
    ]);

    assert.equal(loadSession("foo.meta")?.history[0]?.content, "history that must survive");
    assert.deepEqual(
      new Set(listSessions().map((session) => session.id)),
      new Set(["foo.meta", "foo"]),
    );
    assert.equal(deleteSession("foo"), true);
    assert.equal(
      loadSession("foo.meta")?.history[0]?.content,
      "history that must survive",
      "deleting a neighboring session cannot unlink this transcript",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session metadata cursor uses one stable order when transcript mtimes are equal", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-page-ties-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const dir = join(home, ".hara", "sessions");
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const ids = ["_a", "-a", "10", "2"];
    const stamp = new Date(Date.now() - 1_000);
    for (const id of ids) {
      saveSession({
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: id,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "",
        source: "cron",
        sourceName: "tie order",
        jobId: "tie-order",
      }, []);
      utimesSync(join(dir, `${id}.json`), stamp, stamp);
    }

    const seen = [];
    let cursor;
    do {
      const page = listSessionMetadataPage({ sources: ["cron"], cursor, limit: 1 });
      seen.push(...page.sessions.map((session) => session.id));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
      assert.ok(cursor);
    } while (seen.length < 10);

    assert.deepEqual(
      seen,
      [...ids].reverse(),
      "the append-only index has one deterministic newest-first order independent of locale collation",
    );
    assert.equal(new Set(seen).size, ids.length, "equal-mtime pagination skips and duplicates nothing");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a future-dated stale sidecar never overrides the authoritative transcript generation", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-sidecar-tie-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const id = "sidecar-generation-tie";
    const meta = {
      id,
      cwd: project,
      provider: "test",
      model: "test",
      title: "old title",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "",
      source: "cron",
      sourceName: "sidecar test",
      jobId: "sidecar-test",
    };
    saveSession(meta, [{ role: "user", content: "old transcript" }]);
    const sessions = join(home, ".hara", "sessions");
    const transcript = join(sessions, `${id}.json`);
    const sidecar = join(sessions, `${id}.metadata`);
    const staleSidecar = readFileSync(sidecar);

    meta.title = "new authoritative title";
    saveSession(meta, [{ role: "user", content: "new transcript" }]);
    writeFileSync(sidecar, staleSidecar);
    const transcriptStamp = new Date(Date.now() - 1_000);
    const futureSidecarStamp = new Date(Date.now() + 86_400_000);
    utimesSync(transcript, transcriptStamp, transcriptStamp);
    utimesSync(sidecar, futureSidecarStamp, futureSidecarStamp);

    assert.equal(listSessions().find((session) => session.id === id)?.title, "new authoritative title");
    assert.equal(
      listSessionMetadataPage({ sources: ["cron"], limit: 10 }).sessions
        .find((session) => session.id === id)?.title,
      "new authoritative title",
      "the paged index verifies the storage generation instead of trusting a restored/future mtime",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy metadata migration stays incomplete while a transcript is locked and retries after release", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-held-lock-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const indexRoot = join(home, ".hara", "session-index", "v1");
    const project = join(home, "project");
    const id = "legacy-held-lock";
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
      meta: {
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: "held legacy",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
        source: "interactive",
      },
      history: [],
    }));
    writeFileSync(join(sessions, `${id}.lock`), JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      token: "foreign-live-session-owner",
    }));

    await ensureSessionMetadataIndex({ force: true });
    assert.equal(
      existsSync(join(indexRoot, "legacy-migration.complete")),
      false,
      "a skipped live transcript cannot be hidden behind a completion marker",
    );
    assert.equal(loadSession(id)?.storageGeneration, undefined);

    rmSync(join(sessions, `${id}.lock`));
    await ensureSessionMetadataIndex();
    assert.ok(loadSession(id)?.storageGeneration, "the next ordinary call retries the skipped transcript");
    assert.equal(existsSync(join(indexRoot, "legacy-migration.complete")), true);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a waiter reclaims a migration lock when its owner exits without publishing a marker", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-dead-wait-owner-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  let owner;
  try {
    const sessions = join(home, ".hara", "sessions");
    const indexRoot = join(home, ".hara", "session-index", "v1");
    const project = join(home, "project");
    const id = "legacy-after-owner-exit";
    mkdirSync(sessions, { recursive: true });
    mkdirSync(indexRoot, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
      meta: {
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: "owner exit",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
        source: "interactive",
      },
      history: [],
    }));
    owner = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    assert.ok(owner.pid);
    writeFileSync(join(indexRoot, "legacy-migration.lock"), JSON.stringify({
      pid: owner.pid,
      startedAt: Date.now(),
      token: "owner-that-will-exit",
    }));

    const migration = ensureSessionMetadataIndex({ force: true });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    owner.kill();
    await once(owner, "exit");
    owner = undefined;
    await Promise.race([
      migration,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("migration waiter did not reclaim the dead owner")),
        3_000,
      )),
    ]);
    assert.ok(loadSession(id)?.storageGeneration);
    assert.equal(existsSync(join(indexRoot, "legacy-migration.complete")), true);
  } finally {
    owner?.kill();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unsupported extended-year transcript is isolated while healthy legacy sessions migrate", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-year-boundary-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    const writeLegacy = (id, updatedAt) => writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
      meta: {
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: id,
        createdAt: updatedAt,
        updatedAt,
        source: "interactive",
      },
      history: [{ role: "user", content: id }],
    }));
    writeLegacy("legacy-year-10000", "+010000-01-01T00:00:00.000Z");
    writeLegacy("legacy-healthy-year", "2026-07-24T00:00:00.000Z");

    await assert.doesNotReject(ensureSessionMetadataIndex({ force: true }));
    assert.ok(loadSession("legacy-healthy-year")?.storageGeneration);
    assert.equal(loadSession("legacy-year-10000"), null, "unsupported timestamps never enter an index bucket");
    assert.deepEqual(
      listSessionMetadataPage({ sources: ["interactive"], limit: 10 }).sessions.map((meta) => meta.id),
      ["legacy-healthy-year"],
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy metadata migration is retryable and reclaims a complete dead-owner lock", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-migration-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const indexRoot = join(home, ".hara", "session-index", "v1");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(indexRoot, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(sessions, "legacy-indexed.json"), JSON.stringify({
      meta: {
        id: "legacy-indexed",
        cwd: project,
        provider: "test",
        model: "test",
        title: "legacy indexed session",
        createdAt: "2026-07-23T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
        source: "cron",
        sourceName: "legacy cron",
      },
      history: [],
    }));
    writeFileSync(join(indexRoot, "legacy-migration.lock"), JSON.stringify({
      pid: 2_147_483_647,
      startedAt: Date.now() - 60_000,
      token: "dead-migration-owner",
    }));

    await ensureSessionMetadataIndex();
    assert.equal(
      listSessionMetadataPage({ sources: ["cron"], limit: 10 }).sessions[0]?.id,
      "legacy-indexed",
    );
    assert.equal(existsSync(join(indexRoot, "legacy-migration.complete")), true);
    assert.equal(existsSync(join(indexRoot, "legacy-migration.lock")), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy metadata migration rediscovers mixed-version writes and invalidates duplicate partial imports", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-mixed-writer-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const indexRoot = join(home, ".hara", "session-index", "v1");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(indexRoot, { recursive: true });
    mkdirSync(project, { recursive: true });
    const writeLegacy = (id, updatedAt) => writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
      meta: {
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: id,
        createdAt: updatedAt,
        updatedAt,
        source: "cron",
        sourceName: "mixed writer",
        jobId: "mixed-writer",
      },
      history: [],
    }));

    const firstAt = "2026-07-23T10:00:00.000Z";
    writeLegacy("legacy-before-marker", firstAt);
    const firstBucketDir = join(indexRoot, "2026", "07", "23");
    mkdirSync(firstBucketDir, { recursive: true });
    const duplicate = `${JSON.stringify({
      v: 1,
      id: "legacy-before-marker",
      generation: "legacy",
      at: Date.parse(firstAt),
    })}\n`;
    writeFileSync(join(firstBucketDir, "10.ndjson"), duplicate + duplicate);

    await ensureSessionMetadataIndex();
    assert.ok(
      loadSession("legacy-before-marker")?.storageGeneration,
      "the compatibility import upgrades the authoritative transcript instead of appending another legacy record",
    );

    const afterAt = "2026-07-24T11:00:00.000Z";
    writeLegacy("legacy-after-marker", afterAt);
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      "import { ensureSessionMetadataIndex } from './dist/session/store.js'; await ensureSessionMetadataIndex();",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(loadSession("legacy-after-marker")?.storageGeneration, "a later old-writer transcript is rediscovered");

    const seen = [];
    let cursor;
    do {
      const page = listSessionMetadataPage({ sources: ["cron"], cursor, limit: 1 });
      seen.push(...page.sessions.map((session) => session.id));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (seen.length < 10);
    assert.deepEqual(
      seen.sort(),
      ["legacy-after-marker", "legacy-before-marker"],
      "partial legacy imports cannot duplicate a session across cursor pages after conversion",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy metadata migration publishes same-hour sessions in updatedAt order", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-migration-order-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    const writeLegacy = (id, updatedAt) => writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
      meta: {
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: id,
        createdAt: updatedAt,
        updatedAt,
        source: "interactive",
      },
      history: [{ role: "user", content: id }],
    }));
    writeLegacy("migration-order-a", "2026-07-24T03:10:00.000Z");
    writeLegacy("migration-order-b", "2026-07-24T03:20:00.000Z");
    const enumeration = readdirSync(sessions)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
    assert.equal(enumeration.length, 2);
    // Make the first directory entry newer. An unsorted import appends it first and then incorrectly treats
    // the second entry as newest because cursor paging reads append-only shards backwards.
    const newerId = enumeration[0];
    const olderId = enumeration[1];
    writeLegacy(newerId, "2026-07-24T03:59:00.000Z");
    writeLegacy(olderId, "2026-07-24T03:01:00.000Z");

    await ensureSessionMetadataIndex();

    assert.deepEqual(
      listSessionMetadataPage({ sources: ["interactive"], limit: 2 }).sessions.map((meta) => meta.id),
      [newerId, olderId],
    );
    assert.equal(latestForCwd(project)?.meta.id, newerId);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy metadata migration cannot move an older session ahead of a concurrent current save", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-concurrent-migration-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    const now = new Date();
    const hourStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
    )).toISOString();
    for (let index = 0; index < 32; index += 1) {
      const id = `concurrent-legacy-${String(index).padStart(2, "0")}`;
      writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
        meta: {
          id,
          cwd: project,
          provider: "test",
          model: "test",
          title: id,
          createdAt: hourStart,
          updatedAt: hourStart,
          source: "interactive",
        },
        history: [],
      }));
    }

    const migration = ensureSessionMetadataIndex({ force: true });
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    saveSession({
      id: "concurrent-current",
      cwd: project,
      provider: "test",
      model: "test",
      title: "current save",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      source: "interactive",
    }, []);
    await migration;

    assert.equal(
      latestForCwd(project)?.meta.id,
      "concurrent-current",
      "the route shard stays chronological even when migration yields to a current writer",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("latestForCwd continues past a full filtered index window", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-filter-window-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const indexDir = join(home, ".hara", "session-index", "v1", "2026", "07", "24");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(indexDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    const updatedAt = "2026-07-24T03:30:00.000Z";
    const writeLegacy = (id, source) => {
      writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
        meta: {
          id,
          cwd: project,
          provider: "test",
          model: "test",
          title: id,
          createdAt: updatedAt,
          updatedAt,
          source,
          ...(source === "cron"
            ? { sourceName: "filter window", jobId: "filter-window" }
            : {}),
        },
        history: [],
      }));
      return JSON.stringify({
        v: 1,
        id,
        generation: "legacy",
        at: Date.parse(updatedAt),
      });
    };
    const records = [writeLegacy("interactive-behind-automation", "interactive")];
    for (let index = 0; index < 1_001; index += 1) {
      records.push(writeLegacy(`filtered-cron-${String(index).padStart(4, "0")}`, "cron"));
    }
    writeFileSync(join(indexDir, "03.ndjson"), `${records.join("\n")}\n`);

    const first = listSessionMetadataPage({
      cwd: project,
      sources: ["interactive"],
      limit: 1,
    });
    assert.deepEqual(first.sessions, []);
    assert.equal(first.hasMore, true);
    assert.equal(
      latestForCwd(project)?.meta.id,
      "interactive-behind-automation",
      "implicit resume follows bounded cursors instead of treating a filtered page as exhaustive",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("latestForCwd is independent of more than sixteen global automation pages", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-partitioned-resume-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    saveSession({
      id: "partitioned-interactive-target",
      cwd: project,
      provider: "test",
      model: "test",
      title: "interactive target",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      source: "interactive",
    }, []);
    const at = Date.now();
    const stamp = new Date(at);
    const year = String(stamp.getUTCFullYear()).padStart(4, "0");
    const month = String(stamp.getUTCMonth() + 1).padStart(2, "0");
    const day = String(stamp.getUTCDate()).padStart(2, "0");
    const hour = String(stamp.getUTCHours()).padStart(2, "0");
    const global = join(home, ".hara", "session-index", "v1", year, month, day, `${hour}.ndjson`);
    const noise = [];
    for (let index = 0; index < 16_001; index += 1) {
      noise.push(JSON.stringify({
        v: 1,
        id: `partition-noise-${String(index).padStart(5, "0")}`,
        generation: "legacy",
        at: at + index + 1,
      }));
    }
    writeFileSync(global, `${noise.join("\n")}\n`, { flag: "a" });

    assert.equal(
      latestForCwd(project)?.meta.id,
      "partitioned-interactive-target",
      "implicit resume uses the complete source+cwd route instead of paging unrelated global records",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a durable migration marker prevents a new CLI process from sweeping transcripts again", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-marker-fast-path-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(sessions, "marker-legacy.json"), JSON.stringify({
      meta: {
        id: "marker-legacy",
        cwd: project,
        provider: "test",
        model: "test",
        title: "marker",
        createdAt: "2026-07-24T03:00:00.000Z",
        updatedAt: "2026-07-24T03:00:00.000Z",
        source: "interactive",
      },
      history: [],
    }));
    await ensureSessionMetadataIndex({ force: true });
    const marker = join(home, ".hara", "session-index", "v1", "legacy-migration.complete");
    const before = readFileSync(marker, "utf8");
    saveSession({
      id: "current-writer-after-marker",
      cwd: project,
      provider: "test",
      model: "test",
      title: "current writer",
      createdAt: "2026-07-24T03:01:00.000Z",
      updatedAt: "",
      source: "interactive",
    }, []);
    const lockedId = "locked-current-writer-after-marker";
    assert.equal(acquireSessionLock(lockedId).ok, true);
    saveSession({
      id: lockedId,
      cwd: project,
      provider: "test",
      model: "test",
      title: "locked current writer",
      createdAt: "2026-07-24T03:02:00.000Z",
      updatedAt: "",
      source: "interactive",
    }, []);
    releaseSessionLock(lockedId);
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      "import { ensureSessionMetadataIndex } from './dist/session/store.js'; await ensureSessionMetadataIndex();",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(
      readFileSync(marker, "utf8"),
      before,
      "current saves and lock lifecycle advance the trusted watermark instead of forcing another sweep",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway startup imports legacy history before opening the transport", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-gateway-startup-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const project = join(home, "project");
    const id = "feishu-oc_startup-u0123456789abcdef01234567-abcdef";
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
      meta: {
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: "legacy gateway",
        createdAt: "2026-07-24T03:00:00.000Z",
        updatedAt: "2026-07-24T03:00:00.000Z",
        source: "gateway",
        sourceName: "feishu",
      },
      history: [],
    }));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.HARA_FEISHU_APP_ID;
    delete env.HARA_FEISHU_APP_SECRET;
    const child = spawnSync(process.execPath, [
      "dist/index.js",
      "gateway",
      "--platform",
      "feishu",
      "--cwd",
      project,
    ], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
    assert.equal(child.status, 1, "the transport exits only because test credentials are intentionally absent");
    assert.match(child.stderr, /configure Feishu App credentials in Hara Settings/u);
    assert.ok(
      loadSession(id)?.storageGeneration,
      "legacy gateway history is migrated before transport configuration can end startup",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway fragment lookup finds an owned session older than the previous 100-session window", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-gateway-fragment-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const project = join(home, "project");
    const prefix = "feishu-oc_test-u0123456789abcdef01234567-";
    const route = `gateway-prefix-${createHash("sha256").update(prefix).digest("hex").slice(0, 32)}`;
    const routeDir = join(home, ".hara", "session-index", "v1", "routes", route, "2026", "07", "24");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(routeDir, { recursive: true });
    const records = [];
    for (let index = 0; index < 101; index += 1) {
      const id = `${prefix}abcdef${index ? `-${index}` : ""}`;
      const updatedAt = new Date(Date.UTC(2026, 6, 24, 3, 0, index)).toISOString();
      writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
        meta: {
          id,
          cwd: project,
          provider: "test",
          model: "test",
          title: id,
          createdAt: updatedAt,
          updatedAt,
          source: "gateway",
          sourceName: "feishu",
        },
        history: [],
      }));
      records.push(JSON.stringify({
        v: 1,
        id,
        generation: "legacy",
        at: Date.parse(updatedAt),
      }));
    }
    writeFileSync(join(routeDir, "03.ndjson"), `${records.join("\n")}\n`);

    const matches = findSessionMetadataByFragment("abcdef", {
      sources: ["gateway"],
      sourceName: "feishu",
      idPrefix: prefix,
      includeArchived: true,
    });
    assert.deepEqual(matches.map((meta) => meta.id), [`${prefix}abcdef`]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("metadata paging remains resumable across more empty shards than one request may inspect", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-empty-shards-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const indexRoot = join(home, ".hara", "session-index", "v1");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    const newest = Date.UTC(2026, 6, 24, 12);
    for (let offset = 0; offset < 300; offset++) {
      const date = new Date(newest - offset * 3_600_000);
      const year = String(date.getUTCFullYear()).padStart(4, "0");
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");
      const hour = String(date.getUTCHours()).padStart(2, "0");
      const dir = join(indexRoot, year, month, day);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${hour}.ndjson`), "");
    }

    const oldest = new Date(newest - 300 * 3_600_000);
    const updatedAt = oldest.toISOString();
    writeFileSync(join(sessions, "oldest-valid.json"), JSON.stringify({
      meta: {
        id: "oldest-valid",
        cwd: project,
        provider: "test",
        model: "test",
        title: "oldest valid",
        createdAt: updatedAt,
        updatedAt,
        source: "cron",
        sourceName: "empty shard test",
      },
      history: [],
    }));
    const year = String(oldest.getUTCFullYear()).padStart(4, "0");
    const month = String(oldest.getUTCMonth() + 1).padStart(2, "0");
    const day = String(oldest.getUTCDate()).padStart(2, "0");
    const hour = String(oldest.getUTCHours()).padStart(2, "0");
    const oldestDir = join(indexRoot, year, month, day);
    mkdirSync(oldestDir, { recursive: true });
    writeFileSync(join(oldestDir, `${hour}.ndjson`), `${JSON.stringify({
      v: 1,
      id: "oldest-valid",
      generation: "legacy",
      at: oldest.getTime(),
    })}\n`);

    const first = listSessionMetadataPage({ sources: ["cron"], limit: 1 });
    assert.deepEqual(first.sessions, []);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor, "the shard budget yields an opaque continuation instead of hiding older data");
    const second = listSessionMetadataPage({ sources: ["cron"], limit: 1, cursor: first.nextCursor });
    assert.equal(second.sessions[0]?.id, "oldest-valid");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("latestForCwd ignores a newer automation occurrence", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-latest-interactive-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    saveSession({
      id: "interactive-before-cron",
      cwd: project,
      provider: "test",
      model: "test",
      title: "manual work",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      source: "interactive",
    }, []);
    saveSession({
      id: "newer-cron-occurrence",
      cwd: project,
      provider: "test",
      model: "test",
      title: "scheduled work",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      source: "cron",
      sourceName: "scheduled work",
      jobId: "scheduled-work",
    }, []);

    assert.equal(
      latestForCwd(project)?.meta.id,
      "interactive-before-cron",
      "implicit continue/resume never crosses into an automation audience",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session: corrupt / malformed files don't crash load or list (audit M4)", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const dir = join(home, ".hara", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad1.json"), "{ not valid json"); // parse error
    writeFileSync(join(dir, "bad2.json"), JSON.stringify({})); // no meta/history
    writeFileSync(join(dir, "bad3.json"), JSON.stringify({ meta: { id: "bad3" }, history: "nope" })); // history not an array
    const validMeta = {
      id: "template",
      cwd: "/tmp/project",
      provider: "qwen",
      model: "glm-5",
      title: "template",
      createdAt: "2026-07-13T08:00:00.000Z",
      updatedAt: "2026-07-13T08:00:00.000Z",
    };
    writeFileSync(join(dir, "bad4.json"), JSON.stringify({ meta: { ...validMeta, id: "bad4", updatedAt: 42 }, history: [] }));
    writeFileSync(join(dir, "bad5.json"), JSON.stringify({ meta: { ...validMeta, id: "bad5", createdAt: "not-a-date" }, history: [] }));
    writeFileSync(join(dir, "bad6.json"), JSON.stringify({ meta: { ...validMeta, id: "bad6", workingSet: ["ok", 42] }, history: [] }));
    writeFileSync(join(dir, "bad7.json"), JSON.stringify({ meta: { ...validMeta, id: "bad7", todos: [{ text: "x", status: "bogus" }] }, history: [] }));
    writeFileSync(join(dir, "bad8.json"), JSON.stringify({ meta: { ...validMeta, id: "bad8", archived: "yes" }, history: [] }));
    writeFileSync(join(dir, "bad9.json"), JSON.stringify({ meta: { ...validMeta, id: "bad9" }, history: [null] }));
    writeFileSync(join(dir, "bad10.json"), JSON.stringify({ meta: { ...validMeta, id: "bad10" }, history: [{ role: "assistant", text: "x" }] }));
    writeFileSync(join(dir, "bad11.json"), JSON.stringify({
      meta: { ...validMeta, id: "bad11" },
      history: [{ role: "assistant", text: "x", toolUses: [], continuation: { type: "unknown", text: "x" } }],
    }));
    writeFileSync(join(dir, "bad12.json"), JSON.stringify({
      meta: { ...validMeta, id: "bad12" },
      history: [{ role: "assistant", text: "x", toolUses: [], continuation: { type: "chat_reasoning", text: "x".repeat(128_001) } }],
    }));
    writeFileSync(join(dir, "bad13.json"), JSON.stringify({
      meta: { ...validMeta, id: "bad13" },
      history: [{
        role: "assistant",
        text: "x",
        toolUses: [],
        continuation: {
          type: "responses_reasoning",
          items: Array.from({ length: 65 }, (_, index) => ({ type: "reasoning", id: `r-${index}`, summary: [] })),
        },
      }],
    }));
    writeFileSync(join(dir, "bad14.json"), JSON.stringify({
      meta: { ...validMeta, id: "bad14" },
      history: [{
        role: "assistant",
        text: "x",
        toolUses: [],
        continuation: {
          type: "responses_reasoning",
          items: [{ type: "reasoning", id: "r-1", summary: [{ type: "summary_text", text: 42 }] }],
        },
      }],
    }));
    writeFileSync(join(dir, "spoofed.json"), JSON.stringify({ meta: { ...validMeta, id: "different" }, history: [] }));
    const oversized = join(dir, "oversized.json");
    writeFileSync(oversized, "{}");
    truncateSync(oversized, MAX_SESSION_FILE_BYTES + 1);
    let nested = { leaf: true };
    for (let depth = 0; depth < MAX_SESSION_JSON_DEPTH + 2; depth += 1) nested = { next: nested };
    writeFileSync(join(dir, "too-deep.json"), JSON.stringify({
      meta: { ...validMeta, id: "too-deep" },
      history: [{ role: "assistant", text: "x", toolUses: [{ id: "t", name: "deep", input: nested }] }],
    }));
    assert.equal(loadSession("bad1"), null);
    assert.equal(sessionFileExists("bad1"), true, "callers can fail closed instead of overwriting corrupt data");
    assert.equal(sessionFileExists("missing"), false);
    assert.equal(loadSession("bad2"), null);
    assert.equal(loadSession("bad3"), null, "history must be an array");
    for (const id of ["bad4", "bad5", "bad6", "bad7", "bad8", "bad9", "bad10", "bad11", "bad12", "bad13", "bad14", "spoofed", "oversized", "too-deep"]) {
      assert.equal(loadSession(id), null, id);
    }
    assert.doesNotThrow(() => listSessions(), "metaless/corrupt files are skipped, not crashed on");
    assert.deepEqual(listSessions(), []);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveSessionId prefers an exact id and rejects ambiguous prefixes", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-prefix-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const first = "shared-prefix";
  const second = "shared-prefix-longer";
  try {
    for (const [id, minute] of [[first, "00"], [second, "01"]]) {
      saveSession({
        id,
        cwd: "/tmp/prefix",
        provider: "qwen",
        model: "glm-5",
        title: id,
        createdAt: `2026-07-13T08:${minute}:00.000Z`,
        updatedAt: "",
      }, []);
    }
    assert.equal(resolveSessionId(first), first, "an exact id wins even when it prefixes another id");
    assert.equal(
      resolveSessionId(first, { allowPrefix: false }),
      first,
      "exact-only resolution still finds an existing exact session",
    );
    assert.equal(resolveSessionId("shared-prefix-l"), second, "a unique prefix resolves");
    assert.equal(
      resolveSessionId("shared-prefix-l", { allowPrefix: false }),
      null,
      "generated exact session ids can bypass historical prefix scans",
    );
    assert.equal(resolveSessionId("shared"), null, "an ambiguous prefix fails closed");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("every displayed eight-character id remains resolvable past 8,000 obsolete generations", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-short-route-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const id = "1234abcd-0000-4000-8000-000000000001";
    saveSession({
      id,
      cwd: join(home, "project"),
      provider: "test",
      model: "test",
      title: "short route target",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "",
      source: "interactive",
    }, [{ role: "user", content: "short route target" }]);
    const data = loadSession(id);
    assert.ok(data?.storageGeneration);
    const at = Date.parse(data.meta.updatedAt);
    const date = new Date(at);
    const route = `id-short-${createHash("sha256").update(id.slice(0, 8)).digest("hex").slice(0, 32)}`;
    const routeDir = join(
      home,
      ".hara",
      "session-index",
      "v1",
      "routes",
      route,
      String(date.getUTCFullYear()).padStart(4, "0"),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    );
    const shard = join(routeDir, `${String(date.getUTCHours()).padStart(2, "0")}.ndjson`);
    const stale = JSON.stringify({
      v: 1,
      id,
      generation: "00000000-0000-4000-8000-000000000002",
      at,
    });
    writeFileSync(shard, `${Array(8_001).fill(stale).join("\n")}\n`, { flag: "a" });

    assert.equal(
      resolveSessionId(id.slice(0, 8)),
      id,
      "short-id lookup exhausts its dedicated collision route instead of stopping after eight pages",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("deriveTitle tolerates a non-string (a malformed history's content)", () => {
  assert.equal(deriveTitle(undefined), "");
  assert.equal(deriveTitle(42), "");
});

test("session: save → load round-trip, title, latestForCwd, list", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-roundtrip-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const id = newSessionId();
  const cwd = "/tmp/hara-sess-" + id;
  try {
    const history = [
      { role: "user", content: "hello world task" },
      {
        role: "assistant",
        text: "I will inspect it",
        toolUses: [{ id: "call-1", name: "read_file", input: { path: "README.md" } }],
        continuation: {
          type: "responses_reasoning",
          items: [{
            type: "reasoning",
            id: "reason-1",
            summary: [],
            content: [{ type: "reasoning_text", text: "Inspect the requested file." }],
            status: "completed",
          }],
        },
      },
    ];
    const meta = {
      id,
      cwd,
      provider: "qwen",
      model: "glm-5",
      title: titleFrom(history),
      createdAt: new Date().toISOString(),
      updatedAt: "",
    };
    saveSession(meta, history);

    const loaded = loadSession(id);
    assert.ok(loaded);
    assert.equal(loaded.meta.id, id);
    assert.equal(loaded.meta.title, "hello world task"); // natural auto-summary (CJK-safe), not a slug
    assert.equal(loaded.history.length, 2);
    assert.deepEqual(loaded.history[1].continuation, history[1].continuation, "provider continuation survives resume exactly");
    assert.equal(latestForCwd(cwd)?.meta.id, id);
    assert.ok(listSessions(cwd).some((m) => m.id === id));
    assert.equal(resolveSessionId(shortId(id)), id); // resume by short-id prefix resolves to the full UUID
    const dir = join(home, ".hara", "sessions");
    assert.equal(statSync(dir).mode & 0o777, 0o700, "session directory is private");
    assert.equal(statSync(join(dir, `${id}.json`)).mode & 0o777, 0o600, "session file is private");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session persistence deeply redacts a copy; legacy list/load are strictly read-only", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-redact-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const id = newSessionId();
  const legacyId = newSessionId();
  const secret = "feishu-super-secret-123456";
  const legacySecret = "legacy-super-secret-987654";
  const dir = join(homedir(), ".hara", "sessions");
  const meta = {
    id,
    cwd: `/tmp/API_KEY=${secret}/hara-redaction-test`, // structural path must not be corrupted by redaction
    provider: "qwen",
    model: "glm-5",
    title: "redaction test",
    createdAt: new Date().toISOString(),
    updatedAt: "",
    source: "gateway",
    effort: "high",
    archived: true,
    gatewayOwner: "telegram:12345",
  };
  const history = [
    { role: "user", content: `FEISHU_APP_SECRET=${secret}` },
    { role: "assistant", text: "using env", toolUses: [{ id: "t1", name: "bash", input: { command: `tool --token=${secret}` } }] },
    { role: "tool", results: [{ id: "t1", name: "bash", content: `Authorization: Bearer ${secret}` }] },
  ];
  try {
    saveSession(meta, history);
    assert.ok(history[0].content.includes(secret), "live history is not mutated");
    assert.ok(history[1].toolUses[0].input.command.includes(secret), "nested live tool input is not mutated");
    const saved = readFileSync(join(dir, `${id}.json`), "utf8");
    assert.ok(!JSON.parse(saved).history.some((m) => JSON.stringify(m).includes(secret)), "new persisted history is safe");
    assert.equal(JSON.parse(saved).meta.cwd, meta.cwd, "structural cwd remains resumable byte-for-byte");
    assert.equal(JSON.parse(saved).meta.gatewayOwner, meta.gatewayOwner, "routing ownership metadata is preserved");

    const legacyMeta = { ...meta, id: legacyId };
    const legacyPath = join(dir, `${legacyId}.json`);
    const legacyRaw = JSON.stringify({ meta: legacyMeta, history: [{ role: "user", content: `API_KEY=${legacySecret}` }] }, null, 2);
    writeFileSync(legacyPath, legacyRaw);
    const loaded = loadSession(legacyId);
    assert.ok(loaded);
    assert.ok(!loaded.history[0].content.includes(legacySecret), "legacy secrets are redacted from the in-memory copy");
    listSessions();
    assert.equal(readFileSync(legacyPath, "utf8"), legacyRaw, "list/load never scrub or write a legacy file");

    saveSession(loaded.meta, loaded.history);
    assert.ok(!readFileSync(legacyPath, "utf8").includes(legacySecret), "the next explicit save redacts legacy content");
    assert.equal(statSync(legacyPath).mode & 0o777, 0o600, "explicit save also tightens a legacy file");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session lock: O_EXCL excludes another process, malformed locks fail closed, and files are private", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-lock-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const id = `lock-${newSessionId()}`;
  const malformedId = `malformed-${newSessionId()}`;
  const storeUrl = new URL("../dist/session/store.js", import.meta.url).href;
  try {
    assert.equal(acquireSessionLock(id).ok, true);
    assert.equal(acquireSessionLock(id).ok, true, "same module instance may re-enter its own tokenized lock");
    const lockPath = join(home, ".hara", "sessions", `${id}.lock`);
    assert.equal(statSync(lockPath).mode & 0o777, 0o600);

    const probe = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", "const m=await import(process.env.STORE_URL); process.stdout.write(JSON.stringify(m.acquireSessionLock(process.env.LOCK_ID)));"],
      { encoding: "utf8", env: { ...process.env, HOME: home, STORE_URL: storeUrl, LOCK_ID: id } },
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), { ok: false, pid: process.pid }, "another process cannot pass the lock race");
    releaseSessionLock(id);

    const malformedPath = join(home, ".hara", "sessions", `${malformedId}.lock`);
    writeFileSync(malformedPath, "not-json", { mode: 0o600 });
    assert.deepEqual(acquireSessionLock(malformedId), { ok: false }, "unknown ownership fails closed");
    assert.equal(readFileSync(malformedPath, "utf8"), "not-json", "fail-closed acquisition does not destroy evidence");
  } finally {
    releaseSessionLock(id);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session save: concurrent readers observe only complete old/new JSON and no temp files survive", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-atomic-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const id = newSessionId();
  const meta = {
    id,
    cwd: "/tmp/hara-atomic",
    provider: "openai",
    model: "test-model",
    title: "atomic",
    createdAt: new Date().toISOString(),
    updatedAt: "",
  };
  try {
    saveSession(meta, [{ role: "user", content: "seed" }]);
    const path = join(home, ".hara", "sessions", `${id}.json`);
    const code = `
      const fs = require("node:fs");
      const path = process.env.SESSION_PATH;
      process.stdout.write("ready\\n");
      const end = Date.now() + 500;
      let error = "";
      while (Date.now() < end) {
        try { JSON.parse(fs.readFileSync(path, "utf8")); }
        catch (e) { error = String(e && e.message || e); break; }
      }
      process.stdout.write(JSON.stringify({ error }));
    `;
    const reader = spawn(process.execPath, ["-e", code], {
      env: { ...process.env, SESSION_PATH: path },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    reader.stdout.setEncoding("utf8");
    reader.stderr.setEncoding("utf8");
    reader.stdout.on("data", (chunk) => { stdout += chunk; });
    reader.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = once(reader, "exit");
    while (!stdout.includes("ready\n")) await once(reader.stdout, "data");

    for (let i = 0; i < 150; i++) {
      saveSession(meta, [{ role: "user", content: `generation ${i} ${"x".repeat((i % 10) * 1000)}` }]);
    }
    const [status] = await exited;
    assert.equal(status, 0, stderr);
    const report = JSON.parse(stdout.slice(stdout.indexOf("\n") + 1));
    assert.equal(report.error, "", `reader saw a partial session: ${report.error}`);
    assert.deepEqual(readdirSync(join(home, ".hara", "sessions")).filter((name) => name.includes(".tmp")), []);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionHub acquires before load and locks offline rename/archive mutations", () => {
  const events = [];
  let locked = false;
  let data = {
    meta: {
      id: "stored",
      cwd: "/tmp/stored",
      provider: "old",
      model: "old-model",
      title: "old title",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    history: [{ role: "user", content: "latest history" }],
    task: {
      schemaVersion: 1,
      id: "task-stored",
      objective: "finish stored task",
      status: "running",
      turnId: "turn-stored",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const store = {
    acquire(id) {
      events.push(`acquire:${id}`);
      if (locked) return { ok: false, pid: 123 };
      locked = true;
      return { ok: true };
    },
    release(id) {
      events.push(`release:${id}`);
      locked = false;
    },
    load(id) {
      events.push(`load:${id}`);
      return id === data.meta.id ? structuredClone(data) : null;
    },
    save(meta, history, task) {
      events.push(`save:${meta.id}`);
      data = structuredClone({ meta, history, ...(task ? { task } : {}) });
    },
    list() { return []; },
    delete() { return false; },
  };
  const provider = { id: "new-provider", model: "new-model", async turn() { throw new Error("unused"); } };
  const hub = new SessionHub(store, "0.148.0-test");

  const resumed = hub.resume("stored", { provider, approval: "suggest" });
  assert.ok("session" in resumed);
  assert.deepEqual(events.slice(0, 2), ["acquire:stored", "load:stored"], "resume reads only after locking");
  assert.equal(resumed.session.meta.provider, "new-provider");
  assert.equal(resumed.session.meta.model, "old-model", "resume keeps the persisted model pin");
  assert.equal(resumed.session.meta.haraVersion, "0.148.0-test", "resume stamps the runtime that now owns the session");
  assert.equal(resumed.session.continuationSession, true, "non-empty persisted history enables continuity guidance");
  assert.equal(resumed.session.task.status, "paused", "a persisted running task recovers as paused/interrupted");
  assert.equal(resumed.session.task.objective, "finish stored task", "resume keeps task identity outside history");

  events.length = 0;
  resumed.session.busy = true;
  assert.deepEqual(hub.resume("stored", { provider, approval: "suggest" }), { busy: true });
  assert.equal(hub.rename("stored", "must wait"), false);
  assert.equal(hub.setArchived("stored", true), false);
  assert.deepEqual(events, [], "busy live-session metadata never reaches persistence");
  resumed.session.busy = false;
  resumed.session.configuring = true;
  assert.deepEqual(hub.resume("stored", { provider, approval: "suggest" }), { busy: true });
  assert.equal(hub.rename("stored", "must still wait"), false);
  assert.equal(hub.setArchived("stored", true), false);
  assert.deepEqual(events, [], "configuring live-session metadata never reaches persistence");
  resumed.session.configuring = false;

  assert.equal(hub.detach("stored"), true, "failed client handshakes can detach without deleting persistence");
  assert.equal(hub.get("stored"), undefined);
  assert.equal(events.at(-1), "release:stored");

  events.length = 0;
  assert.equal(hub.rename("stored", "new title"), true);
  assert.deepEqual(events, ["acquire:stored", "load:stored", "save:stored", "release:stored"]);
  assert.equal(data.meta.title, "new title");
  assert.equal(data.meta.haraVersion, "0.148.0-test", "offline metadata writes retain runtime provenance");

  events.length = 0;
  assert.equal(hub.setArchived("stored", true), true);
  assert.deepEqual(events, ["acquire:stored", "load:stored", "save:stored", "release:stored"]);
  assert.equal(data.meta.archived, true);

  data.history = [];
  events.length = 0;
  const emptyResume = hub.resume("stored", { provider, approval: "suggest" });
  assert.ok("session" in emptyResume);
  assert.equal(emptyResume.session.continuationSession, false, "an empty session does not claim an existing task");
  assert.equal(hub.detach("stored"), true);

  locked = true;
  events.length = 0;
  assert.equal(hub.rename("stored", "must not write"), false);
  assert.deepEqual(events, ["acquire:stored"], "a held lock prevents even the pre-write load");
});

test("SessionHub installs a replacement projection only after its candidate snapshot is durable", () => {
  const saved = new Map();
  let rejectReplacement = false;
  const store = {
    acquire: () => ({ ok: true }),
    release: () => {},
    load: (id) => saved.get(id) ?? null,
    save(meta, history, task) {
      if (rejectReplacement) throw new Error("simulated snapshot write failure");
      saved.set(meta.id, structuredClone({ meta, history, ...(task ? { task } : {}) }));
    },
    list: () => [],
    delete: (id) => saved.delete(id),
  };
  const provider = { id: "fake", model: "fake-1", async turn() { throw new Error("unused"); } };
  const hub = new SessionHub(store, "0.166.1-test");
  const session = hub.create({
    cwd: "/tmp/transactional-replacement",
    provider,
    providerId: provider.id,
    model: provider.model,
    approval: "suggest",
  });
  session.history.push({ role: "user", content: "original durable history" });
  hub.save(session);
  const originalUpdatedAt = session.meta.updatedAt;

  rejectReplacement = true;
  assert.throws(
    () => hub.replaceSnapshot(
      session,
      { ...session.meta, workingSet: ["candidate only"] },
      [{ role: "user", content: "compacted candidate" }],
      session.task,
    ),
    /simulated snapshot write failure/,
  );
  assert.deepEqual(session.history, [{ role: "user", content: "original durable history" }]);
  assert.equal(session.meta.workingSet, undefined);
  assert.equal(session.meta.updatedAt, originalUpdatedAt);
  assert.deepEqual(saved.get(session.meta.id).history, [{ role: "user", content: "original durable history" }]);

  rejectReplacement = false;
  hub.replaceSnapshot(
    session,
    { ...session.meta, workingSet: ["candidate committed"] },
    [{ role: "user", content: "compacted candidate" }],
    session.task,
  );
  assert.deepEqual(session.history, [{ role: "user", content: "compacted candidate" }]);
  assert.deepEqual(session.meta.workingSet, ["candidate committed"]);
  assert.deepEqual(saved.get(session.meta.id).history, [{ role: "user", content: "compacted candidate" }]);
});

test("SessionHub releaseIdle keeps in-flight locks and releases only quiescent sessions", () => {
  const released = [];
  const saved = new Map();
  const store = {
    acquire: () => ({ ok: true }),
    release: (id) => released.push(id),
    load: (id) => saved.get(id) ?? null,
    save: (meta, history) => saved.set(meta.id, structuredClone({ meta, history })),
    list: () => [],
    delete: (id) => saved.delete(id),
  };
  const provider = { id: "fake", model: "fake-1", async turn() { throw new Error("unused"); } };
  const hub = new SessionHub(store, "0.148.0-test");
  const busy = hub.create({ cwd: "/tmp/busy", provider, providerId: provider.id, model: provider.model, approval: "suggest", agentRef: "global:architect" });
  const configuring = hub.create({ cwd: "/tmp/configuring", provider, providerId: provider.id, model: provider.model, approval: "suggest", agentRef: "global:reviewer" });
  const idle = hub.create({ cwd: "/tmp/idle", provider, providerId: provider.id, model: provider.model, approval: "suggest" });
  assert.equal(saved.size, 0, "opening new chats creates only live drafts, not empty transcript files");
  assert.equal(busy.meta.haraVersion, "0.148.0-test");
  assert.equal(configuring.meta.haraVersion, "0.148.0-test");
  assert.equal(idle.meta.haraVersion, "0.148.0-test");
  busy.busy = true;
  configuring.configuring = true;
  assert.equal(hub.hasActiveWorkForAgent("global:architect"), true);
  assert.equal(hub.hasActiveWorkForAgent("global:reviewer"), true);
  assert.equal(hub.hasActiveWorkForAgent("global:unrelated"), false);

  hub.releaseIdle();
  assert.equal(hub.get(idle.meta.id), undefined);
  assert.equal(hub.get(busy.meta.id), busy);
  assert.equal(hub.get(configuring.meta.id), configuring);
  assert.deepEqual(released, [idle.meta.id]);

  busy.busy = false;
  configuring.configuring = false;
  assert.equal(hub.hasActiveWorkForAgent("global:architect"), false);
  assert.equal(hub.hasActiveWorkForAgent("global:reviewer"), false);
  hub.releaseAll();
  assert.deepEqual(new Set(released), new Set([idle.meta.id, busy.meta.id, configuring.meta.id]));
});

test("SessionHub persists a draft on its first content and can delete an abandoned draft", () => {
  const saved = new Map();
  const released = [];
  const store = {
    acquire: () => ({ ok: true }),
    release: (id) => released.push(id),
    load: (id) => saved.get(id) ?? null,
    save: (meta, history, task) => saved.set(meta.id, structuredClone({ meta, history, ...(task ? { task } : {}) })),
    list: () => [],
    delete: (id) => saved.delete(id),
  };
  const provider = { id: "fake", model: "fake-1", async turn() { throw new Error("unused"); } };
  const hub = new SessionHub(store);
  const draft = hub.create({ cwd: "/tmp/draft", provider, providerId: provider.id, model: provider.model, approval: "suggest" });
  assert.equal(saved.has(draft.meta.id), false);
  assert.equal(hub.listPage({ cwd: "/tmp/draft" }).sessions[0].id, draft.meta.id,
    "the running client can discover its empty live draft without a transcript file");
  assert.equal(draft.meta.updatedAt, draft.meta.createdAt, "a live draft has a stable timeline position before first save");
  assert.equal(hub.setApproval(draft.meta.id, "full-auto"), "updated");
  assert.equal(hub.rename(draft.meta.id, "draft title"), true);
  assert.equal(saved.has(draft.meta.id), false, "metadata-only edits do not turn an abandoned draft into history");
  draft.history.push({ role: "user", content: "start work" });
  hub.save(draft);
  assert.equal(saved.get(draft.meta.id).history.length, 1);

  const abandoned = hub.create({ cwd: "/tmp/draft", provider, providerId: provider.id, model: provider.model, approval: "suggest" });
  assert.equal(hub.delete(abandoned.meta.id), "gone");
  assert.equal(hub.get(abandoned.meta.id), undefined);
  assert.ok(!hub.listPage({ cwd: "/tmp/draft" }).sessions.some((meta) => meta.id === abandoned.meta.id));
  assert.ok(released.includes(abandoned.meta.id));
});

test("SessionHub journals runtime projections only after a draft becomes durable", () => {
  const saved = new Map();
  const taskEvents = [];
  const retryEvents = [];
  const runtimeItemEvents = [];
  const compactionEvents = [];
  const approvalEvents = [];
  let rejectJournal = false;
  const store = {
    acquire: () => ({ ok: true }),
    release: () => {},
    load: (id) => saved.get(id) ?? null,
    save: (meta, history, task) => saved.set(meta.id, structuredClone({ meta, history, ...(task ? { task } : {}) })),
    list: () => [],
    delete: (id) => saved.delete(id),
    recordTaskState(event) {
      if (rejectJournal) throw new Error("simulated diagnostic write failure");
      taskEvents.push(structuredClone(event));
      return true;
    },
    recordProviderRetry(event) {
      if (rejectJournal) throw new Error("simulated diagnostic write failure");
      retryEvents.push(structuredClone(event));
      return true;
    },
    recordRuntimeItem(event) {
      if (rejectJournal) throw new Error("simulated diagnostic write failure");
      runtimeItemEvents.push(structuredClone(event));
      return true;
    },
    recordCompactionState(event) {
      if (rejectJournal) throw new Error("simulated diagnostic write failure");
      compactionEvents.push(structuredClone(event));
      return true;
    },
    recordApprovalState(event) {
      if (rejectJournal) throw new Error("simulated diagnostic write failure");
      approvalEvents.push(structuredClone(event));
      return true;
    },
  };
  const provider = { id: "fake", model: "fake-1", async turn() { throw new Error("unused"); } };
  const hub = new SessionHub(store);
  const draft = hub.create({
    cwd: "/tmp/runtime-journal-draft",
    provider,
    providerId: provider.id,
    model: provider.model,
    approval: "suggest",
  });
  draft.task = createTaskExecution(
    "journal this active task",
    "turn-runtime",
    "2026-09-09T00:00:00.000Z",
  );
  const taskState = {
    sessionId: draft.meta.id,
    taskId: draft.task.id,
    turnId: draft.task.turnId,
    state: "running",
    taskStatus: "running",
    phase: "thinking",
    at: "2026-09-09T00:00:01.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  };
  const retry = {
    provider: "fixture",
    model: "fixture-model",
    attempt: 1,
    nextAttempt: 2,
    kind: "transient",
    delayMs: 250,
    elapsedMs: 30,
  };
  const compaction = {
    sessionId: draft.meta.id,
    attemptId: "77777777-7777-4777-8777-777777777777",
    windowId: "88888888-8888-4888-8888-888888888888",
    sourceMessages: 2,
    state: "started",
  };
  const runtimeItem = {
    sessionId: draft.meta.id,
    taskId: draft.task.id,
    turnId: draft.task.turnId,
    itemId: "provider-runtime-item",
    kind: "provider",
    state: "started",
    provider: "fixture",
    model: "fixture-model",
  };
  const approval = {
    sessionId: draft.meta.id,
    approvalId: "cccccccc-3333-4333-8333-333333333333",
    taskId: draft.task.id,
    turnId: draft.task.turnId,
    allowAlways: true,
    state: "requested",
  };

  assert.equal(hub.recordTaskState(taskState), false);
  assert.equal(hub.recordProviderRetry(draft.meta.id, retry), false);
  assert.equal(hub.recordRuntimeItem(runtimeItem), false);
  assert.equal(hub.recordCompactionState(compaction), false);
  assert.equal(hub.recordApprovalState(approval), false);
  assert.deepEqual(taskEvents, []);
  assert.deepEqual(retryEvents, []);
  assert.deepEqual(runtimeItemEvents, []);
  assert.deepEqual(compactionEvents, []);
  assert.deepEqual(approvalEvents, []);

  draft.history.push({ role: "user", content: "make this session durable" });
  hub.save(draft);
  assert.equal(hub.recordTaskState(taskState), true);
  assert.equal(hub.recordProviderRetry(draft.meta.id, retry), true);
  assert.equal(hub.recordRuntimeItem(runtimeItem), true);
  assert.equal(hub.recordCompactionState(compaction), true);
  assert.equal(hub.recordApprovalState(approval), true);
  assert.deepEqual(taskEvents, [taskState]);
  assert.deepEqual(retryEvents, [{
    sessionId: draft.meta.id,
    taskId: draft.task.id,
    turnId: draft.task.turnId,
    retry,
  }]);
  assert.deepEqual(runtimeItemEvents, [runtimeItem]);
  assert.deepEqual(compactionEvents, [compaction]);
  assert.deepEqual(approvalEvents, [approval]);

  assert.equal(hub.recordTaskState({ ...taskState, turnId: "stale-turn" }), false);
  assert.equal(hub.recordRuntimeItem({ ...runtimeItem, turnId: "stale-turn" }), false);
  assert.equal(taskEvents.length, 1, "a stale turn cannot enter the active task journal");
  rejectJournal = true;
  assert.equal(hub.recordTaskState(taskState), false);
  assert.equal(hub.recordProviderRetry(draft.meta.id, retry), false);
  assert.equal(hub.recordRuntimeItem(runtimeItem), false);
  assert.equal(hub.recordCompactionState({
    ...compaction,
    attemptId: "99999999-9999-4999-8999-999999999999",
    windowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  }), false);
  assert.equal(hub.recordApprovalState({ ...approval, state: "resolved", outcome: "allowed" }), false);
  assert.equal(taskEvents.length, 1, "diagnostic failures never escape into the active task");
  assert.equal(retryEvents.length, 1, "diagnostic failures never escape into provider retry");
  assert.equal(runtimeItemEvents.length, 1, "diagnostic failures never escape into runtime item handling");
  assert.equal(compactionEvents.length, 1, "diagnostic failures never escape into compaction");
  assert.equal(approvalEvents.length, 1, "diagnostic failures never escape into approval handling");
});

test("SessionHub pages live drafts before durable history without persisting the drafts", () => {
  const saved = new Map();
  const storedMeta = {
    id: "stored-session",
    cwd: "/tmp/paged-drafts",
    provider: "fake",
    model: "fake-1",
    title: "stored",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:01.000Z",
    source: "interactive",
  };
  const store = {
    acquire: () => ({ ok: true }),
    release: () => {},
    load: (id) => saved.get(id) ?? null,
    save: (meta, history, task) => saved.set(meta.id, structuredClone({ meta, history, ...(task ? { task } : {}) })),
    list: () => [storedMeta],
    listPage: ({ cursor, limit = 50 }) => {
      const offset = cursor === undefined ? 0 : Number(cursor.slice("stored:".length));
      const sessions = [storedMeta].slice(offset, offset + limit);
      const nextOffset = offset + sessions.length;
      return {
        sessions,
        hasMore: nextOffset < 1,
        ...(nextOffset < 1 ? { nextCursor: `stored:${nextOffset}` } : {}),
        limit,
      };
    },
    delete: (id) => saved.delete(id),
  };
  const provider = { id: "fake", model: "fake-1", async turn() { throw new Error("unused"); } };
  const hub = new SessionHub(store);
  const firstDraft = hub.create({ cwd: "/tmp/paged-drafts", provider, providerId: provider.id, model: provider.model, approval: "suggest" });
  const secondDraft = hub.create({ cwd: "/tmp/paged-drafts", provider, providerId: provider.id, model: provider.model, approval: "suggest" });

  const first = hub.listPage({ cwd: "/tmp/paged-drafts", sources: ["interactive"], limit: 1 });
  const second = hub.listPage({ cwd: "/tmp/paged-drafts", sources: ["interactive"], limit: 1, cursor: first.nextCursor });
  const third = hub.listPage({ cwd: "/tmp/paged-drafts", sources: ["interactive"], limit: 1, cursor: second.nextCursor });
  assert.deepEqual(new Set([first.sessions[0].id, second.sessions[0].id]), new Set([firstDraft.meta.id, secondDraft.meta.id]));
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, true);
  assert.equal(third.sessions[0].id, storedMeta.id);
  assert.equal(third.hasMore, false);
  assert.equal(saved.size, 0, "listing live drafts never creates durable history rows");
});

test("SessionHub preserves an explicit provider-automatic reasoning default across save, resume, and fork", () => {
  const saved = new Map();
  const store = {
    acquire: () => ({ ok: true }),
    release: () => {},
    load: (id) => saved.get(id) ?? null,
    save: (meta, history, task) => saved.set(meta.id, structuredClone({ meta, history, ...(task ? { task } : {}) })),
    list: () => [],
    delete: (id) => saved.delete(id),
  };
  const provider = { id: "fake", model: "fake-1", async turn() { throw new Error("unused"); } };
  const firstHub = new SessionHub(store);
  const original = firstHub.create({
    cwd: "/tmp/automatic",
    provider,
    providerId: provider.id,
    model: provider.model,
    effort: null,
    approval: "suggest",
  });
  assert.equal(original.meta.effort, null);
  original.history.push({ role: "user", content: "persist automatic" });
  firstHub.save(original);
  firstHub.releaseAll();

  const secondHub = new SessionHub(store);
  const resumed = secondHub.resume(original.meta.id, { provider, approval: "suggest" });
  assert.ok("session" in resumed);
  assert.equal(resumed.session.effort, null);
  assert.equal(resumed.session.meta.effort, null);

  const forked = secondHub.fork(original.meta.id, {
    provider,
    providerId: provider.id,
    approval: "suggest",
    effort: null,
  });
  assert.ok("session" in forked);
  assert.equal(forked.session.effort, null);
  assert.equal(forked.session.meta.effort, null);
  assert.equal(saved.get(forked.session.meta.id).meta.effort, null);
  secondHub.releaseAll();
});
