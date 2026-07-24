import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSession } from "../dist/session/store.js";
import { persistPrintAutomationOccurrence } from "../dist/cron/runner.js";
import { getTool } from "../dist/tools/registry.js";
import { automaticSessionRecall, sessionRecallQuery, sessionSearchTerms } from "../dist/tools/session-search.js";

const previousHome = process.env.HOME;
const root = mkdtempSync(join(tmpdir(), "hara-session-search-"));
const home = join(root, "home");
const project = join(root, "project");
const otherProject = join(root, "other-project");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(otherProject, { recursive: true });
process.env.HOME = home;

after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function meta(id, cwd, extras = {}) {
  return {
    id,
    cwd,
    provider: "openai",
    model: "test-model",
    title: id,
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "",
    source: "interactive",
    ...extras,
  };
}

test("sessionSearchTerms creates useful CJK bigrams and ordinary words", () => {
  const terms = sessionSearchTerms("之前查一下 Elon Musk 的维基百科");
  assert.ok(terms.includes("elon"));
  assert.ok(terms.includes("musk"));
  assert.ok(terms.includes("维基"));
  assert.ok(terms.includes("百科"));
  assert.ok(sessionSearchTerms("C++ interop").includes("c++"));
});

test("automatic transcript recall triggers only for explicit, non-negated historical references", async () => {
  assert.equal(sessionRecallQuery("检查当前代码"), null);
  assert.equal(sessionRecallQuery("不要搜索之前的旧会话"), null);
  assert.equal(sessionRecallQuery("continue the task from our previous session"), "continue the task from our previous session");
  assert.equal(sessionRecallQuery("继续上次讨论的铜色发布流程"), "继续上次讨论的铜色发布流程");

  saveSession(meta("auto-prior-copper", otherProject, { title: "铜色发布流程" }), [
    { role: "user", content: "上次确定铜色发布需要先跑签名验收。" },
    { role: "assistant", text: "发布前先验证签名与摘要。", toolUses: [] },
  ]);
  saveSession(meta("auto-current-copper", project), []);
  const recalled = await automaticSessionRecall(
    "继续上次讨论的铜色发布流程",
    { cwd: project, sessionId: "auto-current-copper" },
  );
  assert.match(recalled, /Automatic prior-session recall/);
  assert.match(recalled, /UNTRUSTED reference text/);
  assert.match(recalled, /session auto-pri/);
  assert.equal(await automaticSessionRecall("检查当前代码", { cwd: project, sessionId: "auto-current-copper" }), "");
});

test("a freshly bound cron occurrence can automatically recall the same job's prior history", async () => {
  saveSession(meta("cron-recall-prior", project, {
    source: "cron",
    sourceName: "old task name",
    jobId: "cron-recall-job",
    title: "cobalt handoff",
  }), [
    { role: "user", content: "上次任务确认 cobalt handoff 要先检查签名。" },
  ]);
  const currentId = persistPrintAutomationOccurrence({
    id: "cron-recall-job",
    name: "renamed task",
    cwd: project,
  });
  const recalled = await automaticSessionRecall(
    "继续上次任务的 cobalt handoff",
    { cwd: project, sessionId: currentId },
  );
  assert.match(recalled, /Automatic prior-session recall/);
  assert.match(recalled, /cron-recall-prior|cobalt handoff/);
});

test("session_search finds a prior same-project conversation, excludes current/tool-only/other-audience data", async () => {
  const tool = getTool("session_search");
  assert.ok(tool);
  saveSession(meta("prior-musk", project), [
    { role: "user", content: "查一下马斯克的维基百科资料" },
    { role: "assistant", text: "Elon Musk 的相关页面已经整理好了。", toolUses: [] },
  ]);
  saveSession(meta("tool-only", project), [
    { role: "user", content: "unrelated" },
    { role: "assistant", text: "", toolUses: [{ id: "t1", name: "bash", input: { command: "echo 马斯克维基百科" } }] },
    { role: "tool", results: [{ id: "t1", name: "bash", content: "马斯克维基百科 private tool output" }] },
  ]);
  saveSession(meta("other-project", otherProject), [
    { role: "user", content: "马斯克维基百科 in another project" },
  ]);
  saveSession(meta("gateway-chat", project, { source: "gateway", sourceName: "feishu", gatewayOwner: "group:private" }), [
    { role: "user", content: "马斯克维基百科 from a private group" },
  ]);
  saveSession(meta("current-chat", project), [
    { role: "user", content: "现在搜索马斯克维基百科" },
  ]);

  const result = await tool.run(
    { query: "马斯克 维基百科" },
    { cwd: project, sessionId: "current-chat" },
  );
  assert.match(result, /UNTRUSTED reference text/);
  assert.match(result, /prior-musk/);
  assert.match(result, /查一下马斯克的维基百科资料/);
  assert.doesNotMatch(result, /current-chat|tool-only|other-project|gateway-chat|private tool output/);
});

