/**
 * Rows one statement of a daily purge deletes at most. Each batch commits on its own, so a purge
 * that has a big backlog never holds its locks on a table for long.
 */
export const PURGE_BATCH = 1000;

/** Runs `deleteBatch` until a batch comes back short, and returns how many rows went in all. */
export async function deleteInBatches(deleteBatch: (limit: number) => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await deleteBatch(PURGE_BATCH);
    total += n;
    if (n < PURGE_BATCH) return total;
  }
}
