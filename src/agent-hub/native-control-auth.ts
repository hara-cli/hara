import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AgentBoundaryTransports, type AgentBoundaryTransport } from "../workspace/agent-boundary-transport.js";
import {
  NATIVE_HUB_LIMITS, NativeHubError, nativeAttachProof, nativeSha256,
  parseNativeAttachFinish, parseNativeAttachHello,
  type NativeAttachHello, type NativeAttachProof, type NativeAttached,
} from "./native-control-contract.js";

const isSecret = (value: unknown): value is string =>
  typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const equal = (value: unknown, expected: string): boolean =>
  isSecret(value) && timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(expected, "hex"));
const denied = (): never => { throw new NativeHubError("unauthorized"); };

declare const nativeSessionBrand: unique symbol;
/** An in-memory identity, available only to the authenticated Host adapter. */
export interface NativeHubSession {
  readonly id: string;
  readonly [nativeSessionBrand]: true;
}
interface ActiveSession {
  handle: NativeHubSession;
  transport: AgentBoundaryTransport;
  tokenDigest: string;
  deadline: number;
}
interface PendingAttach {
  hello: NativeAttachHello;
  deadline: number;
}
export interface NativeHubAuthOptions {
  installId: string;
  hostInstanceId: string;
  port: number;
  workspaceToken: string;
  ownerCredential: string;
  monotonicNow?: () => number;
}

/**
 * Private transport proof only. Possession of an attached session does not
 * supply an original confirmation challenge, a WorkspaceRunPermit, or an RPC.
 */
export class NativeHubAuth {
  readonly hostInstanceId: string;
  readonly #host: Pick<NativeAttachHello, "installId" | "hostInstanceId" | "port">;
  readonly #ownerCredential: string;
  readonly #workspaceTokenDigest: string;
  readonly #transports: AgentBoundaryTransports;
  readonly #now: () => number;
  readonly #pending = new Map<string, PendingAttach>();
  #active: ActiveSession | undefined;
  #closed = false;

  constructor(options: NativeHubAuthOptions) {
    const { installId, hostInstanceId, port } = parseNativeAttachHello({
      installId: options.installId, hostInstanceId: options.hostInstanceId, port: options.port,
      clientNonce: "0".repeat(64),
    });
    if (!isSecret(options.workspaceToken) || !isSecret(options.ownerCredential)
      || equal(options.workspaceToken, options.ownerCredential)) throw new NativeHubError("unauthorized");
    this.hostInstanceId = hostInstanceId;
    this.#host = { installId, hostInstanceId, port };
    this.#ownerCredential = options.ownerCredential;
    this.#workspaceTokenDigest = nativeSha256(options.workspaceToken);
    this.#transports = new AgentBoundaryTransports(this.#ownerCredential);
    this.#now = options.monotonicNow ?? (() => performance.now());
  }

  hello(workspaceToken: unknown, input: unknown): NativeAttachProof {
    this.#verifyWorkspace(workspaceToken);
    const hello = parseNativeAttachHello(input);
    this.#verifyHost(hello);
    const now = this.#now();
    for (const [nonce, pending] of this.#pending) {
      if (pending.deadline <= now) this.#pending.delete(nonce);
      else if (pending.hello.clientNonce === hello.clientNonce) return denied();
    }
    if (this.#pending.size >= NATIVE_HUB_LIMITS.pending) throw new NativeHubError("busy");
    const serverNonce = randomBytes(32).toString("hex");
    const serverProof = nativeAttachProof(this.#ownerCredential, "attach.server", hello, serverNonce, this.#workspaceTokenDigest);
    this.#pending.set(serverNonce, { hello, deadline: this.#now() + NATIVE_HUB_LIMITS.challengeMs });
    return Object.freeze({ serverNonce, serverProof });
  }

  finish(workspaceToken: unknown, input: unknown): NativeAttached {
    this.#verifyWorkspace(workspaceToken);
    const answer = parseNativeAttachFinish(input);
    this.#verifyHost(answer);
    const pending = this.#pending.get(answer.serverNonce);
    this.#pending.delete(answer.serverNonce);
    if (!pending || pending.deadline <= this.#now() || pending.hello.clientNonce !== answer.clientNonce) return denied();
    const proof = nativeAttachProof(this.#ownerCredential, "attach.client", pending.hello, answer.serverNonce, this.#workspaceTokenDigest);
    if (!equal(answer.clientProof, proof)) return denied();

    const sessionToken = randomBytes(32).toString("hex");
    const handle = Object.freeze({ id: randomUUID() }) as NativeHubSession;
    const transport = this.#transports.connect(handle.id, this.#ownerCredential);
    this.#transports.provenance(transport);
    this.#retire();
    this.#pending.clear();
    this.#active = { handle, transport, tokenDigest: nativeSha256(sessionToken), deadline: this.#now() + 300_000 };
    return Object.freeze({ sessionToken });
  }

  authenticate(workspaceToken: unknown, sessionToken: unknown): NativeHubSession {
    this.#verifyWorkspace(workspaceToken);
    const active = this.#active;
    if (!active || !isSecret(sessionToken) || !equal(nativeSha256(sessionToken), active.tokenDigest)) return denied();
    this.assertCurrent(active.handle);
    return active.handle;
  }

  assertCurrent(handle: NativeHubSession): void {
    const active = this.#active;
    if (this.#closed || !active || active.handle !== handle) return denied();
    if (active.deadline <= this.#now()) {
      this.#retire();
      return denied();
    }
    try { this.#transports.provenance(active.transport); } catch { return denied(); }
  }

  detach(handle: NativeHubSession): void {
    this.assertCurrent(handle);
    this.#pending.clear();
    this.#retire();
  }

  close(): void {
    this.#closed = true;
    this.#pending.clear();
    this.#retire();
    this.#transports.close();
  }

  #verifyWorkspace(workspaceToken: unknown): void {
    if (this.#closed || !isSecret(workspaceToken)
      || !equal(nativeSha256(workspaceToken), this.#workspaceTokenDigest)) denied();
  }

  #verifyHost(hello: Omit<NativeAttachHello, "clientNonce">): void {
    if (hello.installId !== this.#host.installId || hello.hostInstanceId !== this.#host.hostInstanceId
      || hello.port !== this.#host.port) denied();
  }

  #retire(): void {
    if (this.#active) this.#transports.disconnect(this.#active.transport);
    this.#active = undefined;
  }
}
