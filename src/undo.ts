// In-session undo stack for file changes. Each edit tool records the prior state of the files it
// touched; `/undo` pops the last group and restores it. Process-scoped (one REPL session).
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileSnap {
  path: string; // display path (as given by the tool)
  absPath: string; // absolute path on disk
  before: string | null; // content before the change; null = file didn't exist → undo deletes it
}

const stack: FileSnap[][] = [];
const MAX = 50;

/** Record a group of file changes (one tool call = one undo step). */
export function recordEdit(group: FileSnap[]): void {
  if (!group.length) return;
  stack.push(group);
  if (stack.length > MAX) stack.shift();
}

export function undoDepth(): number {
  return stack.length;
}

/** Restore the most recent edit group. Returns the files reverted, or an error. */
export async function undoLast(): Promise<{ files: string[] } | { error: string }> {
  const group = stack.pop();
  if (!group) return { error: "nothing to undo" };
  const files: string[] = [];
  for (const s of group) {
    try {
      if (s.before === null) {
        await unlink(s.absPath).catch(() => {}); // was newly created → remove
      } else {
        await mkdir(dirname(s.absPath), { recursive: true });
        await writeFile(s.absPath, s.before, "utf8");
      }
      files.push(s.path);
    } catch {
      /* skip a file we can't restore */
    }
  }
  return { files };
}
