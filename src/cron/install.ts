// Register `hara cron tick` with the OS scheduler so jobs fire without a hara daemon running:
// launchd calendar minutes (macOS) or crontab (Linux, every minute). Survives reboots; nothing to babysit.
import { platform, homedir } from "node:os";
import { join, dirname } from "node:path";
import { writeFileSync, existsSync, rmSync, mkdirSync, lstatSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LABEL = "net.nanhara.hara.cron";
const CRON_TAG = "# hara-cron";
const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`; // safe single-quote for /bin/sh
const plistFile = (): string => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const MAX_SCHEDULER_ENTRY_BYTES = 256 * 1024;

export type SchedulerEntryState = "absent" | "current" | "stale" | "unsafe";

/** launchd's StartInterval may drop or heavily coalesce background timer firings. Calendar events retain
 * wall-clock semantics and coalesce missed wake events into one launch, which is exactly what `cron tick`
 * needs. Spell out all 60 minute values instead of relying on an empty wildcard dictionary. */
export function renderLaunchdPlist(argv: readonly string[]): string {
  const calendarMinutes = Array.from(
    { length: 60 },
    (_, minute) => `<dict><key>Minute</key><integer>${minute}</integer></dict>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${xmlEscape(a)}</string>`).join("")}</array>
  <key>StartCalendarInterval</key><array>${calendarMinutes}</array>
  <key>RunAtLoad</key><false/>
</dict></plist>
`;
}

function renderCronLine(argv: readonly string[]): string {
  return `* * * * * ${argv.map(shQuote).join(" ")} >/dev/null 2>&1  ${CRON_TAG}`;
}

/** Pure comparison used by migrations and tests. A tagged entry with an old executable is stale, not
 * installed: keeping it would make Desktop claim the scheduler is healthy while launchd/cron repeatedly
 * invokes a path that no longer exists. */
export function schedulerEntryStateFor(
  os: NodeJS.Platform,
  raw: string | null,
  cmd: readonly string[],
): Exclude<SchedulerEntryState, "unsafe"> {
  if (!raw) return "absent";
  const argv = [...cmd, "cron", "tick"];
  if (os === "darwin") return raw === renderLaunchdPlist(argv) ? "current" : "stale";
  if (os === "linux") {
    const tagged = raw.split("\n").filter((line) => line.includes(CRON_TAG));
    if (!tagged.length) return "absent";
    return tagged.length === 1 && tagged[0] === renderCronLine(argv) ? "current" : "stale";
  }
  return "absent";
}

function currentCrontab(): string {
  try {
    return execFileSync("crontab", ["-l"], { encoding: "utf8" });
  } catch {
    return ""; // no crontab yet
  }
}

export function isInstalled(): boolean {
  const os = platform();
  if (os === "darwin") return existsSync(plistFile());
  if (os === "linux") return currentCrontab().includes(CRON_TAG);
  return false;
}

export function schedulerEntryState(cmd: readonly string[]): SchedulerEntryState {
  const os = platform();
  if (os === "darwin") {
    const path = plistFile();
    if (!existsSync(path)) return "absent";
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SCHEDULER_ENTRY_BYTES) return "unsafe";
      const raw = readFileSync(path, "utf8");
      if (!raw.includes(`<key>Label</key><string>${LABEL}</string>`)) return "unsafe";
      return schedulerEntryStateFor(os, raw, cmd);
    } catch {
      return "unsafe";
    }
  }
  if (os === "linux") return schedulerEntryStateFor(os, currentCrontab(), cmd);
  return "absent";
}

export interface SchedulerReconciliation {
  installed: boolean;
  current: boolean;
  repaired: boolean;
  detail: string;
}

/** Repair only an already-present Hara-owned entry. This never installs a scheduler for somebody who has
 * not opted in, and refuses suspicious links/files instead of overwriting them. */
