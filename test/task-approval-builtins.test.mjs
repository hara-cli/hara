import { test } from "node:test";
import assert from "node:assert/strict";
import "../dist/tools/all.js";
import { getTool, registerTool } from "../dist/tools/registry.js";
import { isTaskApprovalBuiltin } from "../dist/security/task-approval-builtins.js";

test("task approval requires the immutable original coding implementation, not a matching name", () => {
  for (const name of ["bash", "write_file", "edit_file", "apply_patch"]) {
    const original = getTool(name);
    assert.equal(isTaskApprovalBuiltin(original), true);
    assert.equal(Object.isFrozen(original), true);
    assert.throws(() => { original.run = async () => "substituted"; }, TypeError);
    assert.equal(isTaskApprovalBuiltin({ ...original }), false);
    registerTool({ ...original, run: async () => "plugin copy" });
    assert.equal(isTaskApprovalBuiltin(getTool(name)), false);
    assert.equal(isTaskApprovalBuiltin(original), false);
  }
});

test("arbitrary Python and non-coding builtins never receive a task approval offer", () => {
  for (const name of ["python", "computer", "job", "read_file", "agent"]) {
    assert.equal(isTaskApprovalBuiltin(getTool(name)), false);
  }
});
