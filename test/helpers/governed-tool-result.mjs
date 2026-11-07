import assert from "node:assert/strict";

// Codex attaches a separate governance reminder after the original JSON receipt.
export function governedToolResult(text) {
  assert.equal(typeof text, "string");
  const [body, ...reminders] = text.split("\n\n<system-reminder>");
  assert.ok(reminders.length <= 1);
  if (reminders.length) assert.ok(reminders[0].trimEnd().endsWith("</system-reminder>"));
  return JSON.parse(body);
}
export function compactRosterIds(value) {
  assert.deepEqual(value.columns, ["id", "name", "role", "runtime", "state"]);
  assert.ok(Array.isArray(value.agents));
  for (const row of value.agents) assert.ok(Array.isArray(row) && row.length === value.columns.length);
  return value.agents.map(row => row[0]);
}
