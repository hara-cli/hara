// The hara TUI (ink). Layout, top to bottom:
//   <Static>    committed transcript — rendered once each, scrolls into native scrollback
//   current     the in-progress turn's blocks (assistant text / reasoning / tool / diff), live
//   <TodoPanel> live checklist (when the agent keeps one)
//   status slot ALWAYS one row: StatusRow (spinner while working / key hints idle) ⇄ ModeLine
//               (shift+tab picker) — constant height so the input box never bobs at turn boundaries
//   <InputBox>  the bordered prompt (or a confirm prompt when a tool needs approval)
//
// The agent machinery is injected via `onSubmit` (a turn runner) so this view is testable with
// ink-testing-library against a fake runner — no provider/network needed.
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { InputBox, MODES, approvalColor, type Status, type Approval } from "./InputBox.js";
import type { ImageAttachment } from "../providers/types.js";
import { activity } from "../activity.js";
import { ctxPctFor } from "../statusbar.js";
import { accent } from "./theme.js";
import { renderMarkdown } from "../md.js";
import { clearTodos, currentTodos, onTodosChange, type Todo } from "../tools/todo.js";
import { onTurnPhase, turnPhase, type TurnPhase } from "../agent/phase.js";
import { listJobs, onJobsChange } from "../exec/jobs.js";
import { ModelPicker } from "./model-picker.js";
import type { ReasoningStyle, Effort } from "../providers/reasoning.js";

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
  /** ask_user: pose a question (optionally with likely answers) and resolve to the user's answer (chosen
   *  option or free text). Routes through the same prompt/input channel as confirm/select. */
  ask: (question: string, options?: string[]) => Promise<string>;
  /** /model picker: ↑↓ a model + ←→ its thinking level; resolves to the chosen {model, effort}, or null on esc. */
  pickModel: (o: { models: string[]; style: ReasoningStyle; current?: string; effort: Effort }) => Promise<{ model: string; effort: Effort } | null>;
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
  /** The vision sidecar (describer) model, i.e. `cfg.visionModel` — the model that reads pasted
   *  images when the main model is text-only. When set, the model line gets a dim `· vision <model>`
   *  clause. When undefined we render nothing (native-vision main models stay silent — 顾雅 spec). */
  visionModel?: string;
  /** Update-available notice ("0.112.5 → 0.119.1 · npm i -g @nanhara/hara"). Rendered INSIDE the TUI —
   *  the pre-mount stdout print never survives ink taking over the screen, which is why TUI users
   *  reported the update check as "completely dead" while stuck versions piled up. */
  updateNotice?: string;
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
  /** Unfolded content for the Ctrl+T transcript overlay (full reasoning / full tool output). Falls back to `text`. */
  full?: string;
}
let _id = 0;
const nid = (): number => ++_id;
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Prepare a finalized turn item for the append-only `<Static>` scrollback. A completed reasoning
 *  block collapses to a single-line "✻ thought · N lines" notice (its full text preserved in `full`
 *  for the Ctrl+T overlay) — mirroring codex writing finalized rows to scrollback ONCE. Every other
 *  kind passes through unchanged. Used both mid-turn (as blocks finalize) and at turn end so a given
 *  turn's reasoning is emitted to Static exactly once and never re-rendered/re-emitted. */
function foldForHistory(it: Item): Item {
  if (it.kind !== "reasoning") return it;
  const lines = it.text.split("\n").filter((l) => l.trim()).length;
  return { ...it, kind: "notice", text: `✻ thought · ${lines} lines`, full: it.text };
}

/** Redraw throttle for the LIVE region (~30fps). A fast token stream or a slow/remote terminal can
 *  push deltas far faster than a human perceives; without a cap ink re-diffs the growing dynamic
 *  block on every token, which over a laggy link leaves stale duplicate lines + jitter. 33ms clamps
 *  the live re-render rate while state itself stays exact (nothing is dropped, only coalesced). */
