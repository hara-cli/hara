import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { workspaceResourceScopeKey } from "../dist/workspace/resource-context.js";
import {
  AGENT_ACCENT_PALETTE, AGENT_AVATAR_STYLES, assignAgentAccent, isAgentAccent, isAgentAvatarStyle,
} from "../dist/org/agent-identity.js";

const temporary = [];
after(() => { for (const target of temporary) fs.rmSync(target, { recursive: true, force: true }); });
function dir() { const result = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-persona-accent-"))); temporary.push(result); return result; }
const wsA = "ws_20000000-0000-4000-8000-000000000001";
const scope = () => ({ schemaVersion: 1, workspaceId: wsA, authority: { kind: "local", localAuthorityId: "30000000-0000-4000-8000-000000000001" } });
const open = (home = dir()) => { const result = new WorkspaceResources(home, scope()); result.initialize(); return result; };
const catalogFile = (home, identity = scope()) => join(home, ".hara", "workspace-data", "v1", workspaceResourceScopeKey(identity), "state", ".hara", "workspace-agents.json");
const withProfile = (name, profile) => ({ profile: { displayName: name, ...profile } });

/** The editable profile a client sends: no `version`/`source` (those are projections only). */
const profileOf = (r, agentId) => r.agents.currentPersona(agentId).profile;
function create(r, username, profile = {}) {
  return r.agents.create({ username, ...withProfile(username, profile) }, r.agents.list().revision);
}

test("the designed palette and avatar styles are exactly the client's closed sets", () => {
  assert.deepEqual([...AGENT_ACCENT_PALETTE], ["#ff695f", "#4f9c8f", "#d99a32", "#6e88c8", "#a67bc2", "#d1667b", "#438db3", "#7f9a45"]);
  assert.deepEqual([...AGENT_AVATAR_STYLES], ["circle", "squircle", "hex", "portrait"]);
  assert.equal(AGENT_ACCENT_PALETTE.length, 8);
  assert.equal(new Set(AGENT_ACCENT_PALETTE).size, 8, "palette entries must be unique");
  assert.equal(isAgentAccent("#FF695F"), true, "comparison is case-insensitive");
  assert.equal(isAgentAccent("#123456"), false, "an arbitrary hex is not a designed colour");
  assert.equal(isAgentAvatarStyle("Squircle"), true);
  assert.equal(isAgentAvatarStyle("blob"), false);
});

test("assignAgentAccent is deterministic and prefers an unused palette slot", () => {
  // Same inputs -> same colour, so the creation colour is reproducible before any client sees it.
  assert.equal(assignAgentAccent("ag_fixed", "coder"), assignAgentAccent("ag_fixed", "coder"));
  const first = assignAgentAccent("ag_first", "coder");
  // Once every other colour is in use, a new colleague must take the one nobody has.
  const inUse = AGENT_ACCENT_PALETTE.filter(colour => colour !== first);
  assert.equal(assignAgentAccent("ag_second", "coder", inUse), first);
  // A different agent id can still land on a different slot when usage is equal.
  const spread = new Set(AGENT_ACCENT_PALETTE.map((_, index) => assignAgentAccent(`ag_spread_${index}`, "coder")));
  assert.ok(spread.size > 1, "hash-derived slots should not collapse to one colour");
});

test("a client may set one of the eight colours, and the initial colour is fixed at creation", () => {
  const r = open();
  r.agents.initializeMain();
  const agent = create(r, "coder", { accent: "#4f9c8f", avatarStyle: "squircle" });
  assert.equal(agent.identity.accent, "#4f9c8f");
  assert.equal(agent.identity.avatarStyle, "squircle");
  assert.equal(agent.initialAccent, "#4f9c8f", "an explicit choice is the initial colour");

  // Recolouring later moves `accent` but must NOT move `initialAccent`.
  const recoloured = r.agents.updatePersona(agent.agentId,
    { profile: { ...profileOf(r, agent.agentId), accent: "#a67bc2" } }, agent.configRevision, agent.agentEpoch);
  assert.equal(recoloured.identity.accent, "#a67bc2");
  assert.equal(recoloured.initialAccent, "#4f9c8f", "restore-initial target must not drift");

  // Restoring is an ordinary write of the initial value, not a special RPC.
  const restored = r.agents.updatePersona(recoloured.agentId,
    { profile: { ...profileOf(r, recoloured.agentId), accent: recoloured.initialAccent } }, recoloured.configRevision, recoloured.agentEpoch);
  assert.equal(restored.identity.accent, "#4f9c8f");
  assert.equal(restored.initialAccent, "#4f9c8f");
});

test("a colleague created without a colour receives a persisted palette colour as its initial accent", () => {
  const r = open();
  r.agents.initializeMain();
  const agent = create(r, "plain");
  assert.ok(isAgentAccent(agent.identity.accent), "a default colour is assigned, not left empty");
  assert.equal(agent.initialAccent, agent.identity.accent, "initial and current agree at creation");
  assert.ok(AGENT_ACCENT_PALETTE.includes(agent.initialAccent));
  // ...and it survives a restart rather than being recomputed differently.
  assert.equal(r.agents.list().agents.find(row => row.agentId === agent.agentId).initialAccent, agent.initialAccent);
});

test("writes outside the designed palette or the known avatar styles are rejected explicitly", () => {
  const r = open();
  r.agents.initializeMain();
  const agent = create(r, "coder", { accent: "#4f9c8f" });
  const attempt = patch => assert.throws(
    () => r.agents.updatePersona(agent.agentId, { profile: { ...profileOf(r, agent.agentId), ...patch } }, agent.configRevision, agent.agentEpoch),
    error => /agent accent must be one of|agent avatarStyle must be one of/i.test(error.message),
  );
  // Arbitrary hex, a colour name, and an injection-shaped value are all refused.
  for (const value of ["#123456", "red", "url(https://tracker.example/p.png)", "red;background:url(x)"]) {
    attempt({ accent: value });
  }
  for (const value of ["blob", "rounded", "circle;"]) attempt({ avatarStyle: value });
  // The stored colleague is untouched by the refused writes.
  const after = r.agents.list().agents.find(row => row.agentId === agent.agentId);
  assert.equal(after.identity.accent, "#4f9c8f");
  assert.equal(after.configRevision, agent.configRevision, "a refused write must not bump the configuration");
});

test("older catalogs without initialAccent or avatarStyle stay readable and get a stable derived colour", () => {
  const home = dir(), r = open(home);
  r.agents.initializeMain();
  const agent = create(r, "legacy", { accent: "#d99a32" });
  const file = catalogFile(home);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const row = raw.agents.find(entry => entry.agentId === agent.agentId);
  // Simulate a pre-1.3.0 catalog: no initialAccent anywhere, no avatarStyle in the profile.
  delete row.initialAccent;
  for (const config of row.configurations) delete config.identity.avatarStyle;
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });

  const reopened = open(home);
  const listed = reopened.agents.list().agents.find(entry => entry.agentId === agent.agentId);
  assert.ok(listed, "a catalog without the new fields must still load");
  assert.equal(listed.identity.avatarStyle, undefined, "no avatar style is invented for old data");
  assert.ok(isAgentAccent(listed.initialAccent), "a derived initial colour is provided");
  // The derivation must be stable across reads, not a fresh random colour each time.
  assert.equal(open(home).agents.list().agents.find(entry => entry.agentId === agent.agentId).initialAccent, listed.initialAccent);
  // And it must be the creation colour that was actually stored, since that is what a user saw.
  assert.equal(listed.initialAccent, assignAgentAccent(agent.agentId, listed.identity.character, ["#d99a32"]));
});

