// Per-turn model routing — the answer to "use a strong/coding model for real work, a cheap/general model
// for trivial chat" WITHOUT splitting hara into two products. Opt-in: set `routeModel` (+ optional
// routeBaseURL/routeApiKey) and trivial turns route there; everything with any code/action signal stays on
// the primary model. Conservative by design (a coding tool should err toward the strong model).
import type { Provider, NeutralMsg, TurnArgs } from "../providers/types.js";

// Words that signal real coding/action work → keep the primary (strong) model. Broad on purpose: routing
// should fire only on clearly trivial, non-actionable turns (questions, lookups, chit-chat).
const COMPLEX =
  /\b(debug|refactor|implement|fix(es|ed|ing)?|build|test|deploy|migrat\w*|optimi[sz]e|architect|design|review|trace|profile|benchmark|docker|kubernetes|compile|exception|error|bug|patch|diff|commit|merge|rebase|rename|add|remove|delete|update|change|write|create|edit|run|install|generate|convert|parse|format|lint|setup|configure|wire|hook|render|fetch|query|schema|class|function|async|await|import|export)\b/i;

// Chinese requests do not have whitespace word boundaries. Without an explicit action vocabulary, short
// commands such as “修复这个问题” and “继续部署” looked like casual chat and were routed to the cheap model.
// Keep this intentionally broad: false negatives weaken execution, while false positives only retain the
// primary model for one turn.
const COMPLEX_CJK =
  /(修复|修改|实现|开发|编写|重构|优化|分析|检查|排查|调试|测试|验证|部署|发布|构建|编译|运行|执行|启动|停止|安装|配置|迁移|设计|架构|评审|审查|生成|创建|新建|添加|删除|更新|导入|导出|转换|提交|合并|回滚|继续|开始|开干|处理|完成|解决|代码|脚本|文件|项目|仓库|数据库|接口|错误|异常|故障|问题|功能|界面|组件|模型|插件|工作台)/i;

/** The text of the most recent genuine user message (tool results are role:"tool", so this is stable
 *  across a turn's tool rounds). */
export function lastUserText(history: NeutralMsg[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user") return typeof m.content === "string" ? m.content : "";
  }
  return "";
}

/** True if a turn is trivial enough to hand to the cheap/general model: short, single-line, no code,
 *  no URL, and no coding/action keyword. Defaults to FALSE (stay on the strong model) when unsure. */
export function isTrivialTurn(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (t.length > 160) return false; // long → probably substantive
  if (/\p{Script=Han}/u.test(t) && [...t].length > 60) return false; // Chinese carries more meaning without spaces
  if (t.split(/\s+/).length > 28) return false;
  if (t.includes("\n")) return false; // multi-line / paste
  if (t.includes("`")) return false; // inline code / fences
  if (/https?:\/\//i.test(t)) return false; // a URL to act on
  if (/[{}();=]|=>|::|\/|\\/.test(t)) return false; // code-ish / a path
  if (COMPLEX.test(t)) return false; // an action/coding verb
  if (COMPLEX_CJK.test(t)) return false; // CJK action/domain signal
  return true;
}

/** Wrap a primary + alternate provider so each turn routes to the alternate when the latest user message is
 *  trivial, else the primary. Decided per turn from history (stable across tool rounds). */
export function routingProvider(primary: Provider, alt: Provider): Provider {
  return {
    id: primary.id,
    model: primary.model, // reported model = primary; routing is transparent
    turn(args: TurnArgs) {
      const useAlt = isTrivialTurn(lastUserText(args.history));
      return (useAlt ? alt : primary).turn(args);
    },
  };
}
