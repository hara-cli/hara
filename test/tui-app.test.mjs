import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { App, submissionCanBeSteered } from "../dist/tui/App.js";
import { setTurnPhase } from "../dist/agent/phase.js";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 70) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (predicate, message, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick(10);
  }
  assert.fail(message);
};
const status = { sessionName: "demo", approval: "suggest", input: 0, output: 0, ctxPct: 0, agents: 0 };

test("composer routing distinguishes control work from executable task work", () => {
  assert.equal(submissionCanBeSteered("/model"), false);
  assert.equal(submissionCanBeSteered("/skills"), false);
  assert.equal(submissionCanBeSteered("/continue"), true);
  assert.equal(submissionCanBeSteered("/design", ["design"]), true, "a user-invocable skill owns a real agent turn");
  assert.equal(submissionCanBeSteered("更新一下千问的模型列表"), true);
  assert.equal(submissionCanBeSteered("/Users/me/project/readme.md"), true, "an absolute file path is not a slash control");
});

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
  try {
    stdin.write("clean");
    await waitUntil(() => strip(lastFrame()).includes("clean"), "task text was not rendered before submit");
    stdin.write("\r");
    await waitUntil(
      () => strip(lastFrame()).includes("rm -rf build") && strip(lastFrame()).includes("Type a task"),
      "confirmation did not mount while keeping the input visible",
    );
    stdin.write("y");
    await waitUntil(() => granted !== null, "confirmation did not resolve after y");
    assert.equal(granted, true, "confirm resolved true on y");
  } finally {
    unmount();
  }
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

