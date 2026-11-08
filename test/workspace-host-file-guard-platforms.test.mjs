import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localWorkspaceFileTools } from "../dist/workspace/local-tools.js";

// The Host's own file tools enforce colleague working-folder isolation and the managed-instruction
// confirmation in Host code, not through Seatbelt. Decision B leaves Linux and Windows without an OS
// write sandbox, so these refusals must hold on every platform. process.platform is overridden for
// this test process only; production platform detection is untouched.
async function onPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try { return await run(); } finally { Object.defineProperty(process, "platform", original); }
}
function layout(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-host-file-guard-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = join(root, "legacy"), ownHome = join(legacy, "colleagues", "ag_self"), sibling = join(legacy, "colleagues", "ag_other");
  for (const dir of [ownHome, sibling]) fs.mkdirSync(dir, { recursive: true });
  const writes = [];
  const tools = localWorkspaceFileTools(ownHome, () => {}, { legacyProject: legacy, ownHome, onWrite: () => writes.push(true) });
  const write = tools.find(tool => tool.name === "workspace_write");
  return { legacy, ownHome, sibling, writes, write: input => write.run({ content: "fixture", ...input }, {}) };
}

for (const platform of ["linux", "win32", "darwin"]) test(`${platform}: Host file tools refuse sibling colleague folders and managed instructions without Seatbelt`, async t => {
  const f = layout(t);
  await onPlatform(platform, async () => {
    await assert.rejects(f.write({ root: "legacy", path: "colleagues/ag_other/notes.md" }), /Another colleague working folder is read-only/);
    assert.equal(fs.existsSync(join(f.sibling, "notes.md")), false);
    for (const name of ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "agents.md"]) for (const root of ["legacy", "home"]) {
      await assert.rejects(f.write({ root, path: name }), /Managed instructions require a Hara confirmation card/, `${root}/${name}`);
      assert.equal(fs.existsSync(join(root === "legacy" ? f.legacy : f.ownHome, name)), false, `${root}/${name}`);
    }
    for (const path of [".claude/settings.json", ".codex/config.toml"]) {
      await assert.rejects(f.write({ root: "home", path }), /outside the granted safe project/, path);
      assert.equal(fs.existsSync(join(f.ownHome, path.split("/")[0])), false, path);
    }
    assert.equal(JSON.parse(await f.write({ root: "home", path: "notes.md" })).written, true);
    assert.equal(JSON.parse(await f.write({ root: "legacy", path: "colleagues/ag_self/shared.md" })).written, true);
    assert.equal(fs.readFileSync(join(f.ownHome, "shared.md"), "utf8"), "fixture");
  });
  assert.equal(f.writes.length, 2, "only the two permitted writes reach the Host write hook");
});
