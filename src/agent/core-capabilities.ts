import type { NeutralMsg } from "../providers/types.js";
import { isSystemReminderContent } from "./reminders.js";
import { matchesCoreIntent } from "./core-intent-lexicon.js";

/** The most recent message authored by the person, excluding engine-injected reminder envelopes. */
export function lastGenuineUserText(history: NeutralMsg[]): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role !== "user" || isSystemReminderContent(message.content)) continue;
    return message.content;
  }
  return "";
}

/** A broad request such as “打开百度” may need `open_browser` before the model learns that the page must
 * be operated. Once that bounded opener has run for the current user turn, expose Computer Use on the next
 * provider round instead of forcing weaker models to discover a second tool by name. */
function openedBrowserSinceLatestUser(history: NeutralMsg[]): boolean {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role === "user" && !isSystemReminderContent(message.content)) return false;
    if (message.role === "assistant" && message.toolUses.some((tool) => tool.name === "open_browser")) return true;
    if (message.role === "tool" && message.results.some((result) => result.name === "open_browser")) return true;
  }
  return false;
}

/**
 * Core capabilities are not optional discovery trivia. For a concrete UI-interaction request, expose the
 * reviewed native `computer` schema on the first provider round so weaker providers do not have to infer a
 * `tool_search` dance. Authorization is unchanged: configuration, app allowlists, organization/skill policy,
 * and the ordinary per-action Computer Use confirmation still gate every action.
 */
export function coreDeferredToolsForHistory(history: NeutralMsg[]): string[] {
  const text = lastGenuineUserText(history).trim();
  if (!text) return [];
  const selected = new Set<string>();
  if (openedBrowserSinceLatestUser(history) || matchesCoreIntent("computer.explicit", text) || (matchesCoreIntent("computer.surface", text) && matchesCoreIntent("computer.interaction", text))) {
    selected.add("computer");
  }
  if (matchesCoreIntent("presentation", text)) selected.add("presentation");
  if (matchesCoreIntent("image_inspection", text)) selected.add("inspect_image");
  if (matchesCoreIntent("visual_preview", text)) selected.add("visual_preview");
  if (matchesCoreIntent("open_directory", text)) selected.add("open_directory");
  if (matchesCoreIntent("persistent_task", text)) selected.add("task");
  if (matchesCoreIntent("memory_mutation", text)) {
    selected.add("memory_write");
    selected.add("memory_forget");
  }
  if (matchesCoreIntent("skill_creation", text)) selected.add("skill_create");
  return [...selected];
}