const LIVE_FRAME_MS = 33;
// How long the transient approval-mode selector stays up after a shift+tab before it auto-hides. Long
// enough to read the descriptions + tap shift+tab again to keep cycling; short enough that it isn't
// always-on chrome (codex/Claude-Code keep the mode compact in the status line, not a permanent bar).
const MODE_SELECTOR_MS = 2500;
// Memoized: a live block only re-renders when its own `item` (a fresh object when its text grows) or
// `open` changes. So a spinner tick or an unrelated flush doesn't re-run `renderMarkdown` for every
// live block, and non-tail live blocks stay put while only the streaming tail grows.
/** Tail-window a LIVE block's rendered lines so the dynamic region can never outgrow the terminal.
 *  ink repaints the whole dynamic region in place; once it's taller than the viewport the erase math
 *  breaks and the input box "runs to the top of the screen". Bounding the live view fixes the class:
 *  earlier lines are elided with a dim counter, and the FULL text lands in scrollback the moment the
 *  block finalizes (nothing is lost — ctrl+t shows it live too). `maxRows` comes from the terminal. */
function tailWindow(rendered: string, maxRows: number): { header: string | null; body: string } {
  const lines = rendered.replace(/\n+$/, "").split("\n");
  if (lines.length <= maxRows) return { header: null, body: rendered };
  return {
    header: `… +${lines.length - maxRows} earlier lines — full text lands above when this block finishes · ctrl+t to view now`,
    body: lines.slice(-maxRows).join("\n"),
  };
}

const Block = memo(function Block({ item, open, liveRows }: { item: Item; open?: boolean; liveRows?: number }) {
  // Live streaming blocks get a bounded tail view (liveRows set); committed <Static> blocks render full.
  const windowed = (rendered: string): ReactNode => {
    if (!liveRows) return <Text>{rendered}</Text>;
    const w = tailWindow(rendered, liveRows);
    return (
      <Box flexDirection="column">
        {w.header ? <Text dimColor>{w.header}</Text> : null}
        <Text>{w.body}</Text>
      </Box>
    );
  };
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan">› </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return windowed(renderMarkdown(item.text)); // headers/bold/inline-code/bullets + verbatim fences
    case "reasoning": {
      // A streaming reasoning block lives in the dynamic region ABOVE the input box, and the instant the
      // model stops thinking it FOLDS to a single "✻ thought · N lines" notice in scrollback. If we streamed
      // the body live (up to ~11 rows) and then folded to 1, the input box would jump UP by that many rows
      // every time — the "bobbing" you saw. So by default we show only the compact 1-line header (same height
      // as the folded form → the box holds still). ctrl+r opts into the full streaming body (its own taller
      // view), and the FULL text is always in the ctrl+t transcript regardless — nothing is lost.
      const lines = item.text.replace(/\n+$/, "").split("\n");
      const n = lines.length;
      const hint = open ? " · ctrl-r collapse" : " · ctrl-r expand";
      return (
        <Box flexDirection="column">
          <Text color={accent()} dimColor>{`✻ thinking … ${n} line${n === 1 ? "" : "s"}${hint}`}</Text>
          {open
            ? lines.map((l, i) => (
                <Text key={i} dimColor italic>{`${i === 0 ? "• " : "  "}${l}`}</Text>
              ))
            : null}
        </Box>
      );
    }
    case "tool":
      return <Text dimColor>{"  " + item.text}</Text>;
    case "diff":
      return windowed(item.text); // a big diff must not blow the live region either
    case "notice":
      return <Text dimColor>{item.text}</Text>;
  }
});

// ── Ctrl+T transcript overlay (Codex-style): the whole conversation with NOTHING folded — full reasoning,
// full tool output, full text — scrollable. The folded live view stays the default; this is the "see everything"
// escape hatch so information is hidden but never lost.
type TLine = { t: string; dim?: boolean; italic?: boolean; color?: string };
function flattenTranscript(items: Item[]): TLine[] {
  const out: TLine[] = [];
  for (const it of items) {
    const body = (it.full ?? it.text).replace(/\n+$/, "");
    if (!body && it.kind !== "user") continue;
    out.push({ t: "" }); // blank line between blocks
    if (it.kind === "user") {
      body.split("\n").forEach((l, i) => out.push({ t: (i === 0 ? "› " : "  ") + l, color: "cyan" }));
    } else if (it.kind === "reasoning" || (it.kind === "notice" && it.full !== undefined)) {
      const lines = body.split("\n");
      out.push({ t: `✻ thinking (${lines.length} line${lines.length === 1 ? "" : "s"})`, dim: true, color: accent() });
      lines.forEach((l, i) => out.push({ t: (i === 0 ? "• " : "  ") + l, dim: true, italic: true }));
    } else if (it.kind === "tool") {
      out.push({ t: it.text, dim: true });
      if (it.full && it.full !== it.text) it.full.replace(/\n+$/, "").split("\n").forEach((l) => out.push({ t: "    " + l, dim: true }));
    } else if (it.kind === "diff") {
      body.split("\n").forEach((l) => out.push({ t: l }));
    } else {
      body.split("\n").forEach((l) => out.push({ t: l, dim: it.kind === "notice" }));
    }
  }
  return out;
}

