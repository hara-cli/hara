import type { ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { StringDecoder } from "node:string_decoder";
import crossSpawn from "cross-spawn";
import { terminateSubprocessTree } from "../security/subprocess-env.js";
import {
  resolveExternalCommandRuntime,
  type ExternalCommandOptions,
} from "./process.js";
import {
  ExternalSessionInputError,
  type ExternalTerminalFrame,
  type ExternalTerminalStream,
  type ExternalTerminalStreamOpenInput,
  type ExternalTerminalStreamSink,
} from "./types.js";

const MAX_TERMINAL_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_TERMINAL_LINE_BYTES = 6 * 1024 * 1024;
const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
const TERMINAL_START_TIMEOUT_MS = 5_000;
const TERMINAL_RELEASE_TIMEOUT_MS = 750;

const terminalDimension = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value < 2 || value > 1_000) {
    throw new ExternalSessionInputError(`${label} must be an integer from 2 to 1000`);
  }
  return value;
};

const terminalFrame = (value: unknown): ExternalTerminalFrame | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "terminal.frame") return null;
  const { seq, width, height, full, bytes } = candidate;
  if (
    !Number.isSafeInteger(seq) || Number(seq) < 0
    || !Number.isInteger(width) || Number(width) < 2 || Number(width) > 1_000
    || !Number.isInteger(height) || Number(height) < 2 || Number(height) > 1_000
    || typeof full !== "boolean"
    || typeof bytes !== "string"
    || bytes.length > Math.ceil(MAX_TERMINAL_FRAME_BYTES / 3) * 4
    || (bytes.length > 0 && !/^[A-Za-z0-9+/]+={0,2}$/u.test(bytes))
  ) return null;
  const decoded = Buffer.from(bytes, "base64");
  if (decoded.length > MAX_TERMINAL_FRAME_BYTES || decoded.toString("base64") !== bytes) return null;
  return {
    seq: Number(seq),
    encoding: "ansi-base64",
    width: Number(width),
    height: Number(height),
    full,
    bytes,
  };
};

/** One structured Herdr terminal bridge. It never logs stdout/stderr because terminal bytes can contain
 * prompts, paths, credentials, or other private user data. */
export class HerdrTerminalStream implements ExternalTerminalStream {
  readonly mode: ExternalTerminalStreamOpenInput["mode"];
  private readonly processGroup: boolean;
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private lastSeq: number | null = null;
  private closed = false;
  private releasing = false;
  private releasePromise: Promise<void> | null = null;

  private constructor(
    private readonly child: ChildProcess,
    input: ExternalTerminalStreamOpenInput,
    private readonly sink: ExternalTerminalStreamSink,
  ) {
    this.mode = input.mode;
    this.processGroup = platform() !== "win32";
    child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
    // Deliberately drain without retaining provider/runtime output.
    child.stderr?.on("data", () => {});
    child.once("error", () => this.finish("transport_error"));
    child.once("close", () => this.finish(this.releasing ? "released" : "runtime_closed"));
  }

