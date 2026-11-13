// Shared fixtures for the recent private-conversation tests (fake providers; zero real model calls).
import { randomUUID } from "node:crypto";
import { setup, until } from "./local-channels.mjs";

export const UI = { source: "ui", channel: "rpc", clientId: "client" };
export const reply = text => ({ text, toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
// Colleagues run on the real native Pi path here: Hara tools are exposed as mcp__hara__*, and the
// governed projection reaches the model as Pi's first "Hara authoritative conversation" prompt.
export const call = (name, input) => ({ text: "", toolUses: [{ id: randomUUID(), name: "mcp__hara__" + name, input }], stop: "tool_use", usage: { input: 1, output: 1 } });
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
    return (script[context.objective] ?? [reply("收到。")])[round] ?? reply("收到。");
  } });
  return { calls, factory };
}
export async function send(f, agentId, message, origin = UI) {
  const run = f.host.start("client", f.id, agentId, message, randomUUID(), false, undefined, undefined, origin);
  await f.host.wait(run.runId); return run;
}
