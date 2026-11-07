import { CORE_INTENT_PATTERNS_BY_LOCALE } from "./core-intents.generated.js";

export type CoreIntentPattern = keyof typeof CORE_INTENT_PATTERNS_BY_LOCALE.en;
export const CORE_INTENT_LOCALES = Object.freeze(Object.keys(CORE_INTENT_PATTERNS_BY_LOCALE));

// A message may mix scripts/languages. Match the checked-in patterns, rather than converting user text
// or guessing a UI locale. Availability never bypasses the tool's existing authorization checks.
const compiled = new Map<CoreIntentPattern, readonly RegExp[]>();
for (const key of Object.keys(CORE_INTENT_PATTERNS_BY_LOCALE.en) as CoreIntentPattern[]) {
  const sources = new Set<string>();
  for (const locale of Object.values(CORE_INTENT_PATTERNS_BY_LOCALE)) {
    for (const source of locale[key]) sources.add(source);
  }
  compiled.set(key, [...sources].map(source => new RegExp(source, "iu")));
}

export function matchesCoreIntent(pattern: CoreIntentPattern, text: string): boolean {
  return compiled.get(pattern)!.some(regex => regex.test(text));
}
