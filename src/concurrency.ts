// Bounded-concurrency map: run `fn` over `items` with at most `limit` in flight at once, preserving input
// order in the results. Used to cap parallel sub-agents / read-tools / plan atoms so a wide fan-out (the
// model spawning 20 `agent` calls in one turn) doesn't hammer the provider's rate limits or thrash the box.
// cc-haha caps tool concurrency at 10; hara defaults to 8, tunable via HARA_MAX_CONCURRENCY.

export function maxParallel(): number {
  const n = Number(process.env.HARA_MAX_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 ? n : 8;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
