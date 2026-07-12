// The framed input box (ink): a rounded, dim-bordered box (codex polish) wrapping the prompt line,
// with a single dim footer line rendered BELOW the box (model · approval · route · cwd · usage · ctx).
// The approval-mode picker and working/queue status live OUTSIDE this component (App's constant-height
// StatusRow/ModeLine slot above the box). Pure-ish: pass `width` for deterministic tests.
//
// Render-stability principles (codex-style, for slow/remote terminals): ink erases and rewrites the
// ENTIRE dynamic region on every frame, so the box's cost scales with (a) how many lines it occupies
// and (b) how often any of them change. Two levers here:
//   1. The static chrome (footer, mode bar, mention popup) is memoized so a keystroke that only
//      changes the prompt text doesn't force React to reconcile the unchanged rows.
//   2. Line-wrapping + cursor are computed deterministically from (value, cursor, width) in one memo,
//      so long input wraps under a stable continuation indent and the cursor never drifts — instead
//      of leaning on ink's soft-wrap of a single <Text>, which mis-aligns wrapped rows against the
//      "› " prompt gutter and reflows unpredictably as you type.
import { Box, Text, useInput, useStdout } from "ink";
import { memo, useMemo, useState, type ReactNode } from "react";
import { fileCandidates } from "../context/mentions.js";
import { imagePathFromPaste } from "../images.js";
import { vimNormal, type VimMode } from "./vim.js";
import type { ImageAttachment } from "../providers/types.js";

export const MODES = ["suggest", "auto-edit", "full-auto", "plan"] as const;
export type Approval = (typeof MODES)[number];
export const nextMode = (m: Approval): Approval => MODES[(MODES.indexOf(m) + 1) % MODES.length];

export interface Status {
  sessionName: string;
  approval: Approval;
  input: number;
  output: number;
  ctxPct: number;
  agents: number;
}

const tok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

// The prompt gutter ("› " / "◆ ") is 2 cells wide; wrapped continuation lines indent by the same
// amount so the text column is stable across visual rows.
const GUTTER = 2;

// Tilde-collapse HOME and keep the project tail — a compact cwd for the one-line footer. Local (tiny)
// copy so InputBox doesn't reach back into App.tsx (App imports InputBox — avoid the cycle).
export function footerCwd(abs: string, home: string = process.env.HOME ?? "", maxLen = 28): string {
  let p = abs;
  if (home && (p === home || p.startsWith(home + "/"))) p = "~" + p.slice(home.length);
  if (p.length <= maxLen) return p;
  const tail = p.slice(-(maxLen - 1));
  const slash = tail.indexOf("/");
  return "…" + (slash > 0 ? tail.slice(slash) : tail);
}

/** Approval-mode accent color, shared by the footer indicator + App's transient ModeLine. full-auto is
 *  the dangerous one (red), plan is read-only (cyan), the edit modes are green. */
export function approvalColor(a: Approval): string {
  return a === "full-auto" ? "red" : a === "plan" ? "cyan" : "green";
}

/** The footer split into three parts so the ACTIVE approval mode can be colored inline. The always-on
 *  ModeBar was removed — the mode now lives, glanceable and colored, right here in the footer, and
 *  shift+tab pops a transient selector. `prefix`+`mode`+`suffix` concatenates to exactly the old
 *  `footerLine` (same text, same spacing) — only the color of the `mode` token differs. Pure so the
 *  ordering/spacing can be pinned without rendering React. Shape (codex-style status line):
 *  `<model> · <approval>[ · <route>] · <cwd> · ↑<in> ↓<out> · ctx <pct>%`. The session name is NOT here —
 *  it rides the input box's top-right border (see TopBorder). `ctx N%` is always present (from 0 on) so
 *  the field never pops in mid-session and shifts the layout. */
