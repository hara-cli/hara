import { stdout } from "node:process";

const useColor = stdout.isTTY && process.env.NO_COLOR === undefined;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  cyan: wrap("36"),
  green: wrap("32"),
  yellow: wrap("33"),
  red: wrap("31"),
};

export function out(s: string): void {
  stdout.write(s);
}

export function statusLine(model: string, inTok: number, outTok: number): string {
  return c.dim(`  ${model} · ↑${inTok} ↓${outTok} tok`);
}
