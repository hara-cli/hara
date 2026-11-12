// Explicit in-memory mutation verification; never imported by production or the normal test glob.
import { register } from "node:module";
const mutation = process.env.HARA_C13_TEST_MUTATION;
const substitutions = {
  bodyConflict: ["agent-routing.js", [[ 'if (old.inputDigest !== inputDigest)', 'if (false)' ]]],
  rejectionReceipt: ["local-host.js", [[ 'if (!current?.claim)', 'if (!current?.claim && !current?.receipt)' ]]],
  genuineClaimReadback: ["local-host.js", [[ 'if (!current?.claim)', 'if (true)' ]]],
  recoveryPhaseTerminal: ["agent-command-control.js", [[ '|| prior.execution.phase !== "aborted_before_execution" || !prior.execution.terminal', '' ]]],
  recoveryLease: ["agent-command-control.js", [[ '|| !prior.execution.leaseReleased', '' ]]],
  liveOwner: ["session-lease.js", [[ 'if (!(held.pid === process.pid && held.processInstance === PROCESS_INSTANCE) && !knownDead(held.pid))', 'if (false)' ]]],
  abortEarly: ["agent-command-control.js", [
    [ 'const runId = preparation.binding.runId;', 'const runId = preparation.binding.runId; this.abandoning.add(runId);' ],
    [ 'this.abandoning.add(runId);\n            const terminal', 'const terminal' ],
  ]],
  audienceAtEffect: ["agent-boundary-authority.js", [[ 'assertRoutingExecutionCurrent(state, command) {', 'assertRoutingExecutionCurrent(state, command) { return;' ]]],
};
if (!Object.hasOwn(substitutions, mutation ?? "")) throw new Error("Explicit C13 verification mutation required");
const [target, edits] = substitutions[mutation];
register("data:text/javascript," + encodeURIComponent(`
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith("/dist/workspace/" + ${JSON.stringify(target)})) return result;
  let source = Buffer.from(result.source).toString("utf8");
  for (const [before, after] of ${JSON.stringify(edits)}) {
    if (source.split(before).length !== 2) throw new Error("C13 mutation target missing or ambiguous");
    source = source.replace(before, after);
  }
  process.stderr.write("[C13_MUTATION_APPLIED:${mutation}]\\n");
  return { ...result, source };
}`), import.meta.url);
