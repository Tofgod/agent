import type { TracePage } from "@/lib/studio/trajectory";

export async function trajectoryChanges(latest: TracePage, head: number, openRows: readonly number[],
  fetchPage: (before?: number, after?: number, watch?: number[]) => Promise<TracePage>) {
  const changes = new Map(latest.rows.map((row) => [row.seq, row]));
  const oldest = latest.rows.at(-1)?.seq;
  if (latest.before !== null && oldest !== undefined && oldest > head) {
    let cursor: number | null = head;
    while (cursor !== null) {
      const page = await fetchPage(oldest, cursor);
      for (const row of page.rows) changes.set(row.seq, row);
      cursor = page.after ?? null;
    }
  }
  // A settlement updates its original row even after that row leaves the newest page.
  const outside = openRows.filter((seq) => !changes.has(seq));
  for (let i = 0; i < outside.length; i += 60) {
    const page = await fetchPage(undefined, undefined, outside.slice(i, i + 60));
    for (const row of page.rows) changes.set(row.seq, row);
  }
  return changes;
}
