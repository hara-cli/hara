import { AsyncLocalStorage } from "node:async_hooks";
/** Trusted owner transaction hooks. Only hashes cross this boundary, never written credentials/text.
 * Not an authorization source: normal private writer/CAS/resource guards remain mandatory. */
export interface PrivateWriteObserver {
  checkPath(path: string): void;
  before(path: string, previousHash: string | null, nextHash: string): void;
  committed(path: string, nextHash: string): void;
}
const observers = new AsyncLocalStorage<PrivateWriteObserver>();
export function observePrivateStateWrites<T>(observer: PrivateWriteObserver, action: () => T): T { return observers.run(observer, action); }
export function currentPrivateWriteObserver(): PrivateWriteObserver | undefined { return observers.getStore(); }
