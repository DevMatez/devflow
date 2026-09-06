import { pgTable, uuid, text, jsonb, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { workItems } from './work-items';

/**
 * Human-facing timeline (Wave 3 design §7). A persisted projection built from
 * domain events by the activity projector — NOT rebuilt from raw events on
 * read. `source_event_id` is unique so at-least-once redelivery is a no-op
 * (`ON CONFLICT DO NOTHING`). Not the audit log (that's a separate record).
 */
export const activity = pgTable(
  'activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    summary: text('summary').notNull(),
    metadata: jsonb('metadata'),
    correlationId: text('correlation_id').notNull(),
    sourceEventId: uuid('source_event_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique().on(table.sourceEventId),
    index('activity_org_item_occurred_idx').on(
      table.organizationId,
      table.workItemId,
      table.occurredAt,
    ),
  ],
);
