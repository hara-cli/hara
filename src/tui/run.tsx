// Mounts the hara TUI (ink) and resolves when the user exits. Thin shell — all agent wiring
// (provider, session history, slash commands, turn execution) is passed in via AppProps.onSubmit
// from index.ts, which owns that state.
import { render, Box, Text, useApp, useInput } from "ink";
import { createElement } from "react";
import { App, type AppProps } from "./App.js";

export async function runTui(props: AppProps): Promise<void> {
  const instance = render(createElement(App, props));
  // Resize repaint fix. ink 6.8's own resize handler only clears the screen when the terminal gets
  // NARROWER; on a WIDEN (or a resize it doesn't classify as narrowing) it just re-renders, so the old
  // frame — reflowed at the new width — is never erased, and the ~125ms spinner tick stacks a fresh copy
  // each time (the "moved the window and the UI stacked up" garble). We complement it: on ANY resize,
  // clear ink's tracked output so the next render starts clean. Debounced by a microtask so a burst of
  // resize events during a window drag collapses to one clear.
  const out = process.stdout;
  let pending = false;
  const onResize = (): void => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      try {
        instance.clear();
      } catch {
        /* best-effort — never let a repaint fix crash the session */
      }
    });
  };
  out.on("resize", onResize);
  try {
    await instance.waitUntilExit();
  } finally {
    out.off("resize", onResize);
  }
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
