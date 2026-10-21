import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { after } from "node:test";
import { LocalWorkspaceHost } from "../../dist/workspace/local-host.js";
import { WorkspaceResources } from "../../dist/workspace/resources.js";
import { MemoryCredentialVault } from "../../dist/workspace/credential-vault.js";
import { SYNTHETIC_CONNECTION } from "../../dist/workspace/synthetic-provider.js";

// Shared by the workspace-local-channels*.test.mjs files, which are split so each stays within the
// per-file test timeout on the slower hosted Intel runner.
const temporary = [];
after(() => { for (const p of temporary) fs.rmSync(p, { recursive: true, force: true }); });
export async function setup(count = 3, providerFactory) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-local-channel-"))); temporary.push(root);
  const calls = [], options = { mode: "workspace", credentialVault: new MemoryCredentialVault(), providerFactory: providerFactory ?? ((_connection, binding, context) => ({
    id: "openai", model: binding.model, async turn(args) {
      calls.push({ agentId: context.agent.agentId, objective: context.objective, system: args.system, history: structuredClone(args.history) });
      return { text: `${context.agent.identity.displayName}: ${context.objective}`, toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  })) }, host = new LocalWorkspaceHost(root, options);
  await host.initialize(); const workspace = host.createWorkspace("Local personal", host.list().revision), id = workspace.workspaceId;
  host.configureConnection(id, { ...SYNTHETIC_CONNECTION }, 0); host.select("client", id, host.list().revision);
  const resources = new WorkspaceResources(host.home, host.catalog.resolve(id).scope); resources.initialize();
  const members = [];
  for (let i = 0; i < count; i++) members.push(resources.agents.create({ username: `colleague-${i}`, profile: { displayName: `Colleague ${i}` } }, resources.agents.list().revision).agentId);
  const create = (name = "Local planning", memberIds = members) => {
    const channelId = randomUUID(); host.createChannel("client", id, channelId, name, memberIds, host.listChannels(id).revision); host.selectChannel("client", id, channelId); return channelId;
  };
  return { root, host, options, id, workspace, resources, members, create, calls };
}
export async function until(read) { for (let n = 0; n < 150; n++) { const value = await read(); if (value) return value; await new Promise(r => setTimeout(r, 30)); } throw new Error("bounded local channel wait"); }
