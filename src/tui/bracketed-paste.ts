import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";

export const BRACKETED_PASTE_START = "\u001b[200~";
export const BRACKETED_PASTE_END = "\u001b[201~";
export const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";
export const MAX_BRACKETED_PASTE_CHARS = 2 * 1024 * 1024;
export const INCOMPLETE_PASTE_TIMEOUT_MS = 750;

const pasteTooLargeMessage = (limit: number): string => {
  const size = limit >= 1024 * 1024 ? `${Math.ceil(limit / (1024 * 1024))} MiB` : `${limit} characters`;
  return `[Paste rejected: input exceeds ${size}]`;
};

function suffixPrefixLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);
  for (let length = max; length > 0; length--) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Stateful decoder for xterm bracketed-paste framing. Terminals are free to split both markers and
 * UTF-8 content across arbitrary stdin chunks, so no individual chunk can be treated as a paste.
 * Completed paste contents are emitted as exactly one logical input event; framing bytes never reach
 * Ink's key parser.
 */
export class BracketedPasteDecoder {
  private mode: "normal" | "paste" | "overflow" = "normal";
  private buffer = "";

  constructor(private readonly maxPasteChars = MAX_BRACKETED_PASTE_CHARS) {}

  get hasIncompletePaste(): boolean {
    return this.mode !== "normal";
  }

  get hasPendingMarker(): boolean {
    return this.mode === "normal" && this.buffer.length > 0;
  }

  feed(input: string): string[] {
    if (!input) return [];
    this.buffer += input;
    const output: string[] = [];

    while (this.buffer.length > 0) {
      if (this.mode === "normal") {
        const start = this.buffer.indexOf(BRACKETED_PASTE_START);
        if (start >= 0) {
          if (start > 0) output.push(this.buffer.slice(0, start));
          this.buffer = this.buffer.slice(start + BRACKETED_PASTE_START.length);
          this.mode = "paste";
          continue;
        }

        // Retain only a suffix that could become a split start marker. Everything before it is
        // ordinary keyboard input and can be forwarded immediately.
        const retained = suffixPrefixLength(this.buffer, BRACKETED_PASTE_START);
        const ready = this.buffer.slice(0, this.buffer.length - retained);
        if (ready) output.push(ready);
        this.buffer = retained ? this.buffer.slice(-retained) : "";
        break;
      }

      const end = this.buffer.indexOf(BRACKETED_PASTE_END);
      if (end >= 0) {
        if (this.mode === "paste" && end <= this.maxPasteChars) output.push(this.buffer.slice(0, end));
        else output.push(pasteTooLargeMessage(this.maxPasteChars));
        this.buffer = this.buffer.slice(end + BRACKETED_PASTE_END.length);
        this.mode = "normal";
        continue;
      }

      if (this.mode === "paste" && this.buffer.length > this.maxPasteChars) {
        // Fail closed instead of retaining an unbounded terminal stream or silently submitting a
        // truncated source file. Keep only a possible split end marker while discarding the payload.
        const retained = suffixPrefixLength(this.buffer, BRACKETED_PASTE_END);
        this.buffer = retained ? this.buffer.slice(-retained) : "";
        this.mode = "overflow";
      } else if (this.mode === "overflow") {
        const retained = suffixPrefixLength(this.buffer, BRACKETED_PASTE_END);
        this.buffer = retained ? this.buffer.slice(-retained) : "";
      }
      break;
    }

    return output;
  }

  /** Recover when a terminal sent paste-start but never sent paste-end. */
  flushIncomplete(): string[] {
    if (this.mode === "normal") {
      const pending = this.buffer;
      this.buffer = "";
      return pending ? [pending] : [];
    }
    const output = this.mode === "paste" ? this.buffer : pasteTooLargeMessage(this.maxPasteChars);
    this.mode = "normal";
    this.buffer = "";
    return output ? [output] : [];
  }
}

type RawInput = NodeJS.ReadStream & {
  setRawMode?(enabled: boolean): unknown;
  pause?(): unknown;
  resume?(): unknown;
  ref?(): unknown;
  unref?(): unknown;
};

/**
 * Readable proxy passed to Ink. It preserves the real TTY's raw-mode lifecycle while turning each
 * completed bracketed paste into one readable event. Multiple logical events from one OS chunk are
 * emitted on separate event-loop turns so `paste + Enter` cannot be coalesced back into one keypress.
 */
export class BracketedPasteInput extends Readable {
  readonly isTTY: boolean;
  private readonly utf8 = new StringDecoder("utf8");
  private readonly decoder: BracketedPasteDecoder;
  private readonly queue: string[] = [];
  private drainImmediate: NodeJS.Immediate | undefined;
  private markerImmediate: NodeJS.Immediate | undefined;
  private pasteTimer: NodeJS.Timeout | undefined;
  private ending = false;
  private disposed = false;

