export interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

/**
 * Correlate an already-open descriptor with a stat of the same bounded path. Node on Windows may report
 * a volume-derived `dev` for fstat and `0` for lstat/stat of that exact NTFS file. Its file id (`ino`) stays
 * stable, and the caller has already fixed the path/parent boundary, so requiring `dev` there rejects valid
 * files without adding an identity fence. POSIX retains the ordinary device + inode comparison.
 *
 * Do not use this to decide whether two arbitrary Windows paths are hard links across unrelated roots.
 */
export function sameOpenedFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
  platform: string = process.platform,
): boolean {
  return left.ino === right.ino && (platform === "win32" || left.dev === right.dev);
}
