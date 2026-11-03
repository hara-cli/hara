import type { RuntimeModel } from "../workspace/runtime-models.js";

export const EXPANDED_RUNTIME_IDS = ["copilot", "cursor", "grok"] as const;
export type ExpandedRuntimeId = typeof EXPANDED_RUNTIME_IDS[number];
export const isExpandedRuntime = (value: unknown): value is ExpandedRuntimeId =>
  typeof value === "string" && (EXPANDED_RUNTIME_IDS as readonly string[]).includes(value);

// Dated vendor documentation, never an assertion about the current account's entitlement.
export const EXPANDED_MODEL_SOURCES = {
  copilot: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference",
  cursor: "https://cursor.com/docs/cli/reference/parameters",
  grok: "https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md",
} as const;
export const DOCUMENTED_EXPANDED_MODELS: Partial<Record<ExpandedRuntimeId, readonly RuntimeModel[]>> = {
  copilot: [
    { id: "claude-sonnet-5.5", label: "Claude Sonnet 5.5", recommended: true },
    { id: "gpt-6.1-sol", label: "GPT 6.1 Sol" }, { id: "gpt-6.1-terra", label: "GPT 6.1 Terra" },
    { id: "gpt-6-astra", label: "GPT 6 Astra" }, { id: "gpt-6-luna", label: "GPT 6 Luna" },
    { id: "claude-opus-5.5", label: "Claude Opus 5.5" }, { id: "claude-haiku-5.5", label: "Claude Haiku 5.5" },
    { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" }, { id: "gpt-5.3-codex", label: "GPT 5.3 Codex" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  ],
  grok: [{ id: "grok-4.6", label: "Grok 4.6", recommended: true }],
};
const modelId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value)
  && !value.includes("..") && !value.includes("//") && !value.endsWith("/");
/** Cursor models is a bounded, read-only CLI query. Account banners never become model IDs. */
export function parseCursorModels(output: string): RuntimeModel[] {
  if (Buffer.byteLength(output) > 1024 * 1024) throw new Error("cursor model inventory is invalid");
  const models: RuntimeModel[] = [];
  for (const raw of output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(?:Available models|Models|Loading models)(?::|\.\.\.)?$/i.test(line)) continue;
    const match = /^(?:[*•>]\s*)?([A-Za-z0-9][A-Za-z0-9._/-]*)(?:\s+(?:[-—]\s*)?(.+))?$/.exec(line);
    if (!match || !modelId(match[1]!) || models.length >= 256) throw new Error("cursor model inventory is invalid");
    const id = match[1]!, description = match[2]?.replace(/\s*\((?:current|default)\)\s*$/i, "").trim();
    if (models.some(row => row.id === id)) throw new Error("cursor model inventory has duplicate IDs");
    models.push({ id, label: description && description.length <= 160 ? description : id });
  }
  if (!models.length) throw new Error("cursor model inventory is unavailable");
  return models;
}
/** A documented flag is insufficient: publish levels only when this exact binary advertises them. */
export function copilotHelpEfforts(help: string): string[] {
  const section = /--(?:reasoning-)?effort\b[^\n]*(?:\n\s{2,}[^-\n][^\n]*)?/i.exec(help)?.[0] ?? "";
  return ["low", "medium", "high", "xhigh", "max"].filter(level => new RegExp("\\b" + level + "\\b").test(section));
}
