import { coreText } from "../i18n/messages.js";
import type { Locale } from "../i18n/locale.js";
import type { NeutralMsg } from "../providers/types.js";

const group = /(?:群(?:聊|组|組)?|\b(?:group|room)\b)/iu;
const create = /(?:建(?:立|一?[个個])?|创建|創建|新增|拉|开|開|\b(?:create|make|start|set up)\b).{0,48}(?:群(?:聊|组|組)?|\b(?:group|room)\b)/iu;
const negative = /(?:不要|别|別|不必|无需|無需|不想|\b(?:do not|don't|never|without)\b).{0,24}(?:建|创|創|拉|开|開|create|make|start|set up)/iu;
export const explicitGroupCreateIntent = (message: string): boolean => create.test(message) && !negative.test(message);
/** Proposals are prose. Only the latest human request, or assent to the immediately preceding proposal,
 * permits a card; tool results, system reminders and older agreements never supply this authority. */
export function groupCreationAuthorized(history: readonly NeutralMsg[]): boolean {
  let at = history.length - 1;
  for (; at >= 0; at--) { const row = history[at]!; if (row.role === "user" && !/^\s*<system-reminder>/u.test(row.content)) break; }
  const latest = history[at];
  if (latest?.role !== "user") return false;
  const message = latest.content.trim();
  if (explicitGroupCreateIntent(message)) return true;
  if (!/^(?:好(?:的|啊)?|可以|同意|行|建吧|建立吧|yes(?:,? please)?|okay|ok|go ahead|sounds good)[。！!.,，\s]*$/iu.test(message)) return false;
  for (let i = at - 1; i >= 0; i--) {
    const row = history[i]!;
    if (row.role === "user") return false;
    if (row.role === "assistant" && row.text.trim()) return group.test(row.text)
      && /(?:建议|建議|可以|要不要|是否|\b(?:suggest|could|would|shall|can)\b)/iu.test(row.text)
      && !negative.test(row.text);
  }
  return false;
}
export interface GroupCreateDraft { name: string; memberIds: string[]; memberNames: string[] }

/** Conservative one-group fast closeout. A second requested action still needs its own completion checks. */
export function singleGroupCreationRequest(history: readonly NeutralMsg[]): boolean {
  if (!groupCreationAuthorized(history)) return false;
  const messages = history.filter(row => row.role === "user" && !/^\s*<system-reminder>/u.test(row.content));
  const latest = messages[messages.length - 1];
  if (latest?.role !== "user") return false;
  const text = explicitGroupCreateIntent(latest.content) ? latest.content : history.slice(0, history.indexOf(latest)).reverse().find(row => row.role === "assistant" && row.text.trim());
  const value = typeof text === "string" ? text : text?.role === "assistant" ? text.text : "";
  return value.length <= 400 && !/(?:并且|並且|然后|然後|同时|同時|另外|顺便|順便|發送|发送|寫入|写入|\b(?:also|then|send|write|delete|deploy|publish)\b)/iu.test(value);
}
export function groupCreatedReply(name: string, language: Locale): string {
  return coreText("core.created.group", language, { name });
}
