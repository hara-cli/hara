import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addProfile, archiveHistoricalPersonalRoutes, listProfiles, removeProfile, resolveActive, setFlagOverride,
  spaceProfileSelections, upsertProfile, useProfile, useSpaceProfile,
} from "../dist/profile/profile.js";

const company = (id, tenantId = "team-a") => ({
  id, kind: "gateway", tenantId, gatewayUrl: "https://control.example.test",
  deviceToken: `synthetic-${id}`, defaultModel: "test-model",
});

function withHome(run, active = "token-plan") {
  const home = mkdtempSync(join(tmpdir(), "hara-space-selection-"));
  const savedHome = process.env.HOME;
  const savedOverride = process.env.HARA_PROFILE;
  const stateFile = join(home, ".hara", "profiles.json");
  mkdirSync(join(home, ".hara"), { mode: 0o700 });
  const seed = {
    active,
    profiles: [
      { id: "personal", kind: "byok", provider: "ollama" },
      { id: "token-plan", kind: "byok", provider: "openai", apiKey: "synthetic-key" },
      company("team-primary"), company("team-backup"), company("team-b", "team-b"),
    ],
  };
  writeFileSync(stateFile, JSON.stringify(seed), { mode: 0o600 });
  process.env.HOME = home;
  delete process.env.HARA_PROFILE;
  setFlagOverride(null);
  try { return run({ home, stateFile, seed, read: () => JSON.parse(readFileSync(stateFile, "utf8")) }); }
  finally {
    setFlagOverride(null);
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedOverride === undefined) delete process.env.HARA_PROFILE; else process.env.HARA_PROFILE = savedOverride;
    rmSync(home, { recursive: true, force: true });
  }
}

test("returning from a managed Space preserves the selected Token Plan, including pre-upgrade state", () => withHome(({ read }) => {
  assert.equal(useProfile("team-primary").ok, true);
  assert.equal(spaceProfileSelections().personal, "token-plan");
  assert.equal(useSpaceProfile("personal", "token-plan").ok, true);
  assert.equal(resolveActive().id, "token-plan");
  assert.deepEqual(read().spaceProfileSelections, { personal: "token-plan", "org:team-a": "team-primary" });
}));

test("two connections in one managed Space keep their own last selection", () => withHome(() => {
  assert.equal(useProfile("team-backup").ok, true);
  assert.equal(useProfile("team-b").ok, true);
  assert.equal(spaceProfileSelections()["org:team-a"], "team-backup");
  assert.equal(useSpaceProfile("org:team-a", "team-backup").ok, true);
  assert.equal(resolveActive().id, "team-backup");
}));

test("unselected legacy Spaces retain their original compatibility route", () => withHome(() => {
  assert.equal(useSpaceProfile("org:team-a", "team-primary").ok, true);
  assert.equal(useSpaceProfile("org:team-b", "team-b").ok, true);
}));

test("legacy private routing selects reserved Personal even if stored rows are reordered", () => withHome(({ stateFile, seed }) => {
  writeFileSync(stateFile, JSON.stringify({ ...seed, active: "team-b", profiles: [...seed.profiles].reverse() }), { mode: 0o600 });
  assert.equal(useSpaceProfile("personal", "token-plan").ok, false);
  assert.equal(useSpaceProfile("personal", "personal").ok, true);
}));

