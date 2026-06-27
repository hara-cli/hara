// Mounts the hara TUI (ink) and resolves when the user exits. Thin shell — all agent wiring
// (provider, session history, slash commands, turn execution) is passed in via AppProps.onSubmit
// from index.ts, which owns that state.
import { render, Box, Text, useApp, useInput } from "ink";
import { createElement } from "react";
import { App, type AppProps } from "./App.js";

export async function runTui(props: AppProps): Promise<void> {
  const instance = render(createElement(App, props));
  await instance.waitUntilExit();
}

// A tiny ink yes/no prompt for pre-TUI confirms (e.g. the first-run "create AGENTS.md?" offer).
// MUST be ink, NOT readline: a readline question before the main TUI leaves stdin in a state ink
// can't read from, which kills the input box. ink restores stdin cleanly on unmount, so the main
// TUI mounted right after still gets working input. Resolves true on y/Enter, false on n/Esc.
export async function askConfirm(question: string, def = true): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean): void => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    function Prompt() {
      const { exit } = useApp();
      useInput((input, key) => {
        const v = input.toLowerCase();
        let ans: boolean | null = null;
        if (key.return) ans = def;
        else if (v === "y") ans = true;
        else if (v === "n" || key.escape) ans = false;
        if (ans !== null) {
          finish(ans);
          exit();
        }
      });
      return createElement(
        Box,
        { marginY: 1 },
        createElement(Text, { color: "yellow" }, `  ${question} `),
        createElement(Text, { dimColor: true }, def ? "[Y/n] " : "[y/N] "),
      );
    }
    const inst = render(createElement(Prompt));
    void inst.waitUntilExit().then(() => finish(def));
  });
}
