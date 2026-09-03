import { after, test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalTrustProjectConfig = process.env.HARA_TRUST_PROJECT_CONFIG;
delete process.env.HARA_TRUST_PROJECT_CONFIG;
const {
  loadConfig,
  normalizePersonalProviderConfig,
  providerCatalog,
  readRawConfig,
  reusablePersonalProviderApiKey,
  updatePersonalProviderConfig,
  writeConfigValue,
} = await import("../dist/config.js");
after(() => {
  if (originalTrustProjectConfig === undefined) delete process.env.HARA_TRUST_PROJECT_CONFIG;
  else process.env.HARA_TRUST_PROJECT_CONFIG = originalTrustProjectConfig;
});

test("loadConfig: blank env/project routing values do not hide global credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-live-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".hara"), { recursive: true });
  mkdirSync(join(project, ".hara"), { recursive: true });
  writeFileSync(
    join(home, ".hara", "config.json"),
    JSON.stringify({
      provider: "openai",
      apiKey: "configured-key",
      model: "configured-model",
      baseURL: "https://configured.example/v1",
      fallbackProvider: "deepseek",
      fallbackApiKey: "fallback-key",
      fallbackModel: "fallback-model",
      fallbackBaseURL: "https://fallback.example/v1",
      visionApiKey: "vision-key",
      visionModel: "vision-model",
      visionBaseURL: "https://vision.example/v1",
      embedProvider: "openai",
      embedApiKey: "embed-key",
      embedModel: "embed-model",
      embedBaseURL: "https://embed.example/v1",
      routeApiKey: "route-key",
      routeModel: "route-model",
      routeBaseURL: "https://route.example/v1",
      proxy: "http://127.0.0.1:7890",
      packageRegistry: "https://packages.example/repository/npm/",
      runTimeoutMs: "45m",
      maxAgentRounds: "96",
    }),
  );
  writeFileSync(join(project, "package.json"), "{}");
  writeFileSync(join(project, ".hara", "config.json"), JSON.stringify({
    apiKey: " ", model: "", fallbackApiKey: "", fallbackModel: " ", visionApiKey: "", visionModel: " ",
    embedApiKey: " ", embedModel: "", routeApiKey: "", routeModel: " ",
    proxy: "http://project-must-not-route-credentials.example:8080",
  }));

  const saved = {
    HOME: process.env.HOME,
    cwd: process.cwd(),
    HARA_PROVIDER: process.env.HARA_PROVIDER,
    HARA_API_KEY: process.env.HARA_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    HARA_MODEL: process.env.HARA_MODEL,
    HARA_BASE_URL: process.env.HARA_BASE_URL,
    HARA_FALLBACK_API_KEY: process.env.HARA_FALLBACK_API_KEY,
    HARA_FALLBACK_MODEL: process.env.HARA_FALLBACK_MODEL,
    HARA_FALLBACK_PROVIDER: process.env.HARA_FALLBACK_PROVIDER,
    HARA_FALLBACK_BASE_URL: process.env.HARA_FALLBACK_BASE_URL,
    HARA_VISION_API_KEY: process.env.HARA_VISION_API_KEY,
    HARA_VISION_MODEL: process.env.HARA_VISION_MODEL,
    HARA_VISION_BASE_URL: process.env.HARA_VISION_BASE_URL,
    HARA_EMBED_PROVIDER: process.env.HARA_EMBED_PROVIDER,
    HARA_EMBED_API_KEY: process.env.HARA_EMBED_API_KEY,
    HARA_EMBED_MODEL: process.env.HARA_EMBED_MODEL,
    HARA_EMBED_BASE_URL: process.env.HARA_EMBED_BASE_URL,
    HARA_ROUTE_API_KEY: process.env.HARA_ROUTE_API_KEY,
    HARA_ROUTE_MODEL: process.env.HARA_ROUTE_MODEL,
    HARA_ROUTE_BASE_URL: process.env.HARA_ROUTE_BASE_URL,
    HARA_RUN_TIMEOUT_MS: process.env.HARA_RUN_TIMEOUT_MS,
    HARA_MAX_AGENT_ROUNDS: process.env.HARA_MAX_AGENT_ROUNDS,
  };
  try {
    process.env.HOME = home;
    process.chdir(project);
    process.env.HARA_API_KEY = "";
    process.env.HARA_PROVIDER = "";
    process.env.OPENAI_API_KEY = " ";
    process.env.HARA_MODEL = "";
    process.env.HARA_BASE_URL = "";
    process.env.HARA_FALLBACK_API_KEY = "";
    process.env.HARA_FALLBACK_MODEL = " ";
    process.env.HARA_FALLBACK_PROVIDER = "";
    process.env.HARA_FALLBACK_BASE_URL = " ";
    process.env.HARA_VISION_API_KEY = "";
    process.env.HARA_VISION_MODEL = " ";
    process.env.HARA_VISION_BASE_URL = "";
    process.env.HARA_EMBED_PROVIDER = " ";
    process.env.HARA_EMBED_API_KEY = " ";
    process.env.HARA_EMBED_MODEL = "";
    process.env.HARA_EMBED_BASE_URL = " ";
    process.env.HARA_ROUTE_API_KEY = "";
    process.env.HARA_ROUTE_MODEL = " ";
    process.env.HARA_ROUTE_BASE_URL = "";
    delete process.env.HARA_RUN_TIMEOUT_MS;
    delete process.env.HARA_MAX_AGENT_ROUNDS;
    const cfg = loadConfig();
    assert.equal(cfg.apiKey, "configured-key");
    assert.equal(cfg.model, "configured-model");
    assert.equal(cfg.baseURL, "https://configured.example/v1");
    assert.equal(cfg.fallbackApiKey, "fallback-key");
    assert.equal(cfg.fallbackModel, "fallback-model");
    assert.equal(cfg.fallbackProvider, "deepseek");
    assert.equal(cfg.fallbackBaseURL, "https://fallback.example/v1");
    assert.equal(cfg.visionApiKey, "vision-key");
    assert.equal(cfg.visionModel, "vision-model");
    assert.equal(cfg.visionBaseURL, "https://vision.example/v1");
    assert.equal(cfg.embedProvider, "openai");
    assert.equal(cfg.embedApiKey, "embed-key");
    assert.equal(cfg.embedModel, "embed-model");
    assert.equal(cfg.embedBaseURL, "https://embed.example/v1");
    assert.equal(cfg.routeApiKey, "route-key");
    assert.equal(cfg.routeModel, "route-model");
    assert.equal(cfg.routeBaseURL, "https://route.example/v1");
    assert.equal(
      cfg.proxy,
      "http://127.0.0.1:7890",
      "project config cannot choose the credential-bearing proxy route",
    );
    assert.equal(cfg.packageRegistry, "https://packages.example/repository/npm/");
    assert.equal(cfg.runTimeoutMs, 45 * 60_000);
    assert.equal(cfg.maxAgentRounds, 96);
  } finally {
    process.chdir(saved.cwd);
    for (const [key, value] of Object.entries(saved)) {
      if (key === "cwd") continue;
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("config set persists computerUse and explains a conflicting environment override", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-computer-use-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  try {
    const child = spawnSync(
      process.execPath,
      [join(process.cwd(), "runtime-bootstrap.cjs"), "config", "set", "computerUse", "full"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          HARA_COMPUTER_USE: "off",
        },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Set computerUse/);
    assert.match(child.stdout, /HARA_COMPUTER_USE currently overrides it/);
    const saved = JSON.parse(readFileSync(join(home, ".hara", "config.json"), "utf8"));
    assert.equal(saved.computerUse, "full");

    const invalid = spawnSync(
      process.execPath,
      [join(process.cwd(), "runtime-bootstrap.cjs"), "config", "set", "computerUse", "always"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stdout, /Invalid computer-use mode/);
    assert.equal(JSON.parse(readFileSync(join(home, ".hara", "config.json"), "utf8")).computerUse, "full");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig: Home control-plane config is never re-read as project input or inherited from above Home", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-home-boundary-"));
  const home = join(root, "home");
  const alias = join(root, "home-alias");
  const unmarked = join(home, "scratch");
  const project = join(home, "project");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".hara"), { recursive: true });
  mkdirSync(join(home, ".hara"), { recursive: true });
  mkdirSync(unmarked, { recursive: true });
  mkdirSync(join(project, ".hara"), { recursive: true });
  symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(root, ".hara", "config.json"), JSON.stringify({ model: "parent-must-not-load" }));
  writeFileSync(join(home, ".hara", "config.json"), JSON.stringify({
    provider: "openai",
    model: "global",
    overlays: { work: { model: "overlay" } },
  }));
  writeFileSync(join(project, "package.json"), "{}");
  writeFileSync(join(project, ".hara", "config.json"), JSON.stringify({ model: "project" }));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HARA_MODEL: process.env.HARA_MODEL,
    HARA_OVERLAY: process.env.HARA_OVERLAY,
  };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.HARA_MODEL;
    delete process.env.HARA_OVERLAY;
    assert.equal(loadConfig({ cwd: home, overlay: "work" }).model, "overlay");
    assert.equal(loadConfig({ cwd: alias, overlay: "work" }).model, "overlay", "a Home alias cannot bypass the boundary");
    assert.equal(loadConfig({ cwd: unmarked, overlay: "work" }).model, "overlay", "a child stops before Home and its parent");
    assert.equal(loadConfig({ cwd: project, overlay: "work" }).model, "project", "an explicit child project keeps its override");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig: safe project keys override an overlay while privileged keys are ignored without value leaks", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-precedence-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".hara"), { recursive: true });
  mkdirSync(join(project, ".hara"), { recursive: true });
  writeFileSync(join(home, ".hara", "config.json"), JSON.stringify({
    provider: "openai",
    apiKey: "global-key",
    model: "global",
    baseURL: "https://global.example/v1",
    approval: "suggest",
    sandbox: "read-only",
    guardian: "on",
    evolve: "off",
    assetCapture: "off",
    computerUse: "off",
    fileCheckpoints: true,
    updateCheck: true,
    notify: "off",
    runTimeoutMs: "30m",
    maxAgentRounds: 64,
    overlays: { work: { model: "overlay", mcpServers: { shared: { command: "overlay" } } } },
  }));
  writeFileSync(join(project, "package.json"), "{}");
  writeFileSync(join(project, ".hara", "config.json"), JSON.stringify({
    model: "project",
    mcpServers: { shared: { command: "PROJECT_COMMAND_SECRET" } },
    apiKey: "PROJECT_API_SECRET",
    baseURL: "https://project-secret.invalid/v1",
    approval: "full-auto",
    sandbox: "off",
    guardian: "off",
    evolve: "proactive",
    assetCapture: "auto",
    computerUse: "full",
    computerApps: ["Terminal"],
    fileCheckpoints: false,
    updateCheck: false,
    notify: "system",
    runTimeoutMs: "2h",
    maxAgentRounds: 256,
    "sk-UNKNOWN_KEY_SECRET_123456789": "ignored",
  }));
  const saved = { HOME: process.env.HOME, cwd: process.cwd(), HARA_OVERLAY: process.env.HARA_OVERLAY, HARA_MODEL: process.env.HARA_MODEL };
  try {
    process.env.HOME = home;
    process.env.HARA_OVERLAY = "work";
    delete process.env.HARA_MODEL;
    process.chdir(project);
    let warning = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => { warning += String(chunk); return true; };
    let cfg;
    try {
      cfg = loadConfig();
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(cfg.model, "project");
    assert.equal(cfg.mcpServers.shared.command, "overlay");
    assert.equal(cfg.apiKey, "global-key");
    assert.equal(cfg.baseURL, "https://global.example/v1");
    assert.equal(cfg.approval, "suggest");
    assert.equal(cfg.sandbox, "read-only");
    assert.equal(cfg.guardian, "on");
    assert.equal(cfg.evolve, "off");
    assert.equal(cfg.assetCapture, "off");
    assert.equal(cfg.computerUse, "off");
    assert.equal(cfg.fileCheckpoints, true);
    assert.equal(cfg.updateCheck, true);
    assert.equal(cfg.notify, "off");
    assert.equal(cfg.runTimeoutMs, 30 * 60_000);
    assert.equal(cfg.maxAgentRounds, 64);
    assert.match(warning, /apiKey|baseURL|mcpServers|approval|sandbox|guardian|runTimeoutMs|maxAgentRounds|<unknown-key>/);
    assert.doesNotMatch(warning, /PROJECT_(?:COMMAND|API)_SECRET|project-secret\.invalid|UNKNOWN_KEY_SECRET/);
  } finally {
    process.chdir(saved.cwd);
    for (const [key, value] of Object.entries(saved)) {
      if (key === "cwd") continue;
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig: launch-time HARA_TRUST_PROJECT_CONFIG=1 explicitly enables privileged project keys", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-trusted-project-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".hara"), { recursive: true });
  mkdirSync(join(project, ".hara"), { recursive: true });
  writeFileSync(join(home, ".hara", "config.json"), JSON.stringify({
    provider: "openai",
    apiKey: "global-key",
    model: "global-model",
  }));
  writeFileSync(join(project, "package.json"), "{}");
  writeFileSync(join(project, ".hara", "config.json"), JSON.stringify({
    provider: "deepseek",
    apiKey: "TRUSTED_PROJECT_API_VALUE",
    model: "trusted-project-model",
    baseURL: "https://trusted-project.invalid/v1",
    approval: "full-auto",
    sandbox: "off",
    guardian: "off",
    hooks: { PreToolUse: [{ command: "TRUSTED_HOOK_VALUE" }] },
    mcpServers: { project: { command: "TRUSTED_MCP_VALUE" } },
  }));
  try {
    const moduleUrl = new URL("../dist/config.js", import.meta.url).href;
    const script = `
      const { loadConfig } = await import(${JSON.stringify(moduleUrl)});
      const c = loadConfig({ cwd: ${JSON.stringify(project)} });
      process.stdout.write(JSON.stringify({
        provider: c.provider, apiKey: c.apiKey, model: c.model, baseURL: c.baseURL,
        approval: c.approval, sandbox: c.sandbox, guardian: c.guardian,
        hook: c.hooks.PreToolUse?.[0]?.command, mcp: c.mcpServers.project?.command,
      }));
    `;
    const childEnv = {
      ...process.env,
      HOME: home,
      HARA_TRUST_PROJECT_CONFIG: "1",
      HARA_API_KEY: "",
      DEEPSEEK_API_KEY: "",
      HARA_PROVIDER: "",
      HARA_MODEL: "",
      HARA_BASE_URL: "",
    };
    delete childEnv.HARA_APPROVAL;
    delete childEnv.HARA_SANDBOX;
    delete childEnv.HARA_GUARDIAN;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: project,
      encoding: "utf8",
      env: childEnv,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      provider: "deepseek",
      apiKey: "TRUSTED_PROJECT_API_VALUE",
      model: "trusted-project-model",
      baseURL: "https://trusted-project.invalid/v1",
      approval: "full-auto",
      sandbox: "off",
      guardian: "off",
      hook: "TRUSTED_HOOK_VALUE",
      mcp: "TRUSTED_MCP_VALUE",
    });
    assert.match(child.stderr, /apiKey|baseURL|hooks|mcpServers|approval|sandbox|guardian/);
    assert.doesNotMatch(child.stderr, /TRUSTED_(?:PROJECT_API|HOOK|MCP)_VALUE|trusted-project\.invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig: changing HARA_TRUST_PROJECT_CONFIG after module startup cannot widen trust", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-late-trust-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".hara"), { recursive: true });
  mkdirSync(join(project, ".hara"), { recursive: true });
  writeFileSync(join(home, ".hara", "config.json"), JSON.stringify({ provider: "openai", model: "global" }));
  writeFileSync(join(project, "package.json"), "{}");
  writeFileSync(join(project, ".hara", "config.json"), JSON.stringify({ provider: "deepseek", model: "project-safe" }));
  const savedHome = process.env.HOME;
  const savedTrust = process.env.HARA_TRUST_PROJECT_CONFIG;
  try {
    process.env.HOME = home;
    process.env.HARA_TRUST_PROJECT_CONFIG = "1";
    const cfg = loadConfig({ cwd: project });
    assert.equal(cfg.provider, "openai", "the privileged provider key remains ignored");
    assert.equal(cfg.model, "project-safe", "safe keys still load normally");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedTrust === undefined) delete process.env.HARA_TRUST_PROJECT_CONFIG;
    else process.env.HARA_TRUST_PROJECT_CONFIG = savedTrust;
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig: explicit cwd loads that project's route without changing process cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-cwd-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".hara"), { recursive: true });
  mkdirSync(join(project, ".hara"), { recursive: true });
  writeFileSync(join(home, ".hara", "config.json"), JSON.stringify({ provider: "openai", model: "global" }));
  writeFileSync(join(project, "package.json"), "{}");
  writeFileSync(join(project, ".hara", "config.json"), JSON.stringify({ model: "project-home" }));
  const savedHome = process.env.HOME;
  const savedModel = process.env.HARA_MODEL;
  const before = process.cwd();
  try {
    process.env.HOME = home;
    delete process.env.HARA_MODEL;
    const cfg = loadConfig({ cwd: project });
    assert.equal(cfg.cwd, project);
    assert.equal(cfg.model, "project-home");
    assert.equal(process.cwd(), before);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedModel === undefined) delete process.env.HARA_MODEL;
    else process.env.HARA_MODEL = savedModel;
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig: project config rejects .hara/final symlinks, hard links, and oversized files", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-file-boundary-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".hara"), { recursive: true });
  writeFileSync(join(home, ".hara", "config.json"), JSON.stringify({ provider: "openai", model: "global-safe" }));
  const makeProject = (name) => {
    const project = join(root, name);
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), "{}");
    return project;
  };
  const parentLinkProject = makeProject("parent-link");
  const linkedHara = join(root, "linked-hara");
  mkdirSync(linkedHara);
  writeFileSync(join(linkedHara, "config.json"), JSON.stringify({ model: "PARENT_LINK_SECRET_MODEL" }));
  symlinkSync(linkedHara, join(parentLinkProject, ".hara"));

  const finalLinkProject = makeProject("final-link");
  mkdirSync(join(finalLinkProject, ".hara"));
  const finalLinkSource = join(finalLinkProject, ".env");
  writeFileSync(finalLinkSource, JSON.stringify({ model: "FINAL_LINK_SECRET_MODEL" }));
  symlinkSync(finalLinkSource, join(finalLinkProject, ".hara", "config.json"));

  const hardLinkProject = makeProject("hard-link");
  mkdirSync(join(hardLinkProject, ".hara"));
  const hardLinkSource = join(hardLinkProject, ".env");
  const hardLinkOriginal = JSON.stringify({ model: "HARD_LINK_SECRET_MODEL" });
  writeFileSync(hardLinkSource, hardLinkOriginal);
  linkSync(hardLinkSource, join(hardLinkProject, ".hara", "config.json"));

  const oversizedProject = makeProject("oversized");
  mkdirSync(join(oversizedProject, ".hara"));
  writeFileSync(
    join(oversizedProject, ".hara", "config.json"),
    JSON.stringify({ model: "OVERSIZED_SECRET_MODEL", padding: "x".repeat(300 * 1024) }),
  );

  const savedHome = process.env.HOME;
  const savedModel = process.env.HARA_MODEL;
  let warning = "";
  const originalWrite = process.stderr.write;
  try {
    process.env.HOME = home;
    delete process.env.HARA_MODEL;
    process.stderr.write = (chunk) => { warning += String(chunk); return true; };
    for (const project of [parentLinkProject, finalLinkProject, hardLinkProject, oversizedProject]) {
      assert.equal(loadConfig({ cwd: project }).model, "global-safe");
    }
    assert.equal(readFileSync(hardLinkSource, "utf8"), hardLinkOriginal);
  } finally {
    process.stderr.write = originalWrite;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedModel === undefined) delete process.env.HARA_MODEL;
    else process.env.HARA_MODEL = savedModel;
    rmSync(root, { recursive: true, force: true });
  }
  assert.match(warning, /symlink parent|symlink file|hard-linked file|oversized file/);
  assert.doesNotMatch(warning, /(?:PARENT|FINAL|HARD)_LINK_SECRET_MODEL|OVERSIZED_SECRET_MODEL/);
});

