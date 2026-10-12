import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export interface MailRuntimeStatus {
  ready: boolean;
  reason: "ready" | "helper-missing" | "python-missing" | "helper-incompatible" | "unavailable";
}
const helperPath = () => join(homedir(), ".codex", "skills", "feishu-communicate", "scripts", "feishu_chat.py");
const exec = promisify(execFile);
async function providerHelp(helper: string, operation: string): Promise<string> {
  const result = await exec("python3", [helper, operation, "--help"], { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true });
  return result.stdout;
}

/** Read-only local prerequisite check. Help parsing never authenticates, reads mail or sends. */
export async function inspectMailRuntime(helper = helperPath(), help = providerHelp): Promise<MailRuntimeStatus> {
  if (!existsSync(helper)) return { ready: false, reason: "helper-missing" };
  try {
    const [imap, smtp] = await Promise.all([help(helper, "mail-imap-doctor"), help(helper, "mail-smtp-send")]);
    if (!imap.includes("--account-file") || !smtp.includes("--message-file") || !smtp.includes("--confirm-hash")) {
      return { ready: false, reason: "helper-incompatible" };
    }
    return { ready: true, reason: "ready" };
  } catch (error: unknown) {
    return { ready: false, reason: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "python-missing" : "unavailable" };
  }
}

let cached: { status: MailRuntimeStatus; until: number } | undefined;
let pending: Promise<MailRuntimeStatus> | undefined;
/** Settings polling shares one bounded probe, rather than spawning Python on every refresh. */
export function mailRuntimeStatus(): Promise<MailRuntimeStatus> {
  if (cached && Date.now() < cached.until) return Promise.resolve(cached.status);
  if (!pending) {
    pending = inspectMailRuntime().then(status => {
      cached = { status, until: Date.now() + (status.ready ? 60_000 : 15_000) };
      return status;
    }).finally(() => { pending = undefined; });
  }
  return pending;
}
