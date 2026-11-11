// Explicit mutation verification only. Never imported by production or the normal test glob.
import { register } from "node:module";
const mutation = process.env.HARA_BOUNDARY_TEST_MUTATION;
const substitutions = {
  deny: ["agent-boundary-execution.js", "|| facts.boundary.tools.deny.some(ref => ref.toolId === reference.toolId && ref.connectorId === reference.connectorId)", ""],
  inode: ["agent-boundary-execution.js", "|| canonical(captureWorkspaceProjectIdentity(root.root)) !== canonical(root)", ""],
  scoped: ["agent-boundary-execution.js", "!isWorkspaceScopedFileTool(item.tool) || ", ""],
  drainOwner: ["agent-command-control.js", "assertWorkspaceRunDrainOwner(proof, live.permit);", ""],
  unknown: ["agent-command-state.js", 'old.effect === "unknown" && row.effect !== "unknown"', "false"],
  unknownState: ["agent-command-state.js", '["unknown", "draining", "drained"].includes(old.state) && ["accepted", "bound", "running"].includes(row.state)', "false"],
};
if (!Object.hasOwn(substitutions, mutation ?? "")) throw new Error("Explicit boundary mutation name required");
const [target, before, after] = substitutions[mutation];
register("data:text/javascript," + encodeURIComponent(`
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith("/dist/workspace/" + ${JSON.stringify(target)})) return result;
  const source = Buffer.from(result.source).toString("utf8");
  const before = ${JSON.stringify(before)}, after = ${JSON.stringify(after)};
  if (!source.includes(before)) throw new Error("Boundary mutation target missing");
  return { ...result, source: source.replace(before, after) };
}`), import.meta.url);
