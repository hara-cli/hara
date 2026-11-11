import { randomUUID, timingSafeEqual } from "node:crypto";
import { AgentBoundaryContractError } from "./agent-boundaries-contract.js";

declare const transportBrand: unique symbol;
/** Host-created connection identity. JSON, client names and origin claims cannot construct it. */
export interface AgentBoundaryTransport { readonly [transportBrand]: true }
interface TransportState { live: boolean; human: boolean; proofRef: string; connectionId: string }
const deny = (): never => { throw new AgentBoundaryContractError("AUTHORITY_UNVERIFIED", "authority.transport"); };

/** Trusted native bootstrap supplies a distinct credential in memory, never in generic discovery.
 * It authenticates possession of that local control capability, not physical human presence.
 * This class belongs to Host composition; no RPC can call connect or supply its result. */
export class AgentBoundaryTransports {
  private readonly sessions = new WeakMap<object, TransportState>();
  private closed = false;
  constructor(private readonly ownerCredential: string) {
    if (!/^[a-f0-9]{64}$/.test(ownerCredential)) deny();
  }
  connect(connectionId: string, credential: unknown): AgentBoundaryTransport {
    if (this.closed || typeof connectionId !== "string" || !connectionId) return deny();
    let human = false;
    if (credential !== undefined) {
      if (typeof credential !== "string" || !/^[a-f0-9]{64}$/.test(credential)
        || !timingSafeEqual(Buffer.from(credential), Buffer.from(this.ownerCredential))) return deny();
      human = true;
    }
    const handle = Object.freeze({}) as AgentBoundaryTransport;
    this.sessions.set(handle, { live: true, human, connectionId, proofRef: `transport_${randomUUID()}` });
    return handle;
  }
  provenance(handle: unknown): Readonly<{ channel: "local_human"; proofRef: string }> {
    const state = handle && typeof handle === "object" ? this.sessions.get(handle) : undefined;
    if (this.closed || !state?.live || !state.human) return deny();
    return Object.freeze({ channel: "local_human", proofRef: state.proofRef });
  }
  disconnect(handle: unknown): void {
    const state = handle && typeof handle === "object" ? this.sessions.get(handle) : undefined;
    if (state) state.live = false;
  }
  close(): void { this.closed = true; }
}
