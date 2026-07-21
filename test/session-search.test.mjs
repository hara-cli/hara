import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSession } from "../dist/session/store.js";
import { getTool } from "../dist/tools/registry.js";
import { sessionSearchTerms } from "../dist/tools/session-search.js";

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
