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

/** Progress-aware event waiter for WebSocket RPC and child-IPC channels.
 * Counts only unblocked event-loop idle ticks toward `idleMs` and yields one Check turn after Poll
 * I/O before timing out, so host event-loop stalls cannot cut off ready responses while real hangs
 * still fail fast at `idleMs` (bounded overall by `maxMs`). */
export function awaitProgressSignal(setup, { idleMs = 10000, maxMs = 45000, tickMs = 250, onTimeout = () => new Error("bounded progress wait timed out") } = {}) {
  const effectiveTick = Math.max(10, Math.min(tickMs, idleMs));
  return new Promise((resolve, reject) => {
    let settled = false, activeIdleMs = 0;
    const started = Date.now();
    let lastTick = started, timer = null, cleanup = () => {};
    const finish = fn => value => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      cleanup();
      fn(value);
    };
    const settleResolve = finish(resolve), settleReject = finish(reject);
    const noteProgress = () => { activeIdleMs = 0; };
    timer = setInterval(() => {
      if (settled) return;
      const now = Date.now(), dt = Math.max(0, now - lastTick);
      lastTick = now;
      activeIdleMs += Math.min(dt, effectiveTick);
      if (activeIdleMs >= idleMs || now - started >= maxMs) {
        clearInterval(timer);
        timer = null;
        // Let the current Poll phase deliver any ready socket/IPC message before failing.
        setImmediate(() => settleReject(onTimeout(now - started, activeIdleMs)));
      }
    }, effectiveTick);
    try {
      const teardown = setup({ resolve: settleResolve, reject: settleReject, noteProgress });
      if (typeof teardown === "function") cleanup = teardown;
    } catch (error) {
      settleReject(error);
    }
  });
}

/** Shared WebSocket JSON-RPC client with progress-aware RPC deadlines.
 * Server notifications (`workspace.changed`, `workspace.assistant.preview`) reset active idle time
 * on inflight RPCs while unblocked stalls fail after `idleMs` (capped at `maxMs`). */
export function createJsonRpcRequester(socket, { idleMs = 10000, maxMs = 45000, tickMs = 250, errorText = () => "RPC deadline", mapError = err => new Error(err.message) } = {}) {
  const pending = new Map();
  let serial = 0;
  socket.on("message", raw => {
    const value = JSON.parse(String(raw));
    if (value.method === "workspace.changed" || value.method === "workspace.assistant.preview") {
      for (const waiter of pending.values()) waiter.noteProgress();
      return;
    }
    const waiter = pending.get(value.id);
    if (!waiter) return;
    pending.delete(value.id);
    if (value.error) waiter.reject(mapError(value.error));
    else waiter.resolve(value.result);
  });
  return function request(method, params = {}) {
    const id = ++serial;
    const message = typeof errorText === "function" ? errorText(method) : errorText;
    return awaitProgressSignal(({ resolve, reject, noteProgress }) => {
      pending.set(id, { resolve, reject, noteProgress });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return () => { pending.delete(id); };
    }, { idleMs, maxMs, tickMs, onTimeout: () => new Error(message) });
  };
}
