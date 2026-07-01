// Pure helpers behind HeaderCard (顾雅 spec, 2026-06). These power the host/cwd/session
// rendering without React, so they can be pinned exactly — no escape codes, no layout drift.
import test from "node:test";
import assert from "node:assert/strict";
import { extractHost, shortenHome, shortenSession, modelLineSuffix, fieldFormatter } from "../dist/tui/App.js";
import { routeHost } from "../dist/profile/profile.js";

test("extractHost: returns host-only for canonical URLs (no scheme, no path, no query)", () => {
  assert.equal(extractHost("https://dashscope.aliyuncs.com"), "dashscope.aliyuncs.com");
  assert.equal(extractHost("https://dashscope.aliyuncs.com/v1"), "dashscope.aliyuncs.com");
  assert.equal(extractHost("https://api.openai.com/v1/chat?x=1"), "api.openai.com");
  // Node's URL drops a default port (:443 for https) — that's correct, we want the natural host.
  assert.equal(extractHost("https://gw.nanhara.tech:443/v1/"), "gw.nanhara.tech");
  // Non-default port is preserved.
  assert.equal(extractHost("http://localhost:8080/v1"), "localhost:8080");
});

test("extractHost: falls back gracefully for non-URL strings (don't lose info)", () => {
  assert.equal(extractHost(""), "");
  assert.equal(extractHost(undefined), "");
  assert.equal(extractHost(null), "");
  // Scheme-less hostnames: best-effort split — return what comes before the first slash/?.
  assert.equal(extractHost("api.example.com/foo"), "api.example.com");
});

test("shortenHome: tilde-collapses HOME (and ONLY HOME) prefix", () => {
  assert.equal(shortenHome("/Users/jeff/work/x", "/Users/jeff"), "~/work/x");
  // exact home → "~"
  assert.equal(shortenHome("/Users/jeff", "/Users/jeff"), "~");
  // not under home → unchanged
  assert.equal(shortenHome("/etc/passwd", "/Users/jeff"), "/etc/passwd");
  // empty home → no collapse
  assert.equal(shortenHome("/Users/jeff/x", ""), "/Users/jeff/x");
});

test("shortenHome: truncates long paths from the LEFT, preserving the project tail", () => {
  const home = "/Users/jeff";
  const long = "/Users/jeff/work/projects/some/deeply/nested/repo/with/a/long/path/to/the-project";
  const out = shortenHome(long, home, 30);
  assert.ok(out.length <= 31, "respects the cap (allow +1 for the leading ellipsis)");
  assert.ok(out.startsWith("…"), "truncation marker on the left");
  assert.ok(out.endsWith("the-project"), "keeps the most-specific tail segment");
});

test("shortenSession: 8-char prefix, never the whole id; safe on missing input", () => {
  assert.equal(shortenSession("7bf3ee14-aaaa-bbbb-cccc-deadbeef0000"), "7bf3ee14");
  assert.equal(shortenSession("short"), "short");
  assert.equal(shortenSession(""), "");
  assert.equal(shortenSession(undefined), "");
  assert.equal(shortenSession(null), "");
});

test("modelLineSuffix: the dim vision clause '· vision <model>' ONLY when a visionModel is set (no /model hint here)", () => {
  // With a describer configured → just the vision clause. The actionable `/model ↹` hint now lives in
  // the view (rendered green), NOT in this dim suffix.
  const withVision = modelLineSuffix("qwen3.7-plus");
  assert.ok(withVision.includes("vision qwen3.7-plus"), "vision sidecar shown when set");
  assert.ok(!withVision.includes("/model"), "the /model affordance is rendered by the view, not baked into the suffix");
  // No describer → empty (silence beats a fabricated describer; native-vision models say nothing).
  assert.equal(modelLineSuffix(undefined), "", "empty suffix when no describer configured");
  assert.equal(modelLineSuffix(""), "", "empty string is treated as unset (falsy)");
});

test("fieldFormatter: pads every label to the WIDEST label actually shown (data-driven grid, codex FieldFormatter::from_labels)", () => {
  // Personal grid labels: profile / model / cwd / session → widest is "session" (7).
  const pad = fieldFormatter(["profile", "model", "cwd", "session"]);
  assert.equal(pad("profile").length, 7, "each label padded to the max width (7)");
  assert.equal(pad("model"), "model  ", "shorter labels right-padded with spaces");
  assert.equal(pad("session"), "session", "the widest label is unpadded");
  // Org grid (no session): org / model / cwd → widest is "model"/"cwd"? "model"=5, "org"=3, "cwd"=3 → 5.
  const padOrg = fieldFormatter(["org", "model", "cwd"]);
  assert.equal(padOrg("org").length, 5, "width adapts to the labels present (org grid → 5)");
  assert.equal(padOrg("model"), "model", "widest label unpadded in the org grid");
});

test("routeHost (profile.ts): personal on official endpoint → null (don't display)", () => {
  const r = routeHost({ id: "personal", kind: "byok", provider: "anthropic" });
  assert.equal(r, null, "no baseURL → nothing to show");
});

test("routeHost: personal with custom baseURL → host only, isCustom=true", () => {
  const r = routeHost({ id: "personal", kind: "byok", provider: "qwen", baseURL: "https://dashscope.aliyuncs.com/v1" });
  assert.deepEqual(r, { host: "dashscope.aliyuncs.com", isCustom: true });
});

test("routeHost: gateway profile → host only, isCustom=true", () => {
  const r = routeHost({ id: "acme", kind: "gateway", gatewayUrl: "https://gw.nanhara.tech", deviceToken: "x" });
  assert.deepEqual(r, { host: "gw.nanhara.tech", isCustom: true });
});

test("routeHost: malformed gatewayUrl still returns something (degrade gracefully)", () => {
  const r = routeHost({ id: "acme", kind: "gateway", gatewayUrl: "not-a-url", deviceToken: "x" });
  // either { host: "not-a-url", isCustom: true } or null is acceptable — assert we don't throw.
  assert.ok(r === null || (r && typeof r.host === "string"), "doesn't throw on garbage URL");
});
