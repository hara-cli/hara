// The framed input box (ink): a top border carrying the session name in the right corner, the
// prompt line in the middle, and a bottom border carrying the approval modes + token usage +
// concurrency. Composed from <Text> rows (no ink border fork needed) so the title sits exactly
// where we want it. Pure-ish: pass `width` to make rendering deterministic in tests.
import { Box, Text, useInput, useStdout } from "ink";
import { useMemo, useState } from "react";
import { fileCandidates } from "../context/mentions.js";

export const MODES = ["suggest", "auto-edit", "full-auto"] as const;
export type Approval = (typeof MODES)[number];

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
            {m === approval ? <Text color={warn ? "red" : "green"} bold>{`◆ ${m}`}</Text> : <Text dimColor>{m}</Text>}
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

/** Top border (session) + prompt line + bottom border (usage) + ModeBar, with an @path popup. */
export function InputBox({
  status,
  cwd,
  width,
  onSubmit,
  isActive = true,
  placeholder = "Type a task · /help · @file · shift+tab cycles mode · Esc interrupts",
}: {
  status: Status;
  cwd: string;
  width?: number;
  onSubmit?: (v: string) => void;
  isActive?: boolean;
  placeholder?: string;
}) {
  const { stdout } = useStdout();
  const w = width ?? stdout?.columns ?? 80;
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const set = (v: string, c: number): void => {
    setValue(v);
    setCursor(c);
    setSel(0);
    setDismissed(false);
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
        onSubmit?.(value);
        set("", 0);
        return;
      }
      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
      if (key.ctrl && input === "a") return setCursor(0);
      if (key.ctrl && input === "e") return setCursor(value.length);
      if (key.ctrl && input === "u") return set(value.slice(cursor), 0);
      if (key.backspace || key.delete) {
        if (cursor > 0) set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const nl = input.search(/[\r\n]/); // a chunk carrying a newline (paste / fed input) submits
        if (nl >= 0) {
          onSubmit?.(value.slice(0, cursor) + input.slice(0, nl) + value.slice(cursor));
          set("", 0);
          return;
        }
        set(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
      }
    },
    { isActive },
  );

  const at = value[cursor] ?? " ";
  return (
    <Box flexDirection="column">
      <TopBorder name={status.sessionName || "new session"} width={w} />
      <Box>
        <Text color="cyan">{"› "}</Text>
        {value.length === 0 ? (
          <Text>
            <Text inverse> </Text>
            <Text dimColor>{placeholder}</Text>
          </Text>
        ) : (
          <Text>
            {value.slice(0, cursor)}
            <Text inverse>{at}</Text>
            {value.slice(cursor + 1)}
          </Text>
        )}
      </Box>
      <BottomBorder s={status} width={w} />
      {popupOpen ? <MentionPopup items={candidates} selected={selIdx} query={mention!.query} /> : null}
      <ModeBar approval={status.approval} />
    </Box>
  );
}
