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
import type { ImageAttachment } from "../providers/types.js";
import { activity } from "../activity.js";
import { ctxPctFor } from "../statusbar.js";
import { accent } from "./theme.js";
import { renderMarkdown } from "../md.js";

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
  select: (title: string, options: { label: string; value: string }[]) => Promise<string>;
  setApproval: (m: Approval) => void;
  signal: AbortSignal;
  exit: () => void;
  approval: Approval;
}
export interface AppProps {
  initialStatus: Status;
  model: string;
  cwd: string;
  header?: { version: string; model: string; cwd: string; tip?: string; vision?: string; session?: string };
  onSubmit: (line: string, h: Helpers, images?: ImageAttachment[]) => Promise<void>;
  cycleApproval?: (cur: Approval) => Approval;
  /** Read an image off the OS clipboard for Ctrl+V (injected; omitted in tests). */
  onClipboardImage?: () => ImageAttachment | null;
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
      return <Text>{renderMarkdown(item.text)}</Text>; // headers/bold/inline-code/bullets + verbatim fences
    case "reasoning": {
      // fixed-height window: show the last 5 lines while thinking; ctrl-r toggles the full text.
      const lines = item.text.replace(/\n+$/, "").split("\n");
      const long = lines.length > 5;
      const shown = open || !long ? lines : lines.slice(-5);
      const hint = long ? (open ? " · ctrl-r collapse" : " · ctrl-r expand") : "";
      return (
        <Box flexDirection="column">
          <Text color={accent()} dimColor>{`✻ thinking … ${lines.length} line${lines.length === 1 ? "" : "s"}${hint}`}</Text>
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
function HeaderCard({ version, model, cwd, tip, vision, session }: { version: string; model: string; cwd: string; tip?: string; vision?: string; session?: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {BANNER.map((row, i) => (
        <Text key={i} color={accent()}>
          {row}
        </Text>
      ))}
      <Text dimColor>{` the coding agent that runs like an org   ·   v${version}`}</Text>
      <Text dimColor>{` ${model}  ·  ${cwd}`}</Text>
      {session ? <Text dimColor>{` session ${session}`}</Text> : null}
      {vision ? (
        <Text>
          <Text color={accent()}>{" 👁 "}</Text>
          <Text dimColor>{vision}</Text>
        </Text>
      ) : null}
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

export function App({ initialStatus, model, cwd, header, onSubmit, cycleApproval, onClipboardImage }: AppProps) {
  const { exit } = useApp();
  const [history, setHistory] = useState<Item[]>([]);
  const [current, setCurrent] = useState<Item[]>([]);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<Status>({ ...initialStatus, agents: 0 });
  const [prompt, setPrompt] = useState<{ title: string; options: { label: string; value: unknown; key?: string }[]; resolve: (v: unknown) => void } | null>(null);
  const [promptSel, setPromptSel] = useState(0);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);
  const queueRef = useRef<{ line: string; images?: ImageAttachment[] }[]>([]); // type-ahead: FIFO of messages entered while working
  const [pool, setPool] = useState<string[]>([]); // type-ahead pool: queued message lines, shown above the input
  const drainingRef = useRef(false); // idempotency guard so the drain effect can't double-send one item
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
    async (line: string, images?: ImageAttachment[]): Promise<void> => {
      const t = line.trim();
      if ((!t && !images?.length) || prompt) return; // nothing to send, or a choice is pending
      if (working) {
        // type-ahead: hold the message in the pool; all pooled messages are sent together when the turn ends
        queueRef.current.push({ line, images });
        setPool(queueRef.current.map((q) => q.line.trim() || "🖼 (image)"));
        return;
      }
      setHistory((h) => [...h, { id: nid(), kind: "user", text: t }]); // t already carries any [Image #N] tokens
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
      const openPrompt = <T,>(title: string, options: { label: string; value: T; key?: string }[]): Promise<T> =>
        new Promise((resolve) => {
          setPromptSel(0);
          setPrompt({ title, options: options as { label: string; value: unknown; key?: string }[], resolve: resolve as (v: unknown) => void });
        });
      const confirmFn = (q: string): Promise<boolean | "always"> =>
        openPrompt<boolean | "always">(q, [
          { label: "Yes", value: true, key: "y" },
          { label: "Yes, and don't ask again this session", value: "always", key: "a" },
          { label: "No  (esc)", value: false, key: "n" },
        ]);
      const selectFn = (title: string, options: { label: string; value: string }[]): Promise<string> => openPrompt(title, options);
      const setApprovalFn = (m: Approval): void => setStatus((s) => ({ ...s, approval: m }));
      try {
        await onSubmit(t, { sink, confirm: confirmFn, select: selectFn, setApproval: setApprovalFn, signal: ctrl.signal, exit, approval: statusRef.current.approval }, images);
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
    [working, prompt, onSubmit, pushCurrent, model, exit],
  );

  // Drain the type-ahead pool: when the turn finishes (working → false) and nothing awaits a choice, COALESCE
  // every pooled message into ONE turn and send it — additions/clarifications go to the agent together, in order.
  useEffect(() => {
    if (working || prompt || drainingRef.current || !queueRef.current.length) return;
    drainingRef.current = true;
    const batch = queueRef.current;
    queueRef.current = [];
    setPool([]);
    const line = batch.map((b) => b.line).join("\n\n");
    const images = batch.flatMap((b) => b.images ?? []);
    void Promise.resolve(handleSubmit(line, images.length ? images : undefined)).finally(() => {
      drainingRef.current = false;
    });
  }, [working, prompt, handleSubmit]);

  useInput((input, key) => {
    if (prompt) {
      const opts = prompt.options;
      if (key.upArrow) setPromptSel((s) => (s - 1 + opts.length) % opts.length);
      else if (key.downArrow) setPromptSel((s) => (s + 1) % opts.length);
      else if (key.return) {
        prompt.resolve(opts[Math.min(promptSel, opts.length - 1)].value);
        setPrompt(null);
      } else if (key.escape) {
        prompt.resolve(opts[opts.length - 1].value); // last option = cancel/no
        setPrompt(null);
      } else if (/^[1-9]$/.test(input) && Number(input) <= opts.length) {
        prompt.resolve(opts[Number(input) - 1].value); // type a number to pick directly
        setPrompt(null);
      } else if (input) {
        const hit = opts.find((o) => o.key && o.key === input.toLowerCase());
        if (hit) {
          prompt.resolve(hit.value);
          setPrompt(null);
        }
      }
      return;
    }
    if (key.ctrl && input === "r") return setReasoningOpen((x) => !x);
    if (key.escape && working) {
      // Esc = stop everything: abort the turn AND drop any type-ahead (a stopped turn shouldn't fire queued msgs)
      if (queueRef.current.length) {
        queueRef.current = [];
        setPool([]);
      }
      ctrlRef.current?.abort();
    }
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
      {working && !prompt && <Working />}
      {prompt && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">{`  ${stripAnsi(prompt.title)}`}</Text>
          {prompt.options.map((o, i) => (
            <Text key={i} color={i === promptSel ? "cyan" : undefined} bold={i === promptSel}>
              {(i === promptSel ? " ❯ " : "   ") + `${i + 1}. ` + o.label}
            </Text>
          ))}
          <Text dimColor>{`   ↑↓ or 1–${prompt.options.length} to choose · Enter · Esc cancels`}</Text>
        </Box>
      )}
      {pool.length > 0 && !prompt && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{`  📥 pool (${pool.length}) — sent together when this turn finishes:`}</Text>
          {pool.map((l, i) => (
            <Text key={i} dimColor>{`   ${i + 1}. ${l.length > 64 ? l.slice(0, 64) + "…" : l}`}</Text>
          ))}
        </Box>
      )}
      <InputBox status={status} cwd={cwd} isActive={!prompt} working={working} queued={pool.length} onSubmit={handleSubmit} onClipboardImage={onClipboardImage} />
    </Box>
  );
}
