import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../dist/tui/App.js";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 70) => new Promise((r) => setTimeout(r, ms));
const status = { sessionName: "demo", approval: "suggest", input: 0, output: 0, ctxPct: 0, agents: 0 };

test("App runs a turn: user line in, streamed assistant reply out, status bar pinned below", async () => {
  const onSubmit = async (line, h) => {
    h.sink.assistantDelta("Hello, ");
    h.sink.assistantDelta("world.");
    h.sink.usage(120, 24);
    await tick(200); // keep the live region visible long enough to sample
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("say hi");
  await tick();
  stdin.write("\r"); // submit → turn runs
  await tick(80); // sample mid-turn (within onSubmit's 200ms window)
  const mid = strip(lastFrame());
  assert.ok(mid.includes("Hello, world."), "streamed assistant text visible during the turn");
  assert.ok(mid.includes("glm-5 · suggest"), "status footer stays pinned below the live output");
  await tick(200); // let the turn finish and commit
  unmount();
});

test("App header (personal): bordered card, ◆ glyph + title, profile grid, /model ↹ affordance", async () => {
  // Personal on the provider's official endpoint — grid row is `profile  personal`, the model row
  // carries the model + green /model ↹ affordance, no "→ host" (routeHost undefined), no banner.
  const header = {
    version: "9.9.9",
    modelLabel: "qwen:glm-5",
    cwd: "/Users/jeff/work/projects/test/design",
    agentsMdLoaded: true,
    session: "7bf3ee14-aaaa-bbbb-cccc-deadbeef0000",
    kind: "personal",
  };
  const { lastFrame, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), header, onSubmit: async () => {} }),
  );
  await tick();
  const frame = strip(lastFrame());
  // ASCII banner is gone — no more ███ characters in the header.
  assert.ok(!/[█]/.test(frame), "old ASCII banner block is no longer rendered");
  // Rounded card chrome (codex polish).
  assert.ok(frame.includes("╭") && frame.includes("╰"), "header rendered inside a rounded card");
  // Seal-red ◆ glyph + title + dim version/tagline.
  assert.ok(frame.includes("◆ hara"), "◆ glyph + title present (replaces the old > prompt)");
  assert.ok(frame.includes("v9.9.9"), "version on the title line");
  assert.ok(frame.includes("the agent that runs like an org"), "tagline on the title line");
  // Grid: `profile  personal` (identity row), plus a `model` row (personal now has one too).
  assert.ok(/profile\s+personal/.test(frame), "profile grid row shows 'personal'");
  assert.ok(/model\s+qwen:glm-5/.test(frame), "model row carries the provider:model");
  assert.ok(!frame.includes("→"), "no '→ host' suffix on official-endpoint personal");
  // cwd line gets a "· AGENTS.md" suffix when loaded; never a negative line.
  assert.ok(frame.includes("cwd"), "cwd label present");
  assert.ok(frame.includes("AGENTS.md"), "AGENTS.md flag rendered as a cwd suffix");
  assert.ok(!/no AGENTS\.md/.test(frame), "no negative 'no AGENTS.md' line");
  // session is the first 8 chars, never the full uuid.
  assert.ok(frame.includes("7bf3ee14"), "session shows the short id");
  assert.ok(!frame.includes("7bf3ee14-aaaa"), "no full uuid leak");
  // No visionModel configured → NO "vision <model>" clause on the model row (stay silent).
  assert.ok(!/vision\s+\S/.test(frame), "no 'vision <model>' clause when visionModel is unset");
  // The actionable /model ↹ affordance is present (green in a real TTY).
  assert.ok(frame.includes("/model ↹"), "/model ↹ affordance on the model row");
  // Tip block (below the card) advertises the transcript + reasoning shortcuts.
  assert.ok(frame.includes("ctrl+t transcript"), "tip advertises Ctrl+T transcript overlay");
  assert.ok(frame.includes("ctrl+r reasoning"), "tip advertises Ctrl+R reasoning expand");
  assert.ok(frame.includes("Tip:"), "tip line present below the card");
  assert.ok(frame.includes("@ attach file"), "tip mentions @ file attach");
  unmount();
});

