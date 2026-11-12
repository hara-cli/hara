// An independent real process exits at the original durable/adapter/effect boundary.
import fs from "node:fs";
import { join } from "node:path";
import { routingFixture } from "./agent-routing-fixture.mjs";
import { WorkspaceAgentRouting } from "../../dist/workspace/agent-routing.js";
const f = routingFixture({ after() {} }), mode = process.argv[2], classification = mode.startsWith("classification");
const data = f.input(classification ? "unmatched authorized work" : "invoice status");
process.send({ ready: true, home: f.home, project: f.project, workspaceId: f.row.scope.workspaceId, agentId: f.agent.agentId,
  credential: f.credential, members: f.members.map(agent => agent.agentId), data });
process.once("message", async value => {
  if (value !== "go") process.exit(2);
  try {
    if (classification) {
      const classifier = { providerRef: "synthetic-origin-v1", budgetRef: "routing-fixture", timeoutMs: 10000, maxInputBytes: 8192, maxOutputTokens: 64,
        async invoke() {
          fs.appendFileSync(join(f.project, "classification-submissions.txt"), "one\n", { mode: 0o600 });
          if (mode === "classificationSubmitted") process.exit(0);
          return { text: JSON.stringify({ candidateId: f.agent.agentId }), toolUses: [], providerRequestRef: "original-provider-request" };
        } };
      const router = new WorkspaceAgentRouting({ ...f.options, classifier });
      if (mode === "classificationJournal") f.authority.consumeRoutingPermit = () => process.exit(0);
      if (mode === "classificationPublication") f.authority.observeRoutingClassification = () => process.exit(0);
      await router.classify(f.transport, data); process.exit(3);
    }
    f.router.select(f.transport, data);
    if (mode === "selected") process.exit(0);
    const d = f.prepare(data); d.accept();
    if (mode === "accepted") process.exit(0);
    if (mode === "issued") { f.control.executionGrant(d.binding.runId); process.exit(0); }
    if (mode === "unknown") {
      const runtime = d.runtime();
      try { await runtime.call("workspace_write", { path: "one-effect.txt", content: "once" }, "original-unknown-effect", async frozen => {
        await runtime.files.find(tool => tool.name === "workspace_write").run(frozen, { cwd: f.project }); throw new Error("original result lost");
      }); } catch (error) { if (error.message !== "original result lost") throw error; }
      process.exit(0);
    }
    process.exit(4);
  } catch (error) { process.stderr.write(String(error.stack)); process.exit(5); }
});
