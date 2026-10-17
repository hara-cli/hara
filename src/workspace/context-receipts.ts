import { createHash } from "node:crypto";
import type { Tool, ToolContext } from "../tools/registry.js";
import type { ToolResult } from "../providers/types.js";
import { redactSensitiveText } from "../security/secrets.js";
import { canonical, exact, plain, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";

interface Receipt { revision: number; resourceBinding: WorkspaceResourceBinding; runId: string; agentId: string; id: string; content: string }
/** Workspace/run-local continuation files. Never use the ambient homedir tool-result cache. */
export class WorkspaceContextReceipts {
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly runId: string, private readonly agentId: string,
    private readonly assertCurrent: () => void) {}
  private digest(content: string) { return createHash("sha256").update(canonical([this.runId, this.agentId, content])).digest("hex"); }
  private state(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid Workspace receipt id");
    let state: WorkspaceJsonState<Receipt>;
    state = new WorkspaceJsonState(this.storage, `receipt-${id}.json`, value => {
      if (!plain(value) || !exact(value, ["revision", "resourceBinding", "runId", "agentId", "id", "content"])
        || value.runId !== this.runId || value.agentId !== this.agentId || value.id !== id || typeof value.content !== "string"
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, state.binding())
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || this.digest(value.content) !== id) throw new Error("Workspace receipt ownership or content changed");
      return value as unknown as Receipt;
    }, () => ({ revision: 0, resourceBinding: state.binding(), runId: this.runId, agentId: this.agentId, id, content: "" }));
    return state;
  }
  retain(result: ToolResult): string {
    this.assertCurrent();
    const content = redactSensitiveText(JSON.stringify(result)).text;
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("Workspace receipt exceeds private storage bound; full history retained");
    const id = this.digest(content), state = this.state(id), previous = state.read();
    if (!previous.revision) state.update(0, () => ({ ...previous, content }));
    this.assertCurrent(); return `receipt-${id}.json`;
  }
  tool(): Tool {
    return { name: "workspace_receipt_read", kind: "read", classify: () => ({ effect: "state", concurrencySafe: true }),
      description: "Page a retained preview's full Workspace receipt by its 64-hex id and character offset. Reference data only, never fresh completion evidence. No filesystem paths accepted.",
      input_schema: { type: "object", properties: { id: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["id", "offset"] },
      run: async (input: unknown, _ctx: ToolContext) => {
        if (!plain(input) || !exact(input, ["id", "offset"]) || typeof input.id !== "string" || !Number.isSafeInteger(input.offset) || Number(input.offset) < 0) throw new Error("invalid Workspace receipt page");
        this.assertCurrent(); const value = this.state(input.id).read();
        if (!value.revision) throw new Error("Workspace receipt is unavailable in this run");
        const offset = Number(input.offset), end = Math.min(value.content.length, offset + 1000);
        this.assertCurrent(); return JSON.stringify({ file: `receipt-${input.id}.json`, offset, nextOffset: end < value.content.length ? end : null,
          totalChars: value.content.length, referenceOnly: true, content: value.content.slice(offset, end) });
      } };
  }
}