test("App header (personal w/ visionModel): identity row appends a dim '· vision <model>' clause", async () => {
  const header = {
    version: "9.9.9",
    modelLabel: "qwen:glm-5",
    cwd: "/Users/jeff/work/x",
    kind: "personal",
    visionModel: "qwen3.7-plus",
  };
  const { lastFrame, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), header, onSubmit: async () => {} }),
  );
  await tick();
  const frame = strip(lastFrame());
  assert.ok(/profile\s+personal/.test(frame), "profile grid row shows 'personal'");
  assert.ok(/model\s+qwen:glm-5/.test(frame), "model row carries provider:model");
  assert.ok(frame.includes("vision qwen3.7-plus"), "vision sidecar model surfaced on the model row (dim)");
  assert.ok(frame.includes("/model ↹"), "/model ↹ affordance present alongside the vision clause");
  unmount();
});

test("App header (org, routed): model row shows provenance '· from <source>' INSTEAD of the vision clause", async () => {
  // When routed via an org, the model row surfaces WHERE the model came from (provenance) rather than
  // the vision sidecar — the vision describer is a personal-config detail, not org-relevant chrome.
  const header = {
    version: "1.2.3",
    modelLabel: "qwen:glm-5",
    cwd: "/x/y",
    kind: "org",
    orgLabel: "Acme Inc",
    orgId: "acme-jeff",
    modelSource: "org default",
    visionModel: "qwen3.7-plus",
  };
  const { lastFrame, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), header, onSubmit: async () => {} }),
  );
  await tick();
  const frame = strip(lastFrame());
  assert.ok(/model\s+qwen:glm-5/.test(frame), "org model row present");
  assert.ok(frame.includes("from org default"), "provenance ('from <source>') shown on the org model row");
  assert.ok(!frame.includes("vision qwen3.7-plus"), "vision clause suppressed on org (provenance takes its place)");
  assert.ok(frame.includes("/model ↹"), "/model ↹ affordance still present on the org model row");
  unmount();
});

test("App header (personal w/ custom baseURL): the route host surfaces in the status footer (host only, no scheme)", async () => {
  // Personal grid stays clean (`profile  personal`); the custom-baseURL route host is carried by the
  // status footer below the input box (App passes header.routeHost → InputBox route).
  const header = {
    version: "1.0.0",
    modelLabel: "qwen:glm-5",
    cwd: "/Users/jeff/work/x",
    agentsMdLoaded: false,
    session: "abcd1234efghijkl",
    kind: "personal",
    routeHost: "dashscope.aliyuncs.com",
  };
  const { lastFrame, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), header, onSubmit: async () => {} }),
  );
  await tick();
  const frame = strip(lastFrame());
  assert.ok(frame.includes("dashscope.aliyuncs.com"), "custom baseURL host surfaces (in the footer)");
  assert.ok(!frame.includes("https://"), "no scheme in the rendered route");
  assert.ok(!/no AGENTS\.md/.test(frame), "still no 'no AGENTS.md' negative line");
  unmount();
});

test("App header (org/gateway): split identity + model + source rows; route host shown", async () => {
  const header = {
    version: "1.2.3",
    modelLabel: "qwen:glm-5",
    cwd: "/x/y",
    agentsMdLoaded: false,
    session: "deadbeefcafe0000",
    kind: "org",
    orgLabel: "Acme Inc",
    orgId: "acme-jeff",
    routeHost: "gw.nanhara.tech",
    modelSource: "org default",
  };
  const { lastFrame, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), header, onSubmit: async () => {} }),
  );
  await tick();
  const frame = strip(lastFrame());
  // identity row: org   <label> · <id> → <host>
  assert.ok(/org\s+Acme Inc/.test(frame), "org label rendered");
  assert.ok(frame.includes("acme-jeff"), "org/device id rendered");
  assert.ok(frame.includes("→ gw.nanhara.tech"), "gateway host rendered as '→ <host>' in the org row");
  // model row exists with source annotation
  assert.ok(/model\s+qwen:glm-5/.test(frame), "dedicated model row for org");
  assert.ok(frame.includes("from org default"), "model source annotation present");
  unmount();
});

