import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runGovernedAgent, type AgentRuntimeTurn, type RunOpts, type RunOutcome } from "../agent/loop.js";
import type { NeutralMsg, TurnResult } from "../providers/types.js";
import { createCodingHostBridge } from "../coding/host.js";
import { createHostBoundPiSession } from "./pi-session.js";

/** Pi is the bounded model-step engine; Hara is the shared task/tool governor. A step yields at the
 * assistant boundary BEFORE Pi may run tools. The governor then validates/approves/executes that exact
 * batch once and checkpoints the canonical Hara history. The next step uses that frozen host context.
 * This is not a second planner, imported terminal, ambient Pi account, or parallel transcript authority. */
export const piRuntimeTurn: AgentRuntimeTurn = async (provider, args) => {
  if (args.signal?.aborted) return { text: "", toolUses: [], stop: "error", errorMsg: "interrupted" };
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-pi-step-")));
  const yielded = new AbortController();
  const signal = args.signal ? AbortSignal.any([args.signal, yielded.signal]) : yielded.signal;
  const budget = { maxProviderRounds: 1, maxToolCalls: 1, maxTokens: 10_000_000, timeoutMs: 2 * 60 * 60_000 };
  let captured: TurnResult | undefined;
  let physical: Promise<TurnResult> | undefined;
  let operationError: unknown;
  let completed = false;
  let handle: Awaited<ReturnType<typeof createHostBoundPiSession>> | undefined;
  let bridge: Awaited<ReturnType<typeof createCodingHostBridge>> | undefined;
  try {
    bridge = await createCodingHostBridge({
      // Model/reasoning/media/cache/continuation selection belongs to the frozen Hara request. Pi's
      // nominal wire model and prompt cannot replace it or import another provider/account.
      provider: { id: provider.id, model: provider.model, async turn() {
        if (physical || signal.aborted) throw new Error("Pi model step is no longer current");
        physical = Promise.resolve().then(() => {
          if (signal.aborted) throw new Error("interrupted");
          return provider.turn(args);
        });
        try { captured = await physical; }
        catch (error) { operationError = error; throw error; }
        return { ...captured, toolUses: captured.toolUses.map((call) => ({ ...call, name: "hara_" + call.name })) };
      } },
      tools: args.tools, budget, signal,
      assertCurrent() { if (signal.aborted) throw new Error("Pi model step cancelled"); },
      executeTool: async () => { throw new Error("Pi tools must yield to the Hara task governor"); },
    });
    const tools: ToolDefinition[] = args.tools.map((tool) => ({
      name: "hara_" + tool.name, label: tool.name, description: tool.description,
      parameters: tool.input_schema as ToolDefinition["parameters"], executionMode: "sequential",
      async execute() { throw new Error("Pi tools must yield to the Hara task governor"); },
    }));
    handle = await createHostBoundPiSession({ home, subdirs: ["pi-step"], cwd: home, bridge, budget,
      manager: SessionManager.inMemory(home), tools, signal,
      system: "You are the Hara-owned Pi model-step engine. The host supplies the authoritative conversation and model. Yield at the assistant boundary; tools execute only through the host task governor.",
    });
    const unsubscribe = handle.session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        completed = event.message.stopReason !== "error" && event.message.stopReason !== "aborted";
        // Synchronous yield: no native Pi tool implementation or next model request can start.
        yielded.abort();
      }
    });
    try { await handle.session.prompt("Execute the single frozen host model step.", { expandPromptTemplates: false, source: "rpc" }); }
    finally { unsubscribe(); }
    if (args.signal?.aborted) return { text: "", toolUses: [], stop: "error", errorMsg: "interrupted" };
    if (operationError) throw operationError;
    // Preserve the original neutral result/opaque reasoning byte-for-byte. Malformed calls/errors
    // must reach the existing governor's refusal/recovery path, not become Pi-authored replacements.
    if (captured && (completed || captured.stop === "error" || captured.toolUses.length)) return captured;
    throw new Error("Pi model step did not complete; no fallback Runtime was started");
  } finally {
    yielded.abort();
    if (handle) {
      await handle.session.abort().catch(() => {});
      await handle.session.waitForIdle().catch(() => {});
      handle.dispose();
    }
    await bridge?.close().catch(() => {});
    // Keep the outer provider Promise alive until the physical request drains, including providers
    // that ignore cancellation. Serve must not release its lease merely because Pi stopped waiting.
    await physical?.catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
};

export function runPiAgent(history: NeutralMsg[], options: RunOpts): Promise<RunOutcome> {
  return runGovernedAgent(history, options, "pi", piRuntimeTurn);
}