export function footerParts(model: string, s: Status, cwdShort: string, route?: string): { prefix: string; mode: string; suffix: string; ctx: string; ctxLevel: "ok" | "warn" | "high" } {
  const routeSeg = route ? ` · ${route}` : "";
  return {
    prefix: `  ${model} · `,
    mode: s.approval,
    suffix: `${routeSeg} · ${cwdShort} · ↑${tok(s.input)} ↓${tok(s.output)} · `,
    ctx: `ctx ${s.ctxPct}%`,
    // Claude Code's threshold ladder (60 warn / 80 error / 92 compact): hara auto-compacts at 85, so
    // the footer escalates BEFORE that — yellow at 60, red at 80 — and the user sees compaction coming.
    ctxLevel: s.ctxPct >= 80 ? "high" : s.ctxPct >= 60 ? "warn" : "ok",
  };
}

/** Back-compat: the full footer as one string. Kept for any pure consumer/test. */
export function footerLine(model: string, s: Status, cwdShort: string, route?: string): string {
  const p = footerParts(model, s, cwdShort, route);
  return p.prefix + p.mode + p.suffix + p.ctx;
}

// The merged status footer: model · approval · route · cwd · usage · ctx. The active approval mode is
// colored inline (the always-on ModeBar is gone — shift+tab now pops a transient selector instead), so
// the outer <Text> is NOT dim: only the prefix/suffix are dimmed and the mode token stays bright.
// Memoized so a prompt keystroke doesn't reconcile it.
const Footer = memo(function Footer({ model, s, cwdShort, route }: { model: string; s: Status; cwdShort: string; route?: string }) {
  const { prefix, mode, suffix, ctx, ctxLevel } = footerParts(model, s, cwdShort, route);
  return (
    <Text>
      <Text dimColor>{prefix}</Text>
      <Text color={approvalColor(s.approval)} bold>{mode}</Text>
      <Text dimColor>{suffix}</Text>
      {ctxLevel === "ok" ? <Text dimColor>{ctx}</Text> : <Text color={ctxLevel === "high" ? "red" : "yellow"} bold>{ctx}</Text>}
    </Text>
  );
});

// The rounded TOP edge of the input box, carrying the session name in the right corner (it "rides"
// the border — codex-style titled panel, and where hara has always shown it). Drawn by hand because
// ink's <Box borderStyle> has no title slot; the box below it renders with `borderTop={false}` and a
// fixed `width`, so this line supplies the top with its two corners and everything lines up exactly.
// Layout (total = width): `╭` + left dashes + ` ● <name> ` + `─╮`. `●` (U+25CF) is a hard 1-cell glyph
// (unlike the emoji-presentation `⏺`, which some terminals render 2 cells wide and would skew the corner).
const TopBorder = memo(function TopBorder({ name, width }: { name: string; width: number }) {
  const left = Math.max(2, width - name.length - 7); // ╭(1)+ " "(1)+●(1)+" name "(len+2)+"─╮"(2)
  return (
    <Box>
      <Text dimColor>{"╭" + "─".repeat(left) + " "}</Text>
      <Text color="cyan">●</Text>
      <Text bold>{` ${name} `}</Text>
      <Text dimColor>{"─╮"}</Text>
    </Box>
  );
});

/** The active `@mention` token immediately left of the cursor (for the file popup), or null. */
function activeMention(value: string, cursor: number): { query: string; start: number } | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, cursor));
  return m ? { query: m[1], start: cursor - m[1].length } : null;
}

// Dropdown of fuzzy @path matches, shown above the input as you type `@…` (codex / Claude-Code style).
const MentionPopup = memo(function MentionPopup({ items, selected, query }: { items: string[]; selected: number; query: string }) {
  return (
    <Box flexDirection="column">
      <Text dimColor>{`  @${query}  ·  ${items.length} match${items.length === 1 ? "" : "es"} — ↑↓ select · Tab/Enter insert · Esc dismiss`}</Text>
      {items.map((it, i) => (
        <Text key={it}>
          {i === selected ? <Text color="cyan">{"  ▸ "}</Text> : <Text>{"    "}</Text>}
          <Text color={it.endsWith("/") ? "blue" : undefined} dimColor={i !== selected} bold={i === selected}>
            {it}
          </Text>
        </Text>
      ))}
    </Box>
  );
});

