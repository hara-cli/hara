import { randomUUID } from "node:crypto";
import type { Provider, TurnArgs, ToolUse } from "../providers/types.js";
import type { WorkspaceAgentView } from "./agents.js";
import type { ScopedConnection, ScopedRunConnection } from "./scoped-connections.js";

export const SYNTHETIC_CONNECTION = Object.freeze({ label: "本機合成測試（不連外、不計費）", provider: "openai" as const,
  baseURL: "http://127.0.0.1:1/v1", apiKey: "hara-synthetic-local-only", defaultModel: "hara-synthetic-v1" });
/** Explicit Dev fixture, NOT an LLM and never a fallback for an unavailable real connection. */
export function createWorkspaceSyntheticProvider(connection: ScopedConnection, binding: ScopedRunConnection,
  context: { agent: WorkspaceAgentView; objective: string; colleagues: () => WorkspaceAgentView[] }): Provider {
  if (connection.provider !== SYNTHETIC_CONNECTION.provider || connection.apiKey !== SYNTHETIC_CONNECTION.apiKey
    || connection.baseURL !== SYNTHETIC_CONNECTION.baseURL || binding.model !== SYNTHETIC_CONNECTION.defaultModel) {
    throw new Error("本 Dev 僅允許明確的合成 Provider。真實模型/Key 調用尚未批准；沒有發出請求。");
  }
  const tool = (name: string, input: unknown): ToolUse => ({ id: `call_${randomUUID()}`, name, input });
  const response = (text: string, toolUses: ToolUse[] = []) => ({ text, toolUses, stop: toolUses.length ? "tool_use" as const : "end" as const,
    usage: { input: 100, output: 20 } });
  return { id: "openai", model: binding.model, trailingTurnContext: true, async turn(args: TurnArgs) {
    if (args.signal?.aborted) throw new Error("synthetic request cancelled");
    const reverseIndex = [...args.history].reverse().findIndex(message => message.role === "user" && !message.content.startsWith("<system-reminder>"));
    const start = reverseIndex < 0 ? 0 : args.history.length - reverseIndex - 1;
    const current = args.history.slice(Math.max(0, start));
    const calls = current.flatMap(message => message.role === "assistant" ? message.toolUses : []);
    const results = current.flatMap(message => message.role === "tool" ? message.results : []);
    const last = results.at(-1), objective = context.objective;
    const creation = context.agent.kind === "main" && /(?:建立|创建|新建|create|hire).*(?:同事|agent|colleague)|(?:同事|colleague).*(?:建立|创建|create)/i.test(objective);
    const delegation = context.agent.kind === "main" && /(?:委派|安排|交给|交給|delegate)/i.test(objective);
    const fileTask = /hello\.md|(?:生成|写|寫|create|write).*(?:文件|file)/i.test(objective);
    if (!creation && !delegation && !fileTask) return response("你好，我是 Hara。這是本機合成驗收模式，不會連接真實模型。可以請我「建立 Pi 同事 Coder」，再「委派 Coder 生成 hello.md 並驗證」。");
    if (!calls.some(call => call.name === "task_intake")) return response("", [tool("task_intake", { intent: "change", goal: objective.slice(0, 1500),
      constraints: ["僅本空間與已授權本機 fixture 項目；不連外、不發布、不調用真實模型"],
      acceptance: [creation ? "同事經使用者確認後建立" : delegation ? "同事任務有已驗證的完成回執" : "hello.md 內容與雜湊經工具驗證"], steps: ["執行", "驗證", "回覆結果"] })]);
    if (last?.isError || last?.content.startsWith("Error:")) return response("這一步未完成，已停止繼續嘗試；請查看執行詳情或重新確認。沒有宣稱成功。");
    if (creation && !calls.some(call => call.name === "agent_create")) return response("", [tool("agent_create", { username: "coder", displayName: "Coder", title: "Coding colleague", instructions: "在授權項目內完成文件工作並驗證，不連外。" })]);
    if (delegation && !calls.some(call => call.name === "agent_contact")) {
      const colleague = context.colleagues().find(agent => agent.kind === "colleague" && agent.state === "active");
      if (!colleague) return response("請先建立一位 Pi 同事，再委派任務。");
      return response("", [tool("agent_contact", { agentId: colleague.agentId, task: "生成 hello.md，內容為 hello workspace\\n（實際換行），並驗證。" })]);
    }
    if (!creation && !delegation) {
      if (!calls.some(call => call.name === "workspace_read")) return response("", [tool("workspace_read", { path: "hello.md" })]);
      const observed = results.find(result => result.name === "workspace_read");
      let alreadyCorrect = false;
      try { alreadyCorrect = JSON.parse(observed?.content ?? "{}").text === "hello workspace\n"; } catch { /* malformed result is not evidence */ }
      if (!alreadyCorrect && !calls.some(call => call.name === "workspace_write")) return response("", [tool("workspace_write", { path: "hello.md", content: "hello workspace\n" })]);
      if (!calls.some(call => call.name === "workspace_verify")) return response("", [tool("workspace_verify", { path: "hello.md", expectedContent: "hello workspace\n" })]);
    }
    const success = [...results].reverse().find(result => ["agent_create", "agent_contact", "workspace_verify"].includes(result.name) && !result.isError);
    if (!success) return response("尚無可驗證回執，沒有標記完成。");
    const answer = creation ? "Coder 已經加入這個 Workspace，預設使用內建 Pi。你可以直接聊天，或請我委派文件任務。"
      : delegation ? "Coder 已完成 hello.md 並核驗內容與雜湊。結果已回到主對話，可展開執行詳情。" : "hello.md 已寫入並完成內容與雜湊驗證。";
    return response("", [tool("task_checkpoint", { artifacts: fileTask && !delegation ? ["hello.md"] : [],
      completion: { state: "verified", checks: [{ acceptance_index: 0, evidence: "已收到本次工具執行的成功回執", tool_call_ids: [success.id] }], final_answer: answer } })]);
  } };
}
