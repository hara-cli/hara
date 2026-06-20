// The framed input box (ink): a top border carrying the session name in the right corner, the
// prompt line in the middle, and a bottom border carrying the approval modes + token usage +
// concurrency. Composed from <Text> rows (no ink border fork needed) so the title sits exactly
// where we want it. Pure-ish: pass `width` to make rendering deterministic in tests.
import { Box, Text, useInput, useStdout } from "ink";
import { useMemo, useState, type ReactNode } from "react";
import { fileCandidates } from "../context/mentions.js";
import { imagePathFromPaste } from "../images.js";
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

function TopBorder({ name, width }: { name: string; width: number }) {
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
}

// Bottom border carries token usage + concurrency at the right corner (modes moved to ModeBar below).
function BottomBorder({ s, width }: { s: Status; width: number }) {
  const usage = `↑${tok(s.input)} ↓${tok(s.output)}${s.ctxPct > 0 ? ` · ctx ${s.ctxPct}%` : ""}`;
  const label = s.agents > 0 ? `${usage} · ⛁${s.agents}` : `${usage} · ⛁ idle`;
  const left = Math.max(2, width - label.length - 3);
  return (
    <Box>
      <Text dimColor>{`${"─".repeat(left)} ${label} ─`}</Text>
    </Box>
  );
}

const MODE_DESC: Record<Approval, string> = {
  suggest: "confirms edits & commands",
  "auto-edit": "auto-applies edits · asks before commands",
  "full-auto": "runs everything — no prompts  ⚠",
  plan: "investigate read-only, then propose a plan to approve",
};

// Prominent approval-mode selector below the box: all three listed, the active one highlighted (red
// for the dangerous full-auto) with a one-line description and the shift+tab hint.
function ModeBar({ approval }: { approval: Approval }) {
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
}

/** The active `@mention` token immediately left of the cursor (for the file popup), or null. */
function activeMention(value: string, cursor: number): { query: string; start: number } | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, cursor));
  return m ? { query: m[1], start: cursor - m[1].length } : null;
}

// Dropdown of fuzzy @path matches, shown above the input as you type `@…` (codex / Claude-Code style).
function MentionPopup({ items, selected, query }: { items: string[]; selected: number; query: string }) {
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
}

const TOKEN_RE = /\[Image #\d+\]/g;

/** Render the prompt line: plain text + the cursor, with any `[Image #N]` attachment tokens highlighted
 *  (codex / Claude-Code style — the image lives inline in the text, visibly distinct from what you typed). */
function InputLine({ value, cursor }: { value: string; cursor: number }) {
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
  const seg = (token: boolean, text: string, k: string) =>
    token ? (
      <Text key={k} backgroundColor="magenta" color="white">
        {text}
      </Text>
    ) : (
      <Text key={k}>{text}</Text>
    );
  const nodes: ReactNode[] = [];
  let pos = 0;
  let ki = 0;
  for (const p of parts) {
    const start = pos;
    const end = pos + p.text.length;
    if (cursor >= start && cursor < end) {
      const rel = cursor - start;
      if (rel > 0) nodes.push(seg(p.token, p.text.slice(0, rel), `s${ki++}`));
      nodes.push(
        <Text key={`c${ki++}`} inverse>
          {p.text[rel]}
        </Text>,
      );
      if (rel + 1 < p.text.length) nodes.push(seg(p.token, p.text.slice(rel + 1), `e${ki++}`));
    } else {
      nodes.push(seg(p.token, p.text, `p${ki++}`));
    }
    pos = end;
  }
  if (cursor >= value.length)
    nodes.push(
      <Text key="end" inverse>
        {" "}
      </Text>,
    );
  return <Text>{nodes}</Text>;
}

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
  placeholder?: string;
}) {
  const { stdout } = useStdout();
  const w = width ?? stdout?.columns ?? 80;
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>([]);

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
  };

  const mention = activeMention(value, cursor);
  const candidates = useMemo(
    () => (isActive && mention && !dismissed ? fileCandidates(cwd, mention.query, 8) : []),
    [cwd, isActive, dismissed, mention?.query, mention?.start],
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
        if (popupOpen) setDismissed(true);
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

  return (
    <Box flexDirection="column">
      <TopBorder name={status.sessionName || "session"} width={w} />
      <Box>
        <Text color="cyan">{"› "}</Text>
        {value.length === 0 ? (
          <Text>
            <Text inverse> </Text>
            <Text dimColor>{placeholder}</Text>
          </Text>
        ) : (
          <InputLine value={value} cursor={cursor} />
        )}
      </Box>
      <BottomBorder s={status} width={w} />
      {working ? <Text dimColor>{`  ⌨ working — Enter queues your message${queued ? ` · ${queued} queued` : ""} · Esc interrupts`}</Text> : null}
      {popupOpen ? <MentionPopup items={candidates} selected={selIdx} query={mention!.query} /> : null}
      <ModeBar approval={status.approval} />
    </Box>
  );
}
