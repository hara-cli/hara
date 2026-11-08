import { AsyncLocalStorage } from "node:async_hooks";
import { LOCALE_REGISTRY, type Locale } from "./registry.generated.js";

export { LOCALE_REGISTRY, type Locale } from "./registry.generated.js";
export interface ClientLocale { readonly tag: Locale; readonly fallback: readonly Locale[] }
const localeContext = new AsyncLocalStorage<ClientLocale>();
export function localeDescriptor(tag: Locale): ClientLocale {
  const row = LOCALE_REGISTRY.languages.find(row => row.tag === tag)!;
  return Object.freeze({ tag, fallback: Object.freeze([...row.fallback]) });
}
export function resolveLocale(value: string): Locale {
  try {
    const requested = new Intl.Locale(value.replaceAll("_", "-"));
    const registered = LOCALE_REGISTRY.languages.find(row => row.tag === requested.baseName);
    if (registered) return registered.tag;
    const candidate = requested.maximize();
    const exact = LOCALE_REGISTRY.languages.find(row => row.tag === candidate.baseName);
    if (exact) return exact.tag;
    const match = `${candidate.language}-${candidate.script}`;
    return LOCALE_REGISTRY.languages.find(row => row.match === match)?.tag ?? "en";
  } catch { return "en"; }
}
export function parseClientLocale(value: unknown): ClientLocale {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid client locale");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || !Object.hasOwn(row, "tag") || !Object.hasOwn(row, "fallback")
    || typeof row.tag !== "string" || !Array.isArray(row.fallback)) throw new Error("invalid client locale");
  const expected = LOCALE_REGISTRY.languages.find(item => item.tag === row.tag);
  if (!expected || row.fallback.length !== expected.fallback.length
    || row.fallback.some((tag, index) => tag !== expected.fallback[index])) throw new Error("invalid client locale");
  return localeDescriptor(expected.tag);
}
export function currentClientLocale(env: NodeJS.ProcessEnv = process.env): ClientLocale {
  return localeContext.getStore() ?? localeDescriptor(resolveLocale(env.HARA_CLIENT_LOCALE ?? env.HARA_REPLY_LANGUAGE ?? "en"));
}
export function withClientLocale<T>(value: unknown, operation: () => T): T {
  return localeContext.run(value === undefined ? currentClientLocale() : parseClientLocale(value), operation);
}
