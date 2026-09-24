/**
 * Run `worker` over `items` with at most `limit` in flight, preserving order.
 *
 * Used for batching. The Laya server has no batch route — `/v1/systemone`
 * takes one state per call — so many states means many requests, and the only
 * honest speed-up available to a client is to overlap them.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** Like {@link mapWithConcurrency} but collects failures instead of rejecting. */
export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  return mapWithConcurrency(items, limit, async (item, index) => {
    try {
      return { ok: true as const, value: await worker(item, index) };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
}
