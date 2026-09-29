import type { NeutralMsg } from "../providers/types.js";
import { isSystemReminderContent } from "./reminders.js";

/** The most recent message authored by the person, excluding engine-injected reminder envelopes. */
export function lastGenuineUserText(history: NeutralMsg[]): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role !== "user" || isSystemReminderContent(message.content)) continue;
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
const PRESENTATION =
  /(?:\b(?:presentation|slide\s*deck|slides?|pptx?|powerpoint|keynote)\b|演示文稿|幻灯片|路演稿|汇报材料|PPT)/iu;
const IMAGE_INSPECTION =
  /(?:\b(?:inspect|review|read|analy[sz]e|describe|transcribe)\b[^\n]{0,40}\b(?:image|screenshot|photo|picture|diagram|chart)\b|(?:查看|检查|识别|分析|描述|转录)[^\n]{0,24}(?:图片|截图|照片|图表)|(?:图片|截图|照片)里)/iu;
const VISUAL_PREVIEW =
  /(?:\b(?:visual\s+(?:preview|dock)|preview\s+(?:the\s+)?(?:site|app|page)|localhost\s+preview|local\s+dev\s+server)\b|本地预览|网页预览|扩展屏预览|视觉预览)/iu;
const OPEN_DIRECTORY =
  /(?:(?:\b(?:open|show|reveal)\b[^\n]{0,32}\b(?:folder|directory|finder|file explorer)\b)|(?:(?:打开|显示|定位|访达中显示)[^\n]{0,24}(?:文件夹|目录|访达)))/iu;
const PERSISTENT_TASK =
  /(?:\b(?:persistent|project|multi[- ]day|backlog)\s+(?:task|todo)s?\b|任务池|项目任务|跨会话任务|长期任务|待办池)/iu;
const MEMORY_MUTATION =
  /(?:\b(?:remember|forget|save\s+(?:this|that)\s+(?:preference|fact)|delete\s+(?:that|this)\s+memory)\b|记住|记下来|忘记|删除(?:这条)?记忆)/iu;
const SKILL_CREATION =
  /(?:\b(?:create|save|write|make)\b[^\n]{0,24}\b(?:reusable\s+)?skill\b|创建技能|新建技能|保存为技能|写成技能)/iu;

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
  if (openedBrowserSinceLatestUser(history) || EXPLICIT_COMPUTER_USE.test(text) || (SURFACE.test(text) && INTERACTION.test(text))) {
    selected.add("computer");
  }
  if (PRESENTATION.test(text)) selected.add("presentation");
  if (IMAGE_INSPECTION.test(text)) selected.add("inspect_image");
  if (VISUAL_PREVIEW.test(text)) selected.add("visual_preview");
  if (OPEN_DIRECTORY.test(text)) selected.add("open_directory");
  if (PERSISTENT_TASK.test(text)) selected.add("task");
  if (MEMORY_MUTATION.test(text)) {
    selected.add("memory_write");
    selected.add("memory_forget");
  }
  if (SKILL_CREATION.test(text)) selected.add("skill_create");
  return [...selected];
}
