import { fchmodSync } from "node:fs";

export type DescriptorModeWriter = (fd: number, mode: number) => void;

/**
 * Tighten an already-verified descriptor on platforms that implement POSIX ownership modes.
 *
 * Windows Node/Bun may expose `fchmodSync`, but the underlying handle can reject it with EPERM and
 * Windows ACLs do not implement these POSIX owner bits. Callers must retain their type, identity,
 * no-replace, and atomic-write checks; only the inapplicable mode operation is omitted on Windows.
 * POSIX errors deliberately propagate so a failed private-state repair remains fail-closed.
 */
export function tightenPrivateDescriptorMode(
  fd: number,
  mode: number,
  platform: string = process.platform,
  writeMode: DescriptorModeWriter = fchmodSync,
): void {
  if (platform === "win32") return;
  writeMode(fd, mode);
}
