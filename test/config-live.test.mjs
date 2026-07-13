import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";

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
    }),
  );
  writeFileSync(join(project, "package.json"), "{}");
  writeFileSync(join(project, ".hara", "config.json"), JSON.stringify({
    apiKey: " ", model: "", fallbackApiKey: "", fallbackModel: " ", visionApiKey: "", visionModel: " ",
    embedApiKey: " ", embedModel: "", routeApiKey: "", routeModel: " ",
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

test("loadConfig: a project override wins a selected global overlay", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-config-precedence-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".hara"), { recursive: true });
  mkdirSync(join(project, ".hara"), { recursive: true });
  writeFileSync(join(home, ".hara", "config.json"), JSON.stringify({
    provider: "openai",
    model: "global",
    overlays: { work: { model: "overlay", mcpServers: { shared: { command: "overlay" } } } },
  }));
  writeFileSync(join(project, "package.json"), "{}");
  writeFileSync(join(project, ".hara", "config.json"), JSON.stringify({
    model: "project",
    mcpServers: { shared: { command: "project" } },
  }));
  const saved = { HOME: process.env.HOME, cwd: process.cwd(), HARA_OVERLAY: process.env.HARA_OVERLAY, HARA_MODEL: process.env.HARA_MODEL };
  try {
    process.env.HOME = home;
    process.env.HARA_OVERLAY = "work";
    delete process.env.HARA_MODEL;
    process.chdir(project);
    const cfg = loadConfig();
    assert.equal(cfg.model, "project");
    assert.equal(cfg.mcpServers.shared.command, "project");
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

test("loadConfig: non-object config roots and blank overlay env fail soft", () => {
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