function Transcript({ items, onClose }: { items: Item[]; onClose: () => void }) {
  const { stdout } = useStdout();
  const rows = Math.max(6, (stdout?.rows ?? 30) - 2); // leave a row for the header
  const lines = flattenTranscript(items);
  const maxScroll = Math.max(0, lines.length - rows);
  const [scroll, setScroll] = useState(1e9); // open at the bottom (latest); clamped to maxScroll below
  const at = Math.min(scroll, maxScroll);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "t")) return onClose();
    if (key.upArrow) setScroll(Math.max(0, at - 1));
    else if (key.downArrow) setScroll(Math.min(maxScroll, at + 1));
    else if (key.pageUp) setScroll(Math.max(0, at - rows));
    else if (key.pageDown) setScroll(Math.min(maxScroll, at + rows));
    else if (input === "g") setScroll(0);
    else if (input === "G") setScroll(maxScroll);
  });
  const view = lines.slice(at, at + rows);
  return (
    <Box flexDirection="column">
      <Text color={accent()} bold>
        {` TRANSCRIPT · full, nothing folded · ↑↓/PgUp·PgDn/g·G scroll · esc or ctrl+t closes · ${lines.length ? at + 1 : 0}–${Math.min(at + rows, lines.length)}/${lines.length}`}
      </Text>
      {view.map((l, i) => (
        <Text key={i} color={l.color} dimColor={l.dim} italic={l.italic}>
          {l.t || " "}
        </Text>
      ))}
    </Box>
  );
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

/** Data-driven label column (mirrors codex's `FieldFormatter::from_labels`): pad every label to the
 *  width of the WIDEST label actually shown this render, so values line up without a hard-coded column.
 *  Returns a `(label) => padded` closure. A 3-space gap after the padded label separates label↔value. */
export function fieldFormatter(labels: string[]): (label: string) => string {
  const width = labels.reduce((w, l) => Math.max(w, l.length), 0);
  return (label: string): string => label.padEnd(width, " ");
}

/** Dim trailing clause for the model line: the vision sidecar (only when configured). Pure so the
 *  composition (spacing, silence-when-unset) can be pinned in a unit test without rendering React.
 *  Returns "" when no describer is configured (native-vision main models stay silent — 顾雅 spec).
 *  The actionable `/model ↹` hint is rendered separately (in green) by the view. */
export function modelLineSuffix(visionModel?: string): string {
  return visionModel ? ` · vision ${visionModel}` : "";
}

