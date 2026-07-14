// Cross-process birth identity used by file leases. Only a same-version, unequal identity proves PID reuse;
// missing probes and format upgrades are deliberately "unknown" so callers fail closed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type ProcessIdentityComparison = "same" | "different" | "unknown";

/** Stable for one OS process lifetime. Unknown platforms/probe failures return null. */
export function defaultProcessIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      // Fields after the comm closing parenthesis begin at field 3; starttime is field 22.
      const startTicks = stat.slice(close + 1).trim().split(/\s+/)[19];
      if (!/^\d+$/.test(startTicks ?? "")) return null;
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
      if (!/^[a-f0-9-]{16,64}$/.test(bootId)) return null;
      return `linux-v1:${bootId}:${startTicks}`;
    }
    if (process.platform === "darwin") {
      // `lstart` is rendered in the child process' timezone. Fix both locale and TZ so the same live PID keeps
      // one identity even if Hara's environment or the host timezone changes between lock acquisition/check.
      const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
        maxBuffer: 1_024,
        timeout: 1_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().replace(/\s+/g, " ");
      return started ? `darwin-v1:${started}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function compareProcessIdentity(
  expected: string | undefined,
  current: string | null,
): ProcessIdentityComparison {
  if (!expected || !current) return "unknown";
  const expectedSeparator = expected.indexOf(":");
  const currentSeparator = current.indexOf(":");
  if (expectedSeparator <= 0 || currentSeparator <= 0) return "unknown";
  if (expected.slice(0, expectedSeparator) !== current.slice(0, currentSeparator)) return "unknown";
  return expected === current ? "same" : "different";
}
