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
import { currentTodos, onTodosChange, type Todo } from "../tools/todo.js";

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
  /** Type-ahead steering: drain messages queued while the turn ran (shows each inline), for the
   *  runner to inject before the next model call. Returns [] when nothing is queued. */
  drainQueue: () => { line: string; images?: ImageAttachment[] }[];
}
/** Structured identity/header info — the runtime (index.ts) builds this once, the view
 *  branches on `kind` to render `personal` vs `org` differently (顾雅 spec). Keep this
 *  pure data; presentation lives in `HeaderCard`. */
export interface HeaderInfo {
  version: string;
  /** `<provider>:<model>` — drives the identity line (personal) and the model line (org). */
  modelLabel: string;
  /** Tilde-shortened cwd (rendered as-is by the view). */
  cwd: string;
  /** Truthy when AGENTS.md was loaded for this run — the cwd line appends "· AGENTS.md".
   *  We intentionally do NOT render "no AGENTS.md" when false — silence beats negative noise. */
  agentsMdLoaded?: boolean;
  /** Short session id (8 chars; index.ts uses `shortId`). */
  session?: string;
  /** Identity kind: drives the layout of the first identity line + presence of the `model` line. */
  kind: "personal" | "org";
  /** When `kind === 'personal'` AND `profileId !== 'personal'` we render `personal:<id>`
   *  (rare: multiple personal profiles). For the default `personal` id leave undefined. */
  profileId?: string;
  /** When `kind === 'org'`: the org's friendly label (e.g. "Acme Inc"). */
  orgLabel?: string;
  /** When `kind === 'org'`: the org-side device/user id (e.g. "acme-jeff"). */
  orgId?: string;
  /** Route host (no scheme, no path). Personal: only present when the user set a CUSTOM baseURL.
   *  Org: always present (the gateway host). */
  routeHost?: string;
  /** When `kind === 'org'`: source of the current model — "org default" / "user override"
   *  / "/model override". Drives the suffix of the model line. */
  modelSource?: string;
}