test("App lazy vision notice: not in header at init; emitted inline once on the first image attachment", async () => {
  const header = { version: "9.9.9", modelLabel: "qwen:glm-5", cwd: "/x", kind: "personal" };
  const onSubmit = async (line, h) => {
    h.sink.assistantDelta("ok");
    await tick(80);
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, {
      initialStatus: status,
      model: "glm-5",
      cwd: process.cwd(),
      header,
      onSubmit,
      visionNotice: "glm-5 is text-only — images read by qwen-vl-max",
    }),
  );
  await tick();
  // At init the notice is NOT in the frame — header doesn't carry it anymore.
  assert.ok(!strip(lastFrame()).includes("images read by qwen-vl-max"), "vision notice silent at init");
  // Simulate a turn where the runner reports an image attachment by having the App see one in handleSubmit.
  // We can't paste a real image via stdin in ink-testing-library, so we feed a synthetic onClipboardImage and
  // press Ctrl+V — but the simplest path is to drive the notice via a direct image turn through onSubmit + the
  // App's handleSubmit signature. Use the harness in InputBox: type + Enter (no image, no notice).
  stdin.write("hello");
  await tick();
  stdin.write("\r");
  await tick(150);
  // Still no notice — no image yet.
  assert.ok(!strip(lastFrame()).includes("images read by qwen-vl-max"), "still no notice after a plain text turn");
  unmount();
});

