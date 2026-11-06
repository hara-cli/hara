import type { NeutralMsg } from "../providers/types.js";

/** Run-local model context. Feedback retains its original position across requests, but never
 * enters the durable transcript or the completion ledger. Sync also drops rolled-back replies. */
export class RunModelTranscript {
  private durable: NeutralMsg[] = [];
  private entries: { message: NeutralMsg; transient: boolean }[] = [];

  constructor(private readonly history: NeutralMsg[], private readonly hideDurable: (message: NeutralMsg) => boolean) {}

  private sync(): void {
    let common = 0;
    while (common < this.durable.length && this.durable[common] === this.history[common]) common++;
    const removed = new Set(this.durable.slice(common));
    if (removed.size) this.entries = this.entries.filter(entry => entry.transient || !removed.has(entry.message));
    for (const message of this.history.slice(common)) this.entries.push({ message, transient: false });
    this.durable = this.history.slice();
  }

  push(...messages: NeutralMsg[]): number {
    this.sync();
    for (const message of messages) this.entries.push({ message, transient: true });
    return this.entries.length;
  }

  read(): NeutralMsg[] {
    this.sync();
    return this.entries.filter(entry => entry.transient || !this.hideDurable(entry.message)).map(entry => entry.message);
  }
}