export interface AppProps {
  initialStatus: Status;
  model: string;
  cwd: string;
  header?: HeaderInfo;
  onSubmit: (line: string, h: Helpers, images?: ImageAttachment[]) => Promise<void>;
  cycleApproval?: (cur: Approval) => Approval;
  /** Read an image off the OS clipboard for Ctrl+V (injected; omitted in tests). */
  onClipboardImage?: () => ImageAttachment | null;
  /** modal (vim) keybindings in the input box */
  vim?: boolean;
  /** Vision routing notice text (e.g. "glm-5 is text-only — images read by qwen-vl-max").
   *  When set, the FIRST image attachment in this session triggers a one-shot inline notice.
   *  Header doesn't display it (顾雅: kill the always-on vision line). Undefined = native vision
   *  (no notice) or no describer configured (a different path warns when an image actually arrives). */
  visionNotice?: string;
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
      // Codex-style: stream the reasoning dim + italic with a leading "• " bullet; show the full text up to
      // MAX lines, fold longer to the live tail with a "… +N lines" summary. ctrl-r expands/collapses.
      const MAX = 10;
      const lines = item.text.replace(/\n+$/, "").split("\n");
      const long = lines.length > MAX;
      const shown = open || !long ? lines : lines.slice(-MAX); // short or expanded → all; long & collapsed → live tail
      const omitted = long && !open ? lines.length - MAX : 0;
      const hint = long ? (open ? " · ctrl-r collapse" : ` · … +${omitted} lines · ctrl-r expand`) : "";
      return (
        <Box flexDirection="column">
          <Text color={accent()} dimColor>{`✻ thinking … ${lines.length} line${lines.length === 1 ? "" : "s"}${hint}`}</Text>
          {shown.map((l, i) => (
            <Text key={i} dimColor italic>{`${i === 0 ? "• " : "  "}${l}`}</Text>
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

// ─── header helpers ────────────────────────────────────────────────────────────
// Pure functions so the view stays declarative and tests can pin the formatting
// without rendering ink. Exported for unit tests (see test/tui-header.test.mjs).

/** Extract the URL host (no scheme, no path, no query). Falls back to the raw
 *  string when `url` isn't parseable — better to surface something than swallow it. */
export function extractHost(url: string | undefined | null): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    // Strip a leading scheme + leading // if present (handles "git@host:..." style which URL() rejects).
    const noScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    return noScheme.split("/")[0].split("?")[0];
  }
}

/** Tilde-collapse the user's home directory. If the path is too long, keep the
 *  TAIL (most-specific segments) — the project name reads better than `~/work/…`.
 *  `maxLen` clamps the displayed length; default 60 fits in a 80-col terminal next
 *  to the "cwd       " label + an optional " · AGENTS.md" suffix. */
export function shortenHome(abs: string, home: string = process.env.HOME ?? "", maxLen = 60): string {
  let p = abs;
  if (home && (p === home || p.startsWith(home + "/"))) {
    p = "~" + p.slice(home.length);
  }
  if (p.length <= maxLen) return p;
  // Keep the last `maxLen - 2` chars, prefixed with `…/` to signal truncation.
  const tail = p.slice(-(maxLen - 2));
  // If the truncation lands inside a segment, advance to the next `/` for a clean break.
  const firstSlash = tail.indexOf("/");
  const clean = firstSlash > 0 ? tail.slice(firstSlash) : tail;
  return "…" + clean;
}

/** Render a session uuid (or any id) as its first 8 chars — same convention as `shortId`
 *  in src/session/store.ts. A second helper here so the view never reaches into the session
 *  module + so headers in tests can pass any string and get a stable display. */
export function shortenSession(uuid: string | undefined | null): string {
  if (!uuid) return "";
  return uuid.slice(0, 8);
}

/** Layout constants for the field grid. Field names live in a 10-char column;
 *  values start at column 12 (after 2 spaces). The view uses `padField` to
 *  pad a label so the values align vertically across rows. */
const FIELD_PAD = 10;
const padField = (name: string): string => name.padEnd(FIELD_PAD, " ");

function HeaderCard(props: HeaderInfo) {
  const { version, modelLabel, cwd, agentsMdLoaded, session, kind } = props;
  const home = process.env.HOME ?? "";
  const cwdShort = shortenHome(cwd, home);
  const sessionShort = shortenSession(session);
  // Identity line — branches on kind. Personal collapses kind+model into one line;
  // org splits identity (org/label/id/route) from model (with its source).
  const identity = kind === "org" ? (
    <Text>
      <Text dimColor>{`  ${padField("org")}`}</Text>
      <Text>{props.orgLabel ?? props.orgId ?? "(unnamed)"}</Text>
      {props.orgId && props.orgLabel ? <Text dimColor>{`  ·  ${props.orgId}`}</Text> : null}
      {props.routeHost ? (
        <Text>
          <Text dimColor>{"  →  "}</Text>
          <Text dimColor>{props.routeHost}</Text>
        </Text>
      ) : null}
    </Text>
  ) : (
    <Text>
      <Text dimColor>{`  ${padField(props.profileId ? `personal:${props.profileId}` : "personal")}`}</Text>
      <Text>{modelLabel}</Text>
      {props.routeHost ? (
        <Text>
          <Text dimColor>{"  →  "}</Text>
          <Text dimColor>{props.routeHost}</Text>
        </Text>
      ) : null}
    </Text>
  );
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={accent()}>{"> "}</Text>
        <Text color={accent()} bold>{`hara`}</Text>
        <Text dimColor>{` · v${version} — the coding agent that runs like an org`}</Text>
      </Text>
      <Text>{" "}</Text>
      {identity}
      {kind === "org" ? (
        <Text>
          <Text dimColor>{`  ${padField("model")}`}</Text>
          <Text>{modelLabel}</Text>
          {props.modelSource ? <Text dimColor>{`  ·  from ${props.modelSource}`}</Text> : null}
        </Text>
      ) : null}
      <Text>
        <Text dimColor>{`  ${padField("cwd")}`}</Text>
        <Text dimColor>{cwdShort}</Text>
        {agentsMdLoaded ? <Text dimColor>{"  ·  AGENTS.md"}</Text> : null}
      </Text>
      {sessionShort ? (
        <Text>
          <Text dimColor>{`  ${padField("session")}`}</Text>
          <Text dimColor>{sessionShort}</Text>
        </Text>
      ) : null}
      <Text>{" "}</Text>
      <Text dimColor>{"  /help · @file · shift+tab · esc"}</Text>
    </Box>
  );
}

// Spinner verb: while a turn is running, prefer the in_progress todo's activeForm (or its text),
// so the bottom line reads "▶ updating tests…" instead of an abstract "working". Falls back to
// the elapsed-seconds form when no checklist is active. Exported for unit testing.
export function spinnerVerb(list: Todo[], elapsedSec: number): string {
  const active = list.find((t) => t.status === "in_progress");
  if (active) {
    const phrase = active.activeForm?.trim() || active.text;
    return `${phrase}… ${elapsedSec}s · esc to interrupt`;
  }
  return `working ${elapsedSec}s · esc to interrupt`;
}

function Working({ todos }: { todos: Todo[] }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), 100);
    return () => clearInterval(id);
  }, []);
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  return (
    <Box marginTop={1}>
      <Text color="yellow">{frames[n % frames.length]}</Text>
      <Text dimColor>{` ${spinnerVerb(todos, Math.floor(n / 10))}`}</Text>
    </Box>
  );
}

