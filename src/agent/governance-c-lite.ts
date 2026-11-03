import { createHash } from "node:crypto";
import type { TaskBriefInput, TaskExecution } from "../session/task.js";
import type { ToolResult } from "../providers/types.js";

const CHANGE = /(?:请|帮我|把|将|please|can you|could you|let's)?\s*(?:创建|建立|新增|添加|写入|修改|编辑|删除|移除|重命名|发送|委派|安排|执行|部署|安装|更新|保存|同步|推送|合并|生成|设置|create|add|write|edit|change|delete|remove|rename|send|delegate|schedule|execute|deploy|install|update|save|sync|push|merge|generate|set up)/iu;
const QUESTION = /[?？]|^(?:\s*(?:list|show|read|describe|explain|what|who|which|how|tell me|find|search|列出|查看|读取|说明|解释|告诉我|查找|搜索|有哪些|是什么|谁是))/iu;
const MULTI_OUTCOME = /(?:并且|同时|另外|以及|之后还|然后再|和|and also|also|then|plus|[,，、;；])/iu;

/** Direct engine completion is limited to one stated outcome; richer tasks use explicit checks. */
export function simpleChangeObjective(objective: string): boolean {
  const text = objective.trim();
  return text.length > 0 && text.length <= 400 && CHANGE.test(text) && !MULTI_OUTCOME.test(text);
}

/** User wording supplies authority; the first model response supplies only a bounded execution hint. */
export function engineTaskBrief(task: TaskExecution, firstReply: { text: string; toolUses: readonly { name: string }[] }): TaskBriefInput {
  const objective = task.objective.trim();
  const intent = CHANGE.test(objective) ? "change" : QUESTION.test(objective) ? "answer" : "investigate";
  const firstTool = firstReply.toolUses.find(item => item.name !== "task_intake")?.name;
  return {
    intent,
    goal: objective.slice(0, 1000),
    constraints: [`Authorized scope: ${objective.slice(0, 800)}`, "Preserve unrelated user work and the Workspace safety boundary."],
    acceptance: [intent === "change" ? "The requested change has a verified operation receipt." : "The result is supported by observed evidence."],
    steps: [firstTool ? `Begin with ${firstTool}; verify the outcome.` : "Inspect the request and verify the outcome."],
  };
}

interface Observed { id: string; name: string; digest: string; value: Record<string, unknown> }
/** Only host-owned structured results can close a Workspace change. Model prose is never evidence. */
export class WorkspaceChangeTrace {
  private observations: Observed[] = [];
  private unsafe = false;

  observe(result: ToolResult, denied: boolean): void {
    if (denied || result.isError || result.content.startsWith("Error:")) { this.unsafe = true; return; }
    let value: unknown;
    try { value = JSON.parse(result.content); } catch { return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const receipt = record.receipt;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || (receipt as Record<string, unknown>).toolCallId !== result.id
      || (receipt as Record<string, unknown>).toolName !== result.name) { this.unsafe = true; return; }
    this.observations.push({ id: result.id, name: result.name,
      digest: createHash("sha256").update(result.content).digest("hex"), value: record });
  }

  evidence(): string[] | null {
    if (this.unsafe) return null;
    const writes = this.observations.filter(item => item.name === "workspace_write" && item.value.written === true
      && typeof item.value.path === "string" && typeof item.value.sha256 === "string");
    const verified = writes.filter(write => this.observations.some((item, index) => index > this.observations.indexOf(write)
      && item.name === "workspace_verify"
      && item.value.verified === true && item.value.path === write.value.path && item.value.sha256 === write.value.sha256));
    const intrinsic = this.observations.filter(item =>
      (item.name === "agent_create" && item.value.created === true && item.value.humanConfirmed === true)
      || (item.name === "agent_rename" && item.value.renamed === true)
      || (item.name === "agent_contact" && item.value.completed === true
        && typeof item.value.completion === "object" && item.value.completion !== null
        && (item.value.completion as Record<string, unknown>).state === "verified"));
    const actions = [...verified, ...intrinsic];
    // A simple one-outcome objective cannot silently close after a second unverified mutation.
    if (actions.length !== 1 || writes.length !== verified.length || intrinsic.length + writes.length !== 1) return null;
    return actions.map(item => `${item.name} toolCallId=${item.id} resultSummarySha256=${item.digest} verify=passed`);
  }
}
