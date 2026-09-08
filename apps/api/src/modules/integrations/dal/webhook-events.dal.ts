import { schema, type Database, type DatabaseTransaction } from '@devflow/database';
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { WebhookEventRecord } from '@devflow/integrations-core';

export type WebhookEventRow = typeof schema.webhookEvents.$inferSelect;

export interface InsertWebhookEventInput {
  provider: string;
  providerDeliveryId: string;
  eventType: string;
  payload: unknown;
}

/** Idempotent insert — a duplicate (provider, providerDeliveryId) is a no-op, returns undefined. */
export async function insertWebhookEvent(
  db: Database,
  input: InsertWebhookEventInput,
): Promise<WebhookEventRow | undefined> {
  const [row] = await db
    .insert(schema.webhookEvents)
    .values(input)
    .onConflictDoNothing()
    .returning();
  return row;
}

export interface AttachConnectionInput {
  organizationId: string;
  connectionId: string;
}

export async function attachConnection(
  db: Database,
  id: string,
  input: AttachConnectionInput,
): Promise<void> {
  await db.update(schema.webhookEvents).set(input).where(eq(schema.webhookEvents.id, id));
}

export interface ClaimWebhookEventsParams {
  relayId: string;
  batchSize: number;
  leaseMs: number;
}

function toRelayRecord(row: WebhookEventRow): WebhookEventRecord {
  return {
    id: row.id,
    provider: row.provider,
    eventType: row.eventType,
    payload: row.payload,
    organizationId: row.organizationId,
    connectionId: row.connectionId,
  };
}

/**
 * Claims due rows for the webhook relay (design doc §4/§9) — mirrors
 * `relayOutboxOnce`'s claim query exactly, plus the connection-resolved
 * filter required by the security invariant (§3.1): a row with no
 * organization/connection attached yet is never claimed for processing.
 */
export async function claimWebhookEvents(
  db: Database,
  { relayId, batchSize, leaseMs }: ClaimWebhookEventsParams,
): Promise<WebhookEventRecord[]> {
  const claimExpiresAt = new Date(Date.now() + leaseMs);

  const claimed = await db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: schema.webhookEvents.id })
      .from(schema.webhookEvents)
      .where(
        and(
          isNotNull(schema.webhookEvents.organizationId),
          isNotNull(schema.webhookEvents.connectionId),
          isNull(schema.webhookEvents.processedAt),
          or(
            isNull(schema.webhookEvents.claimExpiresAt),
            lt(schema.webhookEvents.claimExpiresAt, new Date()),
          ),
        ),
      )
      .limit(batchSize)
      .for('update', { skipLocked: true });

    if (candidates.length === 0) return [];

    const ids = candidates.map((row) => row.id);

    return tx
      .update(schema.webhookEvents)
      .set({ processingStartedAt: new Date(), claimedBy: relayId, claimExpiresAt })
      .where(inArray(schema.webhookEvents.id, ids))
      .returning();
  });

  return claimed.map(toRelayRecord);
}

/** Publishes normalized events to the outbox and marks the row processed, in one transaction. */
export async function markWebhookEventProcessed(
  db: Database,
  id: string,
  publish: (tx: DatabaseTransaction) => Promise<void>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await publish(tx);
    await tx
      .update(schema.webhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(schema.webhookEvents.id, id));
  });
}

/** Records a failed processing attempt; the row remains claimable once its lease expires. */
export async function markWebhookEventFailed(
  db: Database,
  id: string,
  error: string,
): Promise<void> {
  await db
    .update(schema.webhookEvents)
    .set({
      processingAttempts: sql`${schema.webhookEvents.processingAttempts} + 1`,
      lastError: error,
    })
    .where(eq(schema.webhookEvents.id, id));
}
