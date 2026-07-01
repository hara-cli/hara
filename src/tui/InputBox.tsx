// The framed input box (ink): a top border carrying the session name in the right corner, the
// prompt line in the middle, and a bottom border carrying the approval modes + token usage +
// concurrency. Composed from <Text> rows (no ink border fork needed) so the title sits exactly
// where we want it. Pure-ish: pass `width` to make rendering deterministic in tests.
//
// Render-stability principles (codex-style, for slow/remote terminals): ink erases and rewrites the
// ENTIRE dynamic region on every frame, so the box's cost scales with (a) how many lines it occupies
// and (b) how often any of them change. Two levers here:
//   1. The static chrome (borders, mode bar, mention popup) is memoized so a keystroke that only
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

const TopBorder = memo(function TopBorder({ name, width }: { name: string; width: number }) {
  const labelLen = name.length + 2; // "⏺ " + name
  const left = Math.max(2, width - labelLen - 3);
  return (
    <Box>
      <Text dimColor>{"─".repeat(left)} </Text>
      <Text color="cyan">⏺</Text>
      <Text bold> {name}</Text>
      <Text dimColor> ─</Text>
    </Box>
  );
});

// Bottom border carries token usage + concurrency at the right corner (modes moved to ModeBar below).
const BottomBorder = memo(function BottomBorder({ s, width }: { s: Status; width: number }) {
  // Always render `ctx N%` (from 0 on) so the field is present from the first frame — otherwise it
  // pops in mid-session the moment ctx first exceeds 0, shifting the whole bottom-border layout.
  const usage = `↑${tok(s.input)} ↓${tok(s.output)} · ctx ${s.ctxPct}%`;
  const label = s.agents > 0 ? `${usage} · ⛁${s.agents}` : `${usage} · ⛁ idle`;
  const left = Math.max(2, width - label.length - 3);
  return (
    <Box>
      <Text dimColor>{`${"─".repeat(left)} ${label} ─`}</Text>
    </Box>
  );
});

const MODE_DESC: Record<Approval, string> = {
  suggest: "confirms edits & commands",
  "auto-edit": "auto-applies edits · asks before commands",
  "full-auto": "runs everything — no prompts  ⚠",
  plan: "investigate read-only, then propose a plan to approve",
};

// Prominent approval-mode selector below the box: all three listed, the active one highlighted (red
// for the dangerous full-auto) with a one-line description and the shift+tab hint.
const ModeBar = memo(function ModeBar({ approval }: { approval: Approval }) {
  const warn = approval === "full-auto";
  return (
    <Box flexDirection="column">
      <Box>
        {MODES.map((m, i) => (
          <Text key={m}>
            {i > 0 ? "   " : "  "}
            {m === approval ? <Text color={warn ? "red" : m === "plan" ? "cyan" : "green"} bold>{`◆ ${m}`}</Text> : <Text dimColor>{m}</Text>}
          </Text>
        ))}
      </Box>
      <Text dimColor>{`    ${MODE_DESC[approval]} · shift+tab ⇄`}</Text>
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

const TOKEN_RE = /\[Image #\d+\]/g;

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

/** Wrap `value` into rows that each fit within `cols` cells, breaking on spaces where possible but
 *  never inside an `[Image #N]` token. Deterministic (no reliance on ink's soft-wrap) so wrapped rows
 *  align under a stable gutter and the cursor position is exact. Always returns at least one row. */
export function wrapRows(value: string, cols: number): Row[] {
  const width = Math.max(1, cols);
  const rows: Row[] = [];
  const parts = segmentize(value);
  // Flatten to atomic units: a run of text is breakable per-char/word; an image token is atomic.
  const atoms: { text: string; start: number; atomic: boolean }[] = [];
  let pos = 0;
  for (const p of parts) {
    if (p.token) {
      atoms.push({ text: p.text, start: pos, atomic: true });
      pos += p.text.length;
    } else {
      // Break the text run into word chunks (keep trailing space with the word) so wraps land on spaces.
      const re = /\S+\s*|\s+/g;
      let m: RegExpExecArray | null;
      let base = pos;
      while ((m = re.exec(p.text))) {
        atoms.push({ text: m[0], start: base + m.index, atomic: false });
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
    if (a.atomic || a.text.length <= width) {
      // A whole unit (image token OR a word chunk that fits within a full row): if it doesn't fit in
      // the remaining room and the row already has content, wrap to a fresh row FIRST — never split it.
      if (a.text.length > width - col && col > 0) flush(a.start);
      col += a.text.length; // an oversized atomic token may exceed width — acceptable (rare, kept whole)
      if (col >= width) flush(aEnd);
    } else {
      // A single word longer than the whole width: hard-break it across rows.
      let s = a.start;
      if (col > 0) flush(s); // start the long word on a fresh row
      while (s < aEnd) {
        const room = width - col;
        const take = Math.min(room, aEnd - s);
        col += take;
        s += take;
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
  const seg = (token: boolean, text: string, k: string): ReactNode =>
    token ? (
      <Text key={k} backgroundColor="magenta" color="white">
        {text}
      </Text>
    ) : (
      <Text key={k}>{text}</Text>
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
          {slice[rel]}
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
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Box key={i}>
          <Text color={gutterColor}>{i === 0 ? gutter : "  "}</Text>
          <Text>{renderRow(value, row, cursor, true, i === rows.length - 1, `r${i}_`)}</Text>
        </Box>
      ))}
    </Box>
  );
});

/** Top border (session) + prompt line + bottom border (usage) + ModeBar, with an @path popup. */
export function InputBox({
  status,
  cwd,
  width,
  onSubmit,
  onClipboardImage,
  isActive = true,
  working = false,
  queued = 0,
  vim = false,
  placeholder = "Type a task · /help · @file · Ctrl+V paste image · shift+tab mode · Esc interrupts",
}: {
  status: Status;
  cwd: string;
  width?: number;
  onSubmit?: (v: string, images?: ImageAttachment[]) => void;
  /** Read an image off the OS clipboard (Ctrl+V). Injected so the view stays side-effect-free in tests. */
  onClipboardImage?: () => ImageAttachment | null;
  isActive?: boolean;
  /** the agent is mid-turn — typing here is type-ahead (queued, sent when the turn finishes) */
  working?: boolean;
  /** how many messages are already queued (for the hint) */
  queued?: number;
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

  const submit = (text: string): void => {
    if (!text.trim() && images.length === 0) return; // nothing to send
    onSubmit?.(text, images.length ? images : undefined);
    set("", 0);
    setImages([]);
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
        const nl = input.search(/[\r\n]/); // a chunk carrying a newline (paste / fed input) submits
        if (nl >= 0) {
          submit(value.slice(0, cursor) + input.slice(0, nl) + value.slice(cursor));
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

  return (
    <Box flexDirection="column">
      <TopBorder name={status.sessionName || "session"} width={w} />
      <InputLine value={value} cursor={cursor} width={w} gutter={gutter} gutterColor={gutterColor} placeholder={placeholder} />
      {vim ? <Text dimColor>{mode === "normal" ? "  -- NORMAL --  i/a insert · h l 0 $ w b e move · x dd D cw p edit" : "  -- INSERT --  Esc → normal"}</Text> : null}
      <BottomBorder s={status} width={w} />
      {working ? <Text dimColor>{`  ⌨ working — Enter queues your message${queued ? ` · ${queued} queued` : ""} · Esc interrupts`}</Text> : null}
      {popupOpen ? <MentionPopup items={candidates} selected={selIdx} query={mention!.query} /> : null}
      <ModeBar approval={status.approval} />
    </Box>
  );
}
