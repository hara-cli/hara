import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExternalAgentRoles } from "../dist/org/external-agent-roles.js";
import { buildAgentsIndex } from "../dist/org/projects.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("installed OpenClaw and Hermes identities become private roles with bounded public profiles", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-external-agents-"));
  const home = join(root, "home");
  const workspace = join(root, "openclaw-dev");
  const previousHome = process.env.HOME;
  const previousHermesHome = process.env.HERMES_HOME;
  try {
    process.env.HOME = home;
    delete process.env.HERMES_HOME;
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    mkdirSync(join(home, ".hermes"), { recursive: true });
    mkdirSync(join(workspace, "avatars"), { recursive: true });
    writeFileSync(join(workspace, "avatars", "dev.png"), ONE_PIXEL_PNG);
    writeFileSync(join(workspace, "IDENTITY.md"), [
      "# Identity",
      "",
      "- **Name:** Linus",
      "- **Role:** Chief Engineer",
      "- **Vibe:** Direct, exact, and practical.",
      "- **Emoji:** 🐧",
      "- **Avatar:** avatars/dev.png",
      "- **Theme:** comic systems lab",
      "- **Traits:** direct, exact, practical",
      "",
    ].join("\n"));
    writeFileSync(join(workspace, "SOUL.md"), "PRIVATE_OPENCLAW_PERSONA\nOwn engineering delivery.\n");
    writeFileSync(join(workspace, "AGENTS.md"), "Verify every change before reporting completion.\n");
    writeFileSync(join(home, ".hermes", "SOUL.md"), "PRIVATE_HERMES_PERSONA\nBe calm and rigorous.\n");
    writeFileSync(join(home, ".openclaw", "openclaw.json"), JSON.stringify({
      apiKey: "SECRET_CONFIG_VALUE",
      agents: {
        defaults: { workspace },
        list: [{ id: "dev" }],
      },
    }));

    const roles = loadExternalAgentRoles();
    const dev = roles.find((role) => role.id === "dev");
    assert.ok(dev);
    assert.equal(dev.home, realpathSync.native(workspace));
    assert.equal(dev.identity.displayName, "Linus");
    assert.equal(dev.identity.title, "Chief Engineer");
    assert.deepEqual(dev.identity.traits, ["direct", "exact", "practical"]);
    assert.equal(dev.identity.source, "openclaw");
    assert.match(dev.identity.avatar, /^data:image\/png;base64,/);
    assert.match(dev.system, /PRIVATE_OPENCLAW_PERSONA/);
    assert.match(dev.system, /Verify every change/);

    const hermes = roles.find((role) => role.id === "hermes");
    assert.ok(hermes);
    assert.equal(hermes.identity.source, "hermes");
    assert.match(hermes.system, /PRIVATE_HERMES_PERSONA/);

    const catalog = buildAgentsIndex();
    const publicDev = catalog.find((role) => role.name === "dev");
    assert.ok(publicDev);
    assert.equal(publicDev.home, realpathSync.native(workspace));
    assert.equal(publicDev.identity.displayName, "Linus");
    const serialized = JSON.stringify(catalog);
    assert.doesNotMatch(serialized, /PRIVATE_OPENCLAW_PERSONA|PRIVATE_HERMES_PERSONA|SECRET_CONFIG_VALUE/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw avatar paths cannot escape the Agent workspace or trigger remote requests", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-external-avatar-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const previousHome = process.env.HOME;
  const previousHermesHome = process.env.HERMES_HOME;
  try {
    process.env.HOME = home;
    process.env.HERMES_HOME = join(root, "missing-hermes");
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(root, "outside.png"), ONE_PIXEL_PNG);
    writeFileSync(join(workspace, "IDENTITY.md"), "- **Name:** Scout\n- **Avatar:** ../outside.png\n");
    writeFileSync(join(home, ".openclaw", "openclaw.json"), JSON.stringify({
      agents: {
        list: [
          { id: "escape", workspace },
          { id: "remote", workspace, identity: { avatar: "https://tracker.invalid/avatar.png" } },
        ],
      },
    }));
    const roles = loadExternalAgentRoles();
    assert.equal(roles.find((role) => role.id === "escape")?.identity.avatar, undefined);
    assert.equal(roles.find((role) => role.id === "remote")?.identity.avatar, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
    rmSync(root, { recursive: true, force: true });
  }
});
