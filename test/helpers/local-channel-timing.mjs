// Bounded, test-only observations. Forward every filesystem operation unchanged: no cached
// authority result, shortened fixture, different deadline, path or user text in diagnostics.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { WorkspaceAgentStore } from "../../dist/workspace/agents.js";
import { AgentRuntimeRegistry } from "../../dist/agent-runtime/registry.js";

export function localChannelTiming() {
  const counts = { lstatSync: 0, openSync: 0, fsyncSync: 0 }, restore = [];
  for (const name of Object.keys(counts)) {
    const original = fs[name], wrapped = (...args) => { counts[name]++; return original(...args); };
    fs[name] = wrapped; restore.push(() => { fs[name] = original; });
  }
  syncBuiltinESMExports();
  const calls = { agentLists: 0, runtimeOptions: 0 };
  for (const [prototype, name, key] of [[WorkspaceAgentStore.prototype, "list", "agentLists"], [AgentRuntimeRegistry.prototype, "options", "runtimeOptions"]]) {
    const original = prototype[name];
    prototype[name] = function (...args) { calls[key]++; return original.apply(this, args); };
    restore.push(() => { prototype[name] = original; });
  }
  const epoch = performance.now();
  let lines = 0;
  const emit = (phase, extra = {}) => {
    if (lines++ < 96) process.stderr.write(`local-channel-timing ${JSON.stringify({ phase, atMs: Math.round(performance.now() - epoch), ...extra, fs: { ...counts }, calls: { ...calls } })}\n`);
  };
  const begin = (phase, extra = {}) => {
    const started = performance.now(); emit(phase, { event: "start", ...extra });
    return () => emit(phase, { event: "end", ...extra, ms: Math.round(performance.now() - started) });
  };
  return {
    begin, emit,
    sync(phase, operation) { const end = begin(phase); try { return operation(); } finally { end(); } },
    async async(phase, operation) { const end = begin(phase); try { return await operation(); } finally { end(); } },
    observe(fixture) {
      const host = fixture.host, rooms = host.localChannels(fixture.id), runs = new Map();
      const start = host.start, wait = host.wait, changeReply = rooms.changeReply, context = rooms.context;
      host.start = function (...args) {
        const member = fixture.members.indexOf(args[2]) + 1, end = begin("colleague", { member });
        try { const result = start.apply(this, args); runs.set(result.runId, end); return result; }
        catch (error) { end(); throw error; }
      };
      host.wait = function (runId) {
        return wait.call(this, runId).finally(() => { const end = runs.get(runId); if (end) { runs.delete(runId); end(); } });
      };
      rooms.changeReply = function (...args) {
        const started = performance.now();
        try { return changeReply.apply(this, args); }
        finally { emit("reply-commit", { member: args[2] + 1, ms: Math.round(performance.now() - started) }); }
      };
      rooms.context = function (...args) {
        const started = performance.now();
        try { return context.apply(this, args); }
        finally { emit("prepare-context", { ms: Math.round(performance.now() - started) }); }
      };
      restore.push(() => { host.start = start; host.wait = wait; rooms.changeReply = changeReply; rooms.context = context; });
    },
    close() { for (const undo of restore.reverse()) undo(); syncBuiltinESMExports(); },
  };
}
