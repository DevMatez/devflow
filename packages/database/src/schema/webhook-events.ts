import { pgTable, uuid, text, jsonb, timestamp, integer, unique } from 'drizzle-orm/pg-core';

/**
 * Inbound webhook idempotency (§10). A duplicate delivery is a no-op at the
 * database layer via the (provider, provider_delivery_id) unique constraint.
 *
 * `organization_id` is nullable: the webhook route persists the raw event
 * before it can always resolve an organization (e.g. unknown installation,
 * revoked OAuth). It is attached once resolved, and NULL is retained for
 * debugging unrecognized deliveries rather than dropping the row.
 *
 * `connection_id` is resolved alongside `organization_id` (Wave 2 design doc
 * §3.1) — the relay needs the specific connection, not just the org, to
 * construct the right adapter for `normalize()`.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(), // 'github' | 'slack' | 'plane' | ...
    providerDeliveryId: text('provider_delivery_id').notNull(),
    organizationId: uuid('organization_id'), // nullable — see note above
    connectionId: uuid('connection_id'), // nullable — see note above
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),

    // Claim-lease processing state, mirrors outbox_events (Wave 2 design doc
    // §4/§9) — processing_started_at doubles as claimed_at.
    processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    processingAttempts: integer('processing_attempts').notNull().default(0),
    lastError: text('last_error'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [unique().on(table.provider, table.providerDeliveryId)],
);
