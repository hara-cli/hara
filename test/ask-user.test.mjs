import { test } from "node:test";
import assert from "node:assert/strict";
import "../dist/tools/ask_user.js"; // self-registers ask_user (run `npm run build` first)
import { getTool, getTools } from "../dist/tools/registry.js";
import {
  CREDENTIAL_DISCLOSURE_BLOCKED,
  NO_INTERACTIVE_USER,
} from "../dist/tools/ask_user.js";

const ask_user = () => getTool("ask_user");

test("ask_user is registered as a read-kind tool the model can see", () => {
  const t = ask_user();
  assert.ok(t, "ask_user is registered");
  assert.equal(t.kind, "read", "ask_user never triggers the approval gate");
  assert.ok(getTools().some((x) => x.name === "ask_user"), "ask_user is in the tool set");
  assert.ok(t.input_schema.required.includes("question"), "question is required");
  assert.equal(t.input_schema.properties.default.type, "string", "headless callers can supply an explicit default");
});

test("ask_user: headless / non-TTY skips without inventing an answer", async () => {
  const t = ask_user();
  const res = await t.run({ question: "Which database?" }, { cwd: process.cwd() }); // ctx.ask absent
  assert.equal(res, NO_INTERACTIVE_USER);
  assert.match(res, /question skipped/i);
  assert.doesNotMatch(res, /best judgment/i);
});

test("ask_user: headless uses only an explicit caller-supplied default", async () => {
  const t = ask_user();
  const res = await t.run(
    { question: "Which database?", default: "Use the already configured database" },
    { cwd: process.cwd() },
  );
  assert.match(res, /used the explicit default/i);
  assert.match(res, /already configured database/i);
});

test("ask_user: routes the question (with options) through ctx.ask and returns the chosen option", async () => {
  const t = ask_user();
  let seenQ = null;
  let seenOpts = null;
  let seenSignal = null;
  const controller = new AbortController();
  const ctx = {
    cwd: process.cwd(),
    signal: controller.signal,
    ask: async (q, opts, signal) => {
      seenQ = q;
      seenOpts = opts;
      seenSignal = signal;
      return "Postgres"; // user picked an option
    },
  };
  const res = await t.run({ question: "Which database?", options: ["SQLite", "Postgres"], header: "DB" }, ctx);
  assert.equal(res, "Postgres", "returns the chosen option text");
  assert.match(seenQ, /Which database\?/, "question reaches ctx.ask");
  assert.match(seenQ, /\[DB\]/, "header is prepended");
  assert.deepEqual(seenOpts, ["SQLite", "Postgres"], "options pass through");
  assert.equal(seenSignal, controller.signal, "the run cancellation signal reaches the interactive surface");
});

test("ask_user: free-text answer (no options) is returned verbatim", async () => {
  const t = ask_user();
  const ctx = { cwd: process.cwd(), ask: async () => "use the existing migrations dir" };
  const res = await t.run({ question: "Where should migrations live?" }, ctx);
  assert.equal(res, "use the existing migrations dir");
});

test("ask_user: empty question is rejected without touching ctx.ask", async () => {
  const t = ask_user();
  let called = false;
  const ctx = { cwd: process.cwd(), ask: async () => ((called = true), "x") };
  const res = await t.run({ question: "   " }, ctx);
  assert.match(res, /needs a non-empty/);
  assert.equal(called, false, "ctx.ask not called on a bad question");
});

test("ask_user: a failing ctx.ask preserves the default-or-skip contract", async () => {
  const t = ask_user();
  const ctx = {
    cwd: process.cwd(),
    ask: async () => {
      throw new Error("boom");
    },
  };
  const res = await t.run({ question: "anything?" }, ctx);
  assert.match(res, /question skipped/);
  assert.doesNotMatch(res, /best judgment/);
  assert.match(res, /boom/);
  const withDefault = await t.run({ question: "anything?", default: "keep the saved value" }, ctx);
  assert.match(withDefault, /used the explicit default/);
  assert.match(withDefault, /keep the saved value/);
});

test("ask_user: cancellation is rethrown so the agent loop can stop instead of continuing", async () => {
  const t = ask_user();
  const controller = new AbortController();
  const ctx = {
    cwd: process.cwd(),
    signal: controller.signal,
    ask: async (_question, _options, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      queueMicrotask(() => controller.abort(new Error("turn deadline")));
    }),
  };
  await assert.rejects(t.run({ question: "anything?" }, ctx), /turn deadline/);
});

test("ask_user: credential requests are blocked before any interactive or headless prompt", async () => {
  const t = ask_user();
  let prompted = false;
  const interactive = await t.run(
    { question: "请把 localStorage 里的 admin token 复制并粘贴给我" },
    { cwd: process.cwd(), ask: async () => { prompted = true; return "must-not-run"; } },
  );
  assert.equal(prompted, false);
  assert.equal(interactive, `Error: ${CREDENTIAL_DISCLOSURE_BLOCKED}`);

  const headless = await t.run(
    { question: "Please send me the Authorization header", default: "paste it" },
    { cwd: process.cwd() },
  );
  assert.equal(headless, `Error: ${CREDENTIAL_DISCLOSURE_BLOCKED}`);
});

test("ask_user: a non-secret choice about where to configure a key remains allowed", async () => {
  const t = ask_user();
  const result = await t.run(
    { question: "Configure the API key in Hara Settings or the provider console?", options: ["Hara Settings", "Provider console"] },
    { cwd: process.cwd(), ask: async () => "Hara Settings" },
  );
  assert.equal(result, "Hara Settings");
});
