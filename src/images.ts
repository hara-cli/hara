// Image attachments for the prompt — paste a screenshot (Ctrl+V) or drag/paste an image file path.
// Zero-dependency by design: shells out to OS tools (osascript/sips on macOS, wl-paste/xclip on
// Linux, PowerShell on Windows) rather than pulling a native clipboard module — same posture as
// sandbox.ts. Paths (not bytes) ride in the conversation; encoding to base64 happens at send time.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { ImageAttachment } from "./providers/types.js";

const MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function mediaTypeFor(p: string): string | null {
  return MEDIA[extname(p).toLowerCase()] ?? null;
}

// Anthropic caps an image near 5 MB of base64; downsize a larger source, then hard-skip if still over.
const DOWNSIZE_OVER = 3_600_000; // raw bytes (base64 ≈ 1.37×)
const MAX_B64 = 5_000_000;

/**
 * Treat a typed/pasted string as a path to an existing image. Terminals emit a bare (often quoted or
 * backslash-escaped) path when you drag a file in; we also accept a `file://` URL. Returns the
 * resolved attachment, or null when it isn't an existing image file.
 */
export function imagePathFromPaste(raw: string, cwd: string = process.cwd()): ImageAttachment | null {
  let s = raw.trim();
  if (!s || /[\r\n]/.test(s)) return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(s.slice("file://".length));
    } catch {
      return null;
    }
  }
  s = s.replace(/\\ /g, " "); // un-escape dragged-in spaces
  const mediaType = mediaTypeFor(s);
  if (!mediaType) return null;
  const abs = resolve(cwd, s);
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return { path: abs, mediaType };
}

let seq = 0;
function tmpPng(): string {
  seq += 1;
  return join(tmpdir(), `hara-clip-${process.pid}-${Date.now()}-${seq}.png`);
}

/**
 * Pull an image off the OS clipboard into a temp PNG (Ctrl+V screenshot-paste). Synchronous — one
 * short-lived helper process. Returns null when the clipboard holds no image or the tooling/platform
 * isn't available. (Copied *files* arrive as a path instead → handled by imagePathFromPaste.)
 */
export function readClipboardImage(): ImageAttachment | null {
  const out = tmpPng();
  try {
    if (process.platform === "darwin") {
      const script = [
        "try",
        "  set thePng to (the clipboard as «class PNGf»)",
        "on error",
        '  return "NONE"',
        "end try",
        `set theFile to open for access POSIX file ${JSON.stringify(out)} with write permission`,
        "write thePng to theFile",
        "close access theFile",
        'return "OK"',
      ].join("\n");
      const r = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
      if (r.status !== 0 || !String(r.stdout).includes("OK")) return null;
    } else if (process.platform === "linux") {
      if (
        !dumpStdout("wl-paste", ["--type", "image/png"], out) &&
        !dumpStdout("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], out)
      )
        return null;
    } else if (process.platform === "win32") {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $i=[System.Windows.Forms.Clipboard]::GetImage(); if($i){$i.Save(${JSON.stringify(out)},[System.Drawing.Imaging.ImageFormat]::Png)}else{exit 1}`;
      if (spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).status !== 0) return null;
    } else {
      return null;
    }
  } catch {
    return null;
  }
  try {
    if (!existsSync(out) || statSync(out).size === 0) return null;
  } catch {
    return null;
  }
  downsizeIfHuge(out);
  return { path: out, mediaType: "image/png" };
}

function dumpStdout(cmd: string, args: string[], outPath: string): boolean {
  try {
    const r = spawnSync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout || r.stdout.length === 0) return false;
    writeFileSync(outPath, r.stdout);
    return true;
  } catch {
    return false;
  }
}

/** Shrink an oversized image in place (macOS `sips`, always present) to stay under the API cap. */
function downsizeIfHuge(path: string): void {
  try {
    if (statSync(path).size <= DOWNSIZE_OVER) return;
    if (process.platform === "darwin") spawnSync("sips", ["--resampleHeightWidthMax", "1568", path], { encoding: "utf8" });
  } catch {
    /* best effort — send as-is and let the provider decide */
  }
}

/** Read an image file → base64 for an API request. Null when missing or still too large to send. */
export function imageToBase64(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const b64 = readFileSync(path).toString("base64");
    return b64.length > MAX_B64 ? null : b64;
  } catch {
    return null;
  }
}
