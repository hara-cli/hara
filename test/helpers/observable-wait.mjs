// Waiting for a real governed run (native child start, MCP gateway, actual file IO) observed through
// polling. Without `progress` this is the original fixed window. With `progress`, the window is
// measured from the last observable change instead of from the start: a hang (nothing changes for
// idleMs) still fails just as fast, while a slow run that keeps making observable progress under
// host load can finish, bounded by maxMs (below the 120 s per-test/file runner limit).
// Measured 2026-11-13: the C3 scoped file task changes its observable state 6 times over ~23 s with
// a largest gap of ~7 s at load1 31–39, so idleMs 30 s keeps a ~4x margin. Budgets, deadlines and
// assertions of the code under test are unchanged.
export async function untilObserved(read, { label, progress, idleMs = 30000, maxMs = 100000, intervalMs = 100 } = {}) {
  const start = Date.now();
  let lastChange = start, last;
  for (;;) {
    const value = await read();
    if (value) return value;
    const now = Date.now();
    if (progress) {
      const signature = await progress();
      if (signature !== last) { last = signature; lastChange = now; }
      if (now - lastChange >= idleMs) throw new Error(`${label} observable state deadline: no observable progress for ${idleMs}ms`);
      if (now - start >= maxMs) throw new Error(`${label} observable state deadline: still progressing after ${maxMs}ms`);
    } else if (now - start >= idleMs) throw new Error(`${label} observable state deadline`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
