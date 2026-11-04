import { parseMessageTimingReport, type MessageTimingIdentity } from "./message-timing.js";
export interface WorkspaceAssistantPreview extends MessageTimingIdentity {
  schemaVersion: 1; requestId: string; nativeTurnId: string; itemId: string; seq: number; text: string; draft: true; evidenceVerified: false;
}
const fields = ["schemaVersion", "workspaceId", "resourceGeneration", "agentId", "sessionId", "runId", "attemptId", "historyStart", "requestId", "nativeTurnId", "itemId", "seq", "text", "draft", "evidenceVerified"];
const native = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;
export function parseWorkspaceAssistantPreview(value: unknown): WorkspaceAssistantPreview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== fields.length || !fields.every(key => Object.prototype.hasOwnProperty.call(row, key)) || row.schemaVersion !== 1
    || row.draft !== true || row.evidenceVerified !== false || !Number.isSafeInteger(row.seq) || Number(row.seq) < 1 || Number(row.seq) > 4096
    || typeof row.text !== "string" || !row.text.length || row.text.length > 24_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(row.text)
    || ![row.nativeTurnId, row.itemId].every(value => typeof value === "string" && native.test(value))) return null;
  const {workspaceId,resourceGeneration,agentId,sessionId,runId,attemptId,historyStart}=row;
  const identity = {workspaceId,resourceGeneration,agentId,sessionId,runId,attemptId,historyStart};
  const points = {T0:null,T1:0,T2:null,T3:null,T4:null,T5:null,T6:null,T7:null,T8:null,T9:null};
  if (!parseMessageTimingReport({schemaVersion:1,...identity,origin:"host_receive",clientClockErrorMs:null,points})
    || !parseMessageTimingReport({schemaVersion:1,...identity,runId:row.requestId,origin:"host_receive",clientClockErrorMs:null,points})) return null;
  return {...row} as unknown as WorkspaceAssistantPreview;
}
