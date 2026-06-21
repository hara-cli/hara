// Optional vim keybindings for the input box (opt-in: `hara config set vimMode true`). A pure reducer so
// the modal editing is fully unit-testable; InputBox owns the state and routes special keys (Esc/Enter/
// arrows/backspace). A practical single-line subset — modes, motions, the common edits, and paste — not
// a full vim. `count`s, visual mode, marks, and search are intentionally out of scope.
export type VimMode = "insert" | "normal";
export interface VimState {
  value: string;
  cursor: number;
  mode: VimMode;
  pending: string; // an operator awaiting its motion: "d" | "c" | "g" | ""
  register: string; // yank/delete register for p/P
}

const isSpace = (ch: string): boolean => ch === " " || ch === "\t";
const clamp = (c: number, n: number): number => Math.max(0, Math.min(n, c));

/** Start of the next word (run of non-space), vim `w`. */
function nextWord(v: string, c: number): number {
  const n = v.length;
  let i = c;
  if (i < n && !isSpace(v[i])) while (i < n && !isSpace(v[i])) i++;
  while (i < n && isSpace(v[i])) i++;
  return i;
}
/** Start of the previous word, vim `b`. */
function prevWord(v: string, c: number): number {
  let i = c - 1;
  while (i > 0 && isSpace(v[i])) i--;
  while (i > 0 && !isSpace(v[i - 1])) i--;
  return Math.max(0, i);
}
/** End index of the current/next word, vim `e`. */
function wordEnd(v: string, c: number): number {
  const n = v.length;
  let i = c + 1;
  while (i < n && isSpace(v[i])) i++;
  while (i < n - 1 && !isSpace(v[i + 1])) i++;
  return Math.min(n, i);
}

/** Apply one printable key in NORMAL mode, returning the next state. Special keys (Esc/Enter/arrows/
 *  backspace) are handled by the caller. Unknown keys are no-ops. */
export function vimNormal(st: VimState, input: string): VimState {
  const { value, cursor } = st;
  const n = value.length;
  const move = (c: number): VimState => ({ ...st, cursor: clamp(c, n), pending: "" });
  const toInsert = (v: string, c: number, register = st.register): VimState => ({ value: v, cursor: clamp(c, v.length), mode: "insert", pending: "", register });
  const toNormal = (patch: Partial<VimState>): VimState => ({ ...st, pending: "", ...patch });

  // operator-pending: d{motion} / c{motion}
  if (st.pending === "d" || st.pending === "c") {
    const op = st.pending;
    if (input === op) return op === "c" ? toInsert("", 0, value) : toNormal({ value: "", cursor: 0, register: value }); // dd / cc
    const ranges: Record<string, [number, number]> = {
      w: [cursor, nextWord(value, cursor)],
      e: [cursor, Math.min(n, wordEnd(value, cursor) + 1)],
      b: [prevWord(value, cursor), cursor],
      $: [cursor, n],
      "0": [0, cursor],
    };
    const r = ranges[op === "c" && input === "w" ? "e" : input]; // cw acts like ce (vim quirk)
    if (!r) return toNormal({}); // unknown motion → cancel the operator
    const [from, to] = r;
    const deleted = value.slice(from, to);
    const next = value.slice(0, from) + value.slice(to);
    return op === "c" ? toInsert(next, from, deleted) : toNormal({ value: next, cursor: clamp(from, next.length), register: deleted });
  }
  if (st.pending === "g") return input === "g" ? move(0) : toNormal({});

  switch (input) {
    // motions
    case "h":
      return move(cursor - 1);
    case "l":
      return move(cursor + 1);
    case "0":
      return move(0);
    case "$":
      return move(n);
    case "w":
      return move(nextWord(value, cursor));
    case "b":
      return move(prevWord(value, cursor));
    case "e":
      return move(wordEnd(value, cursor));
    case "G":
      return move(n);
    // enter insert mode
    case "i":
      return toInsert(value, cursor);
    case "a":
      return toInsert(value, cursor + 1);
    case "I":
      return toInsert(value, value.length - value.trimStart().length);
    case "A":
    case "o": // single-line: open ≈ append at end
      return toInsert(value, n);
    // edits
    case "x": {
      if (!n) return toNormal({});
      return toNormal({ value: value.slice(0, cursor) + value.slice(cursor + 1), cursor: clamp(cursor, n - 1), register: value[cursor] ?? "" });
    }
    case "D":
      return toNormal({ value: value.slice(0, cursor), cursor: clamp(cursor, cursor), register: value.slice(cursor) });
    case "C":
      return toInsert(value.slice(0, cursor), cursor, value.slice(cursor));
    case "p":
      return toNormal({ value: value.slice(0, cursor + 1) + st.register + value.slice(cursor + 1), cursor: cursor + st.register.length });
    case "P":
      return toNormal({ value: value.slice(0, cursor) + st.register + value.slice(cursor), cursor: cursor + Math.max(0, st.register.length - 1) });
    // operators
    case "d":
      return { ...st, pending: "d" };
    case "c":
      return { ...st, pending: "c" };
    case "g":
      return { ...st, pending: "g" };
    default:
      return toNormal({}); // ignore everything else (printable keys don't insert in normal mode)
  }
}
