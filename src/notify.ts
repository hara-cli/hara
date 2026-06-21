// Task-done notifications — ping the user when a turn finishes (or needs them) so they can walk away
// during a long run (codex/Claude-Code parity). off = nothing; bell = terminal BEL; system = an OS
// notification (best-effort, fire-and-forget) + bell. Gated on elapsed so quick turns you watched stay quiet.
import { spawn } from "node:child_process";
import { platform } from "node:os";

export type NotifyMode = "off" | "bell" | "system";
export const NOTIFY_MODES: NotifyMode[] = ["off", "bell", "system"];

/** AppleScript double-quoted string (escape " and \). */
const osaStr = (s: string): string => '"' + s.replace(/[\\"]/g, "\\$&") + '"';

/** Fire a notification for a finished/awaiting turn. No-op under `off` or when the turn was quicker than
 *  `minMs` (default 8s) — you were watching those. `system` shells out without blocking and also rings the bell. */
export function notifyDone(mode: NotifyMode, opts: { title?: string; message: string; elapsedMs: number; minMs?: number }): void {
  if (mode === "off") return;
  if (opts.elapsedMs < (opts.minMs ?? 8000)) return;
  const bell = (): void => {
    try {
      process.stderr.write("\x07");
    } catch {
      /* no tty */
    }
  };
  if (mode === "bell") return bell();
  const title = (opts.title ?? "hara").slice(0, 80);
  const msg = opts.message.slice(0, 200).replace(/\s*\n+\s*/g, " ").trim() || "done";
  try {
    const os = platform();
    if (os === "darwin") {
      spawn("osascript", ["-e", `display notification ${osaStr(msg)} with title ${osaStr(title)}`], { stdio: "ignore", detached: true }).unref();
    } else if (os === "linux") {
      spawn("notify-send", ["-a", "hara", title, msg], { stdio: "ignore", detached: true }).unref();
    }
    // Windows (and any platform): the bell is the reliable cross-terminal signal; toast needs extra modules.
  } catch {
    /* best-effort — a notification must never break the turn */
  }
  bell();
}