// Live task panel: renders the current todo_write checklist between the in-progress turn output
// and the input box. Highlights the in_progress item; caps at 8 rows and folds the rest into
// `… +N pending/done`. Hidden when the list is empty.
const PANEL_MAX_ROWS = 8;
const TODO_MARK: Record<Todo["status"], string> = { pending: "☐", in_progress: "▶", done: "☑" };
function TodoPanel({ todos }: { todos: Todo[] }) {
  if (!todos.length) return null;
  const doneCount = todos.filter((t) => t.status === "done").length;
  // Prioritize visible rows: in_progress first, then pending, then done — show the most informative
  // slice when the list outgrows the cap. Stable order within each group via the original index.
  const indexed = todos.map((t, i) => ({ t, i }));
  const rank = (s: Todo["status"]): number => (s === "in_progress" ? 0 : s === "pending" ? 1 : 2);
  const prioritized = [...indexed].sort((a, b) => rank(a.t.status) - rank(b.t.status) || a.i - b.i);
  const visible = prioritized.slice(0, PANEL_MAX_ROWS).sort((a, b) => a.i - b.i).map((x) => x.t);
  const hidden = todos.length - visible.length;
  const hiddenSummary = hidden > 0 ? (() => {
    const remaining = prioritized.slice(PANEL_MAX_ROWS).map((x) => x.t);
    const p = remaining.filter((t) => t.status === "pending").length;
    const d = remaining.filter((t) => t.status === "done").length;
    const parts: string[] = [];
    if (p) parts.push(`${p} pending`);
    if (d) parts.push(`${d} done`);
    return ` … +${parts.join(", ")}`;
  })() : "";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={accent()}>{`  Todos (${doneCount}/${todos.length} done)`}</Text>
      {visible.map((t, i) => {
        const inProg = t.status === "in_progress";
        const done = t.status === "done";
        return (
          <Text key={i} color={inProg ? accent() : undefined} bold={inProg} dimColor={done}>
            {`  ${TODO_MARK[t.status]} ${t.text}`}
          </Text>
        );
      })}
      {hiddenSummary ? <Text dimColor>{hiddenSummary}</Text> : null}
    </Box>
  );
}

