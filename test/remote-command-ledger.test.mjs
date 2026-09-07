import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RemoteCommandLedger,
} from "../dist/serve/remote-command-ledger.js";

const hash = (character) => character.repeat(64);
const command = (commandId, requestHash = hash("b")) => ({
  commandId,
  method: "external.sessions.submit",
  resourceHash: hash("a"),
  requestHash,
});

test("remote command ledger deduplicates one UUID while allowing an explicit live steer", () => {
  const ledger = new RemoteCommandLedger();
  const first = command("11111111-1111-4111-8111-111111111111");
  assert.deepEqual(ledger.claim(first), { kind: "new" });
  assert.equal(ledger.claim(first).kind, "uncertain");
  const liveSteer = {
    ...command("22222222-2222-4222-8222-222222222222"),
    method: "external.sessions.steer",
  };
  assert.equal(ledger.claim(liveSteer).kind, "new");
  ledger.complete(liveSteer.commandId, { kind: "result", json: JSON.stringify({ accepted: true }) });

  ledger.complete(first.commandId, {
    kind: "result",
    json: JSON.stringify({ reply: "done", apiKey: "sk-1234567890abcdef" }),
  });
  const replay = ledger.claim(first);
  assert.equal(replay.kind, "completed");
  assert.doesNotMatch(replay.outcome.json, /sk-1234567890abcdef/);
  assert.equal(
    ledger.claim({ ...first, requestHash: hash("c") }).kind,
    "conflict",
  );
});

test("remote command ledger survives restart and requires authoritative reconciliation", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-remote-command-ledger-"));
  const ledgerPath = join(home, ".hara", "serve", "remote-command-receipts.json");
  const first = command("33333333-3333-4333-8333-333333333333");
  try {
    const original = new RemoteCommandLedger({ home });
    assert.deepEqual(original.claim(first), { kind: "new" });
    assert.equal(statSync(ledgerPath).mode & 0o777, 0o600);

    const restarted = new RemoteCommandLedger({ home });
    assert.equal(restarted.claim(first).kind, "uncertain");
    assert.equal(restarted.reconcileResource(hash("a"), "working"), 0);
    assert.equal(restarted.reconcileResource(hash("a"), "idle"), 1);
    const reconciled = restarted.claim(first);
    assert.equal(reconciled.kind, "completed");
    assert.equal(reconciled.outcome.kind, "result_omitted");

    const next = command("44444444-4444-4444-8444-444444444444", hash("d"));
    assert.deepEqual(restarted.claim(next), { kind: "new" });
    restarted.complete(next.commandId, {
      kind: "error",
      code: -32000,
      message: "provider rejected Authorization: Bearer sk-abcdef1234567890",
    });
    const disk = readFileSync(ledgerPath, "utf8");
    assert.doesNotMatch(disk, /sk-abcdef1234567890/);

    const finalRestart = new RemoteCommandLedger({ home });
    const failed = finalRestart.claim(next);
    assert.equal(failed.kind, "completed");
    assert.equal(failed.outcome.kind, "error");
    assert.doesNotMatch(failed.outcome.message, /sk-abcdef1234567890/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("remote command ledger never evicts an unresolved side effect", () => {
  const ledger = new RemoteCommandLedger({ maxReceipts: 1 });
  assert.equal(ledger.claim(command("55555555-5555-4555-8555-555555555555")).kind, "new");
  assert.equal(
    ledger.claim({
      ...command("66666666-6666-4666-8666-666666666666"),
      resourceHash: hash("e"),
    }).kind,
    "busy",
  );
});

test("a failed terminal receipt blocks the resource until its durable snapshot is recovered", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-remote-command-ledger-write-failure-"));
  const ledgerPath = join(home, ".hara", "serve", "remote-command-receipts.json");
  const first = command("77777777-7777-4777-8777-777777777777");
  const next = command("88888888-8888-4888-8888-888888888888", hash("e"));
  try {
    const ledger = new RemoteCommandLedger({ home });
    assert.deepEqual(ledger.claim(first), { kind: "new" });
    const durableStarted = readFileSync(ledgerPath, "utf8");

    // Simulate another writer changing the file after the provider side effect but before terminal commit.
    writeFileSync(ledgerPath, `${durableStarted} `, { mode: 0o600 });
    assert.throws(
      () => ledger.complete(first.commandId, { kind: "result", json: JSON.stringify({ accepted: true }) }),
      /changed outside the active Hara Serve writer/,
    );
    assert.equal(ledger.claim(first).kind, "uncertain");
    assert.equal(ledger.claim(next).kind, "uncertain");

    // Once storage is available again, replaying the terminal commit never reruns the provider action.
    writeFileSync(ledgerPath, durableStarted, { mode: 0o600 });
    ledger.complete(first.commandId, { kind: "result", json: JSON.stringify({ accepted: true }) });
    assert.equal(ledger.claim(first).kind, "completed");
    assert.deepEqual(ledger.claim(next), { kind: "new" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
