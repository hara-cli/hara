import { coreText } from "../i18n/messages.js";
import { replyCopyLanguage } from "../i18n/reply-language.js";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { NeutralMsg } from "../providers/types.js";
import { redactSensitiveText } from "../security/secrets.js";
import { WorkspaceLegacyResources } from "./legacy-resources.js";
import { plain } from "./local-state.js";
import type { WorkspaceResourceStorage } from "./resource-context.js";

export interface WorkspaceProjectLocations {
  historicalContextOnly: true; access: "catalog_only"; options: string[]; otherOption: string; truncated: boolean;
}
function safePath(value: string): boolean {
  return value.length <= 240 && isAbsolute(value) && resolve(value) === value && value !== sep
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && !redactSensitiveText(value).redactions.length;
}
/** Metadata only, never a filesystem inventory or an execution grant. Sources are already bound to
 * this Workspace; successful file receipts supply recent directories from this conversation only. */
export function prepareWorkspaceProjectLocations(input: {
  storage: WorkspaceResourceStorage; project: string; history: readonly NeutralMsg[]; objective: string;
}): WorkspaceProjectLocations {
  const language = replyCopyLanguage(input.objective);
  const copy = { project: coreText("core.location.project", language), root: coreText("core.location.root", language), current: coreText("core.location.current", language), recent: coreText("core.location.recent", language), other: coreText("core.location.other", language) };
  const rows = new WorkspaceLegacyResources(input.storage).directoryReferencesForHost();
  const words = [...new Set(input.objective.slice(0, 2000).toLocaleLowerCase().match(/[a-z0-9][a-z0-9_-]{1,79}|[\u3400-\u9fff]{2,40}/gu) ?? [])].slice(0, 32);
  const score = (path: string) => words.reduce((sum, word) => sum + Number(path.toLocaleLowerCase().includes(word)), 0);
  const ranked = rows.map(row => ({ ...row, score: score(row.path) })).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const recent: string[] = [];
  for (const message of input.history.slice(-120).reverse()) {
    if (message.role !== "tool") continue;
    for (const result of [...message.results].reverse()) {
      if (result.isError || !["workspace_read", "workspace_write", "workspace_verify"].includes(result.name) || result.content.length > 200_000) continue;
      try {
        const row: unknown = JSON.parse(result.content);
        if (!plain(row) || !plain(row.receipt) || row.receipt.toolCallId !== result.id || row.receipt.toolName !== result.name
          || typeof row.path !== "string" || row.path.length > 512 || isAbsolute(row.path)
          || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256)
          || !(result.name === "workspace_read" ? row.exists === true : result.name === "workspace_write" ? row.written === true : row.verified === true)) continue;
        const target = resolve(input.project, row.path), rel = relative(input.project, target);
        if (!rel || isAbsolute(rel) || rel.split(sep).some(part => !part || part === ".." || part.startsWith(".") || part === "node_modules")) continue;
        const directory = dirname(target);
        if (!recent.includes(directory)) recent.push(directory);
      } catch { /* A prose/error/truncated result is not a known directory. */ }
    }
    if (recent.length >= 8) break;
  }
  const options: string[] = [], seen = new Set<string>(); let truncated = false;
  const add = (path: string, label: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const option = label + ": " + path;
    if (!safePath(path) || option.length > 300 || options.length >= 7
      || Buffer.byteLength(JSON.stringify([...options, option, copy.other]), "utf8") > 1400) { truncated = true; return; }
    options.push(option);
  };
  for (const row of ranked.filter(row => row.purposes.includes("project")).slice(0, 3)) add(row.path, copy.project);
  add(input.project, copy.current);
  for (const row of ranked.filter(row => row.purposes.includes("workspace-files")).slice(0, 2)) add(row.path, copy.root);
  for (const directory of recent.slice(0, 2)) add(directory, copy.recent);
  truncated ||= ranked.filter(row => row.purposes.includes("project")).length > 3
    || ranked.filter(row => row.purposes.includes("workspace-files")).length > 2 || recent.length > 2;
  return { historicalContextOnly: true, access: "catalog_only", options: [...options, copy.other], otherOption: copy.other, truncated };
}