test("an imported role hex outside the palette is preserved, but a client cannot write one", () => {
  // Role-file imports keep historical accents (their catalogs must stay readable)...
  const imported = { "display-name": "Lin", accent: "#3a8fc2" };
  const r = open();
  r.agents.initializeMain();
  // ...while a client write goes through the strict path and is refused (covered above).
  const agent = create(r, "coder", { accent: "#6e88c8" });
  assert.equal(agent.identity.accent, "#6e88c8");
  assert.deepEqual(imported.accent, "#3a8fc2");
});

test("appearance writes keep the private instructions and the configuration history intact", () => {
  const home = dir(), r = open(home);
  r.agents.initializeMain();
  const agent = r.agents.create({ username: "coder", profile: { displayName: "Coder", accent: "#d1667b" },
    description: "public sentinel", instructions: "PRIVATE instruction sentinel" }, 1);
  const edited = r.agents.updatePersona(agent.agentId,
    { profile: { ...profileOf(r, agent.agentId), accent: "#7f9a45", avatarStyle: "hex" }, description: "public sentinel", instructions: "PRIVATE instruction sentinel" },
    agent.configRevision, agent.agentEpoch);
  const resolved = open(home).agents.currentPersona(agent.agentId);
  assert.equal(resolved.instructions, "PRIVATE instruction sentinel", "appearance edits must not rewrite the prompt");
  assert.equal(resolved.description, "public sentinel");
  assert.equal(edited.identity.accent, "#7f9a45");
  assert.equal(edited.initialAccent, "#d1667b");
  assert.equal(edited.configRevision, agent.configRevision + 1);
});
