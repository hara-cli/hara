// Shared fixtures for the recent private-conversation tests (fake providers; zero real model calls).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup as setupLocalChannels } from "./local-channels.mjs";
import { DEFAULT_TIER } from "./platform-tier.mjs";

// Let focused macOS runs exercise the same controlled fixtures as Linux.
export const recentConversationTier = process.env.HARA_TEST_RECENT_CONVERSATION_TIER ?? DEFAULT_TIER;
export async function setup(memberCount, providerFactory, tier = recentConversationTier) {
  const fixture = await setupLocalChannels(memberCount, providerFactory, tier);
  const main = fixture.resources.agents.get(fixture.workspace.selectedAgentId);
  if (main.permissionTier !== tier) {
    fixture.resources.agents.setPermissionTier(main.agentId, tier, main.configRevision, main.agentEpoch);
  }
  return fixture;
}

export const UI = { source: "ui", channel: "rpc", clientId: "client" };
export const reply = text => ({ text, toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
export const call = (name, input) => ({ text: "", toolUses: [{ id: randomUUID(), name, input }], stop: "tool_use", usage: { input: 1, output: 1 } });
export const PI_PROMPT = "Hara authoritative conversation:\n";
export const unwrap = history => {
  const prompt = history.find(row => row.role === "user" && String(row.content).startsWith(PI_PROMPT));
  return prompt ? JSON.parse(String(prompt.content).slice(PI_PROMPT.length)) : history;
};
export const recentBlock = history => unwrap(history).find(row => row.role === "user" && String(row.content).startsWith("<hara-recent-conversation>"));
export const parseRecent = block => JSON.parse(String(block.content).split("\n").at(-2));
export function scripted(script) {
  const calls = [];
  const factory = (_connection, binding, context) => ({ id: "openai", model: binding.model, trailingTurnContext: true, async turn(args) {
    const round = calls.filter(row => row.objective === context.objective).length;
    calls.push({ agentId: context.agent.agentId, objective: context.objective, history: structuredClone(args.history), system: args.system });
    const response = script[context.objective]?.[round] ?? reply("收到。");
    const toolUses = response.toolUses.map(use => {
      const advertised = args.tools.filter(tool => tool.name === use.name || tool.name === "mcp__hara__" + use.name);
      assert.equal(advertised.length, 1, `Expected one advertised tool for ${use.name}`);
      return { ...use, name: advertised[0].name };
    });
    return { ...response, toolUses };
  } });
  return { calls, factory };
}
export async function send(f, agentId, message, origin = UI) {
  const run = await f.host.start("client", f.id, agentId, message, randomUUID(), false, undefined, undefined, origin);
  await f.host.wait(run.runId); return run;
}
