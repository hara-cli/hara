import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { parsePlan, topoOrder, topoWaves, runCheck } from "../dist/org/planner.js";

test("parsePlan: parses fenced JSON + normalizes deps/status", () => {
  const text = '```json\n{"atoms":[{"id":"a1","title":"do x","deps":[]},{"id":"a2","title":"do y","deps":["a1"],"verify":"x works","role":"impl"}]}\n```';
  const atoms = parsePlan(text);
  assert.equal(atoms.length, 2);
  assert.equal(atoms[1].id, "a2");
  assert.deepEqual(atoms[1].deps, ["a1"]);
  assert.equal(atoms[1].role, "impl");
  assert.equal(atoms[0].status, "pending");
});

test("parsePlan: bare JSON + prose around it; defaults missing ids", () => {
  const atoms = parsePlan('Here is the plan:\n{"atoms":[{"title":"only title"}]}\nDone.');
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].id, "a1"); // defaulted
  assert.deepEqual(atoms[0].deps, []);
});

test("parsePlan: garbage → empty", () => {
  assert.deepEqual(parsePlan("no json here"), []);
  assert.deepEqual(parsePlan("{bad json"), []);
});

test("topoOrder: sequences by deps", () => {
  const atoms = parsePlan('{"atoms":[{"id":"a2","title":"y","deps":["a1"]},{"id":"a1","title":"x","deps":[]},{"id":"a3","title":"z","deps":["a1"]}]}');
  const r = topoOrder(atoms);
  assert.ok("ok" in r);
  assert.equal(r.ok[0].id, "a1"); // dependency first regardless of input order
  assert.ok(r.ok.findIndex((a) => a.id === "a2") > 0);
});

test("topoOrder: detects a cycle", () => {
  const atoms = parsePlan('{"atoms":[{"id":"a1","title":"x","deps":["a2"]},{"id":"a2","title":"y","deps":["a1"]}]}');
  const r = topoOrder(atoms);
  assert.ok("error" in r);
  assert.match(r.error, /cycle/);
});

test("topoOrder: ignores dangling deps", () => {
  const atoms = parsePlan('{"atoms":[{"id":"a1","title":"x","deps":["nonexistent"]}]}');
  const r = topoOrder(atoms);
  assert.ok("ok" in r);
  assert.equal(r.ok.length, 1);
});

test("topoWaves: groups independent atoms into concurrent waves (diamond DAG)", () => {
  // a1 → (a2, a3) → a4   ⇒ waves [a1], [a2,a3], [a4]
  const atoms = parsePlan(
    '{"atoms":[{"id":"a4","title":"merge","deps":["a2","a3"]},{"id":"a1","title":"setup","deps":[]},{"id":"a2","title":"left","deps":["a1"]},{"id":"a3","title":"right","deps":["a1"]}]}',
  );
  const r = topoWaves(atoms);
  assert.ok("ok" in r);
  assert.equal(r.ok.length, 3);
  assert.deepEqual(r.ok[0].map((a) => a.id), ["a1"]);
  assert.deepEqual(r.ok[1].map((a) => a.id).sort(), ["a2", "a3"]); // independent → same wave
  assert.deepEqual(r.ok[2].map((a) => a.id), ["a4"]);
  assert.equal(r.ok.flat().length, atoms.length); // every atom scheduled once
});

test("topoWaves: all-independent atoms collapse to one wave", () => {
  const atoms = parsePlan('{"atoms":[{"id":"a1","title":"x","deps":[]},{"id":"a2","title":"y","deps":[]},{"id":"a3","title":"z","deps":[]}]}');
  const r = topoWaves(atoms);
  assert.ok("ok" in r);
  assert.equal(r.ok.length, 1);
  assert.equal(r.ok[0].length, 3);
});

test("topoWaves: detects a cycle", () => {
  const atoms = parsePlan('{"atoms":[{"id":"a1","title":"x","deps":["a2"]},{"id":"a2","title":"y","deps":["a1"]}]}');
  const r = topoWaves(atoms);
  assert.ok("error" in r);
  assert.match(r.error, /cycle/);
});

test("parsePlan: captures a check command", () => {
  const a = parsePlan('{"atoms":[{"id":"a1","title":"t","deps":[],"check":"npm test"}]}');
  assert.equal(a[0].check, "npm test");
});

test("runCheck: exit 0 passes, nonzero fails", async () => {
  const ok = await runCheck("echo hi", tmpdir(), "off");
  assert.ok(ok.ok);
  assert.match(ok.reason, /hi/);
  const bad = await runCheck("exit 3", tmpdir(), "off");
  assert.ok(!bad.ok);
});
