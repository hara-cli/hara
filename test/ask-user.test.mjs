import { test } from "node:test";
import assert from "node:assert/strict";
import "../dist/tools/ask_user.js"; // self-registers ask_user (run `npm run build` first)
import { getTool, getTools } from "../dist/tools/registry.js";
import { NO_INTERACTIVE_USER } from "../dist/tools/ask_user.js";

const ask_user = () => getTool("ask_user");

test("ask_user is registered as a read-kind tool the model can see", () => {
  const t = ask_user();
  assert.ok(t, "ask_user is registered");
  assert.equal(t.kind, "read", "ask_user never triggers the approval gate");
  assert.ok(getTools().some((x) => x.name === "ask_user"), "ask_user is in the tool set");
  assert.ok(t.input_schema.required.includes("question"), "question is required");
});

test("ask_user: headless / non-TTY (no ctx.ask) returns a safe note and does NOT hang", async () => {
  const t = ask_user();
  const res = await t.run({ question: "Which database?" }, { cwd: process.cwd() }); // ctx.ask absent
  assert.equal(res, NO_INTERACTIVE_USER);
});

test("ask_user: routes the question (with options) through ctx.ask and returns the chosen option", async () => {
  const t = ask_user();
  let seenQ = null;
  let seenOpts = null;
  const ctx = {
    cwd: process.cwd(),
    ask: async (q, opts) => {
      seenQ = q;
      seenOpts = opts;
      return "Postgres"; // user picked an option
    },
  };
  const res = await t.run({ question: "Which database?", options: ["SQLite", "Postgres"], header: "DB" }, ctx);
  assert.equal(res, "Postgres", "returns the chosen option text");
  assert.match(seenQ, /Which database\?/, "question reaches ctx.ask");
  assert.match(seenQ, /\[DB\]/, "header is prepended");
  assert.deepEqual(seenOpts, ["SQLite", "Postgres"], "options pass through");
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

test("ask_user: a failing ctx.ask degrades gracefully (no throw)", async () => {
  const t = ask_user();
  const ctx = {
    cwd: process.cwd(),
    ask: async () => {
      throw new Error("boom");
    },
  };
  const res = await t.run({ question: "anything?" }, ctx);
  assert.match(res, /best judgment/);
  assert.match(res, /boom/);
});
