import type { NeutralMsg } from "../providers/types.js";
import { closedWorkspaceHistory } from "./conversations.js";

/** A request view, NOT another transcript or a completion-evidence source. The Host pins an
 * attempt boundary before appending its user message. Identity/roster remain in the stable system
 * tier, the current task/checkpoint in the engine turn tier, and only this attempt's working
 * messages travel here. On recovery the checkpoint is a hint: state must be observed again.
 * Never strip provider-owned reasoning from a retained tool chain or split use/result pairs. */
export function workspaceTaskHistory(history: NeutralMsg[], start: number): NeutralMsg[] {
  if (!Number.isSafeInteger(start) || start < 0 || start >= history.length || history[start]?.role !== "user") {
    throw new Error("Workspace model context boundary changed; full history retained");
  }
  const current = history.slice(start);
  if (closedWorkspaceHistory(current).length !== current.length) throw new Error("Workspace model context contains an open tool batch");
  return structuredClone(current);
}
