// Color theme — the accent used for the banner + reasoning marker. Switchable via the `theme`
// config key or HARA_THEME env: "dark" (bright vermilion, for dark terminals) | "light" (deeper
// vermilion, readable on a light background). Truecolor; chalk degrades on 256/16-color terms.
export type ThemeName = "dark" | "light";

let current: ThemeName = "dark";

export function setTheme(name?: string): void {
  current = name === "light" ? "light" : "dark";
}
export function themeName(): ThemeName {
  return current;
}
/** Brand accent (warm vermilion · 朱印). */
export function accent(): string {
  return current === "light" ? "#C0392B" : "#FF6B5C";
}