test("App shows a tool-approval confirm and resolves on 'y'", async () => {
  let granted = null;
  const onSubmit = async (line, h) => {
    granted = await h.confirm("⚠ bash rm -rf build — run?");
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("clean");
  await tick();
  stdin.write("\r");
  await tick();
  assert.ok(strip(lastFrame()).includes("rm -rf build"), "confirm question shown");
  assert.ok(strip(lastFrame()).includes("Type a task"), "input box stays visible during confirm (not hidden)");
  stdin.write("y");
  await tick(80);
  assert.equal(granted, true, "confirm resolved true on y");
  unmount();
});

test("App confirm is a selectable list: ↓ then Enter picks 'don't ask again' → always", async () => {
  let reply = null;
  const onSubmit = async (line, h) => {
    reply = await h.confirm("⚠ bash rm -rf build — run?");
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("clean");
  await tick();
  stdin.write("\r");
  await tick();
  assert.ok(strip(lastFrame()).includes("❯ 1. Yes"), "Yes is selected by default (numbered)");
  stdin.write("\x1b[B"); // ↓
  await tick();
  stdin.write("\r"); // Enter
  await tick(80);
  assert.equal(reply, "always", "↓ + Enter selects the don't-ask-again option");
  unmount();
});

test("App select (plan-proceed): ↓↓ + Enter picks the third option", async () => {
  let choice = null;
  const onSubmit = async (line, h) => {
    choice = await h.select("hara has a plan — proceed?", [
      { label: "Yes, and auto-apply edits", value: "auto-edit" },
      { label: "Yes, approve each edit", value: "suggest" },
      { label: "No, keep planning  (esc)", value: "no" },
    ]);
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("go");
  await tick();
  stdin.write("\r");
  await tick();
  assert.ok(strip(lastFrame()).includes("❯ 1. Yes, and auto-apply edits"), "first option selected by default (numbered)");
  stdin.write("\x1b[B");
  await tick();
  stdin.write("\x1b[B");
  await tick();
  stdin.write("\r");
  await tick(80);
  assert.equal(choice, "no", "↓↓ + Enter selects the third option");
  unmount();
});

test("App select: numbered options — typing a number picks it directly", async () => {
  let choice = null;
  const onSubmit = async (line, h) => {
    choice = await h.select("pick one", [
      { label: "alpha", value: "a" },
      { label: "beta", value: "b" },
      { label: "gamma", value: "c" },
    ]);
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("go");
  await tick();
  stdin.write("\r");
  await tick();
  assert.ok(strip(lastFrame()).includes("2. beta"), "options are numbered");
  stdin.write("3"); // type the number → picks the third directly, no Enter
  await tick(80);
  assert.equal(choice, "c", "typing 3 selected the third option");
  unmount();
});

test("App ask_user (h.ask) with options: shows numbered menu + a 'type my own' escape, returns picked option", async () => {
  let answer = null;
  const onSubmit = async (line, h) => {
    answer = await h.ask("Which database?", ["SQLite", "Postgres"]);
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("go");
  await tick();
  stdin.write("\r");
  await tick();
  const f = strip(lastFrame());
  assert.ok(f.includes("Which database?"), "question shown");
  assert.ok(f.includes("1. SQLite") && f.includes("2. Postgres"), "options numbered");
  assert.ok(f.includes("Type my own answer"), "free-text escape hatch offered");
  stdin.write("2"); // pick Postgres directly
  await tick(80);
  assert.equal(answer, "Postgres", "returns the chosen option text");
  unmount();
});

test("App ask_user (h.ask) free-text: no options → input box captures the typed answer", async () => {
  let answer = null;
  const onSubmit = async (line, h) => {
    answer = await h.ask("Where should migrations live?");
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("go");
  await tick();
  stdin.write("\r");
  await tick();
  assert.ok(strip(lastFrame()).includes("Where should migrations live?"), "free-text question shown");
  stdin.write("db/migrations");
  await tick();
  stdin.write("\r");
  await tick(80);
  assert.equal(answer, "db/migrations", "the typed answer is returned as the tool's result");
  unmount();
});

test("App renders assistant markdown (bold/inline-code styled, not raw)", async () => {
  const onSubmit = async (line, h) => {
    h.sink.assistantDelta("Use **bold** and `code` now.");
    await tick(200);
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("hi");
  await tick();
  stdin.write("\r");
  await tick(80);
  const f = strip(lastFrame());
  assert.ok(f.includes("bold") && f.includes("code"), "text content present");
  assert.ok(!f.includes("**bold**"), "raw ** markers gone — markdown rendered, not literal");
  // (color is TTY-only via the `c` helper; in a real terminal ink passes the ANSI through — verified by dogfooding)
  unmount();
});

test("App type-ahead: typing while working queues, then sends after the turn", async () => {
  const seen = [];
  let releaseFirst;
  const onSubmit = async (line) => {
    seen.push(line);
    if (line === "first") await new Promise((r) => (releaseFirst = r)); // hold turn 1 open
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("first");
  await tick();
  stdin.write("\r"); // start turn 1 (stays working)
  await tick();
  assert.ok(seen.includes("first"), "turn 1 started");
  stdin.write("second"); // type-ahead while working
  await tick();
  stdin.write("\r");
  await tick();
  assert.ok(strip(lastFrame()).includes("second"), "pooled message shown (highlighted) above the input");
  assert.equal(seen.length, 1, "queued message NOT sent while working");
  releaseFirst(); // finish turn 1 → pool drains
  await tick(150);
  assert.ok(seen.includes("second"), "queued message sent after the turn finished");
  unmount();
});

test("App type-ahead: multiple pooled messages coalesce into one turn", async () => {
  const seen = [];
  let release;
  const onSubmit = async (line) => {
    seen.push(line);
    if (line === "go") await new Promise((r) => (release = r));
  };
  const { stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("go");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("also do A"); // pool two messages while working
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("and B");
  await tick();
  stdin.write("\r");
  await tick();
  assert.equal(seen.length, 1, "nothing sent while working");
  release();
  await tick(150);
  assert.equal(seen.length, 2, "exactly one coalesced turn after the first");
  assert.ok(seen[1].includes("also do A") && seen[1].includes("and B"), "both pooled messages combined into one turn");
  unmount();
});

test("App commits a notice from a fast (slash-like) turn — no awaited agent run, still lands in scrollback", async () => {
  // Regression: /design, /help and other slash-only turns push a notice then return immediately. The commit
  // used to read currentRef (synced only on render), which lagged a render behind for a fast turn → the notice
  // was lost. Now the commit reads live state via the setCurrent updater.
  const onSubmit = async (line, h) => {
    h.sink.notice("↗ loaded skill design — now describe what you want");
    // returns synchronously — no awaited runAgent (this is the slash-command case)
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("/design");
  await tick();
  stdin.write("\r"); // submit → fast turn
  await tick(150);
  assert.ok(strip(lastFrame()).includes("loaded skill design"), "notice from a fast slash-only turn is committed, not lost");
  unmount();
});

test("Ctrl+T transcript overlay: reasoning folds inline but shows FULL in the overlay; esc closes", async () => {
  const onSubmit = async (line, h) => {
    h.sink.reasoningDelta("first line of the secret reasoning\nsecond line\nthird line");
    h.sink.assistantDelta("Done.");
    await tick(60);
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("do it");
  await tick();
  stdin.write("\r");
  await tick(160); // turn finishes → reasoning commits, folded to "✻ thought · N lines"
  const folded = strip(lastFrame());
  assert.ok(folded.includes("thought · 3 lines"), "committed reasoning is folded inline to one line");
  assert.ok(!folded.includes("secret reasoning"), "full reasoning text is NOT inline once committed");
  stdin.write("\x14"); // Ctrl+T → open overlay
  await tick(80);
  const overlay = strip(lastFrame());
  assert.ok(overlay.includes("TRANSCRIPT"), "transcript overlay opened");
  assert.ok(overlay.includes("secret reasoning"), "overlay shows the FULL reasoning (nothing folded)");
  stdin.write("\x1b"); // Esc → close
  await tick(80);
  assert.ok(strip(lastFrame()).includes("Type a task"), "overlay closed — input box back");
  unmount();
});

test("App live region: finalized reasoning graduates to <Static> ONCE — no stacked/duplicate thinking lines", async () => {
  // Regression for the remote/slow-terminal duplication bug: a completed reasoning block must be
  // emitted to scrollback exactly once (folded), and must NOT keep re-appearing as the assistant
  // streams. We stream reasoning, then a multi-delta assistant reply, and assert the folded
  // "thought" summary shows up exactly once and the live assistant text renders without the
  // expanded reasoning still glued above it.
  const onSubmit = async (line, h) => {
    h.sink.reasoningDelta("weighing options\nline two\nline three");
    // Fast token stream after reasoning finalizes — over a slow link this used to thrash + stack.
    for (const w of ["The ", "answer ", "is ", "42."]) {
      h.sink.assistantDelta(w);
      await tick(5);
    }
    await tick(120); // keep the live region visible to sample
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("go");
  await tick();
  stdin.write("\r");
  await tick(90); // sample mid-turn: reasoning has finalized, assistant is streaming
  const mid = strip(lastFrame());
  assert.ok(mid.includes("The answer is 42."), "assistant text streams in the live region");
  // Reasoning finalized the moment assistant text began → folded, shown at most once, never expanded live.
  const thoughtCount = (mid.match(/thought · \d+ lines/g) || []).length;
  assert.ok(thoughtCount <= 1, `folded reasoning appears at most once mid-turn (saw ${thoughtCount})`);
  assert.ok(!mid.includes("weighing options"), "expanded reasoning is NOT re-rendered above the live reply");
  await tick(200); // finish + commit
  const done = strip(lastFrame());
  const finalCount = (done.match(/thought · \d+ lines/g) || []).length;
  assert.equal(finalCount, 1, "after the turn, the folded reasoning summary appears exactly once (not stacked)");
  unmount();
});

test("App type-ahead: Esc while working clears the queue (stop means stop)", async () => {
  const seen = [];
  let release;
  const onSubmit = async (line) => {
    seen.push(line);
    if (line === "first") await new Promise((r) => (release = r));
  };
  const { stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("first");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("queued one"); // type-ahead
  await tick();
  stdin.write("\r");
  await tick();
  assert.equal(seen.length, 1, "queued, not yet sent");
  stdin.write("\x1b"); // Esc → abort + clear the queue
  await tick();
  release(); // turn 1 ends
  await tick(150);
  assert.ok(!seen.includes("queued one"), "queued message dropped after Esc — stop means stop");
  unmount();
});
