import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {engineTaskBrief} from "../dist/agent/governance-c-lite.js";
import {run,response,call} from "./helpers/governance-c-lite-fixture.mjs";

for(const question of ["你好", "請用一句話介紹你自己。"])
 test("Chinese read-only question closes without a bookkeeping pause: "+question,async()=>{
  assert.equal(engineTaskBrief({objective:question},response("你好，我是 Hara。",[])).intent,"answer");
  const {rounds,view}=await run(question,[response("你好，我是 Hara，可以协助完成已授权的任务。")],"full-protected");
  assert.equal(view.permissionTier,"full-protected");assert.equal(rounds,1);assert.equal(view.taskState,"completed",JSON.stringify(view));
 });
