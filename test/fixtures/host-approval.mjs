// Register before starting work, observe state only after Host notifications unwind, and let the
// original node:test signal bound the wait. This helper never approves a card or retries a run.
export function waitForHostApproval({ events, read, start, wait, signal }) {
  return new Promise((resolve, reject) => {
    let job, settled = false, queued = false;
    const finish = (error, card) => {
      if (settled) return;
      settled = true; events.off("change", changed); signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve({ job, card });
    };
    const check = () => {
      if (settled) return false;
      try { const card = read(); if (card) { finish(null, card); return true; } }
      catch (error) { finish(error); }
      return false;
    };
    const changed = () => {
      if (settled || queued) return;
      queued = true; queueMicrotask(() => { queued = false; check(); });
    };
    const abort = () => finish(signal.reason ?? new Error("Host approval wait aborted"));
    if (signal?.aborted) { abort(); return; }
    events.on("change", changed); signal?.addEventListener("abort", abort, { once: true });
    try {
      job = start(); changed();
      Promise.resolve(wait(job.runId)).then(() => {
        if (!check() && !settled) finish(new Error("Host run ended before publishing an approval card"));
      }, error => finish(error));
    } catch (error) { finish(error); }
  });
}
