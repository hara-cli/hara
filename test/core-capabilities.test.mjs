import assert from "node:assert/strict";
import test from "node:test";
import { coreDeferredToolsForHistory } from "../dist/agent/core-capabilities.js";
import "../dist/tools/all.js";
import { toolSpecs } from "../dist/tools/registry.js";

function history(text) {
  return [{ role: "user", content: text }];
}

test("ordinary coding turns do not preload long-tail product schemas", () => {
  const names = toolSpecs({ activatedDeferred: new Set() }).map((tool) => tool.name);
  for (const deferred of [
    "presentation",
    "inspect_image",
    "visual_preview",
    "open_directory",
    "task",
    "memory_write",
    "memory_forget",
    "skill_create",
  ]) {
    assert.equal(names.includes(deferred), false, `${deferred} should stay out of an unrelated provider request`);
  }
  assert.equal(names.includes("read_file"), true);
  assert.equal(names.includes("apply_patch"), true);
  assert.equal(names.includes("tool_search"), true);
});

test("explicit user intent activates the matching deferred schema on the first provider call", () => {
  assert.deepEqual(coreDeferredToolsForHistory(history("请做一份季度汇报 PPT")), ["presentation"]);
  assert.deepEqual(coreDeferredToolsForHistory(history("检查这张截图里的报错")), ["inspect_image"]);
  assert.deepEqual(coreDeferredToolsForHistory(history("把本地网页放到扩展屏预览")), ["visual_preview"]);
  assert.deepEqual(coreDeferredToolsForHistory(history("在访达中显示这个文件夹")), ["open_directory"]);
  assert.deepEqual(coreDeferredToolsForHistory(history("把它加入跨会话任务池")), ["task"]);
  assert.deepEqual(coreDeferredToolsForHistory(history("记住我偏好简短回复")), ["memory_write", "memory_forget"]);
  assert.deepEqual(coreDeferredToolsForHistory(history("把这套流程保存为技能")), ["skill_create"]);
});

test("unrelated chat does not activate any long-tail schema", () => {
  assert.deepEqual(coreDeferredToolsForHistory(history("你好，解释一下这段代码")), []);
});