  constructor(
    private readonly source: RawInput,
    options: { maxPasteChars?: number; incompleteTimeoutMs?: number } = {},
  ) {
    super();
    this.isTTY = Boolean(source.isTTY);
    this.decoder = new BracketedPasteDecoder(options.maxPasteChars);
    this.incompleteTimeoutMs = options.incompleteTimeoutMs ?? INCOMPLETE_PASTE_TIMEOUT_MS;
    source.on("data", this.onData);
    source.on("end", this.onEnd);
    source.on("error", this.onError);
  }

  private readonly incompleteTimeoutMs: number;

  override _read(): void {
    // readline.close() explicitly pauses process.stdin before the main TUI mounts. Ink reads this
    // proxy rather than the real terminal, so its readable demand must resume the wrapped stream.
    // Without this hand-off the frame renders normally but every key remains stuck upstream.
    this.source.resume?.();
  }

  setRawMode(enabled: boolean): this {
    this.source.setRawMode?.(enabled);
    if (enabled) this.source.resume?.();
    else this.source.pause?.();
    return this;
  }

  ref(): this {
    this.source.ref?.();
    return this;
  }

  unref(): this {
    this.source.unref?.();
    return this;
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.disposed) return;
    this.clearMarkerImmediate();
    const text = Buffer.isBuffer(chunk) ? this.utf8.write(chunk) : String(chunk);
    this.enqueue(this.decoder.feed(text));

    if (this.decoder.hasIncompletePaste) {
      this.resetPasteTimer();
    } else {
      this.clearPasteTimer();
      // Like Ink's own input parser, retain a lone/split ESC sequence for only one event-loop turn.
      if (this.decoder.hasPendingMarker) {
        this.markerImmediate = setImmediate(() => {
          this.markerImmediate = undefined;
          this.enqueue(this.decoder.flushIncomplete());
        });
      }
    }
  };

  private readonly onEnd = (): void => {
    if (this.disposed) return;
    const tail = this.utf8.end();
    if (tail) this.enqueue(this.decoder.feed(tail));
    this.enqueue(this.decoder.flushIncomplete());
    this.ending = true;
    this.finishIfDrained();
  };

  private readonly onError = (error: Error): void => {
    this.destroy(error);
  };

  private resetPasteTimer(): void {
    this.clearPasteTimer();
    this.pasteTimer = setTimeout(() => {
      this.pasteTimer = undefined;
      this.enqueue(this.decoder.flushIncomplete());
    }, this.incompleteTimeoutMs);
    this.pasteTimer.unref?.();
  }

  private enqueue(values: string[]): void {
    for (const value of values) if (value) this.queue.push(value);
    if (this.queue.length === 0 || this.drainImmediate) return;
    const first = this.queue.shift();
    if (first !== undefined) this.push(first);
    if (this.queue.length > 0) this.scheduleDrain();
    else this.finishIfDrained();
  }

  private scheduleDrain(): void {
    if (this.drainImmediate) return;
    this.drainImmediate = setImmediate(() => {
      this.drainImmediate = undefined;
      const next = this.queue.shift();
      if (next !== undefined) this.push(next);
      if (this.queue.length > 0) this.scheduleDrain();
      else this.finishIfDrained();
    });
  }

  private finishIfDrained(): void {
    if (this.ending && this.queue.length === 0 && !this.drainImmediate) this.push(null);
  }

  private clearPasteTimer(): void {
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.pasteTimer = undefined;
  }

  private clearMarkerImmediate(): void {
    if (this.markerImmediate) clearImmediate(this.markerImmediate);
    this.markerImmediate = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearPasteTimer();
    this.clearMarkerImmediate();
    if (this.drainImmediate) clearImmediate(this.drainImmediate);
    this.drainImmediate = undefined;
    this.source.off("data", this.onData);
    this.source.off("end", this.onEnd);
    this.source.off("error", this.onError);
    this.source.pause?.();
    this.push(null);
  }
}

type PasteOutput = { isTTY?: boolean; write(value: string): unknown };

/** Enable terminal-side paste framing and return an idempotent cleanup. */
export function enableBracketedPaste(output: PasteOutput): () => void {
  if (!output.isTTY) return () => {};
  let enabled = false;
  try {
    output.write(ENABLE_BRACKETED_PASTE);
    enabled = true;
  } catch {
    return () => {};
  }
  return () => {
    if (!enabled) return;
    enabled = false;
    try {
      output.write(DISABLE_BRACKETED_PASTE);
    } catch {
      // Terminal cleanup is best effort; never mask the original TUI exit/error.
    }
  };
}
