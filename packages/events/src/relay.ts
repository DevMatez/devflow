import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { schema, type Database } from '@devflow/database';
import type { DomainEvent } from './event';
import type { EventRoute } from './routing';

export interface RelayOptions {
  db: Database;
  routes: EventRoute[];
  /** Identifies this relay instance for claimed_by / lease diagnostics. */
  relayId: string;
  batchSize?: number;
  /** How long a claim is held before another relay instance may reclaim it. */
  leaseMs?: number;
  /** Rows at/above this attempt count are left unclaimed (dead-lettered) instead of retried forever. */
  maxAttempts?: number;
  /**
   * Event types intentionally not consumed yet. They are marked relayed
   * (acknowledged) without enqueuing — a distinct outcome from "unknown type"
   * (no route → dead-lettered as a defect signal). See Wave 3 design §5.
   */
  ignoredEventTypes?: Iterable<string>;
}

export interface RelayResult {
  claimed: number;
  relayed: number;
  /** Rows acknowledged via `ignoredEventTypes` without enqueuing. */
  ignored: number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

function toDomainEvent(row: typeof schema.outboxEvents.$inferSelect): DomainEvent {
  return {
    id: row.id,
    type: row.type,
    organizationId: row.organizationId,
    aggregateId: row.aggregateId,
    correlationId: row.correlationId,
    causationId: row.causationId ?? undefined,
    occurredAt: row.occurredAt.toISOString(),
    schemaVersion: row.schemaVersion,
    aggregateVersion: row.aggregateVersion ?? undefined,
    payload: row.payload,
  };
}

/**
 * Runs a single claim → publish → mark-relayed cycle. Intended to be called
 * in a loop/interval from a worker process — not a held long-running
 * transaction. Never holds a DB transaction open while calling out to Redis
 * (see README "Relay: claim/lease, not a held transaction").
 */
export async function relayOutboxOnce(options: RelayOptions): Promise<RelayResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  // One event type may fan out to several routes (e.g. activity + notifications, §5).
  const routesByType = new Map<string, EventRoute[]>();
  for (const route of options.routes) {
    const list = routesByType.get(route.eventType);
    if (list) list.push(route);
    else routesByType.set(route.eventType, [route]);
  }
  const ignoredTypes = new Set(options.ignoredEventTypes ?? []);

  // Step 1: claim a batch. Short transaction, no external calls.
  const claimExpiresAt = new Date(Date.now() + leaseMs);
  const claimed = await options.db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(
        and(
          isNull(schema.outboxEvents.relayedAt),
          or(
            isNull(schema.outboxEvents.claimExpiresAt),
            lt(schema.outboxEvents.claimExpiresAt, new Date()),
          ),
          // Rows that have exhausted their attempts are dead-lettered in place, not reclaimed forever.
          lt(schema.outboxEvents.attempts, maxAttempts),
        ),
      )
      .limit(batchSize)
      .for('update', { skipLocked: true });

    if (candidates.length === 0) return [];

    const ids = candidates.map((row) => row.id);

    return tx
      .update(schema.outboxEvents)
      .set({ claimedAt: new Date(), claimedBy: options.relayId, claimExpiresAt })
      .where(inArray(schema.outboxEvents.id, ids))
      .returning();
  });

  // Step 2 + 3: publish outside the transaction, then mark relayed (or record failure).
  let relayed = 0;
  let ignored = 0;

  for (const row of claimed) {
    // Intentionally-unsupported type: acknowledge without enqueuing, don't dead-letter.
    if (ignoredTypes.has(row.type)) {
      await options.db
        .update(schema.outboxEvents)
        .set({ relayedAt: new Date() })
        .where(eq(schema.outboxEvents.id, row.id));
      ignored += 1;
      continue;
    }

    const routes = routesByType.get(row.type) ?? [];

    if (routes.length === 0) {
      await options.db
        .update(schema.outboxEvents)
        .set({
          attempts: row.attempts + 1,
          lastError: `No route registered for event type "${row.type}"`,
        })
        .where(eq(schema.outboxEvents.id, row.id));
      continue;
    }

    try {
      const event = toDomainEvent(row);
      // Each route has its own deterministic jobId(name, event.id), so a retried
      // fan-out (one route succeeded, another threw) dedupes per route on BullMQ.
      for (const route of routes) {
        await route.enqueue(event);
      }
      await options.db
        .update(schema.outboxEvents)
        .set({ relayedAt: new Date() })
        .where(eq(schema.outboxEvents.id, row.id));
      relayed += 1;
    } catch (error) {
      await options.db
        .update(schema.outboxEvents)
        .set({
          attempts: row.attempts + 1,
          lastError: error instanceof Error ? error.message : String(error),
        })
        .where(eq(schema.outboxEvents.id, row.id));
    }
  }

  return { claimed: claimed.length, relayed, ignored };
}
