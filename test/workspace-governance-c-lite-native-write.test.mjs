import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {engineTaskBrief} from "../dist/agent/governance-c-lite.js";
import {run,response,call} from "./helpers/governance-c-lite-fixture.mjs";
import { DEFAULT_TIER, FULL_TIER_SKIP, SEATBELT } from "./helpers/platform-tier.mjs";

test("a native write cannot hide behind a conversational answer", { skip: FULL_TIER_SKIP }, async () => {
  const { view, project } = await run("你好", [response("", [call("unexpected-write", "write", { path: "unexpected.txt", content: "observed native change" })]), response("你好，我是 Hara。")], "full-protected");
  assert.equal(fs.readFileSync(join(project, "unexpected.txt"), "utf8"), "observed native change");
  assert.notEqual(view.taskState, "completed"); assert.equal(view.completion, null);
});