const TOKEN_RE = /\[Image #\d+\]|\[Paste #\d+ \+\d+ lines\]/g;

/** Split the value into text/image-token segments (image tokens render highlighted, codex-style). */
function segmentize(value: string): { text: string; token: boolean }[] {
  const parts: { text: string; token: boolean }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(value))) {
    if (m.index > last) parts.push({ text: value.slice(last, m.index), token: false });
    parts.push({ text: m[0], token: true });
    last = m.index + m[0].length;
  }
  if (last < value.length) parts.push({ text: value.slice(last), token: false });
  return parts;
}

/** One wrapped visual row: the character range [start,end) of `value` it covers. Precomputed so the
 *  cursor lands on the right row/column and image tokens stay whole (never split across a wrap). */
export interface Row {
  start: number;
  end: number;
}

/** Terminal cell width of one code point: CJK/fullwidth/emoji render 2 cells, combining marks and
 *  joiners 0, everything else 1. Wrapping used to count `.length` (1 per char) — mixed CJK+ASCII
 *  input then overflowed the real terminal width and ink soft-wrapped a second time mid-word
 *  (field report: "output" torn into "ou/tput" while typing a URL + 中文 prompt). */
export function charCells(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0; // combining/ZWJ/VS
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extension planes
  )
    return 2;
  return 1;
}

/** Display width of a string in terminal cells (sum of charCells over code points). */
export function cells(s: string): number {
  let n = 0;
  for (const ch of s) n += charCells(ch);
  return n;
}

/** Wrap `value` into rows that each fit within `cols` cells, breaking on spaces where possible but
 *  never inside an `[Image #N]` token. Deterministic (no reliance on ink's soft-wrap) so wrapped rows
 *  align under a stable gutter and the cursor position is exact. Always returns at least one row. */
export function wrapRows(value: string, cols: number): Row[] {
  const width = Math.max(1, cols);
  const rows: Row[] = [];
  const parts = segmentize(value);
  // Flatten to atomic units: a run of text is breakable per-char/word; an image token is atomic.
  const atoms: { text: string; start: number; atomic: boolean; br?: boolean }[] = [];
  let pos = 0;
  for (const p of parts) {
    if (p.token) {
      atoms.push({ text: p.text, start: pos, atomic: true });
      pos += p.text.length;
    } else {
      // Break the text run into: a hard newline (its own atom → forces a row break, so a pasted/typed
      // `\n` renders as an actual line), a word + trailing NON-newline whitespace, or a run of spaces.
      const re = /\n|\S+[^\S\n]*|[^\S\n]+/g;
      let m: RegExpExecArray | null;
      const base = pos;
      while ((m = re.exec(p.text))) {
        atoms.push({ text: m[0], start: base + m.index, atomic: false, br: m[0] === "\n" });
      }
      pos += p.text.length;
    }
  }
  if (atoms.length === 0) return [{ start: 0, end: value.length }];

  let rowStart = 0;
  let col = 0;
  const flush = (end: number): void => {
    rows.push({ start: rowStart, end });
    rowStart = end;
    col = 0;
  };
  for (const a of atoms) {
    const aEnd = a.start + a.text.length;
    if (a.br) {
      // A newline ends the current row: the `\n` sits at the row's end (renderRow strips it from the
      // displayed text). The next row starts right after it — rows stay contiguous over the value.
      flush(aEnd);
      continue;
    }
    const aCells = cells(a.text);
    if (a.atomic || aCells <= width) {
      // A whole unit (image token OR a word chunk that fits within a full row): if it doesn't fit in
      // the remaining room and the row already has content, wrap to a fresh row FIRST — never split it.
      if (aCells > width - col && col > 0) flush(a.start);
      col += aCells; // an oversized atomic token may exceed width — acceptable (rare, kept whole)
      if (col >= width) flush(aEnd);
    } else {
      // A single word longer than the whole width: hard-break it across rows — walking CODE POINTS
      // and accumulating CELLS, so a double-width char never straddles the terminal edge.
      let s = a.start;
      if (col > 0) flush(s); // start the long word on a fresh row
      for (const ch of a.text) {
        const w = charCells(ch);
        if (col + w > width && col > 0) flush(s);
        col += w;
        s += ch.length;
        if (col >= width) flush(s);
      }
    }
  }
  // Flush the tail. If content exactly filled the last flushed row (rowStart === value.length), we add
  // an EMPTY trailing row so an end-of-line cursor doesn't overflow the full row (would wrap oddly).
  if (rowStart < value.length) {
    rows.push({ start: rowStart, end: value.length });
  } else if (rows.length === 0) {
    rows.push({ start: 0, end: value.length }); // whole value fit on one (un-flushed) row
  } else if (rowStart === value.length && col === 0) {
    rows.push({ start: value.length, end: value.length }); // exactly-full last row → empty tail for the cursor
  }
  return rows;
}

