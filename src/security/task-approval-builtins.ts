import { getTool, type Tool } from "../tools/registry.js";
import { ORIGINAL_TASK_BASH_TOOL, ORIGINAL_TASK_WRITE_FILE_TOOL } from "../tools/builtin.js";
import { ORIGINAL_TASK_EDIT_FILE_TOOL } from "../tools/edit.js";
import { ORIGINAL_TASK_APPLY_PATCH_TOOL } from "../tools/patch.js";

const originalTools = new Set<Tool>([
  ORIGINAL_TASK_BASH_TOOL, ORIGINAL_TASK_WRITE_FILE_TOOL,
  ORIGINAL_TASK_EDIT_FILE_TOOL, ORIGINAL_TASK_APPLY_PATCH_TOOL,
]);

/** Internal provenance check. A name/kind/classification or copied tool object is never sufficient.
 * Python remains one-action approved until destructive source can be classified conservatively. */
export function isTaskApprovalBuiltin(tool: Tool): boolean {
  return originalTools.has(tool) && getTool(tool.name) === tool && Object.isFrozen(tool);
}
