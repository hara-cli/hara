// Mounts the hara TUI (ink) and resolves when the user exits. Thin shell — all agent wiring
// (provider, session history, slash commands, turn execution) is passed in via AppProps.onSubmit
// from index.ts, which owns that state.
import { render } from "ink";
import { createElement } from "react";
import { App, type AppProps } from "./App.js";

export async function runTui(props: AppProps): Promise<void> {
  const instance = render(createElement(App, props));
  await instance.waitUntilExit();
}
