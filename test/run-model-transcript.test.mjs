import test from "node:test";
import assert from "node:assert/strict";
import { RunModelTranscript } from "../dist/agent/run-model-transcript.js";
test("run transcript hides durable legacy reminders, retains feedback through three views, and removes rolled-back replies", () => {
  const original = { role: "user", content: "task" }, legacy = { role: "user", content: "legacy internal reminder" };
  const history = [legacy, original], transcript = new RunModelTranscript(history, row => row === legacy);
  const feedback = { role: "user", content: "run-only feedback" }; transcript.push(feedback);
  const bad = { role: "assistant", text: "discard", toolUses: [] }; history.push(bad); transcript.read(); history.pop();
  const assistant = { role: "assistant", text: "next", toolUses: [{ id: "read", name: "probe", input: {} }] };
  const results = { role: "tool", results: [{ id: "read", name: "probe", content: "observed" }] };
  history.push(assistant, results);
  for (let request = 0; request < 3; request++) assert.deepEqual(transcript.read(), [original, feedback, assistant, results]);
  assert.deepEqual(history, [legacy, original, assistant, results], "no transient row is persisted");
});
