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
    JSON.stringify({ provider: "openai", apiKey: "configured-key", model: "configured-model", baseURL: "https://configured.example/v1" }),
  );
  writeFileSync(join(project, "package.json"), "{}");
  writeFileSync(join(project, ".hara", "config.json"), JSON.stringify({ apiKey: " ", model: "" }));

  const saved = {
    HOME: process.env.HOME,
    cwd: process.cwd(),
    HARA_API_KEY: process.env.HARA_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    HARA_MODEL: process.env.HARA_MODEL,
    HARA_BASE_URL: process.env.HARA_BASE_URL,
  };
  try {
    process.env.HOME = home;
    process.chdir(project);
    process.env.HARA_API_KEY = "";
    process.env.OPENAI_API_KEY = " ";
    process.env.HARA_MODEL = "";
    process.env.HARA_BASE_URL = "";
    const cfg = loadConfig();
    assert.equal(cfg.apiKey, "configured-key");
    assert.equal(cfg.model, "configured-model");
    assert.equal(cfg.baseURL, "https://configured.example/v1");
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
