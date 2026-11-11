// Explicit author verification only; never imported by production or the ordinary test glob.
import { register } from "node:module";
const mutation = process.env.HARA_C4_TEST_MUTATION;
const substitutions = {
  issuance: ["agent-command-control.js", 'row.phase = "issued";\n                row.issuanceRef = `issued_${randomUUID()}`;', 'row.phase = "prepared";\n                row.issuanceRef = null;'],
  quiescence: ["execution.js", "state.boundaryExecution.prepareQuiescence(state.quiescenceProof);", "/* removed publication before original release */"],
  terminalOrder: ["agent-command-control.js", 'const terminal = { proofRef: `never_${randomUUID()}`, issuerId: this.issuerId, reason, lease: { ...owner } };', 'const terminal = { proofRef: `never_${randomUUID()}`, issuerId: this.issuerId, reason, lease: { ...owner } }; preparation.lease.release();'],
  capabilityScope: ["agent-boundary-authority.js", "assertLifecycleCapabilityCurrent(state, command) {", "assertLifecycleCapabilityCurrent(state, command) { return;"],
  coldRead: ["agent-lifecycle-history.js", "verify(lifecycle) { return lifecycle.segments.map(row => this.read(lifecycle, row.segmentId)); }", "verify(lifecycle) { return []; }"],
  closedProof: ["agent-lifecycle-history.js", 'return Boolean(run && execution?.leaseReleased && (execution.terminal || execution.quiescence || execution.phase === "legacy_unknown" && run.state === "drained" && run.drainProofRef));', "return Boolean(run && execution);"],
  unknown: ["agent-command-state.js", 'old.effect === "unknown" && row.effect !== "unknown"', "false"],
  drainCasIsolation: ["agent-command-control.js", 'if (!this.authority.commandControlSourceHealthy() || !(error instanceof AgentBoundaryContractError))\n                this.available = false;\n            throw error;\n        }\n        this.authority.retire(live.grant);', 'this.available = false;\n            throw error;\n        }\n        this.authority.retire(live.grant);'],
  partialDowngrade: ["agent-command-protection.js", ' || Object.hasOwn(raw, "lifecycle")', ""],
};
if (!Object.hasOwn(substitutions, mutation ?? "")) throw new Error("Explicit C4 verification mutation required");
const [target, before, after] = substitutions[mutation];
register("data:text/javascript," + encodeURIComponent(`
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith("/dist/workspace/" + ${JSON.stringify(target)})) return result;
  const source = Buffer.from(result.source).toString("utf8"), before = ${JSON.stringify(before)}, after = ${JSON.stringify(after)};
  if (source.split(before).length !== 2) throw new Error("C4 mutation target missing or ambiguous");
  process.stderr.write("[C4_MUTATION_APPLIED:${mutation}]\\n");
  return { ...result, source: source.replace(before, after) };
}`), import.meta.url);
