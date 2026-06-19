// The hara TUI (ink). Layout, top to bottom:
//   <Static>   committed transcript — rendered once each, scrolls into native scrollback
//   current    the in-progress turn's blocks (assistant text / reasoning / tool / diff), live
//   <Working>  spinner while a turn runs (Esc interrupts)
//   <InputBox> the pinned, bordered prompt (or a confirm prompt when a tool needs approval)
//
// The agent machinery is injected via `onSubmit` (a turn runner) so this view is testable with
// ink-testing-library against a fake runner — no provider/network needed.
import { Box, Static, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { InputBox, type Status, type Approval } from "./InputBox.js";
import { activity } from "../activity.js";
import { ctxPctFor } from "../statusbar.js";

export interface Sink {
  assistantDelta(t: string): void;
  reasoningDelta(t: string): void;
  tool(name: string, preview: string): void;
  diff(text: string): void;
  notice(text: string): void;
  usage(input: number, output: number): void;
  session(name: string): void;
}
export interface Helpers {
  sink: Sink;
  confirm: (q: string) => Promise<boolean | "always">;
  signal: AbortSignal;
  exit: () => void;
  approval: Approval;
}
export interface AppProps {
  initialStatus: Status;
  model: string;
  cwd: string;
  header?: { version: string; model: string; cwd: string; tip?: string };
  onSubmit: (line: string, h: Helpers) => Promise<void>;
  cycleApproval?: (cur: Approval) => Approval;
}

type Kind = "user" | "assistant" | "reasoning" | "tool" | "diff" | "notice";
interface Item {
  id: number;
  kind: Kind;
  text: string;
}
let _id = 0;
const nid = (): number => ++_id;
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const VIOLET = "#561FBB"; // nanhara brand violet — truecolor (degrades gracefully on 256/16-color terms)
const CONFIRM_OPTS: { label: string; reply: boolean | "always" }[] = [
  { label: "Yes", reply: true },
  { label: "Yes, and don't ask again this session", reply: "always" },
  { label: "No  (esc)", reply: false },
];

function Block({ item, open }: { item: Item; open?: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan">› </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return <Text>{item.text}</Text>;
    case "reasoning": {
      // fixed-height window: show the last 5 lines while thinking; ctrl-r toggles the full text.
      const lines = item.text.replace(/\n+$/, "").split("\n");
      const long = lines.length > 5;
      const shown = open || !long ? lines : lines.slice(-5);
      const hint = long ? (open ? " · ctrl-r collapse" : " · ctrl-r expand") : "";
      return (
        <Box flexDirection="column">
          <Text color={VIOLET} dimColor>{`✻ thinking … ${lines.length} line${lines.length === 1 ? "" : "s"}${hint}`}</Text>
          {shown.map((l, i) => (
            <Text key={i} dimColor>{`│ ${l}`}</Text>
          ))}
        </Box>
      );
    }
    case "tool":
      return <Text dimColor>{"  " + item.text}</Text>;
    case "diff":
      return <Text>{item.text}</Text>;
    case "notice":
      return <Text dimColor>{item.text}</Text>;
  }
}

// ASCII rendering of the nanhara "Λi" mark (small peak + big peak + italic i), in the brand violet.
// hara wordmark — FIGlet "ANSI Shadow". A recognizable banner reads better in a terminal than a
// pixel-faithful logo. Printed once at the top of the session; scrolls away with the transcript.
const BANNER = [
  "██╗  ██╗ █████╗ ██████╗  █████╗",
  "██║  ██║██╔══██╗██╔══██╗██╔══██╗",
  "███████║███████║██████╔╝███████║",
  "██╔══██║██╔══██║██╔══██╗██╔══██║",
  "██║  ██║██║  ██║██║  ██║██║  ██║",
  "╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝",
];
function HeaderCard({ version, model, cwd, tip }: { version: string; model: string; cwd: string; tip?: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {BANNER.map((row, i) => (
        <Text key={i} color={VIOLET}>
          {row}
        </Text>
      ))}
      <Text dimColor>{` the coding agent that runs like an org   ·   v${version}`}</Text>
      <Text dimColor>{` ${model}  ·  ${cwd}`}</Text>
      {tip ? <Text dimColor>{` ${tip}`}</Text> : null}
    </Box>
  );
}

function Working() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), 100);
    return () => clearInterval(id);
  }, []);
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  return (
    <Box marginTop={1}>
      <Text color="yellow">{frames[n % frames.length]}</Text>
      <Text dimColor>{` working ${Math.floor(n / 10)}s · esc to interrupt`}</Text>
    </Box>
  );
}

