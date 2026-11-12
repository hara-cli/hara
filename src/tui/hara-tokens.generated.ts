// Hara design tokens · version 2.1.2 · sourceSha 363e99542888d219a9e9d351738595904da766264ea46d677bfdec70ccafe03f
// GENERATED from uiux/design-language/hara/DESIGN.md by build_tokens.mjs — do not edit by hand.
// Terminal palette. Use the truecolor value when supported, else the 256 index, else the 16-colour name.
// Respect NO_COLOR and non-TTY output: emit no colour at all.

export const haraTerminal = {
  "version": "2.1.2",
  "sourceSha": "363e99542888d219a9e9d351738595904da766264ea46d677bfdec70ccafe03f",
  "accent": {
    "dark": "#A78BFA",
    "light": "#6D28D9",
    "dark256": 141,
    "light256": 56,
    "ansi16": "magenta"
  },
  "success": {
    "dark": "#4ADE80",
    "light": "#157F3C",
    "dark256": 78,
    "light256": 29,
    "ansi16": "green"
  },
  "warning": {
    "dark": "#FACC15",
    "light": "#9A5B05",
    "dark256": 220,
    "light256": 94,
    "ansi16": "yellow"
  },
  "danger": {
    "dark": "#F87171",
    "light": "#B91C1C",
    "dark256": 203,
    "light256": 124,
    "ansi16": "red"
  }
} as const

export type HaraTerminalRole = Exclude<keyof typeof haraTerminal, 'version' | 'sourceSha'>
