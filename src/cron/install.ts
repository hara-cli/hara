// Register `hara cron tick` with the OS scheduler so jobs fire without a hara daemon running:
// launchd (macOS, every 60s) or crontab (Linux, every minute). Survives reboots; nothing to babysit.
import { platform, homedir } from "node:os";
import { join, dirname } from "node:path";
import { writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LABEL = "net.nanhara.hara.cron";
const CRON_TAG = "# hara-cron";
const plistFile = (): string => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

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

/** Install the per-minute tick. `node` = the node binary, `script` = hara's entry (process.argv[1]). */
export function installScheduler(node: string, script: string): { ok: boolean; msg: string } {
  const os = platform();
  if (os === "darwin") {
    const p = plistFile();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${script}</string><string>cron</string><string>tick</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><false/>
</dict></plist>
`;
    mkdirSync(dirname(p), { recursive: true });
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
    return { ok: true, msg: `launchd agent installed (${p}) — runs every 60s` };
  }
  if (os === "linux") {
    const kept = currentCrontab()
      .split("\n")
      .filter((l) => !l.includes(CRON_TAG))
      .join("\n")
      .replace(/\n+$/, "");
    const line = `* * * * * ${node} ${script} cron tick >/dev/null 2>&1  ${CRON_TAG}`;
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