test("cron session recall uses stable jobId instead of a mutable or duplicate task name", async () => {
  const tool = getTool("session_search");
  assert.ok(tool);
  saveSession(meta("cron-alpha-prior", project, {
    source: "cron",
    sourceName: "old shared name",
    jobId: "job-alpha",
  }), [
    { role: "user", content: "job-alpha-only copper boundary" },
  ]);
  saveSession(meta("cron-beta-prior", project, {
    source: "cron",
    sourceName: "renamed shared name",
    jobId: "job-beta",
  }), [
    { role: "user", content: "job-beta confidential copper boundary" },
  ]);
  saveSession(meta("cron-alpha-current", project, {
    source: "cron",
    sourceName: "renamed shared name",
    jobId: "job-alpha",
  }), []);

  const isolated = await tool.run(
    { query: "copper boundary", scope: "project" },
    { cwd: project, sessionId: "cron-alpha-current" },
  );
  assert.match(isolated, /cron-alpha-prior|job-alpha-only/);
  assert.doesNotMatch(
    isolated,
    /cron-beta-prior|job-beta confidential/,
    "same-named cron jobs cannot read each other's transcripts",
  );

  saveSession(meta("cron-legacy-prior", project, {
    source: "cron",
    sourceName: "legacy-only-task",
  }), [
    { role: "user", content: "legacy violet recall marker" },
  ]);
  saveSession(meta("cron-legacy-current", project, {
    source: "cron",
    sourceName: "legacy-only-task",
  }), []);
  const legacy = await tool.run(
    { query: "legacy violet", scope: "project" },
    { cwd: project, sessionId: "cron-legacy-current" },
  );
  assert.match(legacy, /cron-legacy-prior/, "two pre-jobId sessions retain their legacy audience");
});

test("session_search cross-project scope is explicit and unavailable to automated sessions", async () => {
  const tool = getTool("session_search");
  assert.ok(tool);
  const all = await tool.run(
    { query: "another project", scope: "all" },
    { cwd: project, sessionId: "current-chat" },
  );
  assert.match(all, /other-project/);
  assert.match(all, /project /, "cross-project output identifies the source workspace");

  saveSession(meta("gateway-current", project, { source: "gateway", sourceName: "feishu", gatewayOwner: "group:private" }), []);
  const blocked = await tool.run(
    { query: "anything", scope: "all" },
    { cwd: project, sessionId: "gateway-current" },
  );
  assert.match(blocked, /^Blocked: cross-project session search/);
});

test("session_search automatically falls back to prior interactive workspaces when this project has no match", async () => {
  const tool = getTool("session_search");
  assert.ok(tool);
  const result = await tool.run(
    { query: "another project" },
    { cwd: project, sessionId: "current-chat" },
  );
  assert.match(result, /other-project/);
  assert.match(result, /No match in the current project/i);
  assert.match(result, /project /, "fallback output identifies the source workspace");
});

test("session_search can use a saved session title when compacted message text no longer has the terms", async () => {
  const tool = getTool("session_search");
  assert.ok(tool);
  saveSession(meta("title-anchor", project, { title: "Zebra Nebula research" }), [
    { role: "user", content: "The older details were compacted." },
  ]);
  const result = await tool.run(
    { query: "Zebra Nebula", scope: "project" },
    { cwd: project, sessionId: "current-chat" },
  );
  assert.match(result, /Zebra Nebula research/);
  assert.match(result, /older details were compacted/);
});

