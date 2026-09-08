import { schema, type DatabaseTransaction } from '@devflow/database';
import type { DomainEvent } from './event';

/**
 * Writes an event row within the caller's DB transaction — no queue I/O.
 * `tx` must be a transaction-scoped handle (from `db.transaction(...)`), not
 * the top-level `Database`, so "DB commit implies the event exists" holds.
 */
export async function publishOutbox(tx: DatabaseTransaction, event: DomainEvent): Promise<void> {
  await tx.insert(schema.outboxEvents).values({
    id: event.id,
    type: event.type,
    organizationId: event.organizationId,
    aggregateId: event.aggregateId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    payload: event.payload,
    schemaVersion: event.schemaVersion,
    aggregateVersion: event.aggregateVersion,
    occurredAt: new Date(event.occurredAt),
  });
}
