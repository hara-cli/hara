import { randomUUID } from "node:crypto";

export const DEFAULT_CONTROL_LEASE_RESOURCES = 4_096;

export interface ControlLeaseToken {
  leaseId: string;
  epoch: number;
}

interface ResourceLeaseState<Owner extends object> {
  epoch: number;
  active?: ControlLeaseToken & { owner: Owner };
}

export class ControlLeaseError extends Error {
  constructor(
    readonly reason: "held" | "required" | "stale" | "capacity",
    message: string,
  ) {
    super(message);
    this.name = "ControlLeaseError";
  }
}

export interface ControlLeaseAcquisition<Owner extends object> {
  lease: ControlLeaseToken;
  acquired: boolean;
  previousOwner?: Owner;
}

/**
 * Socket-owned, epoch-fenced single-writer leases.
 *
 * Reads remain multi-client. Until a resource has an active lease, legacy clients may mutate it. Once a
 * Desktop/mobile controller acquires the resource, every mutation must come from that owner with the exact
 * lease id and epoch. A takeover always rotates both values, so delayed commands from the old controller
 * fail closed instead of landing in a newer task.
 */
export class ControlLeaseRegistry<Owner extends object> {
  readonly maxResources: number;
  readonly #idFactory: () => string;
  readonly #resources = new Map<string, ResourceLeaseState<Owner>>();

  constructor(options: { maxResources?: number; idFactory?: () => string } = {}) {
    const maxResources = options.maxResources ?? DEFAULT_CONTROL_LEASE_RESOURCES;
    if (!Number.isSafeInteger(maxResources) || maxResources < 1) {
      throw new Error("control lease maxResources must be a positive safe integer");
    }
    this.maxResources = maxResources;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  #touch(resourceId: string, state: ResourceLeaseState<Owner>): void {
    this.#resources.delete(resourceId);
    this.#resources.set(resourceId, state);
  }

  #state(resourceId: string): ResourceLeaseState<Owner> {
    const normalized = resourceId.trim();
    if (!normalized || normalized.length > 1_000) throw new Error("control lease resource id is invalid");
    const existing = this.#resources.get(normalized);
    if (existing) {
      this.#touch(normalized, existing);
      return existing;
    }

    // Retain epochs for recently released resources, but never evict a live owner's fence. If all retained
    // slots are live, reject another acquisition rather than growing without bound.
    while (this.#resources.size >= this.maxResources) {
      const stale = [...this.#resources].find(([, state]) => !state.active);
      if (!stale) {
        throw new ControlLeaseError("capacity", "too many resources currently have an input controller");
      }
      this.#resources.delete(stale[0]);
    }
    const created = { epoch: 0 };
    this.#resources.set(normalized, created);
    return created;
  }

  acquire(resourceId: string, owner: Owner, takeover = false): ControlLeaseAcquisition<Owner> {
    const state = this.#state(resourceId);
    if (state.active?.owner === owner) {
      return {
        lease: { leaseId: state.active.leaseId, epoch: state.active.epoch },
        acquired: false,
      };
    }
    if (state.active && !takeover) {
      throw new ControlLeaseError("held", "another device currently controls input for this session");
    }
    const previousOwner = state.active?.owner;
    const epoch = state.epoch + 1;
    if (!Number.isSafeInteger(epoch)) throw new Error("control lease epoch exhausted");
    state.epoch = epoch;
    state.active = { owner, leaseId: this.#idFactory(), epoch };
    return {
      lease: { leaseId: state.active.leaseId, epoch },
      acquired: true,
      ...(previousOwner ? { previousOwner } : {}),
    };
  }

  /** Authorize a mutation. No active lease preserves backward compatibility for older Desktop clients. */
  authorize(resourceId: string, owner: Owner, lease?: ControlLeaseToken): "legacy" | "leased" {
    const state = this.#resources.get(resourceId);
    if (!state?.active) {
      if (lease) throw new ControlLeaseError("stale", "this control lease is no longer active");
      return "legacy";
    }
    if (!lease) {
      throw new ControlLeaseError("required", "this session is controlled by another Hara client; acquire input control first");
    }
    if (
      state.active.owner !== owner
      || state.active.leaseId !== lease.leaseId
      || state.active.epoch !== lease.epoch
    ) {
      throw new ControlLeaseError("stale", "the control lease changed; refresh the session before sending input");
    }
    return "leased";
  }

  release(resourceId: string, owner: Owner, lease?: ControlLeaseToken): { released: boolean; epoch: number } {
    const state = this.#resources.get(resourceId);
    if (!state?.active) return { released: false, epoch: state?.epoch ?? 0 };
    if (state.active.owner !== owner) {
      throw new ControlLeaseError("stale", "only the current input controller can release this lease");
    }
    if (lease && (state.active.leaseId !== lease.leaseId || state.active.epoch !== lease.epoch)) {
      throw new ControlLeaseError("stale", "the control lease changed before it could be released");
    }
    const epoch = state.active.epoch;
    delete state.active;
    this.#touch(resourceId, state);
    return { released: true, epoch };
  }

  releaseOwner(owner: Owner): Array<{ resourceId: string; epoch: number }> {
    const released: Array<{ resourceId: string; epoch: number }> = [];
    for (const [resourceId, state] of [...this.#resources]) {
      if (state.active?.owner !== owner) continue;
      released.push({ resourceId, epoch: state.active.epoch });
      delete state.active;
      this.#touch(resourceId, state);
    }
    return released;
  }
}
