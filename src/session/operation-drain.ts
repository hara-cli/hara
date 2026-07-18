export interface PhysicalOperationDrain {
  /** Register the real Promise, not its logical timeout/race wrapper. */
  observe<T>(operation: Promise<T>): Promise<T>;
  /** Stop accepting new logical work and run `onDrained` once every observed Promise has settled. */
  close(): void;
  pendingCount(): number;
}

/**
 * A dynamic physical-operation drain for session leases.
 *
 * A one-time `Promise.allSettled([...pending])` snapshot is insufficient: an observed outer tool may
 * start and register a nested provider after shutdown begins. This drain checks the live Set after every
 * settlement and releases only once it remains empty at a microtask boundary.
 */
export function createPhysicalOperationDrain(onDrained: () => void): PhysicalOperationDrain {
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  let drained = false;
  let drainQueued = false;

  const requestDrain = (): void => {
    if (!closing || drained || drainQueued || pending.size > 0) return;
    drainQueued = true;
    queueMicrotask(() => {
      drainQueued = false;
      if (!closing || drained || pending.size > 0) return;
      drained = true;
      onDrained();
    });
  };

  const observe = <T>(operation: Promise<T>): Promise<T> => {
    if (drained) {
      throw new Error("cannot observe a physical operation after its session lease drained");
    }
    pending.add(operation);
    const settled = (): void => {
      pending.delete(operation);
      requestDrain();
    };
    void operation.then(settled, settled);
    return operation;
  };

  return {
    observe,
    close: (): void => {
      closing = true;
      requestDrain();
    },
    pendingCount: (): number => pending.size,
  };
}
