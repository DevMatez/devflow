/**
 * Deterministic, namespace-scoped job id for enqueue-level deduplication.
 * Stable across retries; must not include transient data (timestamps/random).
 * Uses `.` (not `:`) — BullMQ rejects custom job ids containing a bare colon.
 */
export function jobId(namespace: string, id: string): string {
  return `${namespace}.${id}`;
}
