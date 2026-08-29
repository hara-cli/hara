import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dismissAgentRef,
  dismissAgentRefs,
  dismissedAgentRefs,
  isAgentRefDismissed,
  restoreAgentRef,
} from "../dist/org/agent-roster.js";
import { loadActiveGlobalRoles, loadActiveRoles } from "../dist/org/projects.js";

test("personal Agent roster dismisses and restores qualified refs without deleting source state", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-agent-roster-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  try {
    dismissAgentRefs(["global:architect", "nanhara:fanli", "global:architect"], home);
    assert.deepEqual([...dismissedAgentRefs(home)].sort(), ["global:architect", "nanhara:fanli"]);
    assert.equal(isAgentRefDismissed("global:architect", home), true);
    assert.equal(isAgentRefDismissed("main", home), false);

    dismissAgentRef("global:reviewer", home);
    assert.deepEqual(
      [...dismissedAgentRefs(home)].sort(),
      ["global:architect", "global:reviewer", "nanhara:fanli"],
    );
    assert.equal(restoreAgentRef("global:architect", home), true);
    assert.equal(restoreAgentRef("global:architect", home), false);
    assert.equal(isAgentRefDismissed("global:architect", home), false);

    const store = join(home, ".hara", "agent-roster.json");
    assert.equal(statSync(store).mode & 0o777, 0o600);
    assert.throws(() => dismissAgentRef("main", home), /main Agent cannot be dismissed/);
    assert.throws(() => dismissAgentRef("unqualified", home), /qualified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("personal Agent roster fails closed without overwriting malformed state", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-agent-roster-corrupt-"));
  const home = join(root, "home");
  const hara = join(home, ".hara");
  const store = join(hara, "agent-roster.json");
  mkdirSync(hara, { recursive: true, mode: 0o700 });
  const malformed = '{"version":1,"dismissed":[{"ref":"not-qualified","dismissedAt":"2026-08-29T00:00:00.000Z"}]}\n';
  writeFileSync(store, malformed, { mode: 0o600 });
  try {
    assert.throws(() => dismissedAgentRefs(home), /qualified/);
    assert.throws(() => dismissAgentRef("global:safe", home), /qualified/);
    assert.equal(readFileSync(store, "utf8"), malformed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active role loading excludes dismissed merged identities from explicit and automatic routing", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-agent-routing-roster-"));
  const home = join(root, "home");
  const project = join(root, "nanhara");
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    mkdirSync(join(home, ".hara", "roles"), { recursive: true });
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    mkdirSync(join(project, ".hara", "roles"), { recursive: true });
    writeFileSync(join(home, ".claude", "agents", "shared.md"), "---\nname: shared\ndescription: Claude fallback\n---\nCLAUDE FALLBACK\n");
    writeFileSync(join(home, ".hara", "roles", "shared.md"), "---\nname: shared\ndescription: Hara winner\n---\nHARA WINNER\n");
    writeFileSync(join(project, ".hara", "roles", "fanli.md"), "---\nname: fanli\ndescription: Finance\n---\nFINANCE\n");
    writeFileSync(join(home, ".hara", "projects.json"), JSON.stringify({
      projects: [{ name: "nanhara", path: project }],
    }));

    assert.equal(loadActiveGlobalRoles().find((role) => role.id === "shared")?.system, "HARA WINNER");
    assert.ok(loadActiveRoles(project).some((role) => role.id === "fanli"));
    dismissAgentRefs(["global:shared", "nanhara:fanli"], home);
    assert.ok(!loadActiveGlobalRoles().some((role) => role.id === "shared"));
    assert.ok(!loadActiveRoles(project).some((role) => role.id === "shared"));
    assert.ok(!loadActiveRoles(project).some((role) => role.id === "fanli"));
    assert.match(readFileSync(join(home, ".hara", "roles", "shared.md"), "utf8"), /HARA WINNER/);
    assert.match(readFileSync(join(home, ".claude", "agents", "shared.md"), "utf8"), /CLAUDE FALLBACK/);
  } finally {
    process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