// The header is emitted ONCE into <Static> (App's id:-1 sentinel). A rounded, dim-bordered card
// (codex polish) that HUGS its content via alignSelf="flex-start" — so it neither spans the full
// width nor blows out on resize. Keeps hara's identity: seal-red ◆ glyph + title, the org/profile
// grid, and the vision sidecar clause. One accent (◆ + title); one green affordance (/model ↹).
function HeaderCard(props: HeaderInfo) {
  const { version, modelLabel, cwd, agentsMdLoaded, session, kind } = props;
  const home = process.env.HOME ?? "";
  const cwdShort = shortenHome(cwd, home);
  const sessionShort = shortenSession(session);
  const isOrg = kind === "org";
  // Data-driven label column: the first grid row is `org`/`profile`, then `model`, `cwd`, and
  // `session` (only when present). Pad to the widest of exactly the labels we render this pass.
  const labels = [isOrg ? "org" : "profile", "model", "cwd", ...(sessionShort ? ["session"] : [])];
  const pad = fieldFormatter(labels);
  const GAP = "   "; // 3-space label↔value gap (codex spacing)
  // No leading indent here: paddingX={1} on the card already insets content 1 cell, and the title
  // glyph starts at that same column — so labels stay flush-left with `◆ hara` (codex alignment).
  const row = (label: string, body: ReactNode): ReactNode => (
    <Text>
      <Text dimColor>{`${pad(label)}${GAP}`}</Text>
      {body}
    </Text>
  );
  // First grid row: personal → `profile  personal[:<id>]`; org → `org  <label> · <id> → <host>`.
  const identityRow = isOrg
    ? row("org", (
        <Text>
          <Text>{props.orgLabel ?? props.orgId ?? "(unnamed)"}</Text>
          {props.orgId && props.orgLabel ? <Text dimColor>{` · ${props.orgId}`}</Text> : null}
          {props.routeHost ? <Text dimColor>{` → ${props.routeHost}`}</Text> : null}
        </Text>
      ))
    : row("profile", <Text>{props.profileId ? `personal:${props.profileId}` : "personal"}</Text>);
  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        borderDimColor
        paddingX={1}
        alignSelf="flex-start"
        marginBottom={1}
      >
        <Text>
          <Text color={accent()} bold>{"◆ hara"}</Text>
          <Text dimColor>{`   v${version} · the agent that runs like an org`}</Text>
        </Text>
        <Text>{" "}</Text>
        {identityRow}
        {row("model", (
          <Text>
            <Text>{modelLabel}</Text>
            {isOrg
              ? props.modelSource ? <Text dimColor>{` · from ${props.modelSource}`}</Text> : null
              : props.visionModel ? <Text dimColor>{modelLineSuffix(props.visionModel)}</Text> : null}
            <Text>{"   "}</Text>
            <Text color="green">{"/model ↹"}</Text>
          </Text>
        ))}
        {row("cwd", (
          <Text>
            <Text>{cwdShort}</Text>
            {agentsMdLoaded ? <Text dimColor>{" · AGENTS.md"}</Text> : null}
          </Text>
        ))}
        {sessionShort ? row("session", <Text>{sessionShort}</Text>) : null}
      </Box>
      {/* Tip block — moved OUT of the card (顾雅 spec). Dim discoverability line below the card. */}
      <Text dimColor>{"  Tip: @ attach file · ctrl+t transcript · ctrl+r reasoning · shift+tab approval · esc interrupt"}</Text>
      {props.updateNotice ? <Text color="yellow">{`  ⬆ ${props.updateNotice}`}</Text> : null}
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

// The status row — ALWAYS rendered, exactly one content row (codex-style: the bottom pane keeps a
// constant-height status slot and swaps its CONTENT). This is the anti-bob keystone: the old
// `Working` block appeared at turn start and vanished at turn end (±2 rows), so the input box
// jumped up 3 rows at every turn boundary (together with the ⌨-hint line, now folded in here).
// Working → spinner + verb + queue count; idle → dim key hints. Same height either way → zero shift.
//
// The spinner is the only element that animates continuously while a turn runs — and because ink
// redraws the WHOLE dynamic region (input box included) on any change, its tick rate sets a floor on
// full-frame redraws over the life of a turn. At ~8fps (125ms) the braille glyph still reads as
// smooth motion — meaningfully calmer over a slow/remote link. Elapsed seconds come from a
// wall-clock start, so the "Ns" text stays exact and stable.
const SPINNER_FRAME_MS = 125;
const IDLE_HINTS = "⏎ send · @ file · ctrl+v image · ctrl+t transcript · shift+tab mode";
function StatusRow({ working, todos, queued }: { working: boolean; todos: Todo[]; queued: number }) {
  const [frame, setFrame] = useState(0);
  const [phase, setPhase] = useState<TurnPhase>(() => turnPhase());
  const startRef = useRef(Date.now());
  useEffect(() => onTurnPhase(setPhase), []); // waiting → streaming, published by the agent loop
  useEffect(() => {
    if (!working) return;
    startRef.current = Date.now();
    const id = setInterval(() => setFrame((x) => x + 1), SPINNER_FRAME_MS);
    return () => clearInterval(id);
  }, [working]);
  // Background-job indicator — so the user can SEE what's running in the background (a preview server, a
  // watcher) without asking. Live while working (spinner ticks re-render); best-effort at idle (/jobs is
  // the authoritative on-demand view). Re-read each render.
  const bg = listJobs().filter((j) => j.status === "running").length;
  const bgTag = bg ? ` · ⚙ ${bg} bg running (/jobs)` : "";
  if (!working) {
    return (
      <Box marginTop={1}>
        <Text dimColor>{`  ${IDLE_HINTS}${bgTag}`}</Text>
      </Box>
    );
  }
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const elapsedSec = Math.floor((Date.now() - startRef.current) / 1000);
  // Pre-first-token honesty (codex-parity): "waiting for the model" reads very differently from a
  // generic "working" when the network is slow — the user knows the request is out, not dead.
  const verb = (phase === "waiting" ? `waiting for the model… ${elapsedSec}s · esc to interrupt` : spinnerVerb(todos, elapsedSec)) + bgTag;
  return (
    <Box marginTop={1}>
      <Text color="yellow">{frames[frame % frames.length]}</Text>
      <Text dimColor>{` ${verb} · ⏎ queues${queued ? ` (${queued})` : ""}`}</Text>
    </Box>
  );
}

// Short per-mode descriptions for the ONE-ROW mode line (the old two-row ModeBar's long sentences
// don't fit inline). Full behavior is documented in /help; this line is a switching aid, not a manual.
const MODE_HINT: Record<Approval, string> = {
  suggest: "confirms edits+cmds",
  "auto-edit": "auto edits · asks cmds",
  "full-auto": "no prompts ⚠",
  plan: "read-only → plan",
};
// Transient approval-mode line: popped by shift+tab in PLACE of the StatusRow (equal-height swap —
// one row for one row, so the picker appearing/auto-hiding never moves the input box). All modes
// listed, the active one colored, with the active mode's short description inline.
const ModeLine = memo(function ModeLine({ approval }: { approval: Approval }) {
  return (
    <Box marginTop={1}>
      <Text>
        {MODES.map((m, i) => (
          <Text key={m}>
            {i > 0 ? "  " : "  "}
            {m === approval ? <Text color={approvalColor(m)} bold>{`◆ ${m}`}</Text> : <Text dimColor>{m}</Text>}
          </Text>
        ))}
        <Text dimColor>{` · ${MODE_HINT[approval]} · ⇄ shift+tab`}</Text>
      </Text>
    </Box>
  );
});

// Live task panel: renders the current todo_write checklist between the in-progress turn output
// and the input box. Highlights the in_progress item; caps at 8 rows and folds the rest into
// `… +N pending/done`. Hidden when the list is empty.
const PANEL_MAX_ROWS = 8;
const TODO_MARK: Record<Todo["status"], string> = { pending: "☐", in_progress: "▶", done: "☑" };
// Memoized on the `todos` array reference (stable between todo_write updates), so spinner ticks and
// streaming flushes don't re-run the sort/slice every frame.
const TodoPanel = memo(function TodoPanel({ todos }: { todos: Todo[] }) {
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
});

export function App({ initialStatus, model, cwd, header, onSubmit, cycleApproval, onClipboardImage, vim, visionNotice }: AppProps) {
  const { exit } = useApp();
  const { stdout: termOut } = useStdout();
  // Live tail budget: terminal rows minus the rest of the dynamic chrome (todo panel ≤10, status slot,
  // input box + footer, margins). Keeps the WHOLE dynamic region under the viewport — the invariant that
  // stops ink's repaint from "running to the top" when a long answer/diff streams. Floor 8 for tiny panes.
  const liveRows = Math.max(8, (termOut?.rows ?? 30) - 20);
  const [history, setHistory] = useState<Item[]>([]);
  const [current, setCurrent] = useState<Item[]>([]);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<Status>({ ...initialStatus, agents: 0 });
  const [prompt, setPrompt] = useState<{ title: string; options: { label: string; value: unknown; key?: string }[]; resolve: (v: unknown) => void } | null>(null);
  const [promptSel, setPromptSel] = useState(0);
  // Free-text question prompt (ask_user with no/declined options): re-enables the InputBox to capture one
  // line, then resolves the awaiting tool with that text. Separate from `prompt` (the select-only path).
  const [askText, setAskText] = useState<{ title: string; resolve: (v: string) => void } | null>(null);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false); // Ctrl+T full-transcript overlay
  const [picker, setPicker] = useState<{ models: string[]; style: ReasoningStyle; current?: string; effort: Effort; resolve: (v: { model: string; effort: Effort } | null) => void } | null>(null); // /model picker overlay
  const [modeSelector, setModeSelector] = useState(false); // transient approval selector: shift+tab pops it, auto-hides
  const modeSelectorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live checklist mirror: TodoPanel reads this, and `Working` derives its spinner verb from the
  // in_progress item. The tool emits on every todo_write — keeps the UI in lockstep with the agent.
  const [todos, setTodos] = useState<Todo[]>(() => currentTodos());
  const ctrlRef = useRef<AbortController | null>(null);
  const queueRef = useRef<{ line: string; images?: ImageAttachment[] }[]>([]); // type-ahead: FIFO of messages entered while working
  const [pool, setPool] = useState<string[]>([]); // type-ahead pool: queued message lines, shown above the input
  const drainingRef = useRef(false); // idempotency guard so the drain effect can't double-send one item
  const statusRef = useRef(status);
  statusRef.current = status;
  // Live-region write path (codex-style): deltas mutate `liveRef` synchronously (exact, never dropped),
  // and a throttled flush (~30fps) reconciles it into the `current` React state that actually renders.
  // As each block finalizes (a new block kind begins) its predecessors are appended to `history`
  // (`<Static>`, rendered once) and dropped from the live buffer — so only the tail block stays dynamic.
  const liveRef = useRef<Item[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toStaticRef = useRef<Item[]>([]); // finalized blocks awaiting append to <Static> on the next flush

  useEffect(() => {
    const fn = (): void => setStatus((s) => ({ ...s, agents: activity.running }));
    activity.onChange(fn);
    return () => activity.onChange(null);
  }, []);

  // Cancel any pending timers on unmount so they can't fire after teardown.
  useEffect(() => () => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    if (modeSelectorTimerRef.current) clearTimeout(modeSelectorTimerRef.current);
  }, []);

  // Subscribe to todo_write updates so the panel re-renders when the agent edits the checklist.
  useEffect(() => {
    const unsub = onTodosChange((list) => {
      setTodos([...list]); // copy so React sees a new array (the tool reuses one)
    });
    return unsub;
  }, []);

  // Subscribe to background-job start/exit/kill so the `⚙ N bg` indicator is LIVE — crucially at idle.
  // A job finishing on its own, or a preview server still running after a turn ends, now refreshes the
  // status row; without it the idle prompt reads as "it stopped". Bumping a nonce forces the re-render;
  // StatusRow re-reads listJobs().
  const [, setJobsTick] = useState(0);
  useEffect(() => onJobsChange(() => setJobsTick((n) => n + 1)), []);

  // Reconcile the synchronously-mutated live buffer into React state, at most once per ~33ms. First
  // append any finalized blocks to <Static> (once, in order), then publish the remaining live tail.
  // The array identities are fresh each flush so React/ink re-render exactly the minimal live region.
  const flushLive = useCallback((): void => {
    flushTimerRef.current = null;
    if (toStaticRef.current.length) {
      const graduated = toStaticRef.current;
      toStaticRef.current = [];
      setHistory((h) => [...h, ...graduated]);
    }
    setCurrent(liveRef.current.slice());
  }, []);

  // Schedule a throttled flush. Coalesces a burst of deltas into one re-render per LIVE_FRAME_MS —
  // the leading edge is immediate (snappy first paint) and subsequent deltas ride the timer.
  const scheduleFlush = useCallback((): void => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(flushLive, LIVE_FRAME_MS);
  }, [flushLive]);

  const pushCurrent = useCallback(
    (kind: Kind, text: string, merge = false): void => {
      const live = liveRef.current;
      const last = live[live.length - 1];
      if (merge && last && last.kind === kind) {
        // Same streaming block continues — grow it in place in the live buffer (no new React item).
        live[live.length - 1] = { ...last, text: last.text + text };
      } else {
        // A new block begins. Everything before it in the live buffer is now finalized: graduate it
        // to <Static> (folding reasoning) so it's written to scrollback ONCE and never re-rendered.
        if (live.length) {
          for (const it of live) toStaticRef.current.push(foldForHistory(it));
          liveRef.current = [{ id: nid(), kind, text }];
        } else {
          live.push({ id: nid(), kind, text });
        }
      }
      scheduleFlush();
    },
    [scheduleFlush],
  );

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
      // A free-text question (ask_user) is awaiting an answer: this submission IS the answer, not a new turn.
      if (askText) {
        const r = askText.resolve;
        setAskText(null);
        setHistory((h) => [...h, { id: nid(), kind: "user", text: t }]);
        r(t);
        return;
      }
      if ((!t && !images?.length) || prompt) return; // nothing to send, or a choice is pending
      if (working) {
        // type-ahead: hold the message in the pool; all pooled messages are sent together when the turn ends
        queueRef.current.push({ line, images });
        setPool(queueRef.current.map((q) => q.line.trim() || "🖼 (image)"));
        return;
      }
      // Fold the previous turn's checklist NOW, at the natural boundary (a new task begins). The old
      // 30s-idle timer yanked the input box UP by the panel's height while the user was reading/typing
      // (anti-bob); folding on submit means the shrink coincides with the user's own action.
      if (currentTodos().length) {
        const list = currentTodos();
        const done = list.filter((td) => td.status === "done").length;
        setHistory((h) => [...h, { id: nid(), kind: "notice", text: `  ✓ Todos: ${done}/${list.length} done` }]);
        clearTodos(); // emits → the panel unmounts via onTodosChange
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
      // Free-text question: re-enable the InputBox to read one line (resolves via handleSubmit's askText branch).
      const askTextFn = (title: string): Promise<string> =>
        new Promise((resolve) => setAskText({ title, resolve }));
      // ask_user: when options are given, offer them as a select + a "type my own" escape hatch; otherwise (or
      // when the user chooses to type their own) capture a free-text line. Returns the chosen/typed answer.
      const OTHER = " __ask_other__"; // sentinel value for the "type my own" option
      const askFn = async (question: string, options?: string[]): Promise<string> => {
        if (options && options.length) {
          const choice = await openPrompt<string>(question, [
            ...options.map((o) => ({ label: o, value: o })),
            { label: "✎ Type my own answer", value: OTHER },
          ]);
          if (choice !== OTHER) return choice;
        }
        return askTextFn(question);
      };
      const setApprovalFn = (m: Approval): void => setStatus((s) => ({ ...s, approval: m }));
      const pickModelFn = (o: { models: string[]; style: ReasoningStyle; current?: string; effort: Effort }): Promise<{ model: string; effort: Effort } | null> =>
        new Promise((resolve) => setPicker({ ...o, resolve }));
      // Enter the conversation flow INSTANTLY: yield one macrotask so ink paints the committed message +
      // cleared input + spinner BEFORE the turn's synchronous prep runs (reading @-files, base64-encoding
      // images) and before the model's slow first token. Without this, that sync prep blocks ink's flush,
      // so pressing Enter leaves the message stuck in the input box for seconds ("回车一直不动"). One tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        await onSubmit(t, { sink, confirm: confirmFn, select: selectFn, ask: askFn, pickModel: pickModelFn, setApproval: setApprovalFn, signal: ctrl.signal, exit, approval: statusRef.current.approval, drainQueue }, images);
      } catch (e: unknown) {
        pushCurrent("notice", `error: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Commit this turn's items to scrollback. The authoritative source is the synchronous live
      // buffer (liveRef + any blocks already graduated to toStaticRef), NOT the throttled `current`
      // React state — so a fast slash-only turn (/design, /help, /skills…) that pushes a notice and
      // returns before a flush fires still commits it, and a pending throttle timer can't double-emit.
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      const committed = [...toStaticRef.current, ...liveRef.current.map(foldForHistory)];
      toStaticRef.current = [];
      liveRef.current = [];
      if (committed.length) setHistory((h) => [...h, ...committed]);
      setCurrent([]);
      setWorking(false);
      ctrlRef.current = null;
    },
    [working, prompt, askText, onSubmit, pushCurrent, model, exit, drainQueue, noteVisionIfNeeded],
  );

  // Drain the type-ahead pool: when the turn finishes (working → false) and nothing awaits a choice, COALESCE
  // every pooled message into ONE turn and send it — additions/clarifications go to the agent together, in order.
  useEffect(() => {
    if (working || prompt || askText || drainingRef.current || !queueRef.current.length) return;
    drainingRef.current = true;
    const batch = queueRef.current;
    queueRef.current = [];
    setPool([]);
    const line = batch.map((b) => b.line).join("\n\n");
    const images = batch.flatMap((b) => b.images ?? []);
    void Promise.resolve(handleSubmit(line, images.length ? images : undefined)).finally(() => {
      drainingRef.current = false;
    });
  }, [working, prompt, askText, handleSubmit]);

  useInput((input, key) => {
    if (key.ctrl && input === "t") return setShowTranscript((x) => !x); // open/close the full-transcript overlay
    if (showTranscript) return; // while open, the overlay's own useInput owns every key (scroll / esc)
    if (picker) return; // the /model picker overlay owns input (↑↓ model, ←→ thinking, ⏎, esc) while open
    // Free-text question awaiting an answer: Esc cancels (empty answer); all other keys belong to the InputBox.
    if (askText) {
      if (key.escape) {
        const r = askText.resolve;
        setAskText(null);
        r("");
      }
      return;
    }
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
    else if (key.tab && key.shift && cycleApproval) {
      setStatus((s) => ({ ...s, approval: cycleApproval(s.approval) }));
      // Pop the approval selector transiently (codex-style) and (re)arm the auto-hide — tapping shift+tab
      // again keeps it up while cycling; it folds away on its own so it isn't permanent chrome.
      setModeSelector(true);
      if (modeSelectorTimerRef.current) clearTimeout(modeSelectorTimerRef.current);
      modeSelectorTimerRef.current = setTimeout(() => {
        setModeSelector(false);
        modeSelectorTimerRef.current = null;
      }, MODE_SELECTOR_MS);
    }
  });

  if (showTranscript) return <Transcript items={[...history, ...current]} onClose={() => setShowTranscript(false)} />;

  return (
    <Box flexDirection="column">
      <Static items={header ? [{ id: -1, kind: "notice" as const, text: "" }, ...history] : history}>
        {(item) => (item.id === -1 ? <HeaderCard key="hdr" {...header!} /> : <Block key={item.id} item={item} />)}
      </Static>
      {current.map((item) => (
        <Block key={item.id} item={item} open={reasoningOpen} liveRows={liveRows} />
      ))}
      <TodoPanel todos={todos} />
      {picker && (
        <ModelPicker
          models={picker.models}
          style={picker.style}
          current={picker.current}
          effort={picker.effort}
          onSelect={(model, effort) => {
            const r = picker.resolve;
            setPicker(null);
            r({ model, effort });
          }}
          onCancel={() => {
            const r = picker.resolve;
            setPicker(null);
            r(null);
          }}
        />
      )}
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
      {askText && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">{`  ? ${stripAnsi(askText.title)}`}</Text>
          <Text dimColor>{"   type your answer below · Enter to send · Esc cancels"}</Text>
        </Box>
      )}
      {pool.length > 0 && !prompt && !askText && (
        <Box flexDirection="column">
          {pool.map((l, i) => (
            <Text key={i} color={accent()}>{`  › ${l.length > 72 ? l.slice(0, 72) + "…" : l}`}</Text>
          ))}
        </Box>
      )}
      {/* Constant-height status slot (the anti-bob keystone): ModeLine and StatusRow are both exactly
          one row + one margin row, and ONE of them is always rendered — so shift+tab, turn start, and
          turn end never change the chrome height under the transcript. */}
      {modeSelector ? <ModeLine approval={status.approval} /> : <StatusRow working={working} todos={todos} queued={pool.length} />}
      <InputBox status={status} cwd={cwd} model={model} route={header?.routeHost} isActive={!prompt} vim={vim} onSubmit={handleSubmit} onClipboardImage={onClipboardImage} />
    </Box>
  );
}
