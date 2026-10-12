// Test-only event inbox. The enclosing test's AbortSignal bounds every wait; arbitrary polling
// windows must not expire before a multi-hop colleague reaches its actual human decision.
export function colleagueEvents(signal) {
  const events = [], pending = new Set(); let closed = false;
  function finish(waiter, error, value) {
    pending.delete(waiter); signal.removeEventListener("abort", waiter.abort);
    if (error) waiter.reject(error); else waiter.resolve(value);
  }
  return {
    events,
    push(event) {
      events.push(event);
      for (const waiter of [...pending]) {
        try {
          if (event.method === waiter.method && waiter.predicate(event.params)) finish(waiter, undefined, event.params);
        } catch (error) { finish(waiter, error); }
      }
    },
    wait(method, predicate = () => true) {
      signal.throwIfAborted();
      const event = events.find((value) => value.method === method && predicate(value.params));
      if (event) return Promise.resolve(event.params);
      if (closed) return Promise.reject(Error(`fixture disconnected before ${method}`));
      return new Promise((resolve, reject) => {
        const waiter = { method, predicate, resolve, reject };
        waiter.abort = () => finish(waiter, signal.reason ?? Error(`fixture event wait aborted: ${method}`));
        pending.add(waiter); signal.addEventListener("abort", waiter.abort, { once: true });
      });
    },
    close() {
      closed = true;
      for (const waiter of [...pending]) finish(waiter, Error(`fixture disconnected before ${waiter.method}`));
    },
  };
}
