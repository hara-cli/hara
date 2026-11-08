import catalog from "./errors.json" with { type: "json" };
import { redactSensitiveText } from "../security/secrets.js";
export interface PublicErrorData { code: string; params: Record<string, string | number>; technicalDetail: string }
const byMessage = new Map(catalog.errors.flatMap(row => row.sourceMessages.map(message => [message, row.code] as const)));
export function publicErrorData(error: unknown, privateValues: readonly string[] = []): PublicErrorData {
  const message = error instanceof Error ? error.message : "Workspace request failed";
  const archiveReason = error && typeof error === "object" && "reason" in error && typeof error.reason === "string" ? error.reason : "";
  const code = byMessage.get(archiveReason) ?? byMessage.get(message) ?? "request_failed";
  let technicalDetail = message;
  for (const value of privateValues) if (value) technicalDetail = technicalDetail.replaceAll(value, "[private]");
  technicalDetail = redactSensitiveText(technicalDetail).text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").slice(0, 500);
  return { code, params: {}, technicalDetail };
}
export const PUBLIC_ERROR_CODES = Object.freeze(catalog.errors.map(row => row.code));
