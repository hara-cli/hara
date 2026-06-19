// Tiny streaming Markdown renderer for assistant output. Line-buffered (style on complete lines,
// codex-style) so headers/bold/inline-code/bullets render in a terminal instead of showing raw
// `**`/`##`/backticks. Code fences are passed through verbatim (copy-paste accurate). Color via the
// shared `c` helper, so in a non-TTY it degrades to the structural transform only.
import { c } from "./ui.js";

export interface MdState {
  inFence: boolean;
}

const inline = (s: string): string =>
  s.replace(/\*\*([^*]+)\*\*/g, (_, x) => c.bold(x)).replace(/`([^`]+)`/g, (_, x) => c.cyan(x));

/** Style one complete line given the running fence state. */
export function styleLine(line: string, state: MdState): string {
  if (line.trimStart().startsWith("```")) {
    state.inFence = !state.inFence;
    return c.dim(line);
  }
  if (state.inFence) return line; // inside a code block — leave verbatim
  const h = /^(#{1,6})\s+(.*)$/.exec(line);
  if (h) return c.bold(inline(h[2]));
  const b = /^(\s*)[-*]\s+(.*)$/.exec(line);
  if (b) return `${b[1]}${c.cyan("•")} ${inline(b[2])}`;
  return inline(line);
}

/** Whole-block render (non-streaming) — used in tests. */
export function renderMarkdown(text: string): string {
  const state: MdState = { inFence: false };
  return text
    .split("\n")
    .map((l) => styleLine(l, state))
    .join("\n");
}

/** Streaming sink: feed deltas via push(), flush the tail with end(). Styles complete lines. */
export function makeRenderer(write: (s: string) => void): { push: (d: string) => void; end: () => void } {
  const state: MdState = { inFence: false };
  let buf = "";
  return {
    push(d: string): void {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        write(styleLine(line, state) + "\n");
      }
    },
    end(): void {
      if (buf) {
        write(styleLine(buf, state));
        buf = "";
      }
    },
  };
}
