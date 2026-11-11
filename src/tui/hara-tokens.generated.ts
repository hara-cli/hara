// Hara design tokens · version 2.1.0 · sourceSha cc246d5252946cd833a3db6b06ac573c6241e3cb34374e5ee33a4dd4f2b68bc0
// GENERATED from uiux/design-language/hara/DESIGN.md by build_tokens.mjs — do not edit by hand.
// Terminal palette. Use the truecolor value when supported, else the 256 index, else the 16-colour name.
// Respect NO_COLOR and non-TTY output: emit no colour at all.

export const haraTerminal = {
  "version": "2.1.0",
  "sourceSha": "cc246d5252946cd833a3db6b06ac573c6241e3cb34374e5ee33a4dd4f2b68bc0",
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