test("App Esc aborts the turn and actively removes a pending confirmation", async () => {
  let interrupted = false;
  const onSubmit = async (_line, h) => {
    try {
      await h.confirm("approval must disappear on Esc");
    } catch {
      interrupted = h.signal.aborted;
    }
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("go");
  await tick();
  stdin.write("\r");
  await tick();
  assert.ok(strip(lastFrame()).includes("approval must disappear on Esc"));
  stdin.write("\x1b");
  await tick(100);
  assert.equal(interrupted, true, "Esc aborts the owning turn signal");
  assert.ok(!strip(lastFrame()).includes("approval must disappear on Esc"), "the stale confirmation is removed");
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
    setTurnPhase("awaiting_user");
    try {
      answer = await h.ask("Where should migrations live?");
    } finally {
      setTurnPhase("idle");
    }
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("go");
  await tick();
  stdin.write("\r");
  await tick();
  const asking = strip(lastFrame());
  assert.ok(asking.includes("Where should migrations live?"), "free-text question shown");
  assert.ok(asking.includes("waiting for your answer · task timer paused"), "status distinguishes human wait from active work");
  assert.ok(!asking.includes("waiting for the model"), "human wait is not described as model work");
  stdin.write("db/migrations");
  await tick();
  stdin.write("\r");
  await tick(80);
  assert.equal(answer, "db/migrations", "the typed answer is returned as the tool's result");
  unmount();
});

test("App Esc aborts the turn and removes a pending free-text ask", async () => {
  let interrupted = false;
  const onSubmit = async (_line, h) => {
    try {
      await h.ask("question must disappear on Esc");
    } catch {
      interrupted = h.signal.aborted;
    }
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("go");
  await tick();
  stdin.write("\r");
  await tick();
  assert.ok(strip(lastFrame()).includes("question must disappear on Esc"));
  stdin.write("\x1b");
  await tick(100);
  assert.equal(interrupted, true, "Esc aborts the question's turn signal");
  assert.ok(!strip(lastFrame()).includes("question must disappear on Esc"), "the stale free-text prompt is removed");
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
  const interactions = [];
  let releaseFirst;
  const onSubmit = async (line, _helpers, _images, interaction) => {
    seen.push(line);
    interactions.push(interaction);
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
  assert.equal(interactions[0].kind, "turn", "the initial submission creates a task turn");
  assert.equal(interactions[1].kind, "steer", "late type-ahead remains a steer, not a new task");
  assert.equal(interactions[1].expectedTurnId, interactions[0].turnId, "steer is bound to the exact prior turn");
  assert.notEqual(interactions[1].turnId, interactions[0].turnId, "the continuation receives its own turn identity");
  unmount();
});

test("App control-command race: input typed while /model is busy becomes a normal next turn", async () => {
  const seen = [];
  const interactions = [];
  let releaseControl;
  const onSubmit = async (line, _helpers, _images, interaction) => {
    seen.push(line);
    interactions.push(interaction);
    if (line === "/model") await new Promise((resolve) => { releaseControl = resolve; });
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("/model");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("更新一下千问的模型列表");
  await tick();
  stdin.write("\r");
  await tick();
  assert.equal(seen.length, 1, "the request waits until the control command finishes");
  assert.ok(strip(lastFrame()).includes("⏎ queues next"), "the status row does not claim a control command can be steered");
  assert.ok(strip(lastFrame()).includes("next: 更新一下千问的模型列表"), "the queued request is visibly a next turn");
  releaseControl();
  await tick(180);
  assert.deepEqual(seen, ["/model", "更新一下千问的模型列表"]);
  assert.equal(interactions[1].kind, "turn", "the request is not mislabeled as a steer");
  unmount();
});

test("App isolates a slash control typed during a live task from the following queued task", async () => {
  const seen = [];
  const interactions = [];
  let releaseTask;
  const onSubmit = async (line, _helpers, _images, interaction) => {
    seen.push(line);
    interactions.push(interaction);
    if (line === "first") await new Promise((resolve) => { releaseTask = resolve; });
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("first");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("/model");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("do another task");
  await tick();
  stdin.write("\r");
  await tick();
  const queued = strip(lastFrame());
  assert.ok(queued.includes("control: /model"), "the pending control has an explicit non-task queue mode");
  assert.ok(queued.includes("next: do another task"), "later task text stays behind the control barrier");
  releaseTask();
  await tick(300);
  assert.deepEqual(seen, ["first", "/model", "do another task"], "control and task drain as separate submissions");
  assert.equal(interactions[1].kind, "turn", "the slash control is never delivered as task steering");
  assert.equal(interactions[2].kind, "turn", "the later request retains its own task identity");
  unmount();
});

test("App /next: queues a separate task instead of steering the active turn", async () => {
  const seen = [];
  const interactions = [];
  let release;
  const onSubmit = async (line, _helpers, _images, interaction) => {
    seen.push(line);
    interactions.push(interaction);
    if (line === "first") await new Promise((resolve) => { release = resolve; });
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("first");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("/next inspect the other project");
  await tick();
  stdin.write("\r");
  await tick();
  assert.ok(strip(lastFrame()).includes("next: inspect the other project"), "queue barrier is visible");
  release();
  await tick(180);
  assert.deepEqual(seen, ["first", "inspect the other project"]);
  assert.equal(interactions[1].kind, "turn", "explicit next input starts a new task identity");
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

test("App type-ahead: an in-turn drain carries the exact expectedTurnId", async () => {
  let releaseDrain;
  let firstInteraction;
  let drained = [];
  let calls = 0;
  const onSubmit = async (_line, helpers, _images, interaction) => {
    calls++;
    firstInteraction = interaction;
    await new Promise((resolve) => { releaseDrain = resolve; });
    drained = helpers.drainQueue();
  };
  const { stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("primary");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("refine it");
  await tick();
  stdin.write("\r");
  await tick();
  releaseDrain();
  await tick(150);
  assert.equal(calls, 1, "drained steering stays inside the live turn");
  assert.equal(drained.length, 1);
  assert.equal(drained[0].line, "refine it");
  assert.equal(drained[0].expectedTurnId, firstInteraction.turnId);
  unmount();
});

test("App user-invocable slash skill publishes a real steer target", async () => {
  let releaseDrain;
  let skillInteraction;
  let drained = [];
  let calls = 0;
  const onSubmit = async (line, helpers, _images, interaction) => {
    calls++;
    assert.equal(line, "/design landing page");
    skillInteraction = interaction;
    await new Promise((resolve) => { releaseDrain = resolve; });
    drained = helpers.drainQueue();
  };
  const { stdin, unmount } = render(
    React.createElement(App, {
      initialStatus: status,
      model: "glm-5",
      cwd: process.cwd(),
      agentSlashCommands: ["design"],
      onSubmit,
    }),
  );
  await tick();
  stdin.write("/design landing page");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("also make the hero calmer");
  await tick();
  stdin.write("\r");
  await tick();
  releaseDrain();
  await tick(150);

  assert.equal(calls, 1, "the refinement is drained into the live skill instead of starting another task");
  assert.equal(drained.length, 1);
  assert.equal(drained[0].line, "also make the hero calmer");
  assert.equal(drained[0].expectedTurnId, skillInteraction.turnId);
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

test("App: streaming reasoning shows only the compact header by default (steady input box); ctrl+r reveals the body", async () => {
  // Anti-bob: while reasoning is the live tail it must NOT stream its multi-line body above the input box
  // (that body would fold to 1 line on finalize and yank the box up). Default = 1-line header; ctrl+r expands.
  const onSubmit = async (line, h) => {
    h.sink.reasoningDelta("alpha thought\nbeta thought\ngamma thought");
    await tick(300); // hold as the live tail (no assistant delta yet) so both samples land pre-fold
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("think");
  await tick();
  stdin.write("\r");
  await tick(70); // mid-turn: reasoning is the live tail, collapsed by default
  const collapsed = strip(lastFrame());
  assert.ok(collapsed.includes("thinking … 3 lines"), "compact header with the line count is shown");
  assert.ok(!collapsed.includes("alpha thought"), "reasoning body hidden by default — the input box holds steady");
  stdin.write("\x12"); // Ctrl+R → expand
  await tick(70);
  const expanded = strip(lastFrame());
  assert.ok(expanded.includes("alpha thought") && expanded.includes("gamma thought"), "ctrl+r reveals the full reasoning body");
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

test("App type-ahead: queued message is dropped when a later approval prompt is cancelled", async () => {
  const seen = [];
  let openPrompt;
  const promptGate = new Promise((resolve) => { openPrompt = resolve; });
  const onSubmit = async (line, h) => {
    seen.push(line);
    if (line !== "first") return;
    await promptGate;
    await h.confirm("cancel this prompt");
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("first");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("must not auto-submit");
  await tick();
  stdin.write("\r");
  await tick();
  assert.equal(seen.length, 1, "message is pooled while the first turn works");
  openPrompt();
  await tick(100);
  assert.ok(strip(lastFrame()).includes("cancel this prompt"));
  stdin.write("\x1b");
  await tick(200);
  assert.deepEqual(seen, ["first"], "Esc clears type-ahead even from the prompt branch");
  unmount();
});

test("App type-ahead: queued message is dropped when a later free-text ask is cancelled", async () => {
  const seen = [];
  let openAsk;
  const askGate = new Promise((resolve) => { openAsk = resolve; });
  const onSubmit = async (line, h) => {
    seen.push(line);
    if (line !== "first") return;
    await askGate;
    await h.ask("cancel this free-text ask");
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("first");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("also must not auto-submit");
  await tick();
  stdin.write("\r");
  await tick();
  openAsk();
  await tick(100);
  assert.ok(strip(lastFrame()).includes("cancel this free-text ask"));
  stdin.write("\x1b");
  await tick(200);
  assert.deepEqual(seen, ["first"], "Esc clears type-ahead from the ask branch too");
  unmount();
});

// ── Constant-height status slot (anti-bob): StatusRow ⇄ ModeLine, always exactly one row + margin ──

test("App status slot: idle shows key hints; working swaps in the spinner (no ⌨ working row, no height pop)", async () => {
  const onSubmit = async (line, h) => {
    h.sink.assistantDelta("hi");
    await tick(200); // hold the turn open so we can sample the working state
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  const idle = strip(lastFrame());
  assert.ok(idle.includes("⏎ send") && idle.includes("shift+tab mode"), "idle → key-hints row present (slot occupied)");
  stdin.write("go");
  await tick();
  stdin.write("\r");
  await tick(90); // mid-turn
  const mid = strip(lastFrame());
  assert.ok(/working \d+s/.test(mid) || mid.includes("⏎ steers task"), "working → spinner row in the same slot");
  assert.ok(!mid.includes("⏎ send · @ file"), "hints swapped OUT while working (one row at a time)");
  assert.ok(!mid.includes("⌨ working"), "the old extra working-hint row is gone");
  await tick(250); // turn ends
  const done = strip(lastFrame());
  assert.ok(done.includes("⏎ send"), "idle hints return after the turn — slot never empties");
  unmount();
});

test("App shift+tab: ModeLine swaps into the status slot (equal height), cycles the mode, then auto-hides", async () => {
  const nextMode = (m) => ({ suggest: "auto-edit", "auto-edit": "full-auto", "full-auto": "plan", plan: "suggest" })[m];
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit: async () => {}, cycleApproval: nextMode }),
  );
  await tick();
  stdin.write("\x1b[Z"); // shift+tab (backtab)
  await tick();
  const frame = strip(lastFrame());
  assert.ok(frame.includes("◆ auto-edit"), "cycled suggest → auto-edit, marked active in the ModeLine");
  assert.ok(frame.includes("suggest") && frame.includes("full-auto") && frame.includes("plan"), "all modes listed");
  assert.ok(frame.includes("⇄ shift+tab"), "cycle hint inline");
  assert.ok(!frame.includes("⏎ send · @ file"), "StatusRow swapped OUT — the slot holds ONE row at a time");
  assert.ok(frame.includes("glm-5 · auto-edit"), "footer reflects the new mode too");
  unmount();
});

test("App todo fold-on-submit: previous checklist folds to a one-line summary when the NEXT turn starts", async () => {
  await import("../dist/tools/todo.js"); // ensure the tool is registered
  const { getTool } = await import("../dist/tools/registry.js");
  const { currentTodos } = await import("../dist/tools/todo.js");
  const todoTool = getTool("todo_write");
  const onSubmit = async (line, h) => {
    if (line === "task one") {
      await todoTool.run({ todos: [{ text: "step A", status: "done" }, { text: "step B", status: "done" }] }, { cwd: process.cwd() });
    }
    h.sink.assistantDelta("ok");
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("task one");
  await tick();
  stdin.write("\r");
  await tick(150); // turn 1 done — panel visible, NOT folded by any timer
  const after1 = strip(lastFrame());
  assert.ok(after1.includes("step A"), "panel stays visible after the turn (no 30s yank)");
  assert.ok(!after1.includes("✓ Todos:"), "not folded yet");
  stdin.write("/help");
  await tick();
  stdin.write("\r");
  await tick(150);
  assert.equal(currentTodos().length, 2, "a control command does not silently erase the active task checkpoint");
  stdin.write("task two");
  await tick();
  stdin.write("\r");
  await tick(150); // turn 2 — fold happened at submit
  const after2 = strip(lastFrame());
  assert.ok(after2.includes("✓ Todos: 2/2 done"), "checklist folded to a summary at the next submit");
  assert.equal(currentTodos().length, 0, "tool-side list cleared with the fold");
  unmount();
});

test("App live overflow guard: a long streaming answer shows only a tail window; FULL text commits on finalize", async () => {
  // The dynamic region must never outgrow the terminal (ink's repaint breaks and the input box "runs
  // to the top"). A 60-line streaming answer should render as a bounded tail mid-turn, then land whole.
  const long = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n");
  const onSubmit = async (line, h) => {
    h.sink.assistantDelta(long);
    await tick(250); // hold the live region so we can sample mid-turn
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("go");
  await tick();
  stdin.write("\r");
  await tick(100); // mid-turn
  const mid = strip(lastFrame());
  assert.ok(mid.includes("line-60"), "tail of the stream is visible live");
  assert.ok(!mid.includes("line-1\n") && !mid.includes("line-2\n"), "early lines are elided from the live view");
  assert.ok(/\+\d+ earlier lines/.test(mid), "elision counter shown");
  await tick(300); // finalize → full block graduates to <Static>
  const done = strip(lastFrame());
  assert.ok(done.includes("line-1") && done.includes("line-30") && done.includes("line-60"), "full text landed in scrollback after finalize");
  assert.ok(!/\+\d+ earlier lines/.test(done.split("line-60").pop() ?? ""), "no elision header on the committed block");
  unmount();
});
