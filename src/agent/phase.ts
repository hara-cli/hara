// Turn phase for the status line (codex-parity): between "request sent" and "first stream event"
// the user should see *waiting for the model* — not a generic "working" that reads the same whether
// the model is thinking or the connection is dead. The MAIN loop publishes (quiet/sub-agent runs
// don't — they'd stomp the shared channel); the TUI status row subscribes like it does for todos.

export type TurnPhase = "idle" | "waiting" | "streaming";

let phase: TurnPhase = "idle";
type Listener = (p: TurnPhase) => void;
const listeners = new Set<Listener>();

export function turnPhase(): TurnPhase {
  return phase;
}

export function setTurnPhase(p: TurnPhase): void {
  if (p === phase) return;
  phase = p;
  for (const fn of listeners) {
    try {
      fn(phase);
    } catch {
      /* a listener must not break the loop */
    }
  }
}

/** Subscribe to phase changes. Returns an unsubscribe fn. */
export function onTurnPhase(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