/** Render a single visual row of the prompt: text + highlighted image tokens, drawing the block
 *  cursor (inverse cell) when it falls on this row. Splitting happens on precomputed rows so the
 *  whole prompt never reflows as a single <Text> — stable under wrapping and quick to diff. */
function renderRow(value: string, row: Row, cursor: number, showCursor: boolean, isLastRow: boolean, keyPrefix: string): ReactNode {
  // `\n` chars are row SEPARATORS (wrapRows already broke the row on them) — never render them, or ink
  // would insert a second line break and desync the deterministic layout.
  const seg = (token: boolean, text: string, k: string): ReactNode =>
    token ? (
      <Text key={k} backgroundColor="magenta" color="white">
        {text.replace(/\n/g, "")}
      </Text>
    ) : (
      <Text key={k}>{text.replace(/\n/g, "")}</Text>
    );
  // Segments intersected with this row's [start,end) range.
  const parts = segmentize(value);
  const nodes: ReactNode[] = [];
  let ki = 0;
  let pos = 0;
  const cursorOnRow = showCursor && cursor >= row.start && cursor < row.end;
  for (const p of parts) {
    const pStart = pos;
    const pEnd = pos + p.text.length;
    pos = pEnd;
    const from = Math.max(pStart, row.start);
    const to = Math.min(pEnd, row.end);
    if (from >= to) continue; // segment not on this row
    const slice = p.text.slice(from - pStart, to - pStart);
    if (cursorOnRow && cursor >= from && cursor < to) {
      const rel = cursor - from;
      if (rel > 0) nodes.push(seg(p.token, slice.slice(0, rel), `${keyPrefix}s${ki++}`));
      nodes.push(
        <Text key={`${keyPrefix}c${ki++}`} inverse>
          {slice[rel] === "\n" ? " " : slice[rel]}
        </Text>,
      );
      if (rel + 1 < slice.length) nodes.push(seg(p.token, slice.slice(rel + 1), `${keyPrefix}e${ki++}`));
    } else {
      nodes.push(seg(p.token, slice, `${keyPrefix}p${ki++}`));
    }
  }
  // End-of-value cursor: a trailing inverse space, only ever on the LAST row (so it's drawn once).
  if (showCursor && isLastRow && cursor >= value.length && cursor >= row.start) {
    nodes.push(
      <Text key={`${keyPrefix}end`} inverse>
        {" "}
      </Text>,
    );
  }
  return nodes;
}

/** Max input rows drawn at once. A long multi-line paste (a spec, a stack trace, a design brief) wraps
 *  to hundreds/thousands of rows; rendering them ALL every keystroke floods ink's layout+diff and the
 *  box appears frozen ("卡着"). So we draw a bottom-anchored viewport (codex-style) around the cursor. */
export const MAX_INPUT_ROWS = 14;

/** The [first, last) slice of rows to render so the cursor stays visible without drawing the whole
 *  input. Bottom-anchored: when the cursor is at the end (typing), you see the last MAX rows; when
 *  editing mid-text, the cursor's row + a little context below stays on screen. Exported pure for tests. */
export function windowRows(rowCount: number, cursorRow: number, max = MAX_INPUT_ROWS): { first: number; last: number } {
  if (rowCount <= max) return { first: 0, last: rowCount };
  const last = Math.min(rowCount, Math.max(cursorRow + 2, max));
  return { first: Math.max(0, last - max), last };
}