export function reconcileInstalledScheduler(cmd: readonly string[]): SchedulerReconciliation {
  const state = schedulerEntryState(cmd);
  if (state === "absent") {
    return { installed: false, current: false, repaired: false, detail: "The local scheduler is not installed." };
  }
  if (state === "current") {
    return { installed: true, current: true, repaired: false, detail: "The local scheduler is installed." };
  }
  if (state === "unsafe") {
    return {
      installed: true,
      current: false,
      repaired: false,
      detail: "The existing Hara scheduler entry could not be verified; remove it and install the scheduler again.",
    };
  }
  const repaired = installScheduler([...cmd]);
  return repaired.ok
    ? { installed: true, current: true, repaired: true, detail: "The local scheduler path was repaired after the Hara update." }
    : { installed: true, current: false, repaired: false, detail: repaired.msg };
}

/** Install the per-minute tick. `cmd` = how to invoke hara (e.g. `["node","/x/index.js"]` or the single
 *  binary `["/usr/local/bin/hara"]`); `cron tick` is appended. */
export function installScheduler(cmd: string[]): { ok: boolean; msg: string } {
  const os = platform();
  const argv = [...cmd, "cron", "tick"];
  if (argv.some((a) => a.includes("\n"))) return { ok: false, msg: "refusing to install — a path contains a newline" };
  if (os === "darwin") {
    const p = plistFile();
    const plist = renderLaunchdPlist(argv);
    mkdirSync(dirname(p), { recursive: true });
    if (existsSync(p)) {
      try {
        const existing = lstatSync(p);
        if (!existing.isFile() || existing.isSymbolicLink()) {
          return { ok: false, msg: `refusing to replace unsafe scheduler entry ${p}` };
        }
      } catch (e) {
        return { ok: false, msg: `could not inspect existing scheduler entry (${e instanceof Error ? e.message : e})` };
      }
    }
    writeFileSync(p, plist, "utf8");
    try {
      execFileSync("launchctl", ["unload", p], { stdio: "ignore" });
    } catch {
      /* not loaded yet */
    }
    try {
      execFileSync("launchctl", ["load", p], { stdio: "ignore" });
    } catch (e) {
      return { ok: false, msg: `wrote ${p} but launchctl load failed (${e instanceof Error ? e.message : e})` };
    }
    return { ok: true, msg: `launchd agent installed (${p}) — runs every calendar minute` };
  }
  if (os === "linux") {
    const kept = currentCrontab()
      .split("\n")
      .filter((l) => !l.includes(CRON_TAG))
      .join("\n")
      .replace(/\n+$/, "");
    const line = renderCronLine(argv);
    const next = (kept ? kept + "\n" : "") + line + "\n";
    try {
      execFileSync("crontab", ["-"], { input: next });
    } catch (e) {
      return { ok: false, msg: `crontab update failed (${e instanceof Error ? e.message : e})` };
    }
    return { ok: true, msg: "crontab entry installed — runs every minute" };
  }
  return { ok: false, msg: `auto-install unsupported on ${os} — run \`hara cron tick\` from your own scheduler every minute` };
}

export function uninstallScheduler(): { ok: boolean; msg: string } {
  const os = platform();
  if (os === "darwin") {
    const p = plistFile();
    if (!existsSync(p)) return { ok: true, msg: "not installed" };
    try {
      execFileSync("launchctl", ["unload", p], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    rmSync(p, { force: true });
    return { ok: true, msg: "launchd agent removed" };
  }
  if (os === "linux") {
    if (!currentCrontab().includes(CRON_TAG)) return { ok: true, msg: "not installed" };
    const kept =
      currentCrontab()
        .split("\n")
        .filter((l) => !l.includes(CRON_TAG))
        .join("\n")
        .replace(/\n+$/, "") + "\n";
    try {
      execFileSync("crontab", ["-"], { input: kept });
    } catch (e) {
      return { ok: false, msg: `crontab update failed (${e instanceof Error ? e.message : e})` };
    }
    return { ok: true, msg: "crontab entry removed" };
  }
  return { ok: false, msg: `not supported on ${platform()}` };
}
