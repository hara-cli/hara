// Mounts the hara TUI (ink) and resolves when the user exits. Thin shell — all agent wiring
// (provider, session history, slash commands, turn execution) is passed in via AppProps.onSubmit
// from index.ts, which owns that state.
import { render, Box, Text, useApp, useInput } from "ink";
import { createElement } from "react";
import { App, type AppProps } from "./App.js";

type ResizeOutput = {
  columns?: number;
  prependListener(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
};

/** Ink 6.8 clears before repainting when a terminal gets narrower, but not when it gets wider. Install a
 *  complementary WIDTH-only clear ahead of Ink's own resize listener so Ink's normal layout pass redraws
 *  the frame immediately afterwards. Never clear on a rows-only resize: `instance.clear()` erases the
 *  dynamic region without scheduling a React render, which made an idle input box disappear when a user
 *  dragged only the top/bottom edge of the terminal window. Exported for a small ordering regression test. */
export function installResizeRepaint(out: ResizeOutput, instance: { clear(): void }): () => void {
  let lastColumns = out.columns;
  const onResize = (): void => {
    const columns = out.columns;
    if (!columns || columns === lastColumns) return;
    lastColumns = columns;
    try {
      instance.clear();
    } catch {
      /* best-effort — never let a repaint fix crash the session */
    }
  };
  // Ink registered its listener inside render() already. Prepending is essential: clearing AFTER Ink's
  // repaint is precisely what leaves the prompt blank until some unrelated state update happens.
  out.prependListener("resize", onResize);
  return () => out.off("resize", onResize);
}

export async function runTui(props: AppProps): Promise<void> {
  const instance = render(createElement(App, props));
  const out = process.stdout;
  const removeResizeRepaint = installResizeRepaint(out, instance);
  try {
    await instance.waitUntilExit();
  } finally {
    removeResizeRepaint();
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