test("global config refuses hard-link aliases and never rewrites their external inode", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-global-config-hardlink-"));
  const home = join(root, "home");
  const outside = join(root, "outside.json");
  const config = join(home, ".hara", "config.json");
  mkdirSync(join(home, ".hara"), { recursive: true });
  const original = JSON.stringify({ model: "external-must-survive" });
  writeFileSync(outside, original);
  linkSync(outside, config);
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = home;
    assert.throws(() => readRawConfig(), /hard-linked/i, "unsafe global aliases fail closed instead of becoming an empty config");
    assert.throws(() => writeConfigValue("model", "attacker-write"), /hard-linked/i);
    assert.equal(readFileSync(outside, "utf8"), original, "the external hard-link target is unchanged");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig: invalid global roots fail closed while project roots and blank overlays fail soft", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-shape-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".hara"), { recursive: true });
  mkdirSync(join(project, ".hara"), { recursive: true });
  writeFileSync(join(home, ".hara", "config.json"), "null");
  writeFileSync(join(project, "package.json"), "{}");
  writeFileSync(join(project, ".hara", "config.json"), "[]");
  const savedHome = process.env.HOME;
  const savedOverlay = process.env.HARA_OVERLAY;
  try {
    process.env.HOME = home;
    process.env.HARA_OVERLAY = " ";
    assert.throws(() => loadConfig({ cwd: project, overlay: "missing" }), /must contain a JSON object/);
    writeFileSync(join(home, ".hara", "config.json"), "{}");
    const cfg = loadConfig({ cwd: project, overlay: "missing" });
    assert.equal(cfg.provider, "anthropic");
    assert.equal(cfg.cwd, project);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedOverlay === undefined) delete process.env.HARA_OVERLAY;
    else process.env.HARA_OVERLAY = savedOverlay;
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent config updates preserve both processes' keys", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-process-race-"));
  const home = join(root, "home");
  const haraHome = join(home, ".hara");
  const config = join(haraHome, "config.json");
  mkdirSync(haraHome, { recursive: true });
  writeFileSync(config, JSON.stringify({
    provider: "openai",
    model: "stable-model",
    apiKey: "fixture-key",
    sentinel: "preserve-me",
  }), { mode: 0o600 });
  const runChild = (key, holdMs, delayMs = 0) => new Promise((resolve, reject) => {
    const script = `import { updateRawConfig } from "./dist/config.js";
      ${delayMs ? `await new Promise((resolve) => setTimeout(resolve, ${delayMs}));` : ""}
      updateRawConfig((config) => {
        const end = Date.now() + ${holdMs};
        while (Date.now() < end) {}
        config[${JSON.stringify(key)}] = true;
      });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${key} child failed (${code}): ${stderr}`)));
  });
  try {
    const results = await Promise.allSettled([
      runChild("fromA", 500),
      runChild("fromB", 50, 100),
    ]);
    assert.deepEqual(results.filter((result) => result.status === "rejected").map((result) => String(result.reason)), []);
    const stored = JSON.parse(readFileSync(config, "utf8"));
    assert.equal(stored.provider, "openai");
    assert.equal(stored.model, "stable-model");
    assert.equal(stored.apiKey, "fixture-key");
    assert.equal(stored.sentinel, "preserve-me");
    assert.equal(stored.fromA, true);
    assert.equal(stored.fromB, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a publisher crash between lock link and staging cleanup is recovered", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-dead-publication-"));
  const home = join(root, "home");
  const haraHome = join(home, ".hara");
  mkdirSync(haraHome, { recursive: true });
  writeFileSync(join(haraHome, "config.json"), JSON.stringify({ sentinel: "preserve-me" }), { mode: 0o600 });
  const deadPid = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const childPid = child.pid;
    child.once("error", reject);
    child.once("close", () => resolve(childPid));
  });
  assert.equal(Number.isInteger(deadPid), true);
  const token = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const staging = join(haraHome, `.hara-lock-${deadPid}-${token}.tmp`);
  const lock = join(haraHome, "config.lock");
  writeFileSync(staging, `${JSON.stringify({
    pid: deadPid,
    token,
  })}\n`, { mode: 0o600 });
  linkSync(staging, lock);
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = home;
    writeConfigValue("recovered", "yes");
    const stored = JSON.parse(readFileSync(join(haraHome, "config.json"), "utf8"));
    assert.equal(stored.sentinel, "preserve-me");
    assert.equal(stored.recovered, "yes");
    assert.deepEqual(
      readdirSync(haraHome).filter((name) => name.includes(".hara-lock-") || name.endsWith(".lock") || name.endsWith(".reclaim")),
      [],
      "the dead publication and reclaim guard leave no lock artifacts",
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("many live config lock publishers preserve every update", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-publisher-pressure-"));
  const home = join(root, "home");
  const haraHome = join(home, ".hara");
  mkdirSync(haraHome, { recursive: true });
  writeFileSync(join(haraHome, "config.json"), JSON.stringify({ count: 0 }), { mode: 0o600 });
  const workers = 8;
  const updates = 10;
  const activeChildren = new Set();
  const runWorker = (index) => new Promise((resolve, reject) => {
    const script = `import { updateRawConfig } from "./dist/config.js";
      for (let i = 0; i < ${updates}; i++) updateRawConfig((config) => {
        config.count = Number(config.count ?? 0) + 1;
        config["worker-${index}"] = i + 1;
      });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["ignore", "ignore", "pipe"],
    });
    activeChildren.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      activeChildren.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`worker ${index} failed (${code}): ${stderr}`));
    });
  });
  try {
    const results = await Promise.allSettled(Array.from({ length: workers }, (_, index) => runWorker(index)));
    assert.deepEqual(results.filter((result) => result.status === "rejected").map((result) => String(result.reason)), []);
    const stored = JSON.parse(readFileSync(join(haraHome, "config.json"), "utf8"));
    assert.equal(stored.count, workers * updates);
    for (let index = 0; index < workers; index++) assert.equal(stored[`worker-${index}`], updates);
    assert.deepEqual(
      readdirSync(haraHome).filter((name) => name.includes(".hara-lock-") || name.endsWith(".lock") || name.endsWith(".reclaim")),
      [],
    );
  } finally {
    for (const child of activeChildren) {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig: every call re-reads config.json for a rotated key", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-rotate-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".hara"), { recursive: true });
  const path = join(home, ".hara", "config.json");
  const savedHome = process.env.HOME;
  const savedKey = process.env.HARA_API_KEY;
  const savedOpenAI = process.env.OPENAI_API_KEY;
  try {
    process.env.HOME = home;
    delete process.env.HARA_API_KEY;
    delete process.env.OPENAI_API_KEY;
    writeFileSync(path, JSON.stringify({ provider: "openai", apiKey: "first", model: "m" }));
    assert.equal(loadConfig().apiKey, "first");
    writeFileSync(path, JSON.stringify({ provider: "openai", apiKey: "rotated", model: "m" }));
    assert.equal(loadConfig().apiKey, "rotated");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedKey === undefined) delete process.env.HARA_API_KEY;
    else process.env.HARA_API_KEY = savedKey;
    if (savedOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAI;
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider catalog: Ollama and LM Studio are first-class local no-key presets", () => {
  const catalog = providerCatalog();
  const ollama = catalog.find((provider) => provider.id === "ollama");
  const lmstudio = catalog.find((provider) => provider.id === "lmstudio");
  assert.deepEqual(
    { location: ollama?.location, auth: ollama?.auth, baseURL: ollama?.defaultBaseURL },
    { location: "local", auth: "none", baseURL: "http://127.0.0.1:11434/v1" },
  );
  assert.deepEqual(
    { location: lmstudio?.location, auth: lmstudio?.auth, baseURL: lmstudio?.defaultBaseURL },
    { location: "local", auth: "none", baseURL: "http://127.0.0.1:1234/v1" },
  );
});

test("provider catalog: DeepSeek exposes the official visual model while retaining custom ids", () => {
  const deepseek = providerCatalog().find((provider) => provider.id === "deepseek");
  assert.equal(deepseek?.customBaseURL, true);
  assert.deepEqual(deepseek?.knownModels, [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash-vision-exp",
  ]);
});

test("provider catalog: Token Plan is the single current Alibaba setup entry and legacy Qwen routes stay loadable", () => {
  const catalog = providerCatalog();
  const tokenPlan = catalog.find((provider) => provider.id === "token-plan");
  assert.deepEqual(
    {
      auth: tokenPlan?.auth,
      baseURL: tokenPlan?.defaultBaseURL,
      model: tokenPlan?.defaultModel,
      customBaseURL: tokenPlan?.customBaseURL,
    },
    {
      auth: "api-key",
      baseURL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      model: "qwen3.8-max",
      customBaseURL: false,
    },
  );
  assert.ok(tokenPlan?.knownModels?.includes("glm-5.2"));
  assert.equal(catalog.find((provider) => provider.id === "qwen")?.legacy, true);
  assert.equal(catalog.find((provider) => provider.id === "qwen-oauth")?.legacy, true);
});

test("provider catalog: MiniMax Token Plan exposes its fixed Codex endpoint and M3 model", () => {
  const miniMax = providerCatalog().find((provider) => provider.id === "minimax-token-plan");
  assert.deepEqual(
    {
      auth: miniMax?.auth,
      baseURL: miniMax?.defaultBaseURL,
      model: miniMax?.defaultModel,
      customBaseURL: miniMax?.customBaseURL,
      knownModels: miniMax?.knownModels,
    },
    {
      auth: "api-key",
      baseURL: "https://api.minimaxi.com/v1",
      model: "MiniMax-M3",
      customBaseURL: false,
      knownModels: ["MiniMax-M3"],
    },
  );
});

test("provider catalog: Volcengine Agent Plan exposes its fixed Codex Responses endpoint", () => {
  const volcengine = providerCatalog().find((provider) => provider.id === "volcengine-agent-plan");
  assert.deepEqual(
    {
      auth: volcengine?.auth,
      baseURL: volcengine?.defaultBaseURL,
      model: volcengine?.defaultModel,
      customBaseURL: volcengine?.customBaseURL,
    },
    {
      auth: "api-key",
      baseURL: "https://ark.cn-beijing.volces.com/api/plan/v3",
      model: "auto",
      customBaseURL: false,
    },
  );
  assert.ok(volcengine?.knownModels?.includes("glm-5.3-flash"));
  assert.ok(volcengine?.knownModels?.includes("auto"));
  assert.ok(volcengine?.knownModels?.includes("deepseek-v4-pro"));
  assert.equal(volcengine?.knownModels?.some((model) => /seedream|seedance|embedding|tts|asr/i.test(model)), false);
});

test("provider settings pin Token Plan credentials to the official Beijing endpoint", () => {
  assert.equal(
    normalizePersonalProviderConfig({
      provider: "token-plan",
      model: "qwen3.8-max",
      baseURL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
    }).baseURL,
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  );
  assert.throws(
    () => normalizePersonalProviderConfig({
      provider: "token-plan",
      model: "qwen3.8-max",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    }),
    /fixed Beijing endpoint/,
  );
});

test("provider settings pin MiniMax Token Plan credentials to the official Codex endpoint", () => {
  assert.equal(
    normalizePersonalProviderConfig({
      provider: "minimax-token-plan",
      model: "MiniMax-M3",
      baseURL: "https://api.minimaxi.com/v1/",
    }).baseURL,
    "https://api.minimaxi.com/v1",
  );
  assert.throws(
    () => normalizePersonalProviderConfig({
      provider: "minimax-token-plan",
      model: "MiniMax-M3",
      baseURL: "https://api.minimaxi.com/anthropic",
    }),
    /fixed endpoint/,
  );
});

test("provider settings pin Volcengine Agent Plan credentials to the official Beijing endpoint", () => {
  assert.equal(
    normalizePersonalProviderConfig({
      provider: "volcengine-agent-plan",
      model: "ark-code-latest",
      baseURL: "https://ark.cn-beijing.volces.com/api/plan/v3/",
    }).baseURL,
    "https://ark.cn-beijing.volces.com/api/plan/v3",
  );
  assert.throws(
    () => normalizePersonalProviderConfig({
      provider: "volcengine-agent-plan",
      model: "ark-code-latest",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    }),
    /fixed Beijing endpoint/,
  );
});

test("provider settings validation keeps local endpoints loopback-only and cloud HTTP secure", () => {
  assert.throws(
    () => normalizePersonalProviderConfig({ provider: "ollama", model: "qwen3", baseURL: "http://192.168.1.10:11434/v1" }),
    /must use https|must use localhost|labeled local/i,
  );
  assert.throws(
    () => normalizePersonalProviderConfig({ provider: "openai", model: "gpt", baseURL: "http://provider.example/v1" }),
    /must use https/i,
  );
  assert.throws(
    () => normalizePersonalProviderConfig({ provider: "openai", model: "gpt", baseURL: "https://user:secret@provider.example/v1" }),
    /credentials/i,
  );
  assert.equal(
    normalizePersonalProviderConfig({ provider: "lmstudio", model: "local", baseURL: "http://localhost:1234/v1/" }).baseURL,
    "http://localhost:1234/v1",
  );
  assert.throws(
    () => normalizePersonalProviderConfig({ provider: "openai", model: "gpt", apiKey: "line-one\nline-two" }),
    /API key is invalid/i,
  );
});

test("provider settings reuse a credential only for the exact same endpoint", () => {
  const raw = {
    provider: "openai",
    model: "gpt",
    baseURL: "https://first.example/v1/",
    apiKey: "opaque-current-key",
  };
  const same = normalizePersonalProviderConfig({
    provider: "openai",
    model: "gpt-next",
    baseURL: "https://FIRST.example/v1",
  });
  assert.equal(reusablePersonalProviderApiKey(same, raw, {}), "opaque-current-key");

  const changed = normalizePersonalProviderConfig({
    provider: "openai",
    model: "gpt-next",
    baseURL: "https://second.example/v1",
  });
  assert.equal(reusablePersonalProviderApiKey(changed, raw, { HARA_API_KEY: "environment-key" }), undefined);
  assert.equal(
    reusablePersonalProviderApiKey({ ...changed, apiKey: "explicit-new-key" }, raw, {}),
    "explicit-new-key",
  );
});

test("personal provider switch never replays a flat key to another vendor and local mode stores no fake key", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-provider-update-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".hara"), { recursive: true });
  writeFileSync(join(home, ".hara", "config.json"), JSON.stringify({
    provider: "openai",
    model: "gpt-test",
    apiKey: "sk-provider-a-only",
  }));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    updatePersonalProviderConfig({ provider: "ollama", model: "qwen3" });
    let raw = readRawConfig();
    assert.equal(raw.provider, "ollama");
    assert.equal(raw.baseURL, "http://127.0.0.1:11434/v1");
    assert.equal("apiKey" in raw, false);

    updatePersonalProviderConfig({ provider: "deepseek", model: "deepseek-chat" });
    raw = readRawConfig();
    assert.equal(raw.provider, "deepseek");
    assert.equal("apiKey" in raw, false, "switching vendors without a new key must not reuse the previous credential");

    updatePersonalProviderConfig({
      provider: "deepseek",
      model: "deepseek-chat",
      baseURL: "https://proxy-one.example/v1",
      apiKey: "proxy-one-key",
    });
    updatePersonalProviderConfig({
      provider: "deepseek",
      model: "deepseek-reasoner",
      baseURL: "https://proxy-two.example/v1",
    });
    raw = readRawConfig();
    assert.equal("apiKey" in raw, false, "changing only the endpoint also clears the old credential");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("personal provider settings persist, preserve, and clear the default reasoning effort", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-provider-reasoning-default-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".hara"), { recursive: true });
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    updatePersonalProviderConfig({
      provider: "token-plan",
      model: "qwen3.8-flash",
      apiKey: "opaque-token-plan-key",
      reasoningEffort: "medium",
    });
    let raw = readRawConfig();
    assert.equal(raw.reasoningEffort, "medium");

    updatePersonalProviderConfig({
      provider: "token-plan",
      model: "qwen3.8-max",
    });
    raw = readRawConfig();
    assert.equal(raw.reasoningEffort, "medium", "omitting the field preserves the connection default");

    updatePersonalProviderConfig({
      provider: "token-plan",
      model: "qwen3.8-max",
      clearReasoningEffort: true,
    });
    raw = readRawConfig();
    assert.equal("reasoningEffort" in raw, false, "automatic removes the explicit connection default");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("config get masks every API key and authenticated proxy URL", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-redaction-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".hara"), { recursive: true });
  const secrets = {
    visionApiKey: "vision-secret-1234",
    embedApiKey: "embed-secret-2345",
    routeApiKey: "route-secret-3456",
    fallbackApiKey: "fallback-secret-4567",
    proxy: "http://proxy-user:proxy-password@127.0.0.1:7890",
  };
  writeFileSync(join(home, ".hara", "config.json"), JSON.stringify(secrets));
  const cli = join(process.cwd(), "dist", "index.js");
  const run = (key) => spawnSync(process.execPath, [cli, "config", "get", key], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, HARA_UPDATE_CHECK: "0" },
    encoding: "utf8",
    timeout: 10_000,
  });
  try {
    for (const key of ["visionApiKey", "embedApiKey", "routeApiKey", "fallbackApiKey"]) {
      const result = run(key);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /^••••/u);
      assert.equal(result.stdout.includes(secrets[key]), false);
    }
    const proxy = run("proxy");
    assert.equal(proxy.status, 0, proxy.stderr || proxy.stdout);
    assert.match(proxy.stdout, /http:\/\/127\.0\.0\.1:7890 \(credentials redacted\)/);
    assert.doesNotMatch(proxy.stdout, /proxy-user|proxy-password/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
