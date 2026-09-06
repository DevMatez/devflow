import { pgTable, uuid, text, jsonb, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Transactional-outbox contract required by @devflow/events (see its README
 * for the full relay/claim-lease protocol this table supports).
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    organizationId: uuid('organization_id').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    correlationId: uuid('correlation_id').notNull(),
    causationId: uuid('causation_id'),
    payload: jsonb('payload').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    aggregateVersion: integer('aggregate_version'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // relay/claim bookkeeping — relay attempts only, never worker/job retries
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    relayedAt: timestamp('relayed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (table) => [
    // Supports the relay's claim query: unrelayed rows whose lease (if any) has expired.
    index('outbox_events_relay_idx')
      .on(table.occurredAt)
      .where(sql`${table.relayedAt} is null`),
    // Supports "list outbox events for an organization" (admin/debug queries).
    index('outbox_events_organization_id_idx').on(table.organizationId),
  ],
);