/** Index of the wrapped row that holds the cursor (last row if past the end). */
export function cursorRowIndex(rows: Row[], cursor: number): number {
  for (let i = 0; i < rows.length; i++) if (cursor >= rows[i].start && cursor <= rows[i].end) return i;
  return Math.max(0, rows.length - 1);
}

/** The prompt: gutter + wrapped input rows (or a placeholder when empty). Each wrapped continuation
 *  row is indented under the gutter so the text column is stable. Memoized so it only re-renders when
 *  the value/cursor/width/gutter actually change (not when unrelated status ticks over). */
const InputLine = memo(function InputLine({
  value,
  cursor,
  width,
  gutter,
  gutterColor,
  placeholder,
}: {
  value: string;
  cursor: number;
  width: number;
  gutter: string;
  gutterColor: string;
  placeholder: string;
}) {
  const cols = Math.max(1, width - GUTTER); // text column width (after the 2-cell gutter)
  const rows = useMemo(() => (value.length ? wrapRows(value, cols) : [{ start: 0, end: 0 }]), [value, cols]);
  if (value.length === 0) {
    return (
      <Box>
        <Text color={gutterColor}>{gutter}</Text>
        <Text>
          <Text inverse> </Text>
          <Text dimColor>{placeholder}</Text>
        </Text>
      </Box>
    );
  }
  const { first, last } = windowRows(rows.length, cursorRowIndex(rows, cursor));
  return (
    <Box flexDirection="column">
      {first > 0 && <Text dimColor>{`  ⋯ ${first} more line${first > 1 ? "s" : ""} above`}</Text>}
      {rows.slice(first, last).map((row, k) => {
        const i = first + k;
        return (
          <Box key={i}>
            <Text color={gutterColor}>{i === 0 ? gutter : "  "}</Text>
            <Text>{renderRow(value, row, cursor, true, i === rows.length - 1, `r${i}_`)}</Text>
          </Box>
        );
      })}
      {last < rows.length && <Text dimColor>{`  ⋯ ${rows.length - last} more line${rows.length - last > 1 ? "s" : ""} below`}</Text>}
    </Box>
  );
});

/** Bordered prompt box + one dim status footer (model · approval · route · cwd · usage · ctx),
 *  with an @path popup. */
