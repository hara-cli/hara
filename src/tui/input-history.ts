// Pure composer state: bounded shell-style history plus Unicode-safe cursor helpers. Keeping this out
// of the Ink component makes navigation deterministic and avoids copying a growing history on each key.

export interface InputDraft<Attachment> {
  value: string;
  attachments: Attachment[];
  pastes: string[];
}

const cloneDraft = <Attachment>(draft: InputDraft<Attachment>): InputDraft<Attachment> => ({
  value: draft.value,
  attachments: [...draft.attachments],
  pastes: [...draft.pastes],
});

const draftChars = <Attachment>(draft: InputDraft<Attachment>): number =>
  draft.value.length + draft.pastes.reduce((sum, paste) => sum + paste.length, 0) + draft.attachments.length * 128;

/** Bounded in-process history. The draft that existed before Up is restored after navigating Down. */
export class ComposerHistory<Attachment> {
  private readonly entries: { draft: InputDraft<Attachment>; chars: number }[] = [];
  private cursor: number | null = null;
  private scratch: InputDraft<Attachment> | null = null;
  private totalChars = 0;

  constructor(
    private readonly maxEntries = 100,
    private readonly maxChars = 2_000_000,
  ) {}

  get browsing(): boolean {
    return this.cursor !== null;
  }

  get length(): number {
    return this.entries.length;
  }

  record(draft: InputDraft<Attachment>): void {
    this.abandonNavigation();
    const chars = draftChars(draft);
    // A giant paste is already retained by the conversation history. Do not duplicate an entry larger
    // than the entire composer-history budget just to support Up-arrow recall.
    if (chars > this.maxChars || this.maxEntries <= 0) return;
    this.entries.push({ draft: cloneDraft(draft), chars });
    this.totalChars += chars;
    while (this.entries.length > this.maxEntries || this.totalChars > this.maxChars) {
      this.totalChars -= this.entries.shift()!.chars;
    }
  }

  older(current: InputDraft<Attachment>): InputDraft<Attachment> | null {
    if (!this.entries.length) return null;
    if (this.cursor === null) {
      this.scratch = cloneDraft(current);
      this.cursor = this.entries.length - 1;
    } else if (this.cursor > 0) {
      this.cursor--;
    }
    return cloneDraft(this.entries[this.cursor].draft);
  }

  newer(): InputDraft<Attachment> | null {
    if (this.cursor === null) return null;
    if (this.cursor < this.entries.length - 1) {
      this.cursor++;
      return cloneDraft(this.entries[this.cursor].draft);
    }
    const draft = this.scratch ?? { value: "", attachments: [], pastes: [] };
    this.cursor = null;
    this.scratch = null;
    return cloneDraft(draft);
  }

  abandonNavigation(): void {
    this.cursor = null;
    this.scratch = null;
  }
}

let segmenter: Intl.Segmenter | null | undefined;
function graphemeSegmenter(): Intl.Segmenter | null {
  // Constructing Intl.Segmenter loads ICU data. Defer that cost until the first actual cursor edit so
  // lightweight commands such as `hara --version` do not pay for TUI Unicode support.
  if (segmenter === undefined) segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  return segmenter;
}

/** Previous user-perceived character boundary (keeps emoji ZWJ sequences/combining marks intact). */
export function previousGraphemeIndex(value: string, cursor: number): number {
  const at = Math.max(0, Math.min(value.length, cursor));
  if (at === 0) return 0;
  const segments = graphemeSegmenter();
  if (!segments) {
    const low = value.charCodeAt(at - 1);
    const paired = low >= 0xdc00 && low <= 0xdfff && at > 1 && value.charCodeAt(at - 2) >= 0xd800 && value.charCodeAt(at - 2) <= 0xdbff;
    return Math.max(0, at - (paired ? 2 : 1));
  }
  let previous = 0;
  for (const part of segments.segment(value)) {
    if (part.index >= at) break;
    previous = part.index;
  }
  return previous;
}

/** Next user-perceived character boundary. */
export function nextGraphemeIndex(value: string, cursor: number): number {
  const at = Math.max(0, Math.min(value.length, cursor));
  if (at >= value.length) return value.length;
  const segments = graphemeSegmenter();
  if (!segments) {
    const cp = value.codePointAt(at);
    return Math.min(value.length, at + (cp !== undefined && cp > 0xffff ? 2 : 1));
  }
  for (const part of segments.segment(value)) {
    const end = part.index + part.segment.length;
    if (end > at) return end;
  }
  return value.length;
}

/** Start of the previous shell-style word, used by Ctrl+W. */
export function previousWordIndex(value: string, cursor: number): number {
  let at = Math.max(0, Math.min(value.length, cursor));
  while (at > 0) {
    const previous = previousGraphemeIndex(value, at);
    if (!/\s/u.test(value.slice(previous, at))) break;
    at = previous;
  }
  while (at > 0) {
    const previous = previousGraphemeIndex(value, at);
    if (/\s/u.test(value.slice(previous, at))) break;
    at = previous;
  }
  return at;
}

function graphemeFloor(value: string, cursor: number): number {
  const at = Math.max(0, Math.min(value.length, cursor));
  if (at === value.length) return at;
  const segments = graphemeSegmenter();
  if (!segments) return at > 0 && /[\uDC00-\uDFFF]/.test(value[at]) ? at - 1 : at;
  let floor = 0;
  for (const part of segments.segment(value)) {
    if (part.index > at) break;
    floor = part.index;
    if (part.index + part.segment.length === at) return at;
  }
  return floor;
}

/** Move between logical pasted/typed lines while retaining the closest possible column. */
export function moveCursorLine(value: string, cursor: number, direction: -1 | 1): number {
  const at = Math.max(0, Math.min(value.length, cursor));
  const lineStart = (at === 0 ? -1 : value.lastIndexOf("\n", at - 1)) + 1;
  const lineEndAt = value.indexOf("\n", at);
  const lineEnd = lineEndAt < 0 ? value.length : lineEndAt;
  const column = Math.min(at - lineStart, lineEnd - lineStart);

  if (direction < 0) {
    if (lineStart === 0) return at;
    const previousEnd = lineStart - 1;
    const previousStart = value.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
    return graphemeFloor(value, previousStart + Math.min(column, previousEnd - previousStart));
  }
  if (lineEnd === value.length) return at;
  const nextStart = lineEnd + 1;
  const nextEndAt = value.indexOf("\n", nextStart);
  const nextEnd = nextEndAt < 0 ? value.length : nextEndAt;
  return graphemeFloor(value, nextStart + Math.min(column, nextEnd - nextStart));
}
