import { constants } from "node:fs";

export type PosixOnlyOpenFlag = "O_DIRECTORY" | "O_NOFOLLOW" | "O_NONBLOCK";

/**
 * Bun's Windows compatibility layer may expose POSIX-only fs constants even though CreateFileW cannot
 * consume them. Node documents that Windows supports neither O_DIRECTORY, O_NOFOLLOW nor O_NONBLOCK;
 * passing Bun's numeric values can turn an otherwise valid create/open into a misleading ENOENT.
 *
 * Windows callers retain their lstat/fstat/identity checks and O_CREAT|O_EXCL no-replace semantics.
 */
export function optionalPosixOpenFlag(
  name: PosixOnlyOpenFlag,
  platform: string = process.platform,
): number {
  if (platform === "win32") return 0;
  const value = constants[name];
  return typeof value === "number" ? value : 0;
}