export function InputBox({
  status,
  cwd,
  model,
  route,
  width,
  onSubmit,
  onClipboardImage,
  isActive = true,
  vim = false,
  placeholder = "Type a task · /help · @file · Ctrl+V paste image · shift+tab mode · Esc interrupts",
}: {
  status: Status;
  cwd: string;
  /** `<provider>:<model>` (or bare model) — the leading segment of the status footer. */
  model: string;
  /** Route host (gateway / custom baseURL). Omitted → the footer drops the route segment. */
  route?: string;
  width?: number;
  onSubmit?: (v: string, images?: ImageAttachment[]) => void;
  /** Read an image off the OS clipboard (Ctrl+V). Injected so the view stays side-effect-free in tests. */
  onClipboardImage?: () => ImageAttachment | null;
  isActive?: boolean;
  /** modal (vim) keybindings: Esc → normal mode (commands), i/a → insert */
  vim?: boolean;
  placeholder?: string;
}) {
  const { stdout } = useStdout();
  const w = width ?? stdout?.columns ?? 80;
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [pastes, setPastes] = useState<string[]>([]); // full text behind each [Paste #N] token
  const [mode, setMode] = useState<VimMode>("insert"); // vim only
  const [pending, setPending] = useState(""); // vim operator-pending (d/c/g)
  const [register, setRegister] = useState(""); // vim yank/delete register

  const set = (v: string, c: number): void => {
    setValue(v);
    setCursor(c);
    setSel(0);
    setDismissed(false);
  };

  // Attach an image: drop a highlighted `[Image #N]` token inline at the cursor and track the file
  // (codex / Claude-Code style). Backspace over the token removes both.
  const addImage = (img: ImageAttachment): void => {
    const tok = `[Image #${images.length + 1}]`;
    const before = value.slice(0, cursor);
    const ins = (before && !/\s$/.test(before) ? " " : "") + tok + " ";
    setValue(before + ins + value.slice(cursor));
    setCursor((before + ins).length);
    setImages((xs) => [...xs, img]);
    setSel(0);
    setDismissed(false);
  };

  // A big paste folds into a [Paste #N +L lines] token (Claude-Code/codex style) instead of flooding
  // the box: typing stays smooth (the VALUE stays short), the box stays small, and a multi-line paste
  // can no longer fire the newline-submit path mid-paste. Expanded back to the full text on submit.
  const addPaste = (text: string): void => {
    const lines = text.split("\n").length;
    const tok = `[Paste #${pastes.length + 1} +${lines} lines]`;
    const before = value.slice(0, cursor);
    const ins = (before && !/\s$/.test(before) ? " " : "") + tok + " ";
    setValue(before + ins + value.slice(cursor));
    setCursor((before + ins).length);
    setPastes((xs) => [...xs, text]);
    setSel(0);
    setDismissed(false);
  };
  const expandPastes = (text: string): string =>
    text.replace(/\[Paste #(\d+) \+\d+ lines\]/g, (m, d) => pastes[Number(d) - 1] ?? m);

  const submit = (text: string): void => {
    if (!text.trim() && images.length === 0) return; // nothing to send
    onSubmit?.(expandPastes(text), images.length ? images : undefined);
    set("", 0);
    setImages([]);
    setPastes([]);
    setMode("insert"); // a fresh prompt starts in insert
    setPending("");
  };

  const mention = activeMention(value, cursor);
  // FS scan only when the mention QUERY changes — not on every cursor move / unrelated keystroke.
  // (`mention.start` moves whenever the cursor does; keying off it re-scanned the disk needlessly.)
  const mentionQuery = isActive && mention && !dismissed ? mention.query : null;
  const candidates = useMemo(
    () => (mentionQuery !== null ? fileCandidates(cwd, mentionQuery, 8) : []),
    [cwd, mentionQuery],
  );
  const popupOpen = candidates.length > 0;
  const selIdx = popupOpen ? Math.min(sel, candidates.length - 1) : 0;

  const complete = (cand: string): void => {
    if (!mention) return;
    const before = value.slice(0, mention.start); // includes the leading '@'
    const after = value.slice(cursor);
    const insert = cand.endsWith("/") ? cand : cand + " "; // dirs keep drilling; files end the mention
    setValue(before + insert + after);
    setCursor((before + insert).length);
    setSel(0);
    setDismissed(false);
  };

  useInput(
    (input, key) => {
      if (popupOpen && (key.upArrow || key.downArrow)) {
        const n = candidates.length;
        setSel((s) => (key.downArrow ? (s + 1) % n : (s - 1 + n) % n));
        return;
      }
      if (popupOpen && (key.tab || key.return)) {
        complete(candidates[selIdx]);
        return;
      }
      if (key.escape) {
        if (popupOpen) {
          setDismissed(true);
          return;
        }
        if (vim && mode === "insert") {
          setMode("normal");
          setPending("");
        }
        return;
      }
      // vim NORMAL mode: printable keys are commands, not text (Enter/arrows/backspace still navigate/submit)
      if (vim && mode === "normal") {
        if (key.return) return submit(value);
        if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
        if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
        if (key.backspace || key.delete) return setCursor((c) => Math.max(0, c - 1));
        if (input && !key.ctrl && !key.meta) {
          const st = vimNormal({ value, cursor, mode, pending, register }, input);
          setValue(st.value);
          setCursor(st.cursor);
          setMode(st.mode);
          setPending(st.pending);
          setRegister(st.register);
          setSel(0);
          setDismissed(false);
        }
        return;
      }
      if (key.return) {
        submit(value);
        return;
      }
      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
      if (key.ctrl && input === "a") return setCursor(0);
      if (key.ctrl && input === "e") return setCursor(value.length);
      if (key.ctrl && input === "u") return set(value.slice(cursor), 0);
      if (key.ctrl && input === "v") {
        // paste a screenshot / image from the OS clipboard
        const img = onClipboardImage?.();
        if (img) addImage(img);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          const head = value.slice(0, cursor);
          const pm = /\[Paste #(\d+) \+\d+ lines\]\s?$/.exec(head); // paste token deletes whole + renumbers
          if (pm) {
            const n = Number(pm[1]);
            const kept = head.slice(0, pm.index) + value.slice(cursor);
            const renumbered = kept.replace(/\[Paste #(\d+)( \+\d+ lines\])/g, (m2, d, tail) => (Number(d) > n ? `[Paste #${Number(d) - 1}${tail}` : m2));
            setPastes((xs) => xs.filter((_, i) => i !== n - 1));
            setValue(renumbered);
            setCursor(pm.index);
            setSel(0);
            setDismissed(false);
            return;
          }
          const tm = /\[Image #(\d+)\]\s?$/.exec(head); // backspacing over an attachment token removes it whole
          if (tm) {
            const n = Number(tm[1]);
            const kept = head.slice(0, tm.index) + value.slice(cursor);
            const renumbered = kept.replace(/\[Image #(\d+)\]/g, (m2, d) => (Number(d) > n ? `[Image #${Number(d) - 1}]` : m2));
            setImages((xs) => xs.filter((_, i) => i !== n - 1));
            setValue(renumbered);
            setCursor(tm.index);
            setSel(0);
            setDismissed(false);
            return;
          }
          set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        // A lone newline delivered through `input` (some terminals send Enter this way instead of
        // setting key.return) = the user pressed Enter → submit.
        if (/^[\r\n]+$/.test(input)) {
          submit(value);
          return;
        }
        // A PASTE containing newlines inserts as REAL MULTI-LINE TEXT (normalize CRLF/CR → LF) — the
        // user sees and can edit it, and a pasted newline is content, NOT "send" (only a real Enter,
        // above / key.return, submits). Only a truly ENORMOUS dump folds to a `[Paste #N]` token, so a
        // 500-line paste doesn't turn the box into a wall — normal multi-line pastes stay visible.
        const hasNL = /[\r\n]/.test(input);
        if (input.length >= 8000) {
          addPaste(input.replace(/\r\n?/g, "\n"));
          return;
        }
        if (hasNL) {
          const text = input.replace(/\r\n?/g, "\n");
          set(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
          return;
        }
        // a dragged-in / pasted image file path attaches instead of inserting literal text
        if (input.length > 3) {
          const img = imagePathFromPaste(input, cwd);
          if (img) {
            addImage(img);
            return;
          }
        }
        set(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
      }
    },
    { isActive },
  );

  const gutter = vim && mode === "normal" ? "◆ " : "› ";
  const gutterColor = vim ? (mode === "normal" ? "yellow" : "green") : "cyan";

  // The box borders (1 each side) + paddingX (1 each side) subtract 4 cells; InputLine's deterministic
  // wrap needs the INNER width so the cursor/continuation gutter stay exact. The box is a fixed `width={w}`
  // with `borderTop={false}` so the hand-drawn TopBorder (with the session title) supplies the top edge
  // + corners and everything aligns column-for-column.
  const innerW = Math.max(1, w - 4);
  const cwdShort = footerCwd(cwd);
  return (
    <Box flexDirection="column">
      <TopBorder name={status.sessionName || "session"} width={w} />
      <Box borderStyle="round" borderTop={false} borderColor="gray" borderDimColor paddingX={1} width={w}>
        <InputLine value={value} cursor={cursor} width={innerW} gutter={gutter} gutterColor={gutterColor} placeholder={placeholder} />
      </Box>
      {vim ? <Text dimColor>{mode === "normal" ? "  -- NORMAL --  i/a insert · h l 0 $ w b e move · x dd D cw p edit" : "  -- INSERT --  Esc → normal"}</Text> : null}
      <Footer model={model} s={status} cwdShort={cwdShort} route={route} />
      {popupOpen ? <MentionPopup items={candidates} selected={selIdx} query={mention!.query} /> : null}
    </Box>
  );
}
