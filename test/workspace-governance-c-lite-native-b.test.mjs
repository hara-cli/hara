import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {engineTaskBrief} from "../dist/agent/governance-c-lite.js";
import {run,response,call} from "./helpers/governance-c-lite-fixture.mjs";

for(const question of ["请用中文简单介绍自己", "用中文回答：你是什么助手"])
 test("Chinese read-only question closes without a bookkeeping pause: "+question,async()=>{
  assert.equal(engineTaskBrief({objective:question},response("你好，我是 Hara。",[])).intent,"answer");
  const {rounds,view}=await run(question,[response("你好，我是 Hara，可以协助完成已授权的任务。")],"full-protected");
  assert.equal(view.permissionTier,"full-protected");assert.equal(rounds,1);assert.equal(view.taskState,"completed",JSON.stringify(view));
 });
