// Minimal zero-dependency line diff (LCS) + colored unified-style renderer.
// Shown to the user after an edit so a coder sees exactly what changed.
import { stdout } from "node:process";
import { c } from "./ui.js";

interface Op {
  t: " " | "+" | "-";
  s: string;
}

/** Longest-common-subsequence line diff. O(n*m) — guarded by a size cap in renderDiff. */
function lcsDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: " ", s: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: "-", s: a[i] });
      i++;
    } else {
      out.push({ t: "+", s: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ t: "-", s: a[i++] });
  while (j < m) out.push({ t: "+", s: b[j++] });
  return out;
}

const CONTEXT = 2;
const MAX_LINES = 80;
const SIZE_CAP = 4000;

/** Colored unified-style diff for display, with context collapsing + a hard cap. "" if unchanged. */
export function renderDiff(path: string, oldText: string, newText: string): string {
  if (oldText === newText) return "";
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];
  const adds = () => ops.filter((o) => o.t === "+").length;
  const dels = () => ops.filter((o) => o.t === "-").length;
  if (a.length > SIZE_CAP || b.length > SIZE_CAP) {
    return c.dim(`◇ ${path}  (${a.length}→${b.length} lines; too large to diff)\n`);
  }
  const ops = lcsDiff(a, b);

  // mark which lines to show: every change ± CONTEXT lines of surrounding context
  const show = new Array(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.t !== " ") for (let d = -CONTEXT; d <= CONTEXT; d++) if (ops[k + d]) show[k + d] = true;
  });

  const lines: string[] = [c.dim(`◇ ${path}  ${c.green("+" + adds())} ${c.red("-" + dels())}`)];
  let skipping = false;
  let shown = 0;
  for (let k = 0; k < ops.length; k++) {
    if (!show[k]) {
      if (!skipping) {
        lines.push(c.dim("  ⋯"));
        skipping = true;
      }
      continue;
    }
    skipping = false;
    if (shown >= MAX_LINES) {
      lines.push(c.dim("  …(diff truncated)"));
      break;
    }
    const o = ops[k];
    if (o.t === "+") lines.push(c.green(`  + ${o.s}`));
    else if (o.t === "-") lines.push(c.red(`  - ${o.s}`));
    else lines.push(c.dim(`    ${o.s}`));
    shown++;
  }
  return lines.join("\n") + "\n";
}

/** Print a diff to the user — interactive terminal only, so pipes/tests stay clean. */
export function showDiff(path: string, oldText: string, newText: string): void {
  if (!stdout.isTTY) return;
  const d = renderDiff(path, oldText, newText);
  if (d) stdout.write(d);
}

/** Route a diff to the UI sink (TUI) when present, else print it to the terminal. */
export function emitDiff(path: string, oldText: string, newText: string, sink?: { diff(t: string): void }): void {
  if (sink) sink.diff(renderDiff(path, oldText, newText));
  else showDiff(path, oldText, newText);
}
