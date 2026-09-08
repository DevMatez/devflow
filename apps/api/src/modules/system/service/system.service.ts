import type { Database } from '@devflow/database';
import { publishOutbox } from '@devflow/events';
import { SystemPinged } from '../events';

export interface PingSystemInput {
  organizationId: string;
  correlationId: string;
  message: string;
}

export interface PingSystemResult {
  eventId: string;
}

/**
 * Publishes a `system.pinged` event via the outbox, in its own transaction.
 * Wave 0 foundation proof — real modules always pair `publishOutbox` with a
 * domain state change in the same transaction (see `@devflow/events` README).
 */
export async function pingSystem(db: Database, input: PingSystemInput): Promise<PingSystemResult> {
  const event = SystemPinged.create({
    organizationId: input.organizationId,
    aggregateId: input.organizationId,
    correlationId: input.correlationId,
    payload: { message: input.message },
  });

  await db.transaction(async (tx) => {
    await publishOutbox(tx, event);
  });

  return { eventId: event.id };
}
