import type { NeutralMsg } from "../providers/types.js";

const SYSTEM_REMINDER = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/u;

/** The most recent message authored by the person, excluding engine-injected reminder envelopes. */
export function lastGenuineUserText(history: NeutralMsg[]): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role !== "user" || SYSTEM_REMINDER.test(message.content)) continue;
    return message.content;
  }
  return "";
}

const EXPLICIT_COMPUTER_USE =
  /(?:\b(?:computer|browser|desktop|screen|gui)\s+(?:use|control|automation)\b|电脑使用|电脑控制|浏览器(?:使用|控制|交互|自动化)|桌面(?:控制|操作|自动化)|屏幕(?:控制|操作))/iu;
const SURFACE =
  /(?:https?:\/\/|\b(?:browser|website|webpage|web\s+page|chrome|edge|safari|firefox|app|application|window|screen|desktop|button|form|dialog)\b|浏览器|网页|网站|页面|网址|链接|Chrome|Edge|Safari|Firefox|应用|窗口|屏幕|桌面|按钮|输入框|表单|对话框|微信|飞书)/iu;
const INTERACTION =
  /(?:\b(?:open|visit|navigate|click|tap|type|enter|fill|select|check|upload|download|submit|sign\s*in|log\s*in|screenshot|capture|operate|control|switch|scroll|refresh|reload|press|drag)\b|打开|进入|访问|导航|点击|点开|输入|键入|填写|选择|勾选|上传|下载|提交|登录|截图|截屏|操作|控制|切换|滚动|刷新|重载|按下|拖动|交互)/iu;

/** A broad request such as “打开百度” may need `open_browser` before the model learns that the page must
 * be operated. Once that bounded opener has run for the current user turn, expose Computer Use on the next
 * provider round instead of forcing weaker models to discover a second tool by name. */
function openedBrowserSinceLatestUser(history: NeutralMsg[]): boolean {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role === "user" && !SYSTEM_REMINDER.test(message.content)) return false;
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
  if (openedBrowserSinceLatestUser(history)) return ["computer"];
  if (EXPLICIT_COMPUTER_USE.test(text)) return ["computer"];
  return SURFACE.test(text) && INTERACTION.test(text) ? ["computer"] : [];
}