test("route preferences survive a fresh CLI process without copying credentials", () => withHome(({ home }) => {
  useProfile("team-primary");
  const moduleUrl = new URL("../dist/profile/profile.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { spaceProfileSelections, useSpaceProfile, resolveActive } = await import(${JSON.stringify(moduleUrl)});
    const choices = spaceProfileSelections();
    const switched = useSpaceProfile("personal", choices.personal);
    process.stdout.write(JSON.stringify({ choices, ok: switched.ok, active: resolveActive().id }));
  `], { env: { ...process.env, HOME: home }, cwd: home, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.active, "token-plan");
  assert.equal(JSON.stringify(result).includes("synthetic-key"), false);
}));

test("temporary flag/env selections do not overwrite the remembered Space connection", () => withHome(({ home, stateFile }) => {
  useProfile("team-primary");
  const before = readFileSync(stateFile, "utf8");
  for (const mode of ["flag", "env"]) {
    if (mode === "flag") setFlagOverride("personal"); else process.env.HARA_PROFILE = "personal";
    assert.equal(resolveActive(home).source, mode);
    assert.equal(spaceProfileSelections().personal, "token-plan");
    setFlagOverride(null);
    delete process.env.HARA_PROFILE;
  }
  assert.equal(readFileSync(stateFile, "utf8"), before);
}));

test("activating a newly created connection remembers both departing and arriving Spaces", () => withHome(() => {
  assert.equal(addProfile(company("team-new", "team-new"), { activate: true }).ok, true);
  assert.equal(spaceProfileSelections().personal, "token-plan");
  assert.equal(spaceProfileSelections()["org:team-new"], "team-new");
}));

test("saving without activation does not change any Space selection", () => withHome(({ stateFile }) => {
  useProfile("team-primary");
  const before = spaceProfileSelections();
  assert.equal(addProfile({ id: "another-key", kind: "byok", provider: "openai" }).ok, true);
  assert.deepEqual(spaceProfileSelections(), before);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).active, "team-primary");
}));

test("a stale displayed route cannot override a newer connection choice", () => withHome(({ stateFile }) => {
  useProfile("team-backup");
  useProfile("team-b");
  const before = readFileSync(stateFile, "utf8");
  assert.equal(useSpaceProfile("org:team-a", "team-primary").ok, false);
  assert.equal(readFileSync(stateFile, "utf8"), before);
}));

test("re-enrollment cannot redirect a stale Space click to a different tenant", () => withHome(({ stateFile }) => {
  useProfile("team-backup");
  useProfile("team-b");
  upsertProfile(company("team-backup", "replacement-tenant"));
  const before = readFileSync(stateFile, "utf8");
  assert.equal(useSpaceProfile("org:team-a", "team-backup").ok, false);
  assert.equal(spaceProfileSelections()["org:team-a"], undefined);
  assert.equal(readFileSync(stateFile, "utf8"), before);
  assert.equal(listProfiles().length, 5);
}));

test("removing a remembered connection prunes only its compatibility pointer", () => withHome(({ read }) => {
  useProfile("team-backup");
  useProfile("team-b");
  assert.equal(removeProfile("team-backup").ok, true);
  assert.equal(read().spaceProfileSelections["org:team-a"], undefined);
  assert.equal(spaceProfileSelections().personal, "token-plan");
  assert.equal(resolveActive().id, "team-b");
}));

test("explicitly replacing the private route updates its preference, not the managed preference", () => withHome(() => {
  useProfile("team-backup");
  useProfile("token-plan");
  archiveHistoricalPersonalRoutes({ activatePersonal: true });
  assert.equal(resolveActive().id, "personal");
  assert.equal(spaceProfileSelections().personal, "personal");
  assert.equal(spaceProfileSelections()["org:team-a"], "team-backup");
}));

test("unknown/foreign Space routes fail without mutating the selected connection", () => withHome(({ stateFile }) => {
  const before = readFileSync(stateFile, "utf8");
  for (const [space, route] of [["org:team-a", "token-plan"], ["personal", "missing"], ["../other", "personal"]]) {
    assert.equal(useSpaceProfile(space, route).ok, false);
  }
  assert.equal(readFileSync(stateFile, "utf8"), before);
}));

for (const selections of [[], null, { personal: "missing" }, { personal: "team-primary" }, { "org:team-a": "team-b" }]) {
  test(`malformed or cross-audience preferences fail closed (${JSON.stringify(selections)})`, () => withHome(({ stateFile, seed }) => {
    const bytes = JSON.stringify({ ...seed, spaceProfileSelections: selections });
    writeFileSync(stateFile, bytes, { mode: 0o600 });
    assert.throws(() => spaceProfileSelections(), /invalid data/);
    assert.equal(readFileSync(stateFile, "utf8"), bytes);
  }));
}
