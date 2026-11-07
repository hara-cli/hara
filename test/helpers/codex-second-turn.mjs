// Shared fixtures for the Codex second-turn suites (split for the per-file deadline on hosted Intel).
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { until } from "./workspace-cli-mcp.mjs";
export const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
export async function exchange(f, text) { await f.send(text); return until(f.read, done); }
export function state(f) {
  const relative = fs.readdirSync(f.root, { recursive: true }).find(name => /(?:^|\/)codex-thread-[a-f0-9]+\.json$/.test(name));
  assert.ok(relative); return JSON.parse(fs.readFileSync(join(f.root, relative), "utf8"));
}
export const controls = f => f.native().filter(row => ["thread/start", "thread/resume"].includes(row.method));
export const turns = f => f.native().filter(row => row.method === "turn/start");
export const events = f => fs.readFileSync(f.command + ".events.jsonl", "utf8").trim().split("\n").map(row => JSON.parse(row));
export async function changeStanding(f) {
 const agent=(await f.read()).agents.find(row=>row.agentId===f.main.agentId);
 return f.request("workspace.agents.updatePersona",{...f.scope,agentId:agent.agentId,configRevision:agent.configRevision,
  agentEpoch:agent.agentEpoch,input:{profile:{displayName:"Fresh governed persona"}}});
}