test("session_search fails closed when an automated run has no bound session identity", async () => {
  const tool = getTool("session_search");
  assert.ok(tool);
  const previous = process.env.HARA_GATEWAY;
  process.env.HARA_GATEWAY = "feishu";
  try {
    const blocked = await tool.run({ query: "马斯克" }, { cwd: project });
    assert.match(blocked, /^Blocked: automated session_search requires a bound durable session/);
  } finally {
    if (previous === undefined) delete process.env.HARA_GATEWAY;
    else process.env.HARA_GATEWAY = previous;
  }
});

test("session_search returns the stable empty marker used by the recall breaker", async () => {
  const tool = getTool("session_search");
  assert.ok(tool);
  assert.equal(
    await tool.run({ query: "uniquely-absent-needle-7ffde9" }, { cwd: project, sessionId: "current-chat" }),
    "(no session matches)",
  );
});

test("session_search falls back to authoritative metadata after four pages of obsolete generations", async () => {
  const tool = getTool("session_search");
  assert.ok(tool);
  const staleProject = join(root, "stale-generation-project");
  mkdirSync(staleProject, { recursive: true });
  saveSession(meta("stale-page-target", staleProject, { title: "fifth page target" }), [
    { role: "user", content: "fifth page target recall needle" },
  ]);
  saveSession(meta("stale-page-current", staleProject), []);

  const canonicalProject = realpathSync.native(staleProject);
  const cwdHash = createHash("sha256").update(canonicalProject).digest("hex").slice(0, 32);
  const stamp = new Date();
  const year = String(stamp.getUTCFullYear()).padStart(4, "0");
  const month = String(stamp.getUTCMonth() + 1).padStart(2, "0");
  const day = String(stamp.getUTCDate()).padStart(2, "0");
  const hour = String(stamp.getUTCHours()).padStart(2, "0");
  const shard = join(
    home,
    ".hara",
    "session-index",
    "v1",
    "routes",
    `source-cwd-interactive-${cwdHash}`,
    year,
    month,
    day,
    `${hour}.ndjson`,
  );
  const stale = Array.from({ length: 4_001 }, (_, index) => JSON.stringify({
    v: 1,
    id: "stale-page-current",
    generation: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    at: stamp.getTime() + index + 1,
  }));
  writeFileSync(shard, `${stale.join("\n")}\n`, { flag: "a" });

  const result = await tool.run(
    { query: "fifth page target", scope: "project" },
    { cwd: staleProject, sessionId: "stale-page-current" },
  );
  assert.match(result, /stale-page-target|fifth page target recall needle/);
});

test("stateless session_search imports legacy transcripts on first use", () => {
  const isolatedRoot = mkdtempSync(join(tmpdir(), "hara-session-search-legacy-first-use-"));
  const isolatedHome = join(isolatedRoot, "home");
  const isolatedProject = join(isolatedRoot, "project");
  const sessions = join(isolatedHome, ".hara", "sessions");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(isolatedProject, { recursive: true });
  const writeLegacy = (id, title, content) => writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
    meta: {
      id,
      cwd: isolatedProject,
      provider: "test",
      model: "test",
      title,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      source: "interactive",
    },
    history: [{ role: "user", content }],
  }));
  writeLegacy("legacy-search-prior", "violet archive", "violet archive migration needle");
  writeLegacy("legacy-search-current", "current", "search the prior violet archive");
  try {
    const script = [
      "import './dist/tools/session-search.js';",
      "import { getTool } from './dist/tools/registry.js';",
      "const tool = getTool('session_search');",
      `const result = await tool.run({ query: 'violet archive' }, { cwd: ${JSON.stringify(isolatedProject)}, sessionId: 'legacy-search-current' });`,
      "process.stdout.write(result);",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /legacy-search-prior|violet archive migration needle/);
    assert.ok(
      JSON.parse(readFileSync(join(sessions, "legacy-search-prior.json"), "utf8")).storageGeneration,
      "the tool migrated the authoritative transcript before searching its index",
    );
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});