  static async start(
    options: ExternalCommandOptions,
    target: string,
    input: ExternalTerminalStreamOpenInput,
    sink: ExternalTerminalStreamSink,
  ): Promise<HerdrTerminalStream> {
    const cols = terminalDimension(input.cols, "terminal cols");
    const rows = terminalDimension(input.rows, "terminal rows");
    if (input.takeover && input.mode !== "control") {
      throw new ExternalSessionInputError("terminal takeover requires control mode");
    }
    const launch = resolveExternalCommandRuntime(options.command, options.env ?? process.env);
    if (!launch) throw new Error("Hara Live runtime was not found");
    const args = [
      ...(options.argsPrefix ?? []),
      "terminal", "session", input.mode, target,
      ...(input.takeover ? ["--takeover"] : []),
      "--cols", String(cols), "--rows", String(rows),
    ];
    let child: ChildProcess;
    try {
      const spawnProcess = options.spawnProcess ?? ((command, childArgs, spawnOptions) => (
        crossSpawn(command, [...childArgs], spawnOptions)
      ));
      child = spawnProcess(launch.command, args, {
        stdio: [input.mode === "control" ? "pipe" : "ignore", "pipe", "pipe"],
        env: launch.env,
        detached: platform() !== "win32",
        windowsHide: true,
      });
    } catch {
      throw new Error("Hara Live terminal bridge could not start");
    }
    const stream = new HerdrTerminalStream(child, input, sink);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("spawn", spawned);
        child.off("error", failed);
        if (error) reject(error);
        else resolve();
      };
      const spawned = (): void => finish();
      const failed = (): void => finish(new Error("Hara Live terminal bridge could not start"));
      const timer = setTimeout(() => {
        terminateSubprocessTree(child, { force: true, processGroup: platform() !== "win32" });
        finish(new Error("Hara Live terminal bridge timed out while starting"));
      }, TERMINAL_START_TIMEOUT_MS);
      timer.unref();
      child.once("spawn", spawned);
      child.once("error", failed);
    });
    return stream;
  }

  private consume(chunk: Buffer): void {
    if (this.closed) return;
    this.pending += this.decoder.write(chunk);
    if (Buffer.byteLength(this.pending, "utf8") > MAX_TERMINAL_LINE_BYTES) {
      this.finish("invalid_frame");
      return;
    }
    while (!this.closed) {
      const newline = this.pending.indexOf("\n");
      if (newline < 0) return;
      const line = this.pending.slice(0, newline).trim();
      this.pending = this.pending.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.finish("invalid_frame");
        return;
      }
      if (
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && (parsed as Record<string, unknown>).type === "terminal.closed"
      ) {
        this.finish(this.releasing ? "released" : "runtime_closed");
        return;
      }
      const frame = terminalFrame(parsed);
      if (!frame || (this.lastSeq === null && !frame.full)) {
        this.finish("invalid_frame");
        return;
      }
      if (this.lastSeq !== null && frame.seq !== this.lastSeq + 1 && !frame.full) {
        this.finish("sequence_gap");
        return;
      }
      this.lastSeq = frame.seq;
      this.sink.frame(frame);
    }
  }

  private write(value: unknown): void {
    if (this.closed || this.mode !== "control" || !this.child.stdin?.writable) {
      throw new ExternalSessionInputError("this terminal stream does not hold input control");
    }
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  input(text: string): void {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_TERMINAL_INPUT_BYTES) {
      throw new ExternalSessionInputError("terminal input exceeds 64 KiB");
    }
    this.write({ type: "terminal.input", text });
  }

  resize(cols: number, rows: number): void {
    this.write({
      type: "terminal.resize",
      cols: terminalDimension(cols, "terminal cols"),
      rows: terminalDimension(rows, "terminal rows"),
      cell_width_px: 0,
      cell_height_px: 0,
    });
  }

  scroll(direction: "up" | "down", lines: number): void {
    if ((direction !== "up" && direction !== "down") || !Number.isInteger(lines) || lines < 1 || lines > 1_000) {
      throw new ExternalSessionInputError("terminal scroll input is invalid");
    }
    this.write({ type: "terminal.scroll", direction, lines, source: "wheel" });
  }

  async release(): Promise<void> {
    if (this.releasePromise) return await this.releasePromise;
    this.releasing = true;
    this.releasePromise = new Promise<void>((resolve) => {
      if (this.closed) return resolve();
      try {
        if (this.mode === "control" && this.child.stdin?.writable) {
          this.child.stdin.write(`${JSON.stringify({ type: "terminal.release" })}\n`);
          this.child.stdin.end();
        }
      } catch {
        // The bounded shutdown below still releases the child process group.
      }
      const timer = setTimeout(() => {
        if (!this.closed) terminateSubprocessTree(this.child, { force: true, processGroup: this.processGroup });
        resolve();
      }, TERMINAL_RELEASE_TIMEOUT_MS);
      timer.unref();
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      if (this.mode !== "control") {
        terminateSubprocessTree(this.child, { force: true, processGroup: this.processGroup });
      }
    });
    return await this.releasePromise;
  }

  private finish(reason: Parameters<ExternalTerminalStreamSink["closed"]>[0]): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.releasing) terminateSubprocessTree(this.child, { force: true, processGroup: this.processGroup });
    this.sink.closed(reason);
  }
}
