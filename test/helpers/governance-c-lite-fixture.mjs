import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../../dist/workspace/credential-vault.js";
import { WorkspaceChangeTrace, engineTaskBrief, simpleChangeObjective } from "../../dist/agent/governance-c-lite.js";

const roots = [];
after(() => roots.forEach(path => fs.rmSync(path, { recursive: true, force: true })));
const root = () => { const path = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-c-lite-"))); roots.push(path); return path; };
export const response = (text, toolUses = []) => ({ text, toolUses, stop: toolUses.length ? "tool_use" : "end", usage: { input: 5, output: 5 } });
export const call = (id, name, input = {}) => ({ id, name, input });

// These exact tool-ID ledger tests exercise the governed in-process path explicitly.
export async function run(message, turns, tier = "controlled") {
  const path = root(); let rounds = 0;
  const host = new LocalWorkspaceHost(path, { credentialVault: new MemoryCredentialVault(),
    providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn() {
      return turns[rounds++] ?? response("Still done.");
    } }; } });
  try {
    const ws = host.createWorkspace("C-lite", host.list().revision); host.configureSynthetic(ws.workspaceId, 0);
    const agent = host.context(ws.workspaceId).resources.agents.get(ws.selectedAgentId);
    if (agent.permissionTier !== tier) host.context(ws.workspaceId).resources.agents.setPermissionTier(agent.agentId, tier, agent.configRevision, agent.agentEpoch);
    host.select("tester", ws.workspaceId, host.list().revision);
    const receipt = host.start("tester", ws.workspaceId, ws.selectedAgentId, message, randomUUID());
    await host.wait(receipt.runId);
    return { rounds, view: host.snapshot(ws.workspaceId, ws.selectedAgentId, "tester").conversation,
      project: join(path, "project", ws.workspaceId) };
  } finally { await host.close(); }
}
