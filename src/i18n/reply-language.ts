import scripts from "./han-script.generated.json" with { type: "json" };
import { currentClientLocale, resolveLocale, type Locale } from "./locale.js";
const simplified = new Set(scripts.simplifiedExclusive), traditional = new Set(scripts.traditionalExclusive);
/** Latest user text only. Paths/code/emoji/ambiguous short input use the interface language. */
export function replyCopyLanguage(text: string, fallback: Locale = currentClientLocale().tag): Locale {
  const prose = text.slice(0, 16000).replace(/```[\s\S]*?(?:```|$)/gu, " ")
    .replace(/`[^`]*`|https?:\/\/\S+|(?:^|\s)(?:[A-Za-z]:[\\/]|[.~]?[\/])\S+/gu, " ").trim();
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(prose)) return "ja";
  if (/\p{Script=Hangul}/u.test(prose)) return "ko";
  const han = prose.match(/\p{Script=Han}/gu) ?? [];
  if (han.length >= 2) {
    let hans = 0, hant = 0;
    for (const char of han) { hans += Number(simplified.has(char)); hant += Number(traditional.has(char)); }
    if (hans > 0 && hans > hant * 1.5) return "zh-Hans";
    if (hant > 0 && hant > hans * 1.5) return "zh-Hant";
    return fallback;
  }
  if (/[A-Za-z]{4,}/u.test(prose) && /\s/u.test(prose)) return "en";
  return fallback;
}
export function replyLanguageInstruction(env: NodeJS.ProcessEnv = process.env): string {
  const requested = String(env.HARA_REPLY_LANGUAGE ?? "").trim();
  if (/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/u.test(requested))
    return `Reply in ${requested} unless the user explicitly asks for another language;`;
  return "Reply in the same language and writing system as the user's latest message (for Chinese, preserve Simplified or Traditional exactly as written). If the message has no clear language (code, a path, emoji, or very short), use the interface language supplied in the current turn context;";
}
export function requestedReplyCopyLanguage(text: string, env: NodeJS.ProcessEnv = process.env): Locale {
  const requested = String(env.HARA_REPLY_LANGUAGE ?? "").trim();
  return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/u.test(requested) ? resolveLocale(requested) : replyCopyLanguage(text, currentClientLocale(env).tag);
}
