// Explicit mutation verification only. Never imported by production or the normal test glob.
import { register } from "node:module";
const mutation = process.env.HARA_BOUNDARY_TEST_MUTATION;
const substitutions = {
  deny: ["|| facts.boundary.tools.deny.some(ref => ref.toolId === reference.toolId && ref.connectorId === reference.connectorId)", ""],
  inode: ["|| canonical(captureWorkspaceProjectIdentity(root.root)) !== canonical(root)", ""],
  scoped: ["!isWorkspaceScopedFileTool(item.tool) || ", ""],
};
if (!Object.hasOwn(substitutions, mutation ?? "")) throw new Error("Explicit boundary mutation name required");
const [before, after] = substitutions[mutation];
register("data:text/javascript," + encodeURIComponent(`
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith("/dist/workspace/agent-boundary-execution.js")) return result;
  const source = Buffer.from(result.source).toString("utf8");
  const before = ${JSON.stringify(before)}, after = ${JSON.stringify(after)};
  if (!source.includes(before)) throw new Error("Boundary mutation target missing");
  return { ...result, source: source.replace(before, after) };
}`), import.meta.url);