export function App({ initialStatus, model, cwd, header, onSubmit, cycleApproval, onClipboardImage, vim, visionNotice }: AppProps) {
  const { exit } = useApp();
  const [history, setHistory] = useState<Item[]>([]);
  const [current, setCurrent] = useState<Item[]>([]);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<Status>({ ...initialStatus, agents: 0 });
  const [prompt, setPrompt] = useState<{ title: string; options: { label: string; value: unknown; key?: string }[]; resolve: (v: unknown) => void } | null>(null);
  const [promptSel, setPromptSel] = useState(0);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  // Live checklist mirror: TodoPanel reads this, and `Working` derives its spinner verb from the
  // in_progress item. The tool emits on every todo_write — keeps the UI in lockstep with the agent.
  const [todos, setTodos] = useState<Todo[]>(() => currentTodos());
  // Collapse-after-turn: once a turn ends, leave the panel visible briefly (so the user sees the
  // final state) then fold it into a single-line "Todos: N/M done" notice in history. Cleared if
  // a new turn starts before the timer fires.
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Subscribe to todo_write updates so the panel re-renders when the agent edits the checklist.
  useEffect(() => {
    const unsub = onTodosChange((list) => {
      setTodos([...list]); // copy so React sees a new array (the tool reuses one)
      // A change mid-turn cancels any pending collapse — the user is still working with this list.
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
    });
    return () => {
      unsub();
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    };
  }, []);

  const pushCurrent = useCallback((kind: Kind, text: string, merge = false): void => {
    setCurrent((cur) => {
      const last = cur[cur.length - 1];
      if (merge && last && last.kind === kind) return [...cur.slice(0, -1), { ...last, text: last.text + text }];
      return [...cur, { id: nid(), kind, text }];
    });
  }, []);

  // Lazy vision notice: 顾雅 spec — the header no longer carries an always-on "👁 …" line.
  // Instead, the first time an image attachment shows up in this session, we print the
  // routing notice once (inline). `visionShownRef` is the session-scoped flag.
  const visionShownRef = useRef(false);
  const noteVisionIfNeeded = useCallback((): void => {
    if (visionShownRef.current || !visionNotice) return;
    visionShownRef.current = true;
    setHistory((h) => [...h, { id: nid(), kind: "notice", text: `  ⓘ ${visionNotice}` }]);
  }, [visionNotice]);

  // Type-ahead steering: hand the runner everything queued while the turn ran, showing each message
  // inline (as a user block) at the point it gets folded into the conversation. Drained mid-turn so an
  // addition reaches the model on its next call; whatever's still queued at turn end is the effect below.
  const drainQueue = useCallback((): { line: string; images?: ImageAttachment[] }[] => {
    if (!queueRef.current.length) return [];
    const batch = queueRef.current;
    queueRef.current = [];
    setPool([]);
    if (batch.some((b) => b.images?.length)) noteVisionIfNeeded();
    for (const b of batch) pushCurrent("user", b.line.trim() || "🖼 (image)");
    return batch;
  }, [pushCurrent, noteVisionIfNeeded]);

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
      if (images?.length) noteVisionIfNeeded(); // one-shot inline notice on first image of the session
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
        await onSubmit(t, { sink, confirm: confirmFn, select: selectFn, setApproval: setApprovalFn, signal: ctrl.signal, exit, approval: statusRef.current.approval, drainQueue }, images);
      } catch (e: unknown) {
        pushCurrent("notice", `error: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Commit this turn's items to scrollback. Read the LIVE current via the updater — currentRef only
      // syncs on render (line ~225), so a fast slash-only turn (/design, /help, /skills…) that pushes a
      // notice and returns before any re-render would otherwise commit nothing and lose the notice.
      setCurrent((cur) => {
        const committed = cur.map((it) =>
          it.kind === "reasoning"
            ? { ...it, kind: "notice" as const, text: `✻ thought · ${it.text.split("\n").filter((l) => l.trim()).length} lines` }
            : it,
        );
        if (committed.length) setHistory((h) => [...h, ...committed]);
        return [];
      });
      setWorking(false);
      ctrlRef.current = null;
      // Schedule a panel collapse: if there was a checklist this turn, fold it to a one-line summary
      // in scrollback after ~30s of quiet (i.e. no new todo_write or new turn).
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
      if (currentTodos().length) {
        collapseTimerRef.current = setTimeout(() => {
          const list = currentTodos();
          if (!list.length) return;
          const done = list.filter((t) => t.status === "done").length;
          setHistory((h) => [...h, { id: nid(), kind: "notice" as const, text: `  ✓ Todos: ${done}/${list.length} done` }]);
          collapseTimerRef.current = null;
        }, 30_000);
      }
    },
    [working, prompt, onSubmit, pushCurrent, model, exit, drainQueue, noteVisionIfNeeded],
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
      {!prompt && <TodoPanel todos={todos} />}
      {working && !prompt && <Working todos={todos} />}
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
        <Box flexDirection="column">
          {pool.map((l, i) => (
            <Text key={i} color={accent()}>{`  › ${l.length > 72 ? l.slice(0, 72) + "…" : l}`}</Text>
          ))}
        </Box>
      )}
      <InputBox status={status} cwd={cwd} isActive={!prompt} working={working} queued={pool.length} vim={vim} onSubmit={handleSubmit} onClipboardImage={onClipboardImage} />
    </Box>
  );
}
