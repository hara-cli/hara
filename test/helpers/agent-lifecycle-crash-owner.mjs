// Test-only independent process. Genuine preparation/runtime factories publish before a real exit.
import { lifecycleFixture } from "./agent-lifecycle-fixture.mjs";
import { closeWorkspaceRunPermit } from "../../dist/workspace/execution.js";
const f = lifecycleFixture({ after() {} }), d = f.dispatch("crash boundary"); d.accept();
const mode = process.argv[2];
process.send({ ready: true, home: f.home, project: f.project, workspaceId: f.row.scope.workspaceId, agentId: f.agent.agentId,
  credential: f.credential, runId: d.binding.runId, commandId: d.command.commandId });
process.once("message", async message => {
  if (message !== "go") process.exit(2);
  try {
    if (mode === "terminal") {
      d.lease.release = () => process.exit(0); // Synchronous cut after actual durable terminal, before original release.
      f.control.abortBeforeExecution(d.prepared);
    } else if (mode === "quiescence") {
      const runtime = d.runtime(); await runtime.call("workspace_write", { path: "once-before-crash.txt", content: "one" });
      d.lease.release = () => process.exit(0); // Real close publishes actual runtime proof first.
      await closeWorkspaceRunPermit(runtime.permit);
    } else if (mode === "issued") { f.control.executionGrant(d.binding.runId); process.exit(0); }
    else process.exit(3);
  } catch (error) { process.send({ error: { code: error.code, message: error.message } }, () => process.exit(4)); }
});