export function App({ initialStatus, model, cwd, header, onSubmit, cycleApproval }: AppProps) {
  const { exit } = useApp();
  const [history, setHistory] = useState<Item[]>([]);
  const [current, setCurrent] = useState<Item[]>([]);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<Status>({ ...initialStatus, agents: 0 });
  const [confirm, setConfirm] = useState<{ q: string; resolve: (r: boolean | "always") => void } | null>(null);
  const [confirmSel, setConfirmSel] = useState(0);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);
  const currentRef = useRef<Item[]>([]);
  currentRef.current = current;
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    const fn = (): void => setStatus((s) => ({ ...s, agents: activity.running }));
    activity.onChange(fn);
    return () => activity.onChange(null);
  }, []);

  const pushCurrent = useCallback((kind: Kind, text: string, merge = false): void => {
    setCurrent((cur) => {
      const last = cur[cur.length - 1];
      if (merge && last && last.kind === kind) return [...cur.slice(0, -1), { ...last, text: last.text + text }];
      return [...cur, { id: nid(), kind, text }];
    });
  }, []);

  const handleSubmit = useCallback(
    async (line: string): Promise<void> => {
      const t = line.trim();
      if (!t || working || confirm) return;
      setHistory((h) => [...h, { id: nid(), kind: "user", text: t }]);
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setWorking(true);
      const sink: Sink = {
        assistantDelta: (d) => pushCurrent("assistant", d, true),
        reasoningDelta: (d) => pushCurrent("reasoning", d, true),
        tool: (name, preview) => pushCurrent("tool", `↳ ${name}${preview ? " " + preview : ""}`),
        diff: (text) => pushCurrent("diff", text),
        notice: (text) => pushCurrent("notice", text),
        usage: (input, output) =>
          setStatus((s) => ({ ...s, input: s.input + input, output: s.output + output, ctxPct: ctxPctFor(model, input) })),
        session: (name) => setStatus((s) => ({ ...s, sessionName: name })),
      };
      const confirmFn = (q: string): Promise<boolean | "always"> =>
        new Promise((resolve) => {
          setConfirmSel(0);
          setConfirm({ q, resolve });
        });
      try {
        await onSubmit(t, { sink, confirm: confirmFn, signal: ctrl.signal, exit, approval: statusRef.current.approval });
      } catch (e: unknown) {
        pushCurrent("notice", `error: ${e instanceof Error ? e.message : String(e)}`);
      }
      const committed = currentRef.current.map((it) =>
        it.kind === "reasoning"
          ? { ...it, kind: "notice" as const, text: `✻ thought · ${it.text.split("\n").filter((l) => l.trim()).length} lines` }
          : it,
      );
      setHistory((h) => [...h, ...committed]);
      setCurrent([]);
      setWorking(false);
      ctrlRef.current = null;
    },
    [working, confirm, onSubmit, pushCurrent, model, exit],
  );

  useInput((input, key) => {
    if (confirm) {
      if (key.upArrow) setConfirmSel((s) => (s - 1 + CONFIRM_OPTS.length) % CONFIRM_OPTS.length);
      else if (key.downArrow) setConfirmSel((s) => (s + 1) % CONFIRM_OPTS.length);
      else if (key.return) {
        confirm.resolve(CONFIRM_OPTS[confirmSel].reply);
        setConfirm(null);
      } else if (input === "y" || input === "Y") {
        confirm.resolve(true);
        setConfirm(null);
      } else if (input === "a" || input === "A") {
        confirm.resolve("always");
        setConfirm(null);
      } else if (key.escape || input === "n" || input === "N") {
        confirm.resolve(false);
        setConfirm(null);
      }
      return;
    }
    if (key.ctrl && input === "r") return setReasoningOpen((x) => !x);
    if (key.escape && working) ctrlRef.current?.abort();
    else if (key.tab && key.shift && cycleApproval) setStatus((s) => ({ ...s, approval: cycleApproval(s.approval) }));
  });

  return (
    <Box flexDirection="column">
      <Static items={header ? [{ id: -1, kind: "notice" as const, text: "" }, ...history] : history}>
        {(item) => (item.id === -1 ? <HeaderCard key="hdr" {...header!} /> : <Block key={item.id} item={item} />)}
      </Static>
      {current.map((item) => (
        <Block key={item.id} item={item} open={reasoningOpen} />
      ))}
      {working && !confirm && <Working />}
      {confirm && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">{`  ${stripAnsi(confirm.q)}`}</Text>
          {CONFIRM_OPTS.map((o, i) => (
            <Text key={i} color={i === confirmSel ? "cyan" : undefined} bold={i === confirmSel}>
              {(i === confirmSel ? " ❯ " : "   ") + o.label}
            </Text>
          ))}
        </Box>
      )}
      <InputBox status={status} cwd={cwd} isActive={!working && !confirm} onSubmit={handleSubmit} />
    </Box>
  );
}
