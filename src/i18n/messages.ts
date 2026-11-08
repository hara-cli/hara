import { CORE_MESSAGES, CORE_MESSAGE_PARAMS, type CoreMessageKey } from "./messages.generated.js";
import { currentClientLocale, localeDescriptor, type Locale } from "./locale.js";
export type { CoreMessageKey } from "./messages.generated.js";
export type MessageParams = Record<string, string | number>;
/** Render only a compiled, closed resource key. React/CLI callers receive plain text, never HTML. */
export function coreText(key: CoreMessageKey, locale: Locale = currentClientLocale().tag, params: MessageParams = {}): string {
  const chain = [locale, ...localeDescriptor(locale).fallback];
  const ast = chain.map(tag => CORE_MESSAGES[tag]?.[key]).find(Boolean);
  if (!ast) return key;
  const required: readonly string[] = CORE_MESSAGE_PARAMS[key];
  if (Object.keys(params).some(name => !required.includes(name)) || required.some(name => !Object.prototype.hasOwnProperty.call(params, name)
    || typeof params[name] !== "string" && typeof params[name] !== "number" || typeof params[name] === "number" && !Number.isFinite(params[name])))
    throw new Error("invalid localized message parameters");
  const render = (parts: readonly unknown[], plural?: number): string => parts.map(raw => {
    const [kind, name, format] = raw as [string, string, unknown];
    const value = params[name];
    if (kind === "text") return name;
    if (kind === "pound") return new Intl.NumberFormat(locale).format(plural!);
    if (kind === "arg") return String(value);
    if (kind === "number") return new Intl.NumberFormat(locale, format === "integer" ? { maximumFractionDigits: 0 } : {}).format(Number(value));
    if (kind === "date" || kind === "time") {
      const style = ["short", "medium", "long", "full"].includes(String(format)) ? String(format) : "medium";
      return new Intl.DateTimeFormat(locale, kind === "date" ? { dateStyle: style as "medium" } : { timeStyle: style as "medium" }).format(new Date(value));
    }
    const choices = format as Record<string, readonly unknown[]>;
    const selected = kind === "select" ? String(value) : Object.prototype.hasOwnProperty.call(choices, `=${value}`) ? `=${value}`
      : new Intl.PluralRules(locale, { type: kind === "selectordinal" ? "ordinal" : "cardinal" }).select(Number(value));
    return render(choices[selected] ?? choices.other!, kind === "select" ? plural : Number(value));
  }).join("");
  return render(ast);
}
