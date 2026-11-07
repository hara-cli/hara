import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { createWorkspaceSyntheticProvider } from "../dist/workspace/synthetic-provider.js";

// Decision B (Jeff 2026-11-08). The Host platform is simulated synchronously around each Workspace operation;
// production code reads process.platform directly and has no other platform input.
const roots = [], dir = () => { const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-platform-tiers-"))); roots.push(root); return root; };
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const original = Object.getOwnPropertyDescriptor(process, "platform");
function on(platform, fn) {
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try { return fn(); } finally { Object.defineProperty(process, "platform", original); }
}
const unavailable = error => error?.code === "permission_tier_unavailable_on_platform";
function fixture() {
  const host = new LocalWorkspaceHost(dir(), { mode: "workspace", credentialVault: new MemoryCredentialVault(), providerFactory: createWorkspaceSyntheticProvider });
  const workspace = host.createWorkspace("Fixture", host.list().revision);
  return { host, workspaceId: workspace.workspaceId, agents: host.context(workspace.workspaceId).resources.agents };
}
const create = (agents, username, extra = {}) => agents.create({ username, profile: { displayName: username }, runtimeId: "pi", ...extra }, agents.list().revision);

test("off macOS a new colleague defaults to the controlled tier and the full tier is refused on create and on change", async () => {
  const f = fixture();
  try {
    on("linux", () => {
      const created = create(f.agents, "linux-default");
      assert.equal(created.permissionTier, "controlled"); assert.equal(created.permissionTierUnavailable, undefined);
      assert.throws(() => create(f.agents, "linux-full", { permissionTier: "full-protected" }), unavailable);
      assert.throws(() => f.host.setAgentPermissionTier(f.workspaceId, created.agentId, "full-protected", created.configRevision, created.agentEpoch), unavailable);
      assert.equal(f.agents.get(created.agentId).permissionTier, "controlled", "a refused change writes nothing");
    });
  } finally { await f.host.close(); }
});

test("macOS keeps the full tier as the default and accepts both tiers", async () => {
  const f = fixture();
  try {
    on("darwin", () => {
      const created = create(f.agents, "mac-default"); assert.equal(created.permissionTier, "full-protected");
      const controlled = create(f.agents, "mac-controlled", { permissionTier: "controlled" }); assert.equal(controlled.permissionTier, "controlled");
    });
  } finally { await f.host.close(); }
});

test("a full-tier colleague moved to a platform without Seatbelt is surfaced and refused until an explicit switch", async () => {
  const f = fixture();
  try {
    const stored = on("darwin", () => create(f.agents, "migrated", { permissionTier: "full-protected" }));
    on("linux", () => {
      const view = f.agents.get(stored.agentId);
      assert.equal(view.permissionTier, "full-protected", "the stored choice is shown, not silently rewritten");
      assert.equal(view.permissionTierUnavailable, true);
      assert.throws(() => f.host.start("client", f.workspaceId, stored.agentId, "Run without protection?", randomUUID()), unavailable);
      const switched = f.host.setAgentPermissionTier(f.workspaceId, stored.agentId, "controlled", view.configRevision, view.agentEpoch);
      assert.equal(switched.permissionTier, "controlled"); assert.equal(switched.permissionTierUnavailable, undefined);
    });
    // The same stored colleague is unaffected on macOS.
    on("darwin", () => assert.equal(f.agents.get(stored.agentId).permissionTierUnavailable, undefined));
  } finally { await f.host.close(); }
});

test("a Workspace created off macOS gives its main Hara the controlled tier, so nothing is stranded", async () => {
  const f = on("linux", () => fixture());
  try {
    on("linux", () => {
      const main = f.agents.get(f.agents.list().mainAgentId);
      assert.equal(main.permissionTier, "controlled");
      assert.equal(main.permissionTierUnavailable, undefined, "the main Hara never needs a switch on its own platform");
    });
  } finally { await f.host.close(); }
});
